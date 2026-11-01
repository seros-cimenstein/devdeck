// Native side questions (omp's /btw): one ephemeral turn over the session's context that never enters the
// transcript. Topics per session, answers streamed by `btw_delta`, full topics by `btw_record`, follow-ups, cancel.
import { bridge, request } from "./bridge";
import { markdownEl, renderMarkdown } from "./md";
import { errText, isOnline } from "./omp";
import { paneTitle, state } from "./state";
import type { BtwAskMsg, BtwDeltaMsg, BtwListMsg, BtwRecordMsg, BtwStatus, BtwTopic, BtwTurn } from "./types";
import { errorEl, Sheet, spinnerEl, toast } from "./ui";
import { fmtAgo, h, icon, ticking } from "./util";

interface Store {
  topics: Map<string, BtwTopic>;
  loaded: boolean;
}
/** Topics per omp pane, as last listed or pushed. */
const stores = new Map<string, Store>();
/** Streamed text of a topic's running turn; `turn` is the index it belongs to (-1: record not seen yet). */
const streams = new Map<string, { turn: number; text: string }>();
/** Per pane: topics that finished while no sheet showed them; the strip chip offers them. */
const unseen = new Map<string, Set<string>>();
const listeners = new Set<(target: string) => void>();
let sheet: BtwSheet | null = null;

function storeFor(target: string): Store {
  let s = stores.get(target);
  if (!s) stores.set(target, (s = { topics: new Map(), loaded: false }));
  return s;
}

export function onBtw(fn: (target: string) => void) {
  listeners.add(fn);
}
function notify(target: string) {
  for (const fn of listeners) fn(target);
}

const sorted = (s: Store) => [...s.topics.values()].sort((a, b) => b.updated - a.updated);

/** What the strip chip shows for a pane: a running topic, else one that finished unseen; null hides it. */
export function btwChip(target: string): { running: boolean; topicId: string } | null {
  const s = stores.get(target);
  if (!s) return null;
  const run = sorted(s).find((t) => t.status === "running");
  if (run) return { running: true, topicId: run.id };
  const u = unseen.get(target);
  const id = u && [...u].find((x) => s.topics.has(x));
  return id ? { running: false, topicId: id } : null;
}

/** The running turn's answer: streamed text when ahead of the last record. */
function answerText(t: BtwTopic, i: number): string {
  const turn = t.turns[i];
  const st = streams.get(t.id);
  if (turn.status === "running" && st && st.turn === i && st.text.length > turn.answer.length) return st.text;
  return turn.answer;
}

function markSeen(target: string, id: string) {
  const u = unseen.get(target);
  if (u?.delete(id)) notify(target);
}

// ---------------------------------------------------------------- server pushes

export function onBtwDelta(m: BtwDeltaMsg) {
  const t = stores.get(m.target)?.topics.get(m.topicId);
  const turn = t ? t.turns.length - 1 : -1;
  let st = streams.get(m.topicId);
  if (!st || (turn >= 0 && st.turn !== turn && st.turn !== -1)) streams.set(m.topicId, (st = { turn, text: "" }));
  if (st.turn === -1) st.turn = turn;
  st.text += m.delta;
  sheet?.onDelta(m.target, m.topicId);
}

export function onBtwRecord(m: BtwRecordMsg) {
  const t = m.topic;
  if (!t?.id) return;
  const s = storeFor(m.target);
  const prev = s.topics.get(t.id);
  s.topics.set(t.id, t);
  const last = t.turns.length - 1;
  if (t.status === "running") {
    const st = streams.get(t.id);
    if (!st || (st.turn !== last && st.turn !== -1)) streams.set(t.id, { turn: last, text: t.turns[last]?.answer ?? "" });
    else st.turn = last;
  } else {
    streams.delete(t.id);
    if (prev?.status === "running" && !sheet?.shows(m.target, t.id)) {
      let u = unseen.get(m.target);
      if (!u) unseen.set(m.target, (u = new Set()));
      u.add(t.id);
    }
  }
  notify(m.target);
  sheet?.onRecord(m.target, t.id);
}

