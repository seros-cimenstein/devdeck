// Chat view: incremental transcript rendering with bounded DOM, paging, stick-to-bottom.
import { request } from "./bridge";
import { cacheGet, cachePut } from "./cache";
import { hydrate, markdownEl, renderMarkdown } from "./md";
import { dismissSend, onOutboxChange, outboxFor, retrySend } from "./outbox";
import { hooks, state } from "./state";
import type { AssistantEntry, Entry, FullMsg, ToolCall, TranscriptMsg } from "./types";
import { debounce, h, icon, reducedMotion } from "./util";

const MAX_DOM = 220; // rendered entries kept while following the bottom
const TRIM_TO = 160;
const MAX_MEM = 1500; // entries kept in memory
const LOCAL_PAGE = 40;
const CACHE_ENTRIES = 80;

interface CachedTx {
  sessionId?: string;
  entries: Entry[];
  hasMore: boolean;
}

export class ChatView {
  readonly wrap: HTMLElement;
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly top: HTMLElement;
  private readonly outbox: HTMLElement;
  private readonly working: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly empty: HTMLElement;

  private entries: Entry[] = [];
  private nodes = new Map<number, HTMLElement>();
  private domStart = 0;
  private hasMore = false;
  private target = "";
  private sessionId = "";
  private live = false;
  private atBottom = true;
  private loadingMore = false;
  private moreFailed = false;
  private unseen = 0;
  private expanded = new Set<string>();
  private full = new Map<string, string>();
  private scrollQueued = false;

  constructor() {
    this.top = h("div.chat-top");
    this.list = h("div.entries");
    this.outbox = h("div.outbox");
    this.working = h("div.working", { hidden: true });
    this.empty = h("div.empty", { hidden: true });
    this.el = h("div.chat-scroll", null, this.top, this.list, this.empty, this.outbox, this.working);
    this.pill = h(
      "button.jump",
      { onclick: () => this.scrollToBottom(true) },
      h("span.icw", { html: icon("down") }),
      h("span.jump-l", { text: "Latest" }),
    );
    this.wrap = h("div.view.chat-view", null, this.el, this.pill);

    this.el.addEventListener("scroll", () => this.onScroll(), { passive: true });
    const ro = new ResizeObserver(() => {
      if (this.atBottom) this.el.scrollTop = this.el.scrollHeight;
    });
    ro.observe(this.el);
    ro.observe(this.list);
    ro.observe(this.outbox);
    ro.observe(this.working);
    onOutboxChange(() => this.renderOutbox());
  }

  // ---------------------------------------------------------------- target / data

  setTarget(target: string) {
    if (target === this.target) return;
    this.saveNow();
    this.target = target;
    this.live = false;
    this.clear();
    this.renderOutbox();
    this.updateStatus();
    void cacheGet<CachedTx>("tx:" + target).then((c) => {
      if (!c || this.target !== target || this.live) return;
      this.resetWith(c.entries, c.hasMore, c.sessionId || "", true);
    });
  }

  private clear() {
    this.entries = [];
    this.nodes.clear();
    this.list.textContent = "";
    this.domStart = 0;
    this.hasMore = false;
    this.loadingMore = false;
    this.moreFailed = false;
    this.unseen = 0;
    this.sessionId = "";
    this.atBottom = true;
    this.expanded.clear();
    this.full.clear();
    this.wrap.classList.remove("stale");
    this.updateTop();
    this.updateEmpty();
    this.updatePill();
  }

  onTranscript(m: TranscriptMsg) {
    if (m.target !== this.target) return;
    if (m.reset || !this.live) {
      if (!m.reset) return; // appends to a cache snapshot would be out of order: wait for a reset
      this.live = true;
      this.resetWith(m.entries || [], !!m.hasMore, m.sessionId || "", false);
      return;
    }
    let appended = 0;
    for (const e of m.entries || []) if (this.upsert(e)) appended++;
    if (appended && !this.atBottom) this.unseen += appended;
    this.afterAppend();
  }

