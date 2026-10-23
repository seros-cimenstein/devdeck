// Live mode: a GPT Live realtime voice call. Audio runs natively (DD.liveStart / liveStop / liveMute) straight
// between the phone and OpenAI; the PC daemon signals the call, routes delegations and streams the call state,
// captions, delegations and notices (`live*` messages). This module renders the full-screen Live view and the
// top-bar entry / "Live" pill. Back closes the view; the call keeps running until End.
import { bridge, send } from "./bridge";
import { badgeEl, badgeKind, hooks, paneTitle, state } from "./state";
import type { LiveDelegationMsg, LiveLocalMsg, LiveMode, LiveMsg, LiveNoticeMsg, LivePhase, LiveTranscriptMsg, Pane } from "./types";
import { type Layer, pushLayer, removeLayer, Sheet, toast } from "./ui";
import { h, icon, lsGet, lsSet, reducedMotion } from "./util";
import { setEnabled as setVoiceMode, voiceEnabled } from "./voice";

// ---------------------------------------------------------------- settings

export const LIVE_VOICES = [
  { id: "arbor", name: "Arbor", desc: "Easygoing and versatile" },
  { id: "breeze", name: "Breeze", desc: "Animated and earnest" },
  { id: "cove", name: "Cove", desc: "Composed and direct" },
  { id: "ember", name: "Ember", desc: "Confident and optimistic" },
  { id: "juniper", name: "Juniper", desc: "Open and upbeat" },
  { id: "maple", name: "Maple", desc: "Cheerful and candid" },
  { id: "sol", name: "Sol", desc: "Savvy and relaxed" },
  { id: "spruce", name: "Spruce", desc: "Calm and affirming" },
  { id: "vale", name: "Vale", desc: "Bright and inquisitive" },
];

/** tmux session of the concierge omp; never offered as a direct-mode target. */
const CONCIERGE_SESSION = "devdeck-voice";
const KEY = "dd.live";
/** Captions, chips and notices kept in the view. */
const MAX_ITEMS = 160;

interface LiveSettings {
  voice: string;
  mode: LiveMode;
  /** Last direct-mode terminal. */
  target: string;
}
const settings: LiveSettings = { voice: "sol", mode: "concierge", target: "", ...lsGet<Partial<LiveSettings>>(KEY, {}) };
if (!LIVE_VOICES.some((v) => v.id === settings.voice)) settings.voice = "sol";
if (settings.mode !== "direct") settings.mode = "concierge";
const save = () => lsSet(KEY, settings);

// ---------------------------------------------------------------- call state

const call = {
  /** A call exists (connecting or connected). */
  active: false,
  /** Last server phase of this call; null until the daemon reports one. */
  server: null as LivePhase | null,
  /** Native connection reached the media stage. */
  connected: false,
  /** Terminal state shown after the call: "" while active. */
  end: "" as "" | "ended" | "error",
  error: "",
  callId: "",
  mode: settings.mode as LiveMode,
  target: "",
  voice: settings.voice,
  muted: false,
  route: "",
  startedAt: 0,
  connectedAt: 0,
  endedAt: 0,
  /** Delegation currently in flight (drives the "working" hint). */
  working: null as LiveDelegationMsg | null,
};

type Phase = LivePhase;
const phase = (): Phase => (call.end ? call.end : call.server && call.server !== "ended" && call.server !== "error" ? call.server : call.connected ? "listening" : "connecting");

const PHASE_LABEL: Record<Phase, string> = {
  connecting: "Connecting",
  listening: "Listening",
  working: "Working on it",
  speaking: "Speaking",
  ended: "Call ended",
  error: "Call failed",
};

const ERRORS: Record<string, string> = {
  permission: "Microphone permission is needed for Live",
  offline: "No link to your PC",
};

let onStatus: () => void = () => {};
let viewOpen = false;
let tick = 0;