/** After a pause the PC sends no pushes: re-list panes whose topics may have moved on. */
export function btwResync() {
  const targets = new Set<string>();
  for (const [target, s] of stores) if (sorted(s).some((t) => t.status === "running")) targets.add(target);
  if (sheet?.isOpen) targets.add(sheet.target);
  for (const t of targets) void loadTopics(t).catch(() => {});
}

function loadTopics(target: string): Promise<void> {
  return request<BtwListMsg>({ t: "btw_list", target }, 30_000).then((m) => {
    const s = storeFor(target);
    s.topics = new Map((m.topics ?? []).map((t) => [t.id, t]));
    s.loaded = true;
    for (const t of s.topics.values()) if (t.status !== "running") streams.delete(t.id);
    notify(target);
  });
}

/** A started ask: shows the question at once, before the PC's first record. */
function noteAsked(target: string, id: string, question: string) {
  const s = storeFor(target);
  const t = s.topics.get(id);
  const lastQ = t?.turns.at(-1);
  if (t && lastQ?.status === "running" && lastQ.question === question) return; // the record came first
  const turn: BtwTurn = { question, answer: "", status: "running", ts: Date.now() };
  const now = Date.now();
  const next: BtwTopic = t
    ? { ...t, turns: [...t.turns, turn], status: "running", updated: now }
    : { id, title: question.slice(0, 120), status: "running", updated: now, turns: [turn], source: "devdeck" };
  s.topics.set(id, next);
  const idx = next.turns.length - 1;
  const st = streams.get(id);
  if (!st || (st.turn !== -1 && st.turn !== idx)) streams.set(id, { turn: idx, text: "" });
  else st.turn = idx;
  notify(target);
}

// ---------------------------------------------------------------- the sheet

export interface BtwOpen {
  /** Show this topic. */
  topicId?: string;
  /** Ask this at once (typed `/btw question`). */
  ask?: string;
  /** Focus the question box. */
  focus?: boolean;
}

/** The side-question sheet for omp pane `target`. */
export function openBtw(target: string, o: BtwOpen = {}) {
  const p = state.byTarget.get(target);
  if (!p?.agent) return;
  if (sheet?.isOpen && sheet.target === target) sheet.apply(o);
  else {
    sheet?.close();
    sheet = new BtwSheet(target, o);
  }
}

const STATUS: Record<BtwStatus, [label: string, cls: string]> = {
  running: ["Running", ".acc"],
  complete: ["Done", ".ok"],
  cancelled: ["Cancelled", ""],
  error: ["Error", ".err"],
};

function statusTag(st: BtwStatus): HTMLElement {
  const [label, cls] = STATUS[st] ?? [st, ""];
  return h(`span.tag${cls}`, null, st === "running" ? ticking(h("span.spin.xs")) : null, h("span", { text: label }));
}

class BtwSheet {
  private readonly s: Sheet;
  readonly target: string;
  private view: { k: "list" } | { k: "topic"; id: string } = { k: "list" };
  private loadErr = "";
  private sending = false;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  /** The streaming answer element of the shown topic's running turn. */
  private liveEl: HTMLElement | null = null;
  private frame = 0;

