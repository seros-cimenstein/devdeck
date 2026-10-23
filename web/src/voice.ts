// Voice dialogue mode: settings, the listen -> send -> wait -> speak loop, voice answers to omp asks,
// and the play/stop state of assistant replies. Recognition and playback are native (DD.listen / audio queue);
// this module drives them and renders the voice panel that replaces the compose bar.
import type { AskSheet } from "./ask";
import { bridge, send } from "./bridge";
import { onOutboxChange, outboxFor, sendText } from "./outbox";
import { hooks, paneTitle, state } from "./state";
import type { Ask, AudioMsg, Msg, Pane, SttMsg, TtsMsg, VoiceErrorMsg } from "./types";
import { type Layer, pushLayer, removeLayer, Sheet, toast } from "./ui";
import { h, icon, lsGet, lsSet } from "./util";
import { matchAnswer, optionsSpeech, plain, spokenIndex } from "./voicematch";

// ---------------------------------------------------------------- settings

export const VOICES = [
  { id: "af_heart", name: "Heart", desc: "US female" },
  { id: "af_bella", name: "Bella", desc: "US female" },
  { id: "af_nicole", name: "Nicole", desc: "US female, soft" },
  { id: "af_aoede", name: "Aoede", desc: "US female" },
  { id: "af_kore", name: "Kore", desc: "US female" },
  { id: "af_sarah", name: "Sarah", desc: "US female" },
  { id: "am_michael", name: "Michael", desc: "US male" },
  { id: "am_fenrir", name: "Fenrir", desc: "US male" },
  { id: "am_puck", name: "Puck", desc: "US male" },
  { id: "bf_emma", name: "Emma", desc: "UK female" },
  { id: "bm_george", name: "George", desc: "UK male" },
  { id: "bm_fable", name: "Fable", desc: "UK male" },
];
const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
const LANGS = [
  { id: "en-US", label: "English" },
  { id: "tr-TR", label: "Türkçe" },
];

interface VoiceSettings {
  voice: string;
  speed: number;
  lang: string;
  autoRead: boolean;
  readAsks: boolean;
  autoListen: boolean;
  hint: boolean;
}
const KEY = "dd.voice";
const settings: VoiceSettings = {
  voice: "af_heart",
  speed: 1,
  lang: "en-US",
  autoRead: true,
  readAsks: true,
  autoListen: true,
  hint: true,
  ...lsGet<Partial<VoiceSettings>>(KEY, {}),
};
const HINT = "\n\n(voice mode: reply in short plain spoken sentences; no tables or code unless I ask)";

/** How long to wait for the spoken reply after a turn ends before listening again. */
const REPLY_WAIT_MS = 15000;
/** How long to wait for the server to read a new question before listening anyway. */
const ASK_WAIT_MS = 10000;
/** A say request with no audio by then is given up. */
const SAY_TIMEOUT_MS = 45000;
/** The read-back is a courtesy: the answer is sent anyway when it does not play. */
const CONFIRM_WAIT_MS = 8000;

// ---------------------------------------------------------------- utterances (what the player speaks)

type UttKind = "auto" | "ask" | "entry" | "sample" | "prompt" | "confirm" | "info";
interface Utt {
  kind: UttKind;
  key: string;
  req?: string;
  entryId?: string;
  target?: string;
  sentences: string[];
  cur: number;
  started: boolean;
  timer: number;
}

type Phase = "turn" | "listening" | "sending" | "working" | "reply" | "speaking" | "confirm";
const PHASE_LABEL: Record<Phase, string> = {
  turn: "Your turn",
  listening: "Listening",
  sending: "Sending",
  working: "Agent working",
  reply: "Reply coming",
  speaking: "Speaking",
  confirm: "Confirming",
};

interface AskCtx {
  toolCallId: string;
  target: string;
  ask: Ask;
  qi: number;
  answers: { selected: string[]; custom?: string }[];
  tries: number;
  wantOther: boolean;
  cancelled: boolean;
  /** The server read (or is reading) the question. */
  spoken: boolean;
}

let sheet: AskSheet | null = null;
let onActive: (on: boolean) => void = () => {};
let onSent: () => void = () => {};

let enabled = false;
let wasActive = false;
let wire: { target: string; sig: string } | null = null;

