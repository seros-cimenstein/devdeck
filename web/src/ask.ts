// Native bottom sheet for omp's `ask` tool; answers go out via DD.enqueue({t:"answer"}).
import { enqueue } from "./bridge";
import { renderInline, renderMarkdown } from "./md";
import { paneTitle, state } from "./state";
import type { AckMsg, Ask, AskQuestion } from "./types";
import { grabHandle, type Layer, pushLayer, removeLayer, toast } from "./ui";
import { h, icon, lsGet, lsSet, ticking, uuid } from "./util";

interface QState {
  selected: Set<string>;
  other: boolean;
  custom: string;
  note: string;
}

/** Answers picked or typed but not sent yet, per ask (`toolCallId`), so collapsing the sheet or a reload keeps them. */
const DRAFTS_KEY = "dd.askDrafts";
const DRAFTS_MAX = 20;
type StoredQ = { selected: string[]; other: boolean; custom: string; note: string };
type Drafts = Record<string, { ts: number; qs: StoredQ[] }>;

function loadDraft(ask: Ask): QState[] | null {
  const d = lsGet<Drafts>(DRAFTS_KEY, {})[ask.toolCallId];
  if (!d || d.qs.length !== ask.questions.length) return null;
  return d.qs.map((q) => ({ selected: new Set(q.selected), other: q.other, custom: q.custom, note: q.note }));
}

function saveDraft(id: string, qs: QState[] | null) {
  const all = lsGet<Drafts>(DRAFTS_KEY, {});
  const empty = !qs || qs.every((q) => !q.selected.size && !q.other && !q.custom && !q.note);
  if (empty) delete all[id];
  else all[id] = { ts: Date.now(), qs: qs.map((q) => ({ selected: [...q.selected], other: q.other, custom: q.custom, note: q.note })) };
  const keep = Object.entries(all).sort((a, b) => b[1].ts - a[1].ts).slice(0, DRAFTS_MAX);
  lsSet(DRAFTS_KEY, Object.fromEntries(keep));
}

export class AskSheet implements Layer {
  private readonly scrim: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly body: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private target = "";
  private ask: Ask | null = null;
  private qs: QState[] = [];
  private pendingId = "";
  private isOpen = false;
  /** toolCallIds the user dismissed; not auto-opened again. */
  readonly dismissed = new Set<string>();
  /** Called when the sheet opens or closes. */
  onChange?: () => void;
  /** Mic tapped in the sheet's voice strip (voice mode only). */
  onVoiceMic?: () => void;
  private readonly voiceEl: HTMLElement;

  constructor() {
    this.scrim = h("div.scrim.sheet-scrim.ask-scrim", { onclick: () => this.close() });
    this.body = h("div.sheet-body");
    this.statusEl = h("div.ask-status", { hidden: true });
    this.voiceEl = h("div.ask-voice", { hidden: true });
    this.submitBtn = h("button.btn.primary.wide", { text: "Submit", onclick: () => this.submit() }) as HTMLButtonElement;
    this.foot = h("div.sheet-foot", null, this.voiceEl, this.statusEl, this.submitBtn);
    this.sheet = h("div.sheet.ask-sheet", { role: "dialog", "aria-modal": "true" }, this.body, this.foot);
    this.sheet.prepend(grabHandle(this.sheet, () => this.close()));
    document.getElementById("app")!.append(this.scrim, this.sheet);
  }

  get openFor(): string {
    return this.isOpen && this.ask ? this.ask.toolCallId : "";
  }

  open(target: string, ask: Ask) {
    if (this.isOpen && this.ask?.toolCallId === ask.toolCallId) return;
    this.target = target;
    this.ask = ask;
    this.pendingId = "";
    this.qs = loadDraft(ask) ?? ask.questions.map(() => ({ selected: new Set<string>(), other: false, custom: "", note: "" }));
    this.render();
    this.isOpen = true;
    this.scrim.classList.add("open");
    this.sheet.classList.add("open");
    this.sheet.scrollTop = 0;
    this.body.scrollTop = 0;
    pushLayer(this);
    this.onChange?.();
  }

  close() {
    if (!this.isOpen) return;
    if (this.ask && !this.pendingId) {
      this.dismissed.add(this.ask.toolCallId);
      saveDraft(this.ask.toolCallId, this.qs);
    }
    this.isOpen = false;
    removeLayer(this);
    // The sheet stays in the DOM: a leftover "Answering..." spinner would keep animating off-screen.
    this.statusEl.hidden = true;
    this.statusEl.textContent = "";
    this.scrim.classList.remove("open");
    this.sheet.classList.remove("open");
    this.onChange?.();
  }