  constructor(target: string, o: BtwOpen) {
    this.target = target;
    this.s = new Sheet("Side questions", paneTitle(state.byTarget.get(target), target), "tall");
    this.input = h("textarea.field.bt-in", { rows: 1, maxlength: 4000, enterkeyhint: "send", autocapitalize: "sentences" }) as HTMLTextAreaElement;
    this.sendBtn = h("button.c-send.bt-send", { "aria-label": "Ask", html: icon("send") }) as HTMLButtonElement;
    this.cancelBtn = h("button.btn.wide", null, h("span.icw", { html: icon("stop") }), h("span", { text: "Cancel" })) as HTMLButtonElement;
    this.input.addEventListener("input", () => {
      this.autosize();
      this.syncSend();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.sendBtn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the keyboard open
    this.sendBtn.addEventListener("click", () => void this.submit());
    this.cancelBtn.addEventListener("click", () => void this.cancel());
    this.s.onBack = () => {
      if (this.view.k === "list") return false;
      this.show({ k: "list" });
      return true;
    };
    this.s.onClose = () => {
      cancelAnimationFrame(this.frame);
      if (sheet === this) sheet = null;
    };
    const st = storeFor(target);
    this.render();
    void loadTopics(target)
      .then(() => this.render())
      .catch((e) => {
        this.loadErr = errText(e);
        if (!st.loaded) this.render();
        else toast(this.loadErr, "err");
      });
    this.apply(o);
  }

  get isOpen(): boolean {
    return this.s.isOpen;
  }

  close() {
    this.s.close();
  }

  shows(target: string, id: string): boolean {
    return this.s.isOpen && this.target === target && this.view.k === "topic" && this.view.id === id;
  }

  apply(o: BtwOpen) {
    if (o.topicId) this.show({ k: "topic", id: o.topicId });
    if (o.ask) {
      this.input.value = o.ask;
      void this.submit();
    } else if (o.focus) setTimeout(() => this.input.focus(), 320);
  }

  private show(v: BtwSheet["view"]) {
    this.view = v;
    this.render();
    if (v.k === "topic") this.toBottom();
    else this.s.body.scrollTop = 0;
  }

  private topic(): BtwTopic | undefined {
    return this.view.k === "topic" ? stores.get(this.target)?.topics.get(this.view.id) : undefined;
  }

  // ---- pushes

  onDelta(target: string, id: string) {
    if (!this.shows(target, id) || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const t = this.topic();
      if (!t || !this.liveEl) return this.render();
      const stick = this.nearBottom();
      const text = answerText(t, t.turns.length - 1);
      this.liveEl.replaceChildren(text ? h("div.md", { html: renderMarkdown(text) }) : this.thinkingEl());
      if (stick) this.toBottom();
    });
  }

  onRecord(target: string, id: string) {
    if (target !== this.target || !this.s.isOpen) return;
    if (this.view.k === "list" || this.view.id === id) {
      const stick = this.view.k === "topic" && this.nearBottom();
      this.render();
      if (stick) this.toBottom();
    }
  }

  // ---- actions

  private async submit() {
    const q = this.input.value.trim();
    if (!q || this.sending) return;
    if (!isOnline()) return toast("Offline: side questions need the PC", "err");
    const topicId = this.view.k === "topic" ? this.view.id : undefined;
    this.sending = true;
    this.syncSend();
    try {
      const m = await request<BtwAskMsg>({ t: "btw_ask", target: this.target, question: q, ...(topicId ? { topicId } : {}) }, 30_000);
      noteAsked(this.target, m.topicId, q);
      if (this.input.value.trim() === q) this.input.value = "";
      this.autosize();
      this.sending = false;
      this.show({ k: "topic", id: m.topicId });
    } catch (e) {
      this.sending = false;
      this.syncSend();
      toast(errText(e), "err");
    }
  }

  private async cancel() {
    const t = this.topic();
    if (!t) return;
    this.cancelBtn.disabled = true;
    try {
      const m = await request<{ cancelled: boolean }>({ t: "btw_cancel", target: this.target, topicId: t.id }, 15_000);
      if (!m.cancelled) toast("Nothing to cancel: it already finished");
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      this.cancelBtn.disabled = false;
    }
  }

  // ---- rendering

  private nearBottom(): boolean {
    const b = this.s.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
  }

  private toBottom() {
    const b = this.s.body;
    b.scrollTop = b.scrollHeight;
  }

  private autosize() {
    const ta = this.input;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }

  private syncSend() {
    this.sendBtn.disabled = this.sending || !this.input.value.trim();
    this.sendBtn.classList.toggle("busy", this.sending);
    this.sendBtn.innerHTML = this.sending ? '<span class="spin"></span>' : icon("send");
  }

  private thinkingEl(): HTMLElement {
    return h("div.bt-wait", null, ticking(h("span.spin.xs")), h("span", { text: "Thinking..." }));
  }

  private render() {
    if (!this.s.isOpen) return;
    this.liveEl = null;
    const t = this.topic();
    if (this.view.k === "topic" && t) {
      markSeen(this.target, t.id);
      this.s.body.replaceChildren(this.topicView(t));
    } else {
      if (this.view.k === "topic") this.view = { k: "list" };
      this.s.body.replaceChildren(this.listView());
    }
    this.renderFoot(t);
  }

  private renderFoot(t: BtwTopic | undefined) {
    const f = this.s.foot;
    f.hidden = false;
    if (t?.status === "running") {
      f.replaceChildren(this.cancelBtn);
      return;
    }
    this.input.placeholder = t ? "Follow-up question" : "Ask a side question";
    this.syncSend();
    f.replaceChildren(h("div.bt-ask", null, this.input, this.sendBtn));
    this.autosize();
  }

  private listView(): HTMLElement {
    const s = storeFor(this.target);
    const topics = sorted(s);
    const el = h("div.bt-list");
    el.append(h("p.sheet-text.muted.bt-intro", { text: "Ask about this session without interrupting the agent. The model sees the conversation but runs no tools, and nothing is added to the transcript." }));
    if (!topics.length) {
      if (!s.loaded && this.loadErr)
        el.append(
          errorEl(this.loadErr, () => {
            this.loadErr = "";
            this.render();
            void loadTopics(this.target)
              .then(() => this.render())
              .catch((e) => {
                this.loadErr = errText(e);
                this.render();
              });
          }),
        );
      else if (!s.loaded) el.append(spinnerEl("Loading side questions..."));
      else el.append(h("div.empty", { text: "No side questions in this session yet" }));
      return el;
    }
    for (const t of topics) {
      const n = t.turns.length;
      el.append(
        h(
          "button.hs-row.bt-row",
          { onclick: () => this.show({ k: "topic", id: t.id }) },
          h("span.hs-top", null, h("span.hs-title", { text: t.title || t.turns[0]?.question || "Side question" }), h("span.hs-meta", null, h("span", { text: fmtAgo(t.updated) }))),
          h(
            "span.bt-meta",
            null,
            statusTag(t.status),
            n > 1 ? h("span.tag", { text: `${n} questions` }) : null,
            t.source === "omp" ? h("span.tag", { text: "from omp" }) : null,
            unseen.get(this.target)?.has(t.id) ? h("span.tag.acc", { text: "New" }) : null,
          ),
        ),
      );
    }
    return el;
  }

  private topicView(t: BtwTopic): HTMLElement {
    const el = h(
      "div.bt-topic",
      null,
      h("button.ms-back", { onclick: () => this.show({ k: "list" }) }, h("span.ms-back-ic", { text: "\u2039" }), h("span", { text: "Side questions" })),
    );
    if (t.source === "omp") el.append(h("p.sheet-text.muted.bt-note", { text: "Asked in omp on the PC." }));
    t.turns.forEach((turn, i) => {
      el.append(h("div.ent.user.bt-q", null, h("div.bubble", null, h("div.u-text", { text: turn.question }), h("div.u-time", { text: fmtAgo(turn.ts) }))));
      const a = h("div.ent.asst.bt-a");
      const text = answerText(t, i);
      if (turn.status === "running") {
        const live = h("div.bt-live", null, text ? h("div.md", { html: renderMarkdown(text) }) : this.thinkingEl());
        this.liveEl = live;
        a.append(live);
      } else if (text) a.append(markdownEl(text));
      if (turn.status === "error") a.append(h("div.ent-err", { text: turn.error || "The side question failed" }));
      else if (turn.status === "cancelled") a.append(h("div.bt-st.muted", { text: text ? "Cancelled (partial answer)" : "Cancelled" }));
      if (text && turn.status !== "running")
        a.append(
          h(
            "div.ent-acts",
            null,
            h(
              "button.lnk.bt-copy",
              {
                onclick: () => {
                  bridge.copyText(text);
                  toast("Answer copied", "ok");
                },
              },
              h("span.icw", { html: icon("copy") }),
              h("span", { text: "Copy" }),
            ),
          ),
        );
      el.append(a);
    });
    return el;
  }
}
