// DevDeck WebView UI entry: wires the bridge, state and views.
import { AskSheet } from "./ask";
import { btwResync, onBtwDelta, onBtwRecord } from "./btw";
import { bridge, send, settle } from "./bridge";
import { ChatView } from "./chat";
import { Compose } from "./compose";
import { ControlStrip, openSessionMenu } from "./controls";
import { diagramSvg, openDiagram } from "./diagram";
import { Drawer } from "./drawer";
import { FilesPanel, findRepo, openFileViewer } from "./files";
import { openGit } from "./git";
import { initLive, liveEntry, liveStatus, liveSync, onLive, onLiveDelegation, onLiveLocal, onLiveNotice, onLiveTranscript } from "./live";
import { refreshModels } from "./omp";
import { outboxAck, outboxReconcile, sendText } from "./outbox";
import { PagePanel } from "./page";
import { initPlanReview, openPlanReview, planOpenFor, planSync } from "./plan";
import { openSettings } from "./settings";
import { openOmpUpdate } from "./sheets";
import { onSketchChange, onSketchEvent, openSketch, sketchLink, sketchOpenFor } from "./sketch";
import { currentPane, hooks, state, type View } from "./state";
import { TermView } from "./term";
import { TopBar } from "./topbar";
import { onUsagePush, openUsage } from "./usage";
import type {
  AckMsg,
  AudioMsg,
  BtwDeltaMsg,
  BtwRecordMsg,
  LinkMsg,
  LiveDelegationMsg,
  LiveLocalMsg,
  LiveMsg,
  LiveNoticeMsg,
  LiveTranscriptMsg,
  Msg,
  Pane,
  ScreenMsg,
  SessionsMsg,
  SketchEventMsg,
  SttMsg,
  TranscriptMsg,
  TtsMsg,
  UsageMsg,
  VoiceErrorMsg,
} from "./types";
import { openMenu, popLayer, toast } from "./ui";
import { fmtRtt, h, icon, learnHome, lsGet, lsSet } from "./util";
import { initVoice, onAudio, onStt, onTts, onVoiceError, openVoiceSettings, voiceOnline, voicePanel, voiceSync } from "./voice";

const app = document.getElementById("app")!;
const viewPref = lsGet<Record<string, View>>("dd.views", {});
let watchSent = false;
let lastLinkState = "";
let pickTimer = 0;

const top = new TopBar({
  drawer: () => drawer.open(),
  toggleView: () => state.target && openTarget(state.target, state.view === "chat" ? "term" : "chat"),
  more: (anchor) => openMoreMenu(anchor),
  linkInfo: () => {
    const l = state.link;
    if (!l) return toast("No link status yet");
    const parts = [l.state, l.host, fmtRtt(l.rtt) && `rtt ${fmtRtt(l.rtt)}`, l.queued ? `${l.queued} queued` : ""];
    toast(parts.filter(Boolean).join(" · "));
  },
  sessionMenu: (anchor) => openSessionMenu(anchor),
  live: () => liveEntry(),
});
const strip = new ControlStrip();
const chat = new ChatView();
const term = new TermView();
const compose = new Compose((target, text, enter) => {
  sendText(target, text, enter);
  if (state.view === "chat") chat.scrollToBottom(true);
});
const askBanner = h("div.ask-banner", { hidden: true });
const pageBanner = h("div.ask-banner.page-banner", { hidden: true });
const sketchBanner = h("div.ask-banner.sketch-banner", { hidden: true });
const planBanner = h("div.ask-banner.plan-banner", { hidden: true });
const main = h("main.main", null, chat.wrap, term.wrap);
app.append(top.el, strip.el, main, pageBanner, sketchBanner, planBanner, askBanner, voicePanel, compose.el);
const page = new PagePanel();
page.onChange = () => updatePageBanner();
const drawer = new Drawer(
  (t) => openTarget(t),
  () => newTerminal(),
);
const ask = new AskSheet();
ask.onChange = () => updateAskBanner();
initVoice({
  ask,
  onActive: (on) => {
    compose.el.hidden = on;
  },
  onSent: () => chat.scrollToBottom(true),
});
initLive({ onStatus: () => top.setLive(liveStatus()) });
onSketchChange(() => updateSketchBanner());
initPlanReview(() => updatePlanBanner());