let phase: Phase = "turn";
let note = "";
let heard = "";
let partial = "";
let sentId = "";
let workStart = 0;
let sawWorking = false;
let lastPaneState = "";
let askCtx: AskCtx | null = null;
let confirmText = "";
let phaseTimer = 0;
let ticker = 0;
let reqSeq = 0;

const reqs = new Map<string, Utt>();
/** Server-initiated utterances (auto replies, asks) seen in `audio` before they play. */
const incoming = new Map<string, Utt>();
let current: Utt | null = null;
const sayListeners = new Set<() => void>();

const pane = (): Pane | undefined => state.byTarget.get(state.target);
const isActive = () => enabled && state.view === "chat" && !!pane()?.agent;

function sayChanged() {
  for (const l of sayListeners) l();
}

// ---------------------------------------------------------------- panel DOM

const levelEl = h("span.v-level");
const micBtn = h("button.v-mic", { "aria-label": "Talk" }, levelEl, h("span.v-mic-ic", { html: icon("mic") })) as HTMLButtonElement;
const chipEl = h("span.v-state");
const auxEl = h("span.v-aux");
const stageEl = h("div.v-stage");
const sideL = h("div.v-side");
const sideR = h("div.v-side");
export const voicePanel = h(
  "div.voice",
  { hidden: true, "aria-live": "polite" },
  h(
    "div.v-head",
    null,
    chipEl,
    auxEl,
    h("span.v-gap"),
    h("button.ib.v-ib", { "aria-label": "Voice settings", title: "Voice settings", html: icon("sliders"), onclick: () => openVoiceSettings() }),
    h("button.ib.v-ib", { "aria-label": "Leave voice mode", title: "Leave voice mode", html: icon("close"), onclick: () => setEnabled(false) }),
  ),
  stageEl,
  h("div.v-ctl", null, sideL, micBtn, sideR),
);
micBtn.addEventListener("click", () => micTap());
stageEl.addEventListener("click", () => {
  if (phase === "speaking" || phase === "confirm") stopTap();
});

// ---------------------------------------------------------------- public API

export function initVoice(o: { ask: AskSheet; onActive: (on: boolean) => void; onSent: () => void }) {
  sheet = o.ask;
  onActive = o.onActive;
  onSent = o.onSent;
  sheet.onVoiceMic = () => micTap();
  onOutboxChange(() => checkSent());
}

export function voiceEnabled(): boolean {
  return enabled;
}

export function setEnabled(on: boolean) {
  if (on && !bridge.hasVoice()) {
    toast("Voice needs the updated DevDeck+ app", "err");
    return;
  }
  if (on === enabled) return;
  enabled = on;
  voiceSync();
  if (on && !isActive()) toast("Voice mode works in the chat view of an agent");
}

/** The link came back: re-send `voice` only when our last send did not reach the shell. */
export function voiceOnline() {
  if (wire?.sig === "") {
    wire = null;
    syncWire();
  }
}

export function sayStatus(entryId: string): "" | "loading" | "playing" {
  if (current?.entryId === entryId) return "playing";
  for (const u of reqs.values()) if (u.entryId === entryId) return u.started ? "playing" : "loading";
  return "";
}

export function onSayChange(fn: () => void) {
  sayListeners.add(fn);
}

/** Play button on an assistant reply: speak it, or stop when it is the one playing. */
export function toggleEntry(target: string, entryId: string) {
  if (sayStatus(entryId)) {
    stopTap();
    return;
  }
  quietMic();
  if (current || reqs.size) stopPlayback();
  say({ kind: "entry", target, entryId });
}

// ---------------------------------------------------------------- activation + wire

/** Hardware back leaves voice mode (after any sheet above it). */
const voiceLayer: Layer = { close: () => setEnabled(false) };

/** Pane list, target or view changed: (de)activates voice mode for the current pane. */
export function voiceSync() {
  const act = isActive();
  if (act !== wasActive) {
    wasActive = act;
    if (act) start();
    else stop();
    bridge.setVoiceMode(act);
    if (act) pushLayer(voiceLayer);
    else removeLayer(voiceLayer);
    voicePanel.hidden = !act;
    onActive(act);
  } else if (act && wire && wire.target !== state.target) {
    stop();
    start();
  }
  syncWire();
  if (act) onPanes();
}