// ---------------------------------------------------------------- view DOM

const orbHalo = h("div.lv-halo");
const orbRing = h("div.lv-ring");
const orbCore = h("div.lv-core", null, h("div.lv-sheen"));
const orb = h("div.lv-orb", { "aria-hidden": "true" }, orbHalo, orbRing, orbCore);
const phaseEl = h("div.lv-phase", { "aria-live": "polite" });
const hintEl = h("div.lv-hint");
const titleSub = h("div.lv-sub");
const voiceBtn = h("button.lv-voice", { "aria-label": "Voice" }) as HTMLButtonElement;
const modeBtn = h("button.lv-mode", { "aria-label": "Who you are talking to" }) as HTMLButtonElement;
const items = h("div.lv-items");
const emptyEl = h("div.lv-empty");
const log = h("div.lv-log", null, emptyEl, items);
const ctl = h("div.lv-ctl");
const viewEl = h(
  "div.live",
  { hidden: true, role: "dialog", "aria-label": "Live" },
  h(
    "div.lv-head",
    null,
    h("button.ib", { "aria-label": "Back (the call keeps running)", html: icon("chevDown"), onclick: () => closeView() }),
    h("div.lv-titles", null, h("div.lv-title", { text: "Live" }), titleSub),
    voiceBtn,
  ),
  h("div.lv-moderow", null, modeBtn),
  h("div.lv-stage", null, orb, phaseEl, hintEl),
  log,
  ctl,
);
voiceBtn.addEventListener("click", () => openVoicePicker());
modeBtn.addEventListener("click", () => openModePicker());
log.addEventListener("scroll", () => {
  stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
});
let stick = true;

const viewLayer: Layer = { close: () => closeView() };

/** Transcript bubbles by role+turn, delegation chips by id. */
const bubbles = new Map<string, { el: HTMLElement; text: HTMLElement }>();
const chips = new Map<string, HTMLElement>();

// ---------------------------------------------------------------- public API

export function initLive(o: { onStatus: () => void }) {
  document.getElementById("app")!.append(viewEl);
  onStatus = o.onStatus;
}

/** For the top bar: whether a call runs (pill) and its elapsed time. */
export function liveStatus(): { active: boolean; phase: Phase; elapsed: string; muted: boolean } {
  return { active: call.active, phase: phase(), elapsed: call.connectedAt ? fmtElapsed(Date.now() - call.connectedAt) : "", muted: call.muted };
}

/** Top-bar entry: returns to a running call, else starts one. */
export function liveEntry() {
  if (call.active) openView();
  else startCall();
}

/** Pane list changed: names in the mode chip / picker and notice badges. */
export function liveSync() {
  if (viewOpen) renderChrome();
}

// ---------------------------------------------------------------- start / stop

function startCall() {
  if (!bridge.hasLive()) return toast("Live needs the updated DevDeck+ app", "err");
  if (state.link?.state !== "online") return toast("Offline: Live needs the link to your PC", "err");
  let mode = settings.mode;
  let target = mode === "direct" ? settings.target : "";
  if (mode === "direct" && !directTargets().some((p) => p.target === target)) {
    mode = "concierge";
    target = "";
    if (settings.mode === "direct") toast("That terminal is gone; talking to the concierge");
  }
  if (voiceEnabled()) setVoiceMode(false);
  Object.assign(call, {
    active: true,
    server: null,
    connected: false,
    end: "",
    error: "",
    callId: "",
    mode,
    target,
    voice: settings.voice,
    muted: false,
    route: "",
    startedAt: Date.now(),
    connectedAt: 0,
    endedAt: 0,
    working: null,
  });
  clearLog();
  bridge.liveStart(target ? { voice: call.voice, mode, target } : { voice: call.voice, mode });
  openView();
  changed();
}

function endCall() {
  bridge.liveStop();
  finish("ended", "");
}

