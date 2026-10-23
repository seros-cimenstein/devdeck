// Persistent Kokoro TTS worker for devdeck.py's voice mode: loads the model once and then
// synthesises one sentence per request, so only the first sentence after a start pays for
// loading the model (`omp say` pays it on every call).
//
//   bun tts_worker.ts RUNTIME_DIR CACHE_DIR [cpu|cuda]
//
// RUNTIME_DIR is omp's Kokoro runtime (~/.omp/agent/cache/tts-runtime/kokoro-X, installed by
// the first `omp say`); CACHE_DIR is where omp keeps the model weights. omp uses the q8
// weights; on CPUs without fast int8 kernels the fp32 ones (onnx/model.onnx, 325 MB) are
// several times faster, so they are used when they are already in CACHE_DIR. They are never
// downloaded here (omp's q8 ones are, if missing, like omp would).
//
// cuda (default cpu) runs the model on onnxruntime's CUDA execution provider (its provider
// libraries next to libonnxruntime.so.1, CUDA 12 + cuDNN 9 on LD_LIBRARY_PATH) and checks it with
// a short warm-up synthesis. If that fails the worker reports it and exits: transformers.js keeps
// the first session creation's failure and repeats it for every later session, so a CPU fallback
// needs a new process (devdeck.py's DEVDECK_TTS_DEVICE=auto starts one).
//
// stdin: one JSON object per line {text, voice, speed}.
// stdout: first {"ready":true,"ms","dtype","device"} once the model is loaded (or
// {"ready":false,"error"} before exiting); then per request one JSON line
// {"ok":true,"rate","bytes","ms"} followed by `bytes` of mono PCM16 little-endian, or
// {"ok":false,"error"}. Exits when stdin closes.
import { existsSync } from "fs";
import { createRequire } from "module";
import * as path from "path";

const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const [runtimeDir, cacheDir, device = "cpu"] = process.argv.slice(2);
if (!runtimeDir || !cacheDir || !["cpu", "cuda"].includes(device)) {
  console.error("usage: bun tts_worker.ts RUNTIME_DIR CACHE_DIR [cpu|cuda]");
  process.exit(2);
}

const out = Bun.stdout.writer();
async function send(header: object, body?: Uint8Array): Promise<void> {
  out.write(`${JSON.stringify(header)}\n`);
  if (body) out.write(body);
  await out.flush();
}

// onnxruntime's messages carry C++ source locations and signatures ("/onnxruntime_src/...cc:122
// std::conditional_t<...> onnxruntime::CudaCall(...) [with ...]") around the actual reason.
function reason(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0]
    .replace(/\/onnxruntime_src\/\S+ .*?\)( \[with [^\]]*\])?\s*/g, "").replace(/ ; GPU=.*/, "").slice(0, 300);
}

// CommonJS on purpose, like omp: kokoro-js must see the very transformers instance whose
// env (cache dir, no local models, quiet logs) is configured here.
const require = createRequire(path.join(runtimeDir, "package.json"));
const transformers = require(require.resolve("@huggingface/transformers", { paths: [path.dirname(require.resolve("kokoro-js"))] }));
transformers.env.cacheDir = cacheDir;
transformers.env.allowLocalModels = false;
transformers.env.logLevel = transformers.LogLevel?.ERROR ?? "error";
if (transformers.env.backends?.onnx) transformers.env.backends.onnx.logLevel = "error";
// The parts of kokoro-js used here (it is loaded untyped, from omp's runtime).
type Kokoro = {
  generate(text: string, opts: { voice?: string; speed?: number }): Promise<{ audio: Float32Array | Float32Array[]; sampling_rate: number }>;
};
const { KokoroTTS } = require("kokoro-js") as { KokoroTTS: { from_pretrained(repo: string, opts: object): Promise<Kokoro> } };

const dtype = existsSync(path.join(cacheDir, REPO, "onnx", "model.onnx")) ? "fp32" : "q8";

const t0 = performance.now();
let engine: Kokoro;
try {
  engine = await KokoroTTS.from_pretrained(REPO, { dtype, device });
  if (device === "cuda") {
    // The first run also picks cuDNN's kernels; an unusable setup (no kernels for this GPU, a
    // missing library, NaN output) fails here rather than on the first real sentence.
    const res = await engine.generate("Ready.", { voice: "af_heart" });
    const audio = Array.isArray(res.audio) ? res.audio[0] : res.audio;
    let peak = 0;
    for (const s of audio ?? []) peak = Math.max(peak, Math.abs(s));
    if (!audio?.length || !Number.isFinite(peak) || peak < 1e-3) throw new Error(`warm-up produced unusable audio (peak ${peak})`);
  }
} catch (err) {
  await send({ ready: false, error: reason(err) });
  process.exit(1);
}
await send({ ready: true, ms: Math.round(performance.now() - t0), dtype, device });

function pcm16(samples: Float32Array): Uint8Array {
  const buf = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(buf.buffer);
}

// A long sentence (or a slow speed) can need more than a 2 GB GPU has: on the MX150 a
// 290-character sentence (19 s of audio) peaks at 1.9 GB, a 350-character one fails to
// allocate. On CUDA such a sentence is synthesised in two halves split at a comma (else a
// space) near the middle, and from then on anything as long is split up front.
let splitFrom = Infinity; // text length / speed that ran out of GPU memory

function halves(text: string): [string, string] | null {
  const mid = text.length / 2;
  let best = -1;
  for (const re of [/[,;:]\s/g, /\s/g]) {
    for (const m of text.matchAll(re)) {
      const at = m.index + 1;
      if (at >= 10 && text.length - at >= 10 && (best < 0 || Math.abs(at - mid) < Math.abs(best - mid))) best = at;
    }
    if (best >= 0) return [text.slice(0, best).trim(), text.slice(best).trim()];
  }
  return null;
}

async function synth(text: string, voice: string, speed: number): Promise<{ audio: Float32Array; rate: number }> {
  let parts = device === "cuda" && text.length / speed >= splitFrom ? halves(text) : null;
  if (!parts) {
    try {
      const res = await engine.generate(text, { voice, speed });
      const audio = Array.isArray(res.audio) ? res.audio[0] : res.audio;
      if (!audio?.length) throw new Error("Kokoro returned no audio");
      return { audio, rate: res.sampling_rate || 24000 };
    } catch (err) {
      parts = device === "cuda" && /Failed to allocate memory/.test(String(err)) ? halves(text) : null;
      if (!parts) throw err;
      splitFrom = Math.min(splitFrom, text.length / speed);
      console.error(`out of GPU memory for ${text.length} characters, splitting it`);
    }
  }
  const a = await synth(parts[0], voice, speed), b = await synth(parts[1], voice, speed);
  const audio = new Float32Array(a.audio.length + b.audio.length);
  audio.set(a.audio);
  audio.set(b.audio, a.audio.length);
  return { audio, rate: a.rate };
}

for await (const line of console) {
  if (!line.trim()) continue;
  const t = performance.now();
  try {
    const req = JSON.parse(line);
    const { audio, rate } = await synth(String(req.text), req.voice, Number(req.speed) || 1);
    const body = pcm16(audio);
    await send({ ok: true, rate, bytes: body.length, ms: Math.round(performance.now() - t) }, body);
  } catch (err) {
    await send({ ok: false, error: reason(err) });
  }
}