function syncWire() {
  const target = isActive() ? state.target : "";
  const opts = { autoRead: settings.autoRead, readAsks: settings.readAsks, voice: settings.voice, speed: settings.speed };
  const sig = target ? JSON.stringify(opts) : "";
  if (wire && wire.target !== target) {
    send({ t: "voice", target: wire.target, on: false, opts });
    wire = null;
  }
  if (!target || (wire && wire.sig === sig)) return;
  const ok = send({ t: "voice", target, on: true, opts });
  wire = { target, sig: ok ? sig : "" };
}

function start() {
  const p = pane();
  phase = "turn";
  note = "";
  heard = "";
  partial = "";
  askCtx = null;
  sawWorking = p?.state === "working";
  lastPaneState = p?.state ?? "";
  clearInterval(ticker);
  ticker = window.setInterval(tick, 1000);
  if (p?.state === "working") {
    workStart = Date.now();
    setPhase("working");
  } else if (p?.state === "asking" && p.ask) {
    beginAsk(p.ask);
  } else listen();
}

function stop() {
  clearTimeout(phaseTimer);
  clearInterval(ticker);
  if (phase === "listening") bridge.stopListening();
  if (current || reqs.size) stopPlayback();
  askCtx = null;
  sheet?.setVoice(null);
  phase = "turn";
}

// ---------------------------------------------------------------- loop

function setPhase(p: Phase, n = "") {
  clearTimeout(phaseTimer);
  phase = p;
  note = n;
  render();
}

function listen() {
  if (!bridge.hasVoice()) return setPhase("turn", "Voice input is not available in this app version");
  if (current || reqs.size || phase === "reply") stopPlayback();
  partial = "";
  setPhase("listening");
  bridge.listen({ lang: settings.lang, partial: true, preferOffline: true });
}

function micTap() {
  bridge.haptic();
  if (phase === "listening") {
    bridge.stopListening();
    return;
  }
  if (phase === "confirm" && askCtx) {
    // Barge-in on the read-back: answer again from the first question.
    askCtx.qi = 0;
    askCtx.answers = [];
    askCtx.wantOther = false;
  }
  if (askCtx?.cancelled) askCtx.cancelled = false;
  listen();
}

function stopTap() {
  stopPlayback();
  if (phase === "confirm") return commitAsk();
  if (isActive() && phase === "speaking") setPhase(restingPhase());
}

/** Stops native playback and every stream of this connection (say, auto reply, ask). */
function stopPlayback() {
  bridge.stopSpeaking();
  send({ t: "say_stop" });
  for (const r of reqs.values()) clearTimeout(r.timer);
  reqs.clear();
  incoming.clear();
  current = null;
  sayChanged();
}

/** Where the loop rests when nothing is being said or heard. */
function restingPhase(): Phase {
  const p = pane();
  if (p?.state === "working") return "working";
  return "turn";
}

function afterReply() {
  if (!isActive()) return;
  if (pane()?.state === "asking" && askCtx) return askCtx.spoken || !settings.readAsks ? askListen() : awaitAskSpeech(askCtx);
  if (settings.autoListen) listen();
  else setPhase("turn");
}

function onFinal(text: string) {
  const t = text.trim();
  if (!t) return setPhase("turn", "Didn't catch that");
  heard = t;
  const p = pane();
  if (askCtx && !askCtx.cancelled && p?.ask?.toolCallId === askCtx.toolCallId) return answerAsk(t);
  sentId = sendText(state.target, t + (settings.hint ? HINT : ""), true);
  workStart = Date.now();
  sawWorking = false;
  setPhase("sending");
  onSent();
  checkSent();
}

function checkSent() {
  if (phase !== "sending" || !sentId) return;
  const it = outboxFor(state.target).find((i) => i.id === sentId);
  if (!it) {
    sentId = "";
    setPhase(pane()?.state === "asking" ? "turn" : "working");
  } else if (it.failed) {
    sentId = "";
    setPhase("turn", `Send failed: ${it.failed}`);
  }
}