hooks.open = (t, v) => openTarget(t, v);
hooks.openAsk = (t, a) => {
  if (t !== state.target) openTarget(t);
  ask.open(t, a);
};
hooks.openFiles = (p) => new FilesPanel(p || currentPane()?.cwd || "~");
hooks.openGit = (p) => openGit(p);
hooks.openFile = (p) => openFileViewer(p);
hooks.setDraft = (t, text) => compose.putDraft(t, text);

// ---------------------------------------------------------------- navigation

function openTarget(target: string, view?: View) {
  clearTimeout(pickTimer);
  const p = state.byTarget.get(target);
  let v: View = view ?? viewPref[target] ?? (p && !p.agent ? "term" : "chat");
  if (p && !p.agent) v = "term";
  const changed = target !== state.target || v !== state.view;
  if (state.view === "chat" && v !== "chat") chat.suspend();
  if (state.view === "term" && v !== "term") term.suspend();
  state.target = target;
  state.view = v;
  lsSet("dd.last", target);
  if (p?.agent || view) {
    viewPref[target] = v;
    lsSet("dd.views", viewPref);
  }
  if (state.done.delete(target)) lsSet("dd.done", [...state.done]);
  main.className = `main view-${v}`;
  if (v === "chat") chat.setTarget(target);
  else term.setTarget(target);
  chat.updateStatus();
  compose.setTarget(target);
  voiceSync();
  if (changed || !watchSent) watchSent = send({ t: "watch", target, view: v });
  top.update();
  strip.update();
  syncPage();
  drawer.render();
  updateAttention();
  maybeAutoAsk();
  updateAskBanner();
  updateSketchBanner();
  planSync(target);
  updatePlanBanner();
}

function newTerminal() {
  if (!send({ t: "new" })) toast("Offline: cannot create a terminal", "err");
  else toast("Creating terminal...");
}

function openMoreMenu(anchor: HTMLElement) {
  const p = currentPane();
  const l = state.link;
  openMenu(anchor, [
    { label: "Files", icon: "folder", act: () => hooks.openFiles(p?.cwd) },
    {
      label: "Git",
      icon: "git",
      disabled: !p?.cwd,
      act: () => {
        const cwd = p?.cwd;
        if (!cwd) return;
        void findRepo(cwd).then((r) => (r ? openGit(r) : toast("Not inside a git repository")));
      },
    },
    ...(p?.agent
      ? [
          { label: state.view === "chat" ? "Terminal view" : "Chat view", icon: state.view === "chat" ? "term" : "chat", act: () => openTarget(p.target, state.view === "chat" ? "term" : "chat") },
          { label: "Sketch", icon: "edit", act: () => openSketch(p.target) },
        ]
      : []),
    { label: "Keep screen awake", icon: "sun", toggle: true, on: !!l?.wakelock, act: () => bridge.setWakelock(!l?.wakelock) },
    { label: "Notifications", icon: "bell", toggle: true, on: !!l?.notify, act: () => bridge.setNotify(!l?.notify) },
    { label: "Resync", icon: "refresh", act: () => (send({ t: "resync" }) ? toast("Resyncing") : toast("Offline", "err")) },
    { label: "Voice settings", icon: "headset", act: openVoiceSettings },
    { label: "New terminal", icon: "plus", act: newTerminal },
    { label: "omp settings", icon: "sliders", act: openSettings },
    { label: "Usage limits", icon: "gauge", act: openUsage },
    { label: "Update omp", icon: "refresh", act: openOmpUpdate },
  ]);
}

// ---------------------------------------------------------------- server/shell messages