  /** Sessions update: close when the ask went away (answered on the PC or elsewhere). */
  sync() {
    if (!this.isOpen || !this.ask) return;
    const p = state.byTarget.get(this.target);
    if (!p || p.ask?.toolCallId !== this.ask.toolCallId) {
      if (!this.pendingId) {
        const id = this.ask.toolCallId;
        this.close();
        saveDraft(id, null);
        toast("The question was answered or cancelled");
      }
    }
  }

  onAck(m: AckMsg): boolean {
    if (!this.pendingId || m.id !== this.pendingId) return false;
    this.pendingId = "";
    if (m.ok) {
      this.close();
      if (this.ask) saveDraft(this.ask.toolCallId, null);
      toast("Answer sent", "ok");
    } else {
      this.setStatus("err", m.error || "The answer could not be delivered");
      this.submitBtn.disabled = false;
      this.submitBtn.textContent = "Retry";
    }
    return true;
  }

  /** The ask shown (open or not) for voice answering. */
  get current(): { target: string; ask: Ask } | null {
    return this.ask ? { target: this.target, ask: this.ask } : null;
  }

  get answering(): boolean {
    return !!this.pendingId;
  }

  /** Voice strip in the sheet foot: what voice mode is doing for this ask; null hides it. */
  setVoice(v: { phase: string; title: string; text?: string } | null) {
    const el = this.voiceEl;
    el.hidden = !v;
    if (!v) return;
    el.className = `ask-voice v-${v.phase}`;
    el.textContent = "";
    el.append(
      h("button.av-mic", { "aria-label": "Answer by voice", html: icon("mic"), onclick: () => this.onVoiceMic?.() }),
      h("div.av-main", null, h("div.av-title", { text: v.title }), v.text ? h("div.av-text", { text: v.text }) : null),
    );
  }

  /** Applies a spoken answer to question `qi` and shows it as if tapped. */
  applyVoice(qi: number, selected: string[], custom?: string) {
    const st = this.qs[qi];
    if (!st || this.pendingId) return;
    st.selected = new Set(selected);
    st.other = !!custom;
    st.custom = custom ?? "";
    this.render();
    this.body.querySelectorAll("section.q")[qi]?.scrollIntoView({ block: "nearest" });
  }

  /** Sends the answers set so far (voice confirmation done); false when incomplete. */
  submitVoice(): boolean {
    if (this.pendingId || this.submitBtn.disabled) return false;
    this.submit();
    return !!this.pendingId;
  }

  private render() {
    const ask = this.ask!;
    const p = state.byTarget.get(this.target);
    this.body.textContent = "";
    this.body.append(
      h(
        "div.sheet-head",
        null,
        h("div", null, h("div.sheet-title", { text: ask.questions.length > 1 ? `${ask.questions.length} questions` : "Question" }), h("div.sheet-sub", { text: paneTitle(p, this.target) })),
        h("button.ib", { "aria-label": "Close", html: icon("close"), onclick: () => this.close() }),
      ),
    );
    ask.questions.forEach((q, i) => this.body.append(this.renderQuestion(q, i)));
    this.statusEl.hidden = true;
    this.submitBtn.textContent = "Submit";
    this.validate();
  }