function onPanes() {
  const p = pane();
  if (!p) return;
  const prev = lastPaneState;
  lastPaneState = p.state;
  if (p.state === "asking" && p.ask) {
    if (askCtx?.toolCallId !== p.ask.toolCallId) beginAsk(p.ask);
  } else if (askCtx) {
    askCtx = null;
    sheet?.setVoice(null);
    if (phase === "listening") bridge.stopListening();
    if (phase === "confirm" || phase === "listening") setPhase(restingPhase());
  }
  if (p.state === "working") {
    sawWorking = true;
    if (phase === "turn" || phase === "reply" || (phase === "sending" && !sentId)) {
      if (phase !== "sending") workStart = Date.now();
      setPhase("working");
    }
  } else if (prev === "working" && p.state === "idle") turnEnded();
  render();
}

function turnEnded() {
  if (phase !== "working" && phase !== "sending" && phase !== "turn") return;
  if (!settings.autoRead) return afterReply();
  setPhase("reply");
  phaseTimer = window.setTimeout(() => {
    if (phase === "reply") afterReply();
  }, REPLY_WAIT_MS);
}

function tick() {
  if (!isActive()) return;
  const p = pane();
  // Missed the working -> idle edge (fast turn, or the send never started a turn).
  if (phase === "working" && p?.state === "idle" && Date.now() - workStart > 8000 && !sawWorking) turnEnded();
  if (phase === "sending" && !sentId && p?.state === "idle" && Date.now() - workStart > 20000) setPhase("turn");
  if (phase === "working" || phase === "reply" || phase === "sending") auxEl.textContent = fmtElapsed(Date.now() - workStart);
}

// ---------------------------------------------------------------- asks

function beginAsk(ask: Ask) {
  const p = pane();
  askCtx = { toolCallId: ask.toolCallId, target: state.target, ask, qi: 0, answers: [], tries: 0, wantOther: false, cancelled: false, spoken: false };
  if (p && sheet?.current?.ask.toolCallId !== ask.toolCallId) hooks.openAsk(p.target, ask);
  if (phase === "listening" || phase === "speaking") return render();
  if (settings.readAsks) awaitAskSpeech(askCtx);
  else askListen();
}

/** The server reads a new ask; listen once it is done (its tts end), or anyway after a while. */
function awaitAskSpeech(c: AskCtx) {
  setPhase("turn", "omp is asking");
  phaseTimer = window.setTimeout(() => {
    if (askCtx === c && !c.spoken && phase === "turn") askListen();
  }, ASK_WAIT_MS);
}

function askListen() {
  if (settings.autoListen) listen();
  else setPhase("turn", "Tap the mic to answer");
}

function answerAsk(text: string) {
  const c = askCtx!;
  const q = c.ask.questions[c.qi];
  if (c.wantOther) {
    c.wantOther = false;
    return recordAnswer(c, [], text);
  }
  const r = matchAnswer(text, q);
  switch (r.kind) {
    case "cancel":
      c.cancelled = true;
      setPhase("turn", "Voice answer cancelled; answer on screen or tap the mic");
      say({ kind: "info", text: "Cancelled." });
      return;
    case "pick":
      return recordAnswer(
        c,
        r.selected.map((i) => q.options[i].label),
        r.custom,
      );
    case "other":
      c.wantOther = true;
      setPhase("speaking");
      say({ kind: "prompt", text: "Okay. What is your answer?" });
      return;
    default: {
      c.tries++;
      if (c.tries >= 3) {
        setPhase("turn", "Couldn't match an option; answer on screen or tap the mic");
        say({ kind: "info", text: "Sorry, I couldn't match that. Please answer on screen." });
        return;
      }
      const lead = r.kind === "ambiguous" ? "That could be more than one option." : "Sorry, I didn't catch which option.";
      setPhase("speaking");
      say({ kind: "prompt", text: `${lead} ${optionsSpeech(q)}` });
    }
  }
}

function recordAnswer(c: AskCtx, selected: string[], custom?: string) {
  c.answers[c.qi] = { selected, custom };
  c.tries = 0;
  ensureSheet(c);
  sheet?.applyVoice(c.qi, selected, custom);
  c.qi++;
  if (c.qi < c.ask.questions.length) {
    const q = c.ask.questions[c.qi];
    setPhase("speaking");
    say({ kind: "prompt", text: `Question ${spokenIndex(c.qi)} of ${spokenIndex(c.ask.questions.length - 1)}. ${plain(q.question)}. ${optionsSpeech(q)}` });
    return;
  }
  confirmText = `Picked ${c.answers.map((a) => answerSpeech(a)).join("; then ")}. Sending.`;
  setPhase("confirm");
  const u = say({ kind: "confirm", text: confirmText });
  phaseTimer = window.setTimeout(() => {
    if (phase === "confirm" && !u?.started) commitAsk();
  }, CONFIRM_WAIT_MS);
}

