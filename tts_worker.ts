// Persistent Kokoro TTS worker for devdeck.py's voice mode: loads the model once and then
// synthesises one sentence per request, so only the first sentence after a start pays for
// loading the model (`omp say` pays it on every call).
//
//   bun tts_worker.ts RUNTIME_DIR CACHE_DIR
//
// RUNTIME_DIR is omp's Kokoro runtime (~/.omp/agent/cache/tts-runtime/kokoro-X, installed by
// the first `omp say`); CACHE_DIR is where omp keeps the model weights. omp uses the q8
// weights; on CPUs without fast int8 kernels the fp32 ones (onnx/model.onnx, 325 MB) are
// several times faster, so they are used when they are already in CACHE_DIR. They are never
// downloaded here (omp's q8 ones are, if missing, like omp would).
//
// stdin: one JSON object per line {text, voice, speed}.
// stdout: first {"ready":true,"ms","dtype"} once the model is loaded; then per request one
// JSON line {"ok":true,"rate","bytes","ms"} followed by `bytes` of mono PCM16 little-endian,
// or {"ok":false,"error"}. Exits when stdin closes.
import { existsSync } from "fs";
import { createRequire } from "module";
import * as path from "path";

const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const [runtimeDir, cacheDir] = process.argv.slice(2);
if (!runtimeDir || !cacheDir) {
  console.error("usage: bun tts_worker.ts RUNTIME_DIR CACHE_DIR");
  process.exit(2);
}

const out = Bun.stdout.writer();
async function send(header: object, body?: Uint8Array): Promise<void> {
  out.write(`${JSON.stringify(header)}\n`);
  if (body) out.write(body);
  await out.flush();
}

// CommonJS on purpose, like omp: kokoro-js must see the very transformers instance whose
// env (cache dir, no local models, quiet logs) is configured here.
const require = createRequire(path.join(runtimeDir, "package.json"));
const transformers = require(require.resolve("@huggingface/transformers", { paths: [path.dirname(require.resolve("kokoro-js"))] }));
transformers.env.cacheDir = cacheDir;
transformers.env.allowLocalModels = false;
transformers.env.logLevel = transformers.LogLevel?.ERROR ?? "error";
if (transformers.env.backends?.onnx) transformers.env.backends.onnx.logLevel = "error";
const { KokoroTTS } = require("kokoro-js");

const dtype = existsSync(path.join(cacheDir, REPO, "onnx", "model.onnx")) ? "fp32" : "q8";
const t0 = performance.now();
const tts = await KokoroTTS.from_pretrained(REPO, { dtype, device: "cpu" });
await send({ ready: true, ms: Math.round(performance.now() - t0), dtype });

function pcm16(samples: Float32Array): Uint8Array {
  const buf = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(buf.buffer);
}

for await (const line of console) {
  if (!line.trim()) continue;
  const t = performance.now();
  try {
    const req = JSON.parse(line);
    const res = await tts.generate(String(req.text), { voice: req.voice, speed: req.speed });
    const audio: Float32Array | undefined = Array.isArray(res.audio) ? res.audio[0] : res.audio;
    if (!audio || !audio.length) throw new Error("Kokoro returned no audio");
    const body = pcm16(audio);
    await send({ ok: true, rate: res.sampling_rate || 24000, bytes: body.length, ms: Math.round(performance.now() - t) }, body);
  } catch (err) {
    await send({ ok: false, error: String((err as Error)?.message ?? err) });
  }
}