function onSessions(list: Pane[]) {
  const prev = state.byTarget;
  const byTarget = new Map<string, Pane>();
  let doneChanged = false;
  for (const p of list) {
    byTarget.set(p.target, p);
    if (p.cwd) learnHome(p.cwd);
    if (!p.agent) {
      if (state.done.delete(p.target)) doneChanged = true;
      continue;
    }
    const was = prev.get(p.target)?.state;
    if (p.state === "working" || p.state === "asking") {
      if (state.done.delete(p.target)) doneChanged = true;
    } else if ((was === "working" || was === "asking") && p.state === "idle" && (p.target !== state.target || document.hidden)) {
      state.done.add(p.target);
      doneChanged = true;
    }
  }
  for (const t of state.done) {
    if (!byTarget.has(t)) {
      state.done.delete(t);
      doneChanged = true;
    }
  }
  if (doneChanged) lsSet("dd.done", [...state.done]);
  state.panes = list;
  state.byTarget = byTarget;

  const cur = byTarget.get(state.target);
  if (cur && !cur.agent && state.view === "chat") openTarget(cur.target, "term");
  if (!state.target) {
    // The shell replays `open` right after `sessions` on ready; give it a moment before picking.
    clearTimeout(pickTimer);
    pickTimer = window.setTimeout(() => {
      if (state.target || !state.panes.length) return;
      const last = lsGet<string>("dd.last", "");
      const pick = byTarget.get(last) ?? state.panes.find((p) => p.agent) ?? state.panes[0];
      openTarget(pick.target);
    }, 400);
  }
  top.update();
  strip.update();
  compose.refresh();
  syncPage();
  drawer.render();
  chat.updateStatus();
  ask.sync();
  voiceSync();
  liveSync();
  updateAttention();
  maybeAutoAsk();
  updateAskBanner();
  updateSketchBanner();
  planSync(state.target);
  updatePlanBanner();
}

function updateAttention() {
  top.setAttention(state.panes.some((p) => p.target !== state.target && (p.state === "asking" || !!p.sketch || state.done.has(p.target))));
}

function maybeAutoAsk() {
  const p = currentPane();
  if (!p?.ask || ask.dismissed.has(p.ask.toolCallId) || ask.openFor === p.ask.toolCallId) return;
  ask.open(p.target, p.ask);
}

function syncPage() {
  const p = currentPane();
  // A pending plan review is answered in the native sheet, not in omp's mirrored overlay.
  if (state.view === "chat" && p?.agent) page.sync(p.target, p.planReview ? null : p.omp?.page);
  else page.reset();
  updatePageBanner();
}

function updatePageBanner() {
  const p = currentPane();
  const pg = p?.omp?.page;
  const show = !!pg && !p?.planReview && state.view === "chat" && page.hiddenFor === p?.target && !page.isOpen;
  pageBanner.hidden = !show;
  if (!show) return;
  pageBanner.textContent = "";
  pageBanner.append(
    h("span.ab-badge", { html: icon("term") }),
    h("span.ab-text", { text: `omp page open: ${pg?.title || "page"}` }),
    h("button.btn.primary.sm", { text: "Show", onclick: () => page.show() }),
  );
}

function updateAskBanner() {
  const p = currentPane();
  const show = !!p?.ask && ask.openFor !== p.ask.toolCallId;
  askBanner.hidden = !show;
  if (!show || !p?.ask) return;
  const a = p.ask;
  const q = a.questions[0];
  askBanner.textContent = "";
  askBanner.append(
    h("span.ab-badge", { text: "?" }),
    h("span.ab-text", { text: q ? q.question.split("\n", 1)[0] : "The agent is asking" }),
    h("button.btn.primary.sm", { text: "Answer", onclick: () => ask.open(p.target, a) }),
  );
}

function updateSketchBanner() {
  const p = currentPane();
  const req = p?.sketch;
  const show = !!req && sketchOpenFor() !== p?.target;
  sketchBanner.hidden = !show;
  if (!show || !p || !req) return;
  sketchBanner.textContent = "";
  sketchBanner.append(
    h("span.ab-badge", { html: icon("edit") }),
    h("span.ab-text", { text: req.prompt.split("\n", 1)[0] || "The agent asks for a sketch" }),
    h("button.btn.primary.sm", { text: "Draw", onclick: () => openSketch(p.target) }),
  );
}

function updatePlanBanner() {
  const p = currentPane();
  const r = p?.planReview;
  const show = !!r && state.view === "chat" && planOpenFor() !== r.id;
  planBanner.hidden = !show;
  if (!show || !p || !r) return;
  planBanner.replaceChildren(
    h("span.ab-badge", { html: icon("plan") }),
    h("span.ab-text", { text: `Plan ready for review: ${r.title || "plan"}` }),
    h("button.btn.primary.sm", { text: "Review", onclick: () => openPlanReview(p.target, r) }),
  );
}

function onLink(l: LinkMsg) {
  state.link = l;
  top.setLink(l);
  if (l.state === "online" && lastLinkState !== "online" && state.target && !watchSent) {
    watchSent = send({ t: "watch", target: state.target, view: state.view });
  }
  if (l.state === "online" && lastLinkState !== "online") {
    refreshModels().catch(() => {});
    voiceOnline();
    sketchLink(true);
    btwResync();
  } else if (l.state !== "online" && lastLinkState === "online") {
    sketchLink(false);
  }
  lastLinkState = l.state;
  if (l.state === "online") outboxReconcile(l.queued ?? 0);
  strip.update();
  compose.refresh();
  drawer.render();
}