function answerSpeech(a: { selected: string[]; custom?: string }): string {
  const parts = a.selected.map(plain);
  if (a.custom) parts.push(`your answer: ${a.custom}`);
  return parts.join(" and ");
}

function ensureSheet(c: AskCtx) {
  if (sheet?.current?.ask.toolCallId === c.toolCallId && sheet.openFor) return;
  hooks.openAsk(c.target, c.ask);
  c.answers.forEach((a, i) => sheet?.applyVoice(i, a.selected, a.custom));
}

function commitAsk() {
  const c = askCtx;
  clearTimeout(phaseTimer);
  if (!c || phase !== "confirm") return;
  ensureSheet(c);
  if (sheet?.submitVoice()) {
    sentId = "";
    workStart = Date.now();
    setPhase("sending", "Answer sent");
  } else setPhase("turn", "Finish the answer on screen");
}

// ---------------------------------------------------------------- say + native events

function say(o: { kind: UttKind; target?: string; entryId?: string; text?: string; voice?: string }): Utt | null {
  const req = `v${Date.now().toString(36)}${(++reqSeq).toString(36)}`;
  const target = o.target ?? state.target;
  const msg: Msg = { t: "say", req, target, voice: o.voice ?? settings.voice, speed: settings.speed };
  if (o.entryId) msg.entryId = o.entryId;
  if (o.text) msg.text = o.text;
  if (!send(msg)) {
    toast("Offline: cannot reach the PC for speech", "err");
    if (o.kind === "confirm") window.setTimeout(commitAsk, 0);
    else if (o.kind === "prompt" && isActive()) window.setTimeout(listen, 0);
    return null;
  }
  const u: Utt = { kind: o.kind, key: req, req, entryId: o.entryId, target, sentences: [], cur: 0, started: false, timer: 0 };
  u.timer = window.setTimeout(() => {
    if (!reqs.has(req) || u.started) return;
    reqs.delete(req);
    sayChanged();
    toast("No audio from the PC", "err");
    uttDone(u, "error");
  }, SAY_TIMEOUT_MS);
  reqs.set(req, u);
  sayChanged();
  return u;
}

function serverKey(m: { auto?: boolean; target?: string; entryId?: string }): string {
  return m.auto ? `auto:${m.target ?? ""}:${m.entryId ?? ""}` : `ask:${m.target ?? ""}`;
}

/** Finds (or creates for auto/ask) the utterance an `audio`/`tts` message belongs to. */
function uttFor(m: { req?: string; auto?: boolean; ask?: boolean; target?: string; entryId?: string }, create: boolean): Utt | null {
  if (m.req) return reqs.get(m.req) ?? (current?.req === m.req ? current : null);
  if (!m.auto && !m.ask) return current;
  const key = serverKey(m);
  if (current?.key === key) return current;
  let u = incoming.get(key) ?? null;
  if (!u && create) {
    u = { kind: m.auto ? "auto" : "ask", key, entryId: m.entryId, target: m.target, sentences: [], cur: 0, started: false, timer: 0 };
    incoming.set(key, u);
  }
  return u;
}

export function onAudio(m: AudioMsg) {
  const u = uttFor(m, m.seq === 0);
  if (!u) return;
  if (m.text) u.sentences[m.seq] = m.text;
  if (u === current) render();
}

export function onTts(m: TtsMsg) {
  if (m.phase === "start" || m.phase === "chunk") {
    const u = uttFor(m, true);
    if (!u) return;
    if (m.text && m.seq != null) u.sentences[m.seq] = m.text;
    u.cur = m.seq ?? u.cur;
    if (m.phase === "start" || !u.started) {
      clearTimeout(u.timer);
      if (u.req) reqs.delete(u.req);
      incoming.delete(u.key);
      if (isActive() && phase === "listening" && (u.kind === "auto" || u.kind === "ask")) {
        // You started talking first: the reply waits (play it from the chat).
        bridge.stopSpeaking();
        sayChanged();
        return;
      }
      u.started = true;
      current = u;
      sayChanged();
      if (u.kind === "ask" && askCtx) askCtx.spoken = true;
      if (isActive()) {
        if (u.kind === "confirm") setPhase("confirm");
        else if (u.kind !== "sample" && u.kind !== "info") setPhase("speaking");
      }
    }
    render();
    return;
  }
  const u = current && (!m.req || m.req === current.req) ? current : uttFor(m, false);
  if (!u) return;
  if (m.phase === "error") toast(`Playback failed${m.error ? `: ${m.error}` : ""}`, "err");
  uttDone(u, m.phase);
}