function finish(end: "ended" | "error", error: string) {
  if (!call.active && call.end) {
    // Already over; a later error explains a stop that looked clean.
    if (end === "error" && error && !call.error) Object.assign(call, { end, error });
    changed();
    return;
  }
  call.active = false;
  call.end = end;
  call.error = error;
  call.endedAt = Date.now();
  call.working = null;
  if (end === "error") bridge.haptic();
  changed();
}

function toggleMute() {
  if (!call.active) return;
  call.muted = !call.muted;
  bridge.liveMute(call.muted);
  bridge.haptic();
  changed();
}

function setMode(mode: LiveMode, target = "") {
  settings.mode = mode;
  if (mode === "direct") settings.target = target;
  save();
  if (!call.active) return changed();
  call.mode = mode;
  call.target = mode === "direct" ? target : "";
  if (!send(mode === "direct" ? { t: "live_mode", mode, target } : { t: "live_mode", mode })) toast("Offline: cannot switch now", "err");
  changed();
}

// ---------------------------------------------------------------- messages

/** Native call state, or levels when `mic` is present. */
export function onLiveLocal(m: LiveLocalMsg) {
  if (m.mic != null || m.spk != null) {
    lvMic = clampLevel(m.mic);
    lvSpk = clampLevel(m.spk);
    return;
  }
  if (m.callId && call.callId && m.callId !== call.callId && !m.active) return;
  if (m.callId) call.callId = m.callId;
  if (m.muted != null) call.muted = m.muted;
  if (m.route) call.route = m.route;
  if (m.active) {
    if (!call.active) reattach();
    if (m.phase === "connected" && !call.connected) {
      call.connected = true;
      call.connectedAt ||= Date.now();
    }
    return changed();
  }
  if (m.phase === "error") return finish("error", m.error ? ERRORS[m.error] || m.error : "The call failed");
  if (m.phase === "ended" || m.active === false) return finish("ended", "");
  changed();
}

/** Server call state. */
export function onLive(m: LiveMsg) {
  if (m.callId && call.callId && m.callId !== call.callId && (m.phase === "ended" || m.phase === "error")) return;
  if (m.callId) call.callId = m.callId;
  if (m.mode) {
    call.mode = m.mode;
    call.target = m.mode === "direct" ? m.target || "" : "";
    if (settings.mode !== m.mode || (m.mode === "direct" && m.target && settings.target !== m.target)) {
      settings.mode = m.mode;
      if (m.mode === "direct" && m.target) settings.target = m.target;
      save();
    }
  }
  if (m.phase === "ended") return finish("ended", "");
  if (m.phase === "error") return finish("error", m.error || "The call failed");
  if (!call.active) reattach();
  call.server = m.phase;
  if (m.phase !== "connecting") {
    call.connected = true;
    call.connectedAt ||= Date.now();
  }
  if (m.phase !== "working" && call.working?.state !== "sent") call.working = null;
  changed();
}

export function onLiveTranscript(m: LiveTranscriptMsg) {
  if (!call.active && !call.end) return;
  const key = `${m.role}:${m.turn}`;
  let b = bubbles.get(key);
  if (!b) {
    if (!m.text && !m.final) return;
    const text = h("div.lv-text");
    const el = h(`div.lv-b.lv-${m.role === "user" ? "user" : "asst"}`, null, text);
    b = { el, text };
    bubbles.set(key, b);
    addItem(el);
  }
  b.text.textContent = m.text;
  b.el.classList.toggle("partial", !m.final);
  if (m.final && !m.text.trim()) {
    b.el.remove();
    bubbles.delete(key);
  }
  afterItems();
}