function onAck(m: AckMsg) {
  if (ask.onAck(m)) return;
  if (outboxAck(m)) return;
  if (!m.ok && m.error) toast(m.error, "err");
}

/** One message from the shell: server traffic plus local link/toast/open/back. Types per contract. */
function receive(m: Msg) {
  switch (m.t) {
    case "link":
      return onLink(m as unknown as LinkMsg);
    case "sessions":
      return onSessions((m as unknown as SessionsMsg).list || []);
    case "transcript": {
      if (settle(m)) return;
      const tm = m as unknown as TranscriptMsg;
      if (state.view === "chat" && tm.target === state.target) chat.onTranscript(tm);
      return;
    }
    case "screen": {
      const sm = m as unknown as ScreenMsg;
      if (sm.page != null) {
        // omp's plan review overlay is answered in the native sheet instead.
        const native = sm.page !== false && !!state.byTarget.get(sm.target)?.planReview;
        if (state.view === "chat" && sm.target === state.target && !native) page.onScreen(sm);
        return;
      }
      if (state.view === "term" && sm.target === state.target) term.onScreen(sm);
      return;
    }
    case "ack":
      return onAck(m as unknown as AckMsg);
    case "created":
      if (typeof m.target === "string") openTarget(m.target, m.view === "chat" ? "chat" : "term");
      return;
    case "open":
      if (typeof m.target === "string") openTarget(m.target);
      return;
    case "toast":
      toast(String(m.text ?? ""));
      return;
    case "back":
      bridge.backResult(popLayer());
      return;
    case "error":
      if (settle(m)) return;
      toast(String(m.error || "Error"), "err");
      return;
    case "audio":
      return onAudio(m as unknown as AudioMsg);
    case "tts":
      return onTts(m as unknown as TtsMsg);
    case "stt":
      return onStt(m as unknown as SttMsg);
    case "voice_error":
      return onVoiceError(m as unknown as VoiceErrorMsg);
    case "live":
      return onLive(m as unknown as LiveMsg);
    case "live_local":
      return onLiveLocal(m as unknown as LiveLocalMsg);
    case "live_transcript":
      return onLiveTranscript(m as unknown as LiveTranscriptMsg);
    case "live_delegation":
      return onLiveDelegation(m as unknown as LiveDelegationMsg);
    case "live_notice":
      return onLiveNotice(m as unknown as LiveNoticeMsg);
    case "sketch_event":
      return onSketchEvent(m as unknown as SketchEventMsg);
    case "btw_delta":
      return onBtwDelta(m as unknown as BtwDeltaMsg);
    case "btw_record":
      return onBtwRecord(m as unknown as BtwRecordMsg);
    case "usage":
      if (settle(m)) return;
      return onUsagePush(m as unknown as UsageMsg);
    case "pong":
      return;
    default:
      settle(m);
  }
}

// ---------------------------------------------------------------- global behaviour

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const a = t.closest<HTMLAnchorElement>("a[href]");
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) bridge.openUrl(href);
    return;
  }
  const copy = t.closest<HTMLElement>("[data-act=copy]");
  if (copy) {
    const code = copy.closest(".code")?.querySelector("code")?.textContent ?? "";
    bridge.copyText(code);
    copy.classList.add("done");
    copy.querySelector("span")!.textContent = "Copied";
    setTimeout(() => {
      copy.classList.remove("done");
      copy.querySelector("span")!.textContent = "Copy";
    }, 1400);
    return;
  }
  const dg = t.closest<HTMLElement>(".diagram");
  if (dg && diagramSvg(dg)) openDiagram(dg);
});

main.className = `main view-${state.view}`;
top.update();
compose.setTarget("");
document.title = "DevDeck";

const w: Window & { dd?: { receive(json: string | Msg): void } } = window;
w.dd = {
  receive(json) {
    let m: Msg;
    try {
      m = typeof json === "string" ? (JSON.parse(json) as Msg) : json;
    } catch {
      return;
    }
    try {
      receive(m);
    } catch (err) {
      console.error("receive", m.t, err);
    }
  },
};
bridge.ready();