export function onVoiceError(m: VoiceErrorMsg) {
  toast(`Voice: ${m.error}`, "err");
  const u = m.req ? (reqs.get(m.req) ?? null) : m.auto || m.ask ? uttFor(m, false) : null;
  // A reading already playing ends through the player (tts end/error once its queued sentences are done).
  if (u && u === current) return;
  if (u) {
    clearTimeout(u.timer);
    uttDone(u, "error");
  } else if (isActive() && m.auto && phase === "reply") afterReply();
  else if (isActive() && m.ask && askCtx && !askCtx.spoken && phase === "turn") askListen();
}

/** Stops listening without sending what was heard (another reading is about to start). */
function quietMic() {
  if (phase !== "listening") return;
  setPhase("turn");
  bridge.stopListening();
}

function uttDone(u: Utt, how: string) {
  if (current === u) current = null;
  if (u.req) reqs.delete(u.req);
  incoming.delete(u.key);
  sayChanged();
  if (!isActive()) return;
  if (how === "stopped") {
    if (phase === "speaking") setPhase(restingPhase());
    else if (phase === "confirm") commitAsk();
    return;
  }
  switch (u.kind) {
    case "auto":
      if (phase === "speaking" || phase === "reply") afterReply();
      return;
    case "ask":
    case "prompt":
      if (askCtx && !askCtx.cancelled && (phase === "speaking" || phase === "turn")) askListen();
      else if (phase === "speaking") setPhase(restingPhase());
      return;
    case "confirm":
      return commitAsk();
    case "info":
      return render();
    default:
      if (phase === "speaking") setPhase(restingPhase());
  }
}

export function onStt(m: SttMsg) {
  if (m.phase === "rms") {
    const v = Math.max(0, Math.min(1, ((m.rms ?? -2) + 2) / 12));
    document.documentElement.style.setProperty("--vlvl", v.toFixed(2));
    return;
  }
  if (phase !== "listening") return;
  switch (m.phase) {
    case "ready":
      voicePanel.classList.add("hearing");
      return;
    case "partial":
      partial = m.text ?? "";
      renderStage();
      renderAskStrip();
      return;
    case "final":
      document.documentElement.style.setProperty("--vlvl", "0");
      return onFinal(m.text ?? "");
    case "error":
      document.documentElement.style.setProperty("--vlvl", "0");
      if (m.error === "permission") toast("Microphone permission is needed for voice mode", "err");
      return setPhase("turn", sttError(m.error));
    case "end":
      document.documentElement.style.setProperty("--vlvl", "0");
      return setPhase("turn");
  }
}

function sttError(e = ""): string {
  switch (e) {
    case "no-match":
    case "speech-timeout":
      return "Didn't catch that";
    case "permission":
      return "Microphone permission denied";
    case "network":
    case "network-timeout":
    case "server":
    case "server-disconnected":
      return "Speech recognition needs the network for this language";
    case "language":
    case "unavailable":
      return "This recognition language is not available on the phone";
    case "busy":
      return "The recognizer is busy; try again";
    default:
      return e ? `Recognition error: ${e}` : "Recognition stopped";
  }
}

// ---------------------------------------------------------------- render