export function onLiveDelegation(m: LiveDelegationMsg) {
  const st = m.state || "sent";
  if (st === "sent") call.working = m;
  else if (call.working?.id === m.id) call.working = null;
  let el = chips.get(m.id);
  if (!el) {
    el = h("button.lv-chip");
    el.addEventListener("click", () => el!.classList.toggle("open"));
    chips.set(m.id, el);
    addItem(el);
  }
  el.className = `lv-chip s-${st}${el.classList.contains("open") ? " open" : ""}`;
  el.textContent = "";
  const who = routeName(m.routedTo);
  const lead = st === "failed" ? `Could not reach ${who}` : st === "done" ? `${cap(who)} finished` : `Sent to ${who}`;
  el.append(
    h("span.lv-chip-ic", null, st === "sent" ? h("span.spin.xs") : h("span.icw", { html: icon(st === "done" ? "check" : "close") })),
    h("span.lv-chip-t", null, h("b", { text: lead + ": " }), m.text),
  );
  if (st === "failed" && m.error) el.append(h("span.lv-chip-err", { text: m.error }));
  afterItems();
  changed();
}

export function onLiveNotice(m: LiveNoticeMsg) {
  const p = state.byTarget.get(m.target);
  const asking = m.kind === "asking";
  const el = h(
    `button.lv-notice.k-${m.kind}`,
    null,
    h("span.lv-n-ic", null, asking ? h("span", { text: "?" }) : h("span.icw", { html: icon("check") })),
    h(
      "span.lv-n-main",
      null,
      h("span.lv-n-who", { text: `${p ? paneTitle(p) : m.target} ${asking ? "is asking" : "finished"}` }),
      // The spoken form leads with "<terminal> finished:" / "<terminal> is asking:"; the title line already says it.
      h("span.lv-n-text", { text: m.text.replace(/^[^:\n]{1,60}?\s(?:finished|is asking):\s*/, "") }),
    ),
    h("span.lv-n-go", { text: asking ? "Answer" : "Open" }),
  );
  el.addEventListener("click", () => {
    const cur = state.byTarget.get(m.target);
    if (asking && cur?.ask) return hooks.openAsk(m.target, cur.ask);
    closeView();
    hooks.open(m.target);
  });
  addItem(el);
  afterItems();
  if (!viewOpen && call.active) toast(`${p ? paneTitle(p) : m.target} ${asking ? "is asking" : "finished"}`);
}

function reattach() {
  Object.assign(call, { active: true, end: "", error: "", startedAt: call.startedAt || Date.now() });
  if (!tick) startTicker();
}

// ---------------------------------------------------------------- view

function openView() {
  if (!viewOpen) {
    viewOpen = true;
    viewEl.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => viewEl.classList.add("open")));
    pushLayer(viewLayer);
    stick = true;
  }
  render();
  scrollEnd();
  startOrb();
}

function closeView() {
  if (!viewOpen) return;
  viewOpen = false;
  removeLayer(viewLayer);
  viewEl.classList.remove("open");
  const done = () => {
    if (!viewOpen) viewEl.hidden = true;
  };
  viewEl.addEventListener("transitionend", done, { once: true });
  setTimeout(done, 400);
  onStatus();
}

function changed() {
  if (call.active && !tick) startTicker();
  if (!call.active && tick) {
    clearInterval(tick);
    tick = 0;
  }
  if (viewOpen) render();
  onStatus();
}

function startTicker() {
  tick = window.setInterval(() => {
    if (viewOpen) renderChrome();
    onStatus();
  }, 1000);
}

function render() {
  const ph = phase();
  viewEl.dataset.phase = ph;
  viewEl.classList.toggle("muted", call.muted && call.active);
  phaseEl.textContent = call.muted && call.active && ph === "listening" ? "Muted" : PHASE_LABEL[ph];
  hintEl.textContent = hint(ph);
  hintEl.classList.toggle("err", ph === "error");
  renderChrome();
  renderControls(ph);
  emptyEl.hidden = items.childElementCount > 0;
  emptyEl.textContent =
    ph === "connecting"
      ? ""
      : call.active
        ? call.mode === "direct"
          ? `Talk to ${targetName(call.target)} directly. Say "back to the concierge" to switch.`
          : "Ask about your terminals, hand off a coding task, or think out loud."
        : "";
}