  private resetWith(entries: Entry[], hasMore: boolean, sessionId: string, fromCache: boolean) {
    const sid = this.sessionId;
    const keepExpanded = sid && sid === sessionId;
    const expanded = this.expanded;
    this.clear();
    if (keepExpanded) this.expanded = expanded;
    this.sessionId = sessionId;
    this.entries = [...entries].sort((a, b) => a.seq - b.seq);
    this.hasMore = hasMore;
    this.domStart = Math.max(0, this.entries.length - MAX_DOM);
    const frag = document.createDocumentFragment();
    for (let i = this.domStart; i < this.entries.length; i++) frag.append(this.node(this.entries[i]));
    this.list.append(frag);
    hydrate(this.list);
    this.wrap.classList.toggle("stale", fromCache);
    this.updateTop();
    this.updateEmpty();
    this.scrollToBottom(false);
    if (!fromCache) this.saveSoon();
  }

  /** Inserts or replaces one entry; true if it is new. */
  private upsert(e: Entry): boolean {
    const arr = this.entries;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].seq < e.seq) lo = mid + 1;
      else hi = mid;
    }
    if (lo < arr.length && arr[lo].seq === e.seq) {
      arr[lo] = e;
      const old = this.nodes.get(e.seq);
      if (old) {
        const n = this.node(e);
        old.replaceWith(n);
        hydrate(n);
      }
      return false;
    }
    arr.splice(lo, 0, e);
    if (lo < this.domStart) {
      this.domStart++;
      return true;
    }
    const n = this.node(e);
    const next = arr[lo + 1] && this.nodes.get(arr[lo + 1].seq);
    if (next) this.list.insertBefore(n, next);
    else this.list.append(n);
    hydrate(n);
    return true;
  }

  private afterAppend() {
    if (this.atBottom) this.trim();
    if (this.entries.length > MAX_MEM && this.domStart > MAX_MEM / 2) {
      const drop = this.entries.length - MAX_MEM;
      this.entries.splice(0, Math.min(drop, this.domStart));
      this.domStart -= Math.min(drop, this.domStart);
      this.hasMore = true;
    }
    this.updateEmpty();
    this.updatePill();
    if (this.atBottom) this.el.scrollTop = this.el.scrollHeight;
    this.saveSoon();
  }

  private trim() {
    const rendered = this.entries.length - this.domStart;
    if (rendered <= MAX_DOM) return;
    const target = this.entries.length - TRIM_TO;
    for (let i = this.domStart; i < target; i++) {
      const s = this.entries[i].seq;
      this.nodes.get(s)?.remove();
      this.nodes.delete(s);
    }
    this.domStart = target;
    this.updateTop();
  }

  private saveSoon = debounce(() => this.saveNow(), 1500);
  private saveNow() {
    if (!this.target || !this.live || !this.entries.length) return;
    const entries = this.entries.slice(-CACHE_ENTRIES);
    void cachePut<CachedTx>("tx:" + this.target, {
      sessionId: this.sessionId,
      entries,
      hasMore: this.hasMore || this.entries.length > entries.length,
    });
  }

  // ---------------------------------------------------------------- paging

  private onScroll() {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      const el = this.el;
      const d = el.scrollHeight - el.scrollTop - el.clientHeight;
      this.atBottom = d < 64;
      if (this.atBottom) this.unseen = 0;
      this.updatePill();
      if (el.scrollTop < 900) this.loadOlder();
    });
  }

  private loadOlder() {
    if (this.domStart > 0) {
      const from = Math.max(0, this.domStart - LOCAL_PAGE);
      this.prependNodes(this.entries.slice(from, this.domStart));
      this.domStart = from;
      this.updateTop();
      return;
    }
    if (!this.hasMore || this.loadingMore || !this.live || !this.entries.length || this.moreFailed) return;
    this.loadingMore = true;
    this.updateTop();
    const target = this.target;
    const before = this.entries[0].seq;
    request<TranscriptMsg>({ t: "more", target, before }, 45000)
      .then((m) => {
        if (target !== this.target) return;
        this.loadingMore = false;
        const first = this.entries[0]?.seq ?? Infinity;
        const older = (m.entries || []).filter((e) => e.seq < first).sort((a, b) => a.seq - b.seq);
        this.hasMore = !!m.hasMore;
        if (older.length) {
          this.entries.unshift(...older);
          this.prependNodes(older);
        }
        this.updateTop();
      })
      .catch(() => {
        if (target !== this.target) return;
        this.loadingMore = false;
        this.moreFailed = true;
        this.updateTop();
      });
  }

  /** Prepends nodes keeping the first visible entry fixed on screen. */
  private prependNodes(entries: Entry[]) {
    if (!entries.length) return;
    const el = this.el;
    const anchor = this.firstVisible();
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    const frag = document.createDocumentFragment();
    for (const e of entries) frag.append(this.node(e));
    this.list.prepend(frag);
    hydrate(this.list);
    if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  private firstVisible(): HTMLElement | null {
    const top = this.el.getBoundingClientRect().top;
    for (const c of this.list.children) {
      if ((c as HTMLElement).getBoundingClientRect().bottom > top) return c as HTMLElement;
    }
    return null;
  }

  private updateTop() {
    const t = this.top;
    t.textContent = "";
    if (!this.entries.length) return;
    if (this.domStart > 0 || this.loadingMore) t.append(h("span.spin"));
    else if (this.moreFailed)
      t.append(
        h("button.btn.ghost", {
          text: "Couldn't load older messages. Retry",
          onclick: () => {
            this.moreFailed = false;
            this.loadOlder();
          },
        }),
      );
    else if (this.hasMore) t.append(h("span.muted", { text: "Scroll for older messages" }));
    else t.append(h("span.muted", { text: "Beginning of session" }));
  }

  private updateEmpty() {
    const none = !this.entries.length;
    this.empty.hidden = !none;
    if (none) this.empty.textContent = this.live ? "No messages yet" : "Loading conversation...";
  }

  private updatePill() {
    const el = this.el;
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 0.6;
    const show = !this.atBottom && (far || this.unseen > 0);
    this.pill.classList.toggle("show", show);
    const label = this.pill.querySelector(".jump-l")!;
    label.textContent = this.unseen > 0 ? `${this.unseen} new` : "Latest";
  }

  scrollToBottom(smooth: boolean) {
    this.atBottom = true;
    this.unseen = 0;
    if (this.domStart < this.entries.length - MAX_DOM) this.trim();
    const el = this.el;
    if (smooth && !reducedMotion()) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    this.updatePill();
  }

  // ---------------------------------------------------------------- status rows

  /** The server stops streaming (view switched away / link lost); the next reset replaces the content. */
  suspend() {
    this.saveNow();
    this.live = false;
  }

  /** Refreshes the working indicator from the current pane state (asking is the ask banner's job). */
  updateStatus() {
    const p = state.byTarget.get(this.target);
    const w = this.working;
    const busy = p?.state === "working";
    w.hidden = !busy;
    if (busy) {
      if (!w.firstChild) w.append(h("span.dots", null, h("i"), h("i"), h("i")), h("span.w-l"));
      w.lastChild!.textContent = p?.context || "Working";
    }
    if (!busy && p?.state !== "asking") {
      this.list.querySelectorAll(".tool-st.run").forEach((s) => {
        s.classList.replace("run", "pend");
        s.textContent = "";
      });
    }
  }

  private renderOutbox() {
    const o = this.outbox;
    o.textContent = "";
    for (const it of outboxFor(this.target)) {
      const status = it.failed
        ? h(
            "div.ob-st.err",
            null,
            h("span", { text: it.failed }),
            h("button.lnk", { text: "Retry", onclick: () => retrySend(it.id) }),
            h("button.lnk", { text: "Dismiss", onclick: () => dismissSend(it.id) }),
          )
        : h("div.ob-st", null, h("span.spin.xs"), h("span", { text: it.enter ? "Sending" : "Pasting (no Enter)" }));
      o.append(h("div.ent.user.pending", null, h("div.bubble", null, h("div.u-text", { text: it.text || "(Enter)" }), status)));
    }
  }

  // ---------------------------------------------------------------- entry rendering

  private node(e: Entry): HTMLElement {
    const n = this.renderEntry(e);
    n.dataset.seq = String(e.seq);
    this.nodes.set(e.seq, n);
    return n;
  }

  private renderEntry(e: Entry): HTMLElement {
    switch (e.kind) {
      case "user": {
        const text = this.full.get(e.id) ?? e.text;
        return h(
          "div.ent.user",
          null,
          h(
            "div.bubble",
            null,
            h("div.u-text", { text }),
            e.textTruncated && !this.full.has(e.id) ? this.fullBtn(e.id, "Show full message") : null,
            h("div.u-time", { text: fmtTime(e.ts) }),
          ),
        );
      }
      case "assistant":
        return this.renderAssistant(e);
      case "compaction": {
        const d = h("details.ent.card.compaction", null, h("summary", null, h("span.icw", { html: icon("history") }), h("span", { text: "Context compacted" })));
        d.addEventListener(
          "toggle",
          () => {
            d.append(markdownEl(this.full.get(e.id) ?? e.summary));
            if (e.textTruncated && !this.full.has(e.id)) d.append(this.fullBtn(e.id, "Show full summary"));
          },
          { once: true },
        );
        return d;
      }
      case "notice":
        return h("div.ent.notice", null, h("span", { text: this.full.get(e.id) ?? e.text }));
      default:
        return h("div.ent.notice", { text: "Unsupported entry" });
    }
  }

  private renderAssistant(e: AssistantEntry): HTMLElement {
    const n = h("div.ent.asst");
    if (e.thinking) {
      const key = e.id + ":thinking";
      const text = this.full.get(key) ?? e.thinking;
      const d = h(
        "details.thinking",
        { open: this.expanded.has(key) },
        h("summary", null, h("span.th-l", { text: "Thinking" }), h("span.th-p", { text: firstLine(text) })),
      );
      d.addEventListener("toggle", () => {
        const open = (d as HTMLDetailsElement).open;
        if (open) this.expanded.add(key);
        else this.expanded.delete(key);
        if (open && !d.querySelector(".th-body")) {
          d.append(h("div.th-body", { text }));
          if (e.thinkingTruncated && !this.full.has(key)) d.append(this.fullBtn(key, "Show full thinking"));
        }
      });
      if (this.expanded.has(key)) {
        d.append(h("div.th-body", { text }));
        if (e.thinkingTruncated && !this.full.has(key)) d.append(this.fullBtn(key, "Show full thinking"));
      }
      n.append(d);
    }
    if (e.text) {
      const md = h("div.md", { html: renderMarkdown(this.full.get(e.id) ?? e.text) });
      n.append(md);
      if (e.textTruncated && !this.full.has(e.id)) n.append(this.fullBtn(e.id, "Show full message"));
    }
    if (e.tools?.length) {
      const tl = h("div.tools");
      for (const t of e.tools) tl.append(this.renderTool(t));
      n.append(tl);
    }
    if (e.errorMessage) n.append(h("div.ent-err", { text: e.errorMessage }));
    else if (e.stopReason === "aborted") n.append(h("div.ent-meta", { text: "Aborted" }));
    return n;
  }

  private renderTool(t: ToolCall): HTMLElement {
    const open = this.expanded.has(t.id);
    const paneState = state.byTarget.get(this.target)?.state;
    const busy = paneState === "working" || paneState === "asking";
    const st = t.result ? (t.result.isError ? "err" : "ok") : busy ? "run" : "pend";
    const stEl = h(`span.tool-st.${st}`);
    if (st === "run") stEl.append(h("span.spin.xs"));
    else if (st === "ok") stEl.innerHTML = icon("check");
    else if (st === "err") stEl.innerHTML = icon("close");
    const label = t.intent || argSummary(t.args);
    const head = h(
      "button.tool-h",
      { "aria-expanded": String(open) },
      stEl,
      h("span.tool-n", { text: t.name }),
      h("span.tool-i", { text: label }),
      h("span.icw.tool-c", { html: icon("chevDown") }),
    );
    const box = h(`div.tool.t-${st}${open ? ".open" : ""}`, { "data-tool": t.id }, head);
    if (t.name === "ask" && !t.result) {
      const p = state.byTarget.get(this.target);
      if (p?.ask && p.ask.toolCallId === t.id) {
        const ask = p.ask;
        box.append(h("button.btn.primary.sm.tool-ask", { text: "Answer", onclick: () => hooks.openAsk(p.target, ask) }));
      }
    }
    const body = () => {
      const b = h("div.tool-b");
      const argsKey = t.id + ":args";
      b.append(h("div.tool-sec", { text: "Input" }), argsView(this.full.get(argsKey) ?? t.args));
      if (t.argsTruncated && !this.full.has(argsKey)) b.append(this.fullBtn(argsKey, "Show full input"));
      if (t.result) {
        b.append(h("div.tool-sec", { text: t.result.isError ? "Error" : "Output" }));
        const txt = this.full.get(t.id) ?? t.result.text;
        b.append(h(`pre.tool-out${t.result.isError ? ".err" : ""}`, { text: txt || "(empty)" }));
        if (t.result.truncated && !this.full.has(t.id)) b.append(this.fullBtn(t.id, "Show full output"));
      } else b.append(h("div.tool-sec.muted", { text: "No result yet" }));
      return b;
    };
    if (open) box.append(body());
    head.addEventListener("click", () => {
      const nowOpen = !box.classList.contains("open");
      box.classList.toggle("open", nowOpen);
      head.setAttribute("aria-expanded", String(nowOpen));
      if (nowOpen) {
        this.expanded.add(t.id);
        if (!box.querySelector(".tool-b")) box.append(body());
      } else {
        this.expanded.delete(t.id);
        box.querySelector(".tool-b")?.remove();
      }
    });
    return box;
  }

  private fullBtn(entryId: string, label: string): HTMLElement {
    const b = h("button.btn.ghost.sm.full-btn", { text: label }) as HTMLButtonElement;
    b.addEventListener("click", () => {
      b.disabled = true;
      b.textContent = "Loading...";
      request<FullMsg>({ t: "full", target: this.target, entryId })
        .then((m) => {
          this.full.set(entryId, m.text);
          this.rerenderFor(entryId);
        })
        .catch((err: Error) => {
          b.disabled = false;
          b.textContent = `${label} (failed: ${err.message})`;
        });
    });
    return b;
  }

  /** Re-renders the entry owning a full-text key (entry id, `<tool>`, `<tool>:args`, `<entry>:thinking`). */
  private rerenderFor(key: string) {
    const base = key.replace(/:(args|thinking)$/, "");
    for (let i = this.domStart; i < this.entries.length; i++) {
      const e = this.entries[i];
      const owns = e.id === base || (e.kind === "assistant" && e.tools?.some((t) => t.id === base));
      if (!owns) continue;
      if (key.endsWith(":thinking")) this.expanded.add(key);
      if (e.kind === "assistant" && e.tools?.some((t) => t.id === base)) this.expanded.add(base);
      const old = this.nodes.get(e.seq);
      if (!old) return;
      const n = this.node(e);
      old.replaceWith(n);
      hydrate(n);
      if (e.kind === "compaction") (n as HTMLDetailsElement).open = true;
      return;
    }
  }
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
}

function firstLine(s: string): string {
  const l = (s.trim().split("\n", 1)[0] || "").replace(/\*\*|__|^#+\s*/g, "");
  return l.length > 90 ? l.slice(0, 90) + "..." : l;
}

function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function argSummary(args: string): string {
  const o = parseArgs(args);
  if (!o) return args.slice(0, 120);
  for (const k of ["command", "path", "pattern", "query", "url", "code", "content"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v.split("\n", 1)[0].slice(0, 120);
  }
  for (const v of Object.values(o)) if (typeof v === "string" && v) return v.split("\n", 1)[0].slice(0, 120);
  return args.slice(0, 120);
}

function argsView(args: string): HTMLElement {
  const o = parseArgs(args);
  if (!o) return h("pre.tool-out", { text: args });
  const box = h("div.args");
  for (const [k, v] of Object.entries(o)) {
    const val = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    box.append(h("div.arg-k", { text: k }), h("pre.arg-v", { text: val }));
  }
  return box;
}