function render() {
  if (!isActive()) return;
  voicePanel.dataset.phase = phase;
  if (phase !== "listening") voicePanel.classList.remove("hearing");
  chipEl.textContent = "";
  chipEl.append(h("span.v-dot"), h("span", { text: askCtx && (phase === "listening" || phase === "turn") ? "Answer by voice" : PHASE_LABEL[phase] }));
  auxEl.textContent = phase === "working" || phase === "reply" || phase === "sending" ? fmtElapsed(Date.now() - workStart) : "";
  micBtn.setAttribute("aria-label", phase === "listening" ? "Stop listening" : phase === "speaking" ? "Interrupt and talk" : "Talk");
  sideL.textContent = "";
  sideR.textContent = "";
  if (phase === "speaking" || phase === "confirm")
    sideR.append(h("button.v-pill", { onclick: () => stopTap() }, h("span.icw", { html: icon("stop") }), h("span", { text: phase === "confirm" ? "Send now" : "Stop" })));
  else if (phase === "listening") sideR.append(h("button.v-pill", { onclick: () => bridge.stopListening() }, h("span", { text: "Done" })));
  if (askCtx && phase !== "sending") sideL.append(h("button.v-pill.dim", { onclick: () => sheet && askCtx && hooks.openAsk(askCtx.target, askCtx.ask) }, h("span", { text: "Options" })));
  renderStage();
  renderAskStrip();
}

function renderStage() {
  const s = stageEl;
  s.textContent = "";
  const p = pane();
  const c = askCtx;
  const q = c ? c.ask.questions[Math.min(c.qi, c.ask.questions.length - 1)] : null;
  if (c && q && (phase === "listening" || phase === "turn")) {
    const n = c.ask.questions.length;
    s.append(
      h("div.v-ask", null, h("span.chip", { text: n > 1 ? `Question ${c.qi + 1} of ${n}` : "omp asks" }), h("div.v-ask-q", { text: plain(q.question.split("\n", 1)[0]) })),
    );
  }
  switch (phase) {
    case "listening":
      s.append(partial ? h("div.v-heard", { text: partial }) : h("div.v-hint", { text: c ? (c.wantOther ? "Say your answer" : "Say an option: \"two\", \"the second one\", its name, or \"other ...\"") : "Speak now" }));
      break;
    case "sending":
      if (heard) s.append(h("div.v-you", { text: heard }));
      s.append(h("div.v-hint", null, h("span.spin.xs"), h("span", { text: note || "Sending to the terminal..." })));
      break;
    case "working":
    case "reply":
      if (heard) s.append(h("div.v-you", { text: heard }));
      s.append(
        h(
          "div.v-work",
          null,
          h("span.v-wave", null, h("i"), h("i"), h("i"), h("i"), h("i")),
          h("span.v-work-l", { text: phase === "reply" ? "Preparing the spoken reply..." : p?.context || "Working" }),
        ),
      );
      break;
    case "speaking":
    case "confirm": {
      const u = current;
      if (phase === "confirm") s.append(h("div.v-confirm", null, h("span.icw", { html: icon("check") }), h("span", { text: confirmText })));
      else if (u && u.sentences.length) {
        const box = h("div.v-sents");
        u.sentences.forEach((t, i) => {
          if (t) box.append(h(`span.v-sent${i === u.cur ? ".cur" : i < u.cur ? ".past" : ""}`, { text: t + " " }));
        });
        s.append(box);
        requestAnimationFrame(() => box.querySelector(".cur")?.scrollIntoView({ block: "nearest" }));
      } else s.append(h("div.v-hint", null, h("span.spin.xs"), h("span", { text: "Getting the audio..." })));
      if (phase === "speaking") s.append(h("div.v-tap", { text: "Tap to stop" }));
      break;
    }
    default:
      s.append(h("div.v-turn", { text: note || (c ? "Tap the mic to answer" : "Tap the mic to talk") }));
      if (!note && !c && settings.autoListen) s.append(h("div.v-hint", { text: "After each reply I listen again" }));
  }
}