function hint(ph: Phase): string {
  switch (ph) {
    case "connecting":
      return call.route === "bluetooth" ? "Using your headset" : "Setting up the call";
    case "listening":
      return call.muted ? "Tap Mute again to talk" : "Go ahead, I'm listening";
    case "working":
      return call.working ? `${cap(routeName(call.working.routedTo))} is on it` : "One moment";
    case "speaking":
      return "Talk anytime to interrupt";
    case "ended":
      return call.connectedAt && call.endedAt ? `Lasted ${fmtElapsed(call.endedAt - call.connectedAt)}` : "";
    case "error":
      return call.error;
  }
}

function renderChrome() {
  const v = LIVE_VOICES.find((x) => x.id === (call.active ? call.voice : settings.voice));
  voiceBtn.textContent = "";
  voiceBtn.append(h("span", { text: v?.name || "Voice" }), h("span.icw", { html: icon("chevDown") }));
  const bits = [call.active && call.connectedAt ? fmtElapsed(Date.now() - call.connectedAt) : "", call.active ? ROUTES[call.route] : ""];
  titleSub.textContent = bits.filter(Boolean).join(" · ") || (call.active ? "GPT Live" : "GPT Live voice chat");
  const mode = call.active ? call.mode : settings.mode;
  const target = call.active ? call.target : settings.target;
  modeBtn.textContent = "";
  modeBtn.classList.toggle("direct", mode === "direct");
  const p = state.byTarget.get(target);
  if (mode === "direct") modeBtn.append(p ? badgeEl(badgeKind(p)) : h("span.icw", { html: icon("term") }));
  else modeBtn.append(h("span.icw", { html: icon("headset") }));
  modeBtn.append(h("span.lv-mode-l", { text: mode === "direct" ? `Talking to ${targetName(target)}` : "Concierge" }), h("span.icw.lv-mode-c", { html: icon("chevDown") }));
}

function renderControls(ph: Phase) {
  ctl.textContent = "";
  if (call.active) {
    ctl.append(
      roundBtn(call.muted ? "micOff" : "mic", call.muted ? "Unmute" : "Mute", `lv-mute${call.muted ? ".on" : ""}`, toggleMute),
      roundBtn("hangup", "End", "lv-end", endCall),
    );
    return;
  }
  ctl.append(
    roundBtn("close", "Close", "lv-close", closeView),
    roundBtn(ph === "error" ? "refresh" : "wave", ph === "error" ? "Try again" : "Start again", "lv-again", startCall),
  );
}

function roundBtn(ic: string, label: string, cls: string, fn: () => void): HTMLElement {
  return h(`div.lv-rb.${cls}`, null, h("button.lv-rbb", { "aria-label": label, html: icon(ic), onclick: fn }), h("span.lv-rbl", { text: label }));
}

function clearLog() {
  items.textContent = "";
  bubbles.clear();
  chips.clear();
}

function addItem(el: HTMLElement) {
  items.append(el);
  while (items.childElementCount > MAX_ITEMS) {
    const first = items.firstElementChild as HTMLElement;
    for (const [k, b] of bubbles) if (b.el === first) bubbles.delete(k);
    for (const [k, c] of chips) if (c === first) chips.delete(k);
    first.remove();
  }
}

function afterItems() {
  if (!viewOpen) return;
  emptyEl.hidden = items.childElementCount > 0;
  scrollEnd();
}

function scrollEnd() {
  if (stick) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
}

// ---------------------------------------------------------------- orb

let lvMic = 0;
let lvSpk = 0;
let lvShown = 0;
let orbRaf = 0;

/** Levels are 0..1 over -60..0 dBFS; room noise sits near the bottom, speech around .5-.7. */
function clampLevel(x: number | undefined): number {
  return Math.max(0, Math.min(1, ((x ?? 0) - 0.3) / 0.5));
}