  private renderQuestion(q: AskQuestion, qi: number): HTMLElement {
    const st = this.qs[qi];
    const type = q.multi ? "checkbox" : "radio";
    const name = `q${qi}-${uuid().slice(0, 6)}`;
    const box = h("section.q");
    const head = h("div.q-head");
    if (q.header) head.append(h("span.chip", { text: q.header }));
    if (q.multi) head.append(h("span.chip.dim", { text: "Select any" }));
    if (head.childNodes.length) box.append(head);
    box.append(h("div.q-text.md", { html: renderMarkdown(q.question) }));

    const opts = h("div.opts");
    const inputs: HTMLInputElement[] = [];
    const otherInput = h("textarea.other-in", { rows: 1, placeholder: "Type your own answer" }) as HTMLTextAreaElement;
    const sync = () => {
      inputs.forEach((inp) => inp.closest(".opt")!.classList.toggle("sel", inp.checked));
      otherRow.classList.toggle("sel", st.other);
      otherInput.hidden = !st.other;
      this.validate();
    };
    q.options.forEach((o, oi) => {
      const inp = h("input", { type, name }) as HTMLInputElement;
      inputs.push(inp);
      const label = h(
        "label.opt",
        null,
        inp,
        h("span.mark"),
        h(
          "span.opt-main",
          null,
          h(
            "span.opt-l",
            null,
            h("span", { html: renderInline(o.label) }),
            q.recommended === oi ? h("span.rec", { text: "Recommended" }) : null,
          ),
          o.description ? h("span.opt-d", { html: renderInline(o.description) }) : null,
          o.preview ? h("pre.opt-pre", { text: o.preview }) : null,
        ),
      );
      inp.addEventListener("change", () => {
        if (q.multi) {
          if (inp.checked) st.selected.add(o.label);
          else st.selected.delete(o.label);
        } else {
          st.selected = new Set([o.label]);
          st.other = false;
          otherRadio.checked = false;
        }
        sync();
      });
      opts.append(label);
    });
    const otherRadio = h("input", { type, name }) as HTMLInputElement;
    const otherRow = h(
      "label.opt.other",
      null,
      otherRadio,
      h("span.mark"),
      h("span.opt-main", null, h("span.opt-l", { text: "Other" }), h("span.opt-d", { text: "Type your own answer" })),
    );
    otherRadio.addEventListener("change", () => {
      st.other = otherRadio.checked;
      if (!q.multi && st.other) {
        st.selected.clear();
        inputs.forEach((x) => (x.checked = false));
      }
      sync();
      if (st.other) otherInput.focus();
    });
    otherInput.hidden = true;
    otherInput.addEventListener("input", () => {
      st.custom = otherInput.value;
      otherInput.style.height = "auto";
      otherInput.style.height = `${Math.min(otherInput.scrollHeight, 140)}px`;
      this.validate();
    });
    opts.append(otherRow, otherInput);
    box.append(opts);
    // Re-renders (voice answers) and reopening (a saved draft) keep what is already chosen.
    inputs.forEach((inp, oi) => (inp.checked = st.selected.has(q.options[oi].label)));
    otherRadio.checked = st.other;
    otherInput.value = st.custom;
    if (st.selected.size || st.other) sync();
    if (st.custom) requestAnimationFrame(() => (otherInput.style.height = `${Math.min(otherInput.scrollHeight, 140)}px`));

    const noteIn = h("textarea.note-in", { rows: 1, placeholder: "Note for the agent (optional)" }) as HTMLTextAreaElement;
    noteIn.value = st.note;
    noteIn.hidden = !st.note;
    noteIn.addEventListener("input", () => {
      st.note = noteIn.value;
      this.persist();
    });
    const noteBtn = h("button.lnk.note-btn", { text: "Add note" });
    noteBtn.hidden = !!st.note;
    noteBtn.addEventListener("click", () => {
      noteIn.hidden = false;
      noteBtn.hidden = true;
      noteIn.focus();
    });
    box.append(noteBtn, noteIn);
    return box;
  }

  private complete(qi: number): boolean {
    const st = this.qs[qi];
    return st.selected.size > 0 || (st.other && st.custom.trim().length > 0);
  }

  private validate() {
    if (this.pendingId) return;
    const ok = this.qs.every((_, i) => this.complete(i));
    this.submitBtn.disabled = !ok;
    this.persist();
  }

  /** Saves the answers so far, so they survive collapsing the sheet and an app restart. */
  private persist() {
    if (this.ask && this.isOpen) saveDraft(this.ask.toolCallId, this.qs);
  }

  private setStatus(kind: "pending" | "err", text: string) {
    const s = this.statusEl;
    s.hidden = false;
    s.className = `ask-status ${kind}`;
    s.textContent = "";
    if (kind === "pending") s.append(ticking(h("span.spin.xs")), h("span", { text }));
    else s.append(h("pre", { text }));
  }

  private submit() {
    const ask = this.ask;
    if (!ask || this.pendingId) return;
    const answers = ask.questions.map((q, i) => {
      const st = this.qs[i];
      const a: { qid: string; selected: string[]; custom?: string; note?: string } = {
        qid: q.id,
        selected: q.options.filter((o) => st.selected.has(o.label)).map((o) => o.label),
      };
      if (st.other && st.custom.trim()) a.custom = st.custom.trim();
      if (st.note.trim()) a.note = st.note.trim();
      return a;
    });
    const id = uuid();
    this.pendingId = enqueue({ t: "answer", id, target: this.target, toolCallId: ask.toolCallId, answers });
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = "Sending...";
    this.setStatus("pending", state.link?.state === "online" ? "Answering in the terminal..." : "Queued until the PC is reachable");
  }
}