function renderAskStrip() {
  const c = askCtx;
  if (!sheet || !c || sheet.current?.ask.toolCallId !== c.toolCallId) return sheet?.setVoice(null);
  const n = c.ask.questions.length;
  const which = n > 1 ? ` (question ${Math.min(c.qi + 1, n)} of ${n})` : "";
  switch (phase) {
    case "listening":
      return sheet.setVoice({ phase, title: `Listening${which}`, text: partial || (c.wantOther ? "Say your answer" : "Say an option number or its name") });
    case "speaking":
      return sheet.setVoice({ phase, title: "Reading the options", text: current?.sentences[current.cur] ?? "" });
    case "confirm":
      return sheet.setVoice({ phase, title: confirmText, text: "Tap the mic to change it" });
    case "sending":
      return sheet.setVoice({ phase, title: "Answer sent" });
    default:
      return sheet.setVoice({ phase: "turn", title: note || "Tap the mic to answer by voice", text: heard && phase === "turn" ? `Heard: "${heard}"` : undefined });
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- settings sheet

function save() {
  lsSet(KEY, settings);
  syncWire();
}

export function openVoiceSettings() {
  const p = pane();
  const s = new Sheet("Voice", p?.agent ? paneTitle(p) : "Spoken replies and voice input", "voice-set");
  const body = h("div.vs");
  s.body.append(body);
  const samples = new Map<string, string>();
  const draw = () => {
    body.textContent = "";
    const grid = h("div.vs-voices");
    for (const v of VOICES) {
      const st = [...samples.entries()].find(([, id]) => id === v.id)?.[0];
      const status = st ? (current?.req === st ? "playing" : reqs.has(st) ? "loading" : "") : "";
      if (st && !status) samples.delete(st);
      const sample = h(
        `button.vs-sample${status ? "." + status : ""}`,
        { "aria-label": `Play a sample of ${v.name}` },
        status === "loading" ? h("span.spin.xs") : h("span.icw", { html: icon(status === "playing" ? "stop" : "play") }),
      );
      sample.addEventListener("click", (e) => {
        e.stopPropagation();
        if (status) return stopPlayback();
        quietMic();
        const u = say({ kind: "sample", text: `Hi, this is ${v.name}.`, voice: v.id, target: state.target });
        if (u?.req) samples.set(u.req, v.id);
        draw();
      });
      const card = h(
        `button.vs-voice${v.id === settings.voice ? ".sel" : ""}`,
        { "aria-pressed": String(v.id === settings.voice) },
        h("span.vs-vmain", null, h("span.vs-vname", { text: v.name }), h("span.vs-vdesc", { text: v.desc })),
        sample,
      );
      card.addEventListener("click", () => {
        settings.voice = v.id;
        save();
        draw();
      });
      grid.append(card);
    }
    body.append(h("div.ms-sec", { text: "Voice" }), grid);

    const speed = h("div.seg.ms-seg.vs-seg");
    for (const sp of SPEEDS) {
      const b = h(`button.seg-b${sp === settings.speed ? ".on" : ""}`, { text: `${sp}x`, "aria-pressed": String(sp === settings.speed) });
      b.addEventListener("click", () => {
        settings.speed = sp;
        save();
        draw();
      });
      speed.append(b);
    }
    body.append(h("div.ms-sec", { text: "Speed" }), speed);

    const lang = h("div.seg.ms-seg.vs-seg");
    for (const l of LANGS) {
      const b = h(`button.seg-b${l.id === settings.lang ? ".on" : ""}`, { text: l.label, "aria-pressed": String(l.id === settings.lang) });
      b.addEventListener("click", () => {
        settings.lang = l.id;
        save();
        draw();
      });
      lang.append(b);
    }
    body.append(h("div.ms-sec", { text: "Recognition language" }), lang);

    body.append(h("div.ms-sec", { text: "Voice mode" }));
    const toggle = (k: "autoRead" | "readAsks" | "autoListen" | "hint", ic: string, label: string, desc: string) => {
      const row = h(
        "button.ms-fast.vs-row",
        { role: "switch", "aria-checked": String(settings[k]) },
        h("span.icw", { html: icon(ic) }),
        h("span.ms-fast-l", null, h("span", { text: label }), h("span.ms-fast-d", { text: desc })),
        h(`span.switch${settings[k] ? ".on" : ""}`),
      );
      row.addEventListener("click", () => {
        settings[k] = !settings[k];
        save();
        draw();
      });
      body.append(row);
    };
    toggle("autoRead", "volume", "Read replies aloud", "Speak the agent's reply when its turn ends");
    toggle("readAsks", "list", "Read questions aloud", "Speak omp's questions and options, then listen");
    toggle("autoListen", "mic", "Listen again", "Start listening after each spoken reply");
    toggle("hint", "chat", "Ask for spoken-style replies", "Adds a short note asking for plain sentences, no tables or code");
  };
  draw();
  sayListeners.add(draw);
  s.onClose = () => sayListeners.delete(draw);
}