function startOrb() {
  if (orbRaf) return;
  const step = () => {
    orbRaf = 0;
    if (!viewOpen || document.hidden) return;
    const ph = phase();
    const want = !call.active ? 0 : ph === "speaking" ? lvSpk : ph === "listening" && !call.muted ? lvMic : Math.max(lvSpk, call.muted ? 0 : lvMic) * 0.5;
    lvShown += (want - lvShown) * (want > lvShown ? 0.35 : 0.12);
    orb.style.setProperty("--lv", lvShown.toFixed(3));
    if (!reducedMotion()) orbRaf = requestAnimationFrame(step);
  };
  orbRaf = requestAnimationFrame(step);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && viewOpen) startOrb();
});

// ---------------------------------------------------------------- pickers

function openVoicePicker() {
  const s = new Sheet("Voice", call.active ? "A new voice applies from the next call" : "GPT Live voice for your calls", "lv-voices");
  const grid = h("div.vs-voices");
  const draw = () => {
    grid.textContent = "";
    for (const v of LIVE_VOICES) {
      const sel = v.id === settings.voice;
      const card = h(
        `button.vs-voice${sel ? ".sel" : ""}`,
        { "aria-pressed": String(sel) },
        h("span.vs-vmain", null, h("span.vs-vname", { text: v.name }), h("span.vs-vdesc", { text: v.desc })),
        call.active && v.id === call.voice ? h("span.tag.live", { text: "Now" }) : null,
      );
      card.addEventListener("click", () => {
        settings.voice = v.id;
        save();
        draw();
        renderChrome();
        if (!call.active) setTimeout(() => s.close(), 160);
      });
      grid.append(card);
    }
  };
  draw();
  s.body.append(h("div.vs", null, grid));
}

function directTargets(): Pane[] {
  return state.panes.filter((p) => p.agent && p.session !== CONCIERGE_SESSION);
}

function openModePicker() {
  const s = new Sheet("Talk to", call.active ? "Switches the live call" : "For your next call", "lv-modes");
  const mode = call.active ? call.mode : settings.mode;
  const target = call.active ? call.target : settings.target;
  const list = h("div.lv-picks");
  const row = (sel: boolean, lead: HTMLElement, name: string, sub: string, fn: () => void) => {
    const b = h(`button.ms-row${sel ? ".sel" : ""}`, null, lead, h("span.ms-main", null, h("span.ms-name", { text: name }), h("span.ms-id", { text: sub })), sel ? h("span.ms-cur", { text: "Now" }) : null);
    b.addEventListener("click", () => {
      fn();
      s.close();
    });
    list.append(b);
  };
  row(mode === "concierge", h("span.icw.lv-pick-ic", { html: icon("headset") }), "Concierge", "Quick assistant that knows all your terminals", () => setMode("concierge"));
  const panes = directTargets();
  list.append(h("div.ms-sec", { text: "Or a coding agent directly" }));
  if (!panes.length) list.append(h("div.lv-none", { text: "No agent terminals are open" }));
  for (const p of panes) row(mode === "direct" && target === p.target, badgeEl(badgeKind(p)), paneTitle(p), p.context || p.cwd || p.target, () => setMode("direct", p.target));
  s.body.append(list);
}

// ---------------------------------------------------------------- names

function targetName(t: string): string {
  const p = state.byTarget.get(t);
  return p ? paneTitle(p) : t ? t.replace(/:.*$/, "") : "a terminal";
}

function routeName(t: string): string {
  if (!t || t === "concierge" || t.startsWith(CONCIERGE_SESSION + ":")) return "the concierge";
  return targetName(t);
}

const ROUTES: Record<string, string> = { bluetooth: "Headset", wired: "Wired", earpiece: "Earpiece", speaker: "Speaker" };

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
