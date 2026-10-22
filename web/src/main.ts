// DevDeck WebView UI entry: wires the bridge, state and views.
import { AskSheet } from "./ask";
import { bridge, send, settle } from "./bridge";
import { ChatView } from "./chat";
import { Compose } from "./compose";
import { Drawer } from "./drawer";
import { FilesPanel, findRepo, openFileViewer } from "./files";
import { openGit } from "./git";
import { outboxAck, sendText } from "./outbox";
import { currentPane, hooks, state, type View } from "./state";
import { TermView } from "./term";
import { TopBar } from "./topbar";
import type { AckMsg, LinkMsg, Msg, Pane, ScreenMsg, SessionsMsg, TranscriptMsg } from "./types";
import { openMenu, popLayer, toast } from "./ui";
import { fmtRtt, h, learnHome, lsGet, lsSet } from "./util";

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
});
const chat = new ChatView();
const term = new TermView();
const compose = new Compose((target, text, enter) => {
  sendText(target, text, enter);
  if (state.view === "chat") chat.scrollToBottom(true);
});
const askBanner = h("div.ask-banner", { hidden: true });
const main = h("main.main", null, chat.wrap, term.wrap);
app.append(top.el, main, askBanner, compose.el);
const drawer = new Drawer(
  (t) => openTarget(t),
  () => newTerminal(),
);
const ask = new AskSheet();
ask.onChange = () => updateAskBanner();

hooks.open = (t, v) => openTarget(t, v);
hooks.openAsk = (t, a) => {
  if (t !== state.target) openTarget(t);
  ask.open(t, a);
};
hooks.openFiles = (p) => new FilesPanel(p || currentPane()?.cwd || "~");
hooks.openGit = (p) => openGit(p);
hooks.openFile = (p) => openFileViewer(p);

// ---------------------------------------------------------------- navigation

function openTarget(target: string, view?: View) {
  clearTimeout(pickTimer);
  const p = state.byTarget.get(target);
  let v: View = view ?? viewPref[target] ?? (p && !p.agent ? "term" : "chat");
  if (p && !p.agent) v = "term";
  const changed = target !== state.target || v !== state.view;
  if (state.view === "chat" && v !== "chat") chat.suspend();
  if (state.view === "term" && v !== "term") term.setStale(true);
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
  compose.setPlaceholder(p && !p.agent ? "Type a command" : "Message");
  if (changed || !watchSent) watchSent = send({ t: "watch", target, view: v });
  top.update();
  drawer.render();
  updateAttention();
  maybeAutoAsk();
  updateAskBanner();
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
      ? [{ label: state.view === "chat" ? "Terminal view" : "Chat view", icon: state.view === "chat" ? "term" : "chat", act: () => openTarget(p.target, state.view === "chat" ? "term" : "chat") }]
      : []),
    { label: "Keep screen awake", icon: "sun", toggle: true, on: !!l?.wakelock, act: () => bridge.setWakelock(!l?.wakelock) },
    { label: "Notifications", icon: "bell", toggle: true, on: !!l?.notify, act: () => bridge.setNotify(!l?.notify) },
    { label: "Resync", icon: "refresh", act: () => (send({ t: "resync" }) ? toast("Resyncing") : toast("Offline", "err")) },
    { label: "New terminal", icon: "plus", act: newTerminal },
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
  drawer.render();
  chat.updateStatus();
  ask.sync();
  updateAttention();
  maybeAutoAsk();
  updateAskBanner();
}

function updateAttention() {
  top.setAttention(state.panes.some((p) => p.target !== state.target && (p.state === "asking" || state.done.has(p.target))));
}

function maybeAutoAsk() {
  const p = currentPane();
  if (!p?.ask || ask.dismissed.has(p.ask.toolCallId) || ask.openFor === p.ask.toolCallId) return;
  ask.open(p.target, p.ask);
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

function onLink(l: LinkMsg) {
  state.link = l;
  top.setLink(l);
  if (l.state === "online" && lastLinkState !== "online" && state.target && !watchSent) {
    watchSent = send({ t: "watch", target: state.target, view: state.view });
  }
  lastLinkState = l.state;
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
      if (state.view === "term" && sm.target === state.target) term.onScreen(sm);
      return;
    }
    case "ack":
      return onAck(m as unknown as AckMsg);
    case "created":
      if (typeof m.target === "string") openTarget(m.target, "term");
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
  }
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

