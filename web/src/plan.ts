// Native plan review (omp's plan approval): opens when a pane's `planReview` appears, shows the plan file
// (`plan_get`), its choices, the execution-model tier and feedback, and answers with `plan_answer`.
import { request } from "./bridge";
import { markdownEl } from "./md";
import { errText, isOnline } from "./omp";
import { paneTitle, state } from "./state";
import type { OkMsg, PlanChoice, PlanGetMsg, PlanReview } from "./types";
import { errorEl, Sheet, spinnerEl, toast } from "./ui";
import { h, tildify, uuid } from "./util";

/** Review ids the user closed; not auto-opened again (the banner stays). */
const dismissed = new Set<string>();
let sheet: PlanSheet | null = null;
/** Pane whose review `/plan-review` asked omp to open: shown when it arrives, even if dismissed before. */
let wanted = "";
/** Called when the sheet opens or closes (banner refresh). */
let changed = () => {};

export function initPlanReview(onChange: () => void) {
  changed = onChange;
}

/** The review id shown in an open sheet, "" when none. */
export function planOpenFor(): string {
  return sheet?.isOpen ? sheet.review.id : "";
}

export function openPlanReview(target: string, review: PlanReview) {
  if (sheet?.isOpen && sheet.review.id === review.id) return;
  sheet?.close();
  sheet = new PlanSheet(target, review);
  changed();
}

/** Sessions update: opens a new review on the watched pane once; closes a sheet whose review went away. */
export function planSync(target: string) {
  if (sheet?.isOpen) sheet.sync();
  const r = state.byTarget.get(target)?.planReview;
  if (!r || planOpenFor() === r.id || state.view !== "chat") return;
  if (wanted === target || !dismissed.has(r.id)) {
    wanted = "";
    openPlanReview(target, r);
  }
}

/** `/plan-review`: the pending review, else asks omp to open one on the newest plan file. */
export async function requestPlanReview(target: string) {
  const r = state.byTarget.get(target)?.planReview;
  if (r) return openPlanReview(target, r);
  if (!isOnline()) return toast("Offline: plan review needs the PC", "err");
  try {
    const m = await request<OkMsg>({ t: "plan_open", target }, 30_000);
    if (!m.ok) return toast(m.error || "omp could not open the plan review", "err");
    const p = state.byTarget.get(target)?.planReview;
    if (p) return openPlanReview(target, p);
    wanted = target;
    toast("Opening the plan review...");
  } catch (e) {
    toast(errText(e), "err");
  }
}

class PlanSheet {
  private readonly s: Sheet;
  private readonly planBox = h("div.pr-plan");
  private readonly feedback: HTMLTextAreaElement;
  private readonly fbWrap: HTMLElement;
  private readonly go: HTMLButtonElement;
  private readonly status = h("div.ask-status", { hidden: true });
  private choice: PlanChoice | null = null;
  private role: string;
  private answering = false;

  constructor(
    private readonly target: string,
    readonly review: PlanReview,
  ) {
    const p = state.byTarget.get(target);
    this.s = new Sheet(review.title || "Plan review", paneTitle(p, target), "tall");
    this.role = review.defaultRole ?? review.tiers?.[0]?.role ?? "";
    this.feedback = h("textarea.field.pr-fb", { rows: 3, placeholder: "What should change in the plan?", maxlength: 8000 }) as HTMLTextAreaElement;
    this.feedback.addEventListener("input", () => this.validate());
    this.fbWrap = h("div.pr-fbw", { hidden: true }, h("div.ms-lbl", { text: "Feedback" }), this.feedback);
    this.go = h("button.btn.primary.wide", { text: "Choose an option", onclick: () => void this.submit() }) as HTMLButtonElement;
    this.s.foot.hidden = false;
    this.s.foot.append(this.status, this.go);
    this.s.onClose = () => {
      if (!this.answering) dismissed.add(review.id);
      if (sheet === this) sheet = null;
      changed();
    };
    this.s.body.append(h("div.ms-sec", null, h("span", { text: "Plan" })), this.planBox, this.decision());
    this.loadPlan();
    this.validate();
  }

  get isOpen(): boolean {
    return this.s.isOpen;
  }

  close() {
    this.s.close();
  }

  sync() {
    const r = state.byTarget.get(this.target)?.planReview;
    if (r?.id === this.review.id || this.answering) return;
    this.close();
    toast("The plan review was answered or closed on the PC");
  }

  private loadPlan() {
    this.planBox.replaceChildren(spinnerEl("Loading the plan..."));
    request<PlanGetMsg>({ t: "plan_get", target: this.target, id: this.review.id }, 30_000)
      .then((m) => {
        if (!this.s.isOpen) return;
        this.planBox.replaceChildren(markdownEl(m.markdown || "*The plan file is empty.*", "md pr-md"), h("div.ms-id.pr-path", { text: tildify(m.path) }));
      })
      .catch((e) => {
        if (this.s.isOpen) this.planBox.replaceChildren(errorEl(`Couldn't load the plan: ${errText(e)}`, () => this.loadPlan()));
      });
  }

  private decision(): HTMLElement {
    const r = this.review;
    const box = h("div.pr-dec", null, h("div.ms-sec", null, h("span", { text: "Your decision" })));
    const name = `pr-${uuid().slice(0, 6)}`;
    const opts = h("div.opts");
    for (const c of r.choices) {
      const inp = h("input", { type: "radio", name }) as HTMLInputElement;
      const label = h(
        "label.opt",
        null,
        inp,
        h("span.mark"),
        h("span.opt-main", null, h("span.opt-l", { text: c.label }), c.description ? h("span.opt-d", { text: c.description }) : null),
      );
      inp.addEventListener("change", () => {
        this.choice = c;
        for (const o of opts.querySelectorAll(".opt")) o.classList.toggle("sel", o === label);
        this.fbWrap.hidden = !c.needsFeedback;
        this.validate();
        if (c.needsFeedback) setTimeout(() => this.feedback.focus(), 50);
      });
      opts.append(label);
    }
    box.append(opts, this.fbWrap);
    if (r.tiers?.length) {
      const seg = h("div.seg.ms-seg.pr-tiers");
      const sub = h("div.ms-id.pr-tier-m");
      const paint = () => {
        for (const b of seg.children) b.classList.toggle("on", (b as HTMLElement).dataset.role === this.role);
        sub.textContent = r.tiers?.find((t) => t.role === this.role)?.model ?? "";
      };
      for (const t of r.tiers)
        seg.append(
          h("button.seg-b", {
            text: t.label,
            "data-role": t.role,
            onclick: () => {
              this.role = t.role;
              paint();
            },
          }),
        );
      paint();
      box.append(h("div.ms-lbl.pr-tl", { text: "Execution model" }), seg, sub);
    }
    return box;
  }

  private validate() {
    if (this.answering) return;
    const c = this.choice;
    this.go.disabled = !c || (!!c.needsFeedback && !this.feedback.value.trim()) || !isOnline();
    this.go.textContent = c ? c.label : "Choose an option";
  }

  private async submit() {
    const c = this.choice;
    if (!c || this.answering) return;
    this.answering = true;
    this.go.disabled = true;
    this.status.hidden = false;
    this.status.className = "ask-status pending";
    this.status.replaceChildren(h("span.spin.xs"), h("span", { text: "Answering in omp..." }));
    const fb = this.feedback.value.trim();
    try {
      const msg = { t: "plan_answer", target: this.target, id: this.review.id, choice: c.id, ...(c.needsFeedback && fb ? { feedback: fb } : {}), ...(this.role ? { role: this.role } : {}) };
      const m = await request<OkMsg>(msg, 60_000);
      if (!m.ok) throw new Error(m.error || "omp did not take the answer");
      dismissed.add(this.review.id);
      toast(`Plan: ${c.label}`, "ok");
      this.close();
    } catch (e) {
      this.answering = false;
      this.status.className = "ask-status err";
      this.status.replaceChildren(h("pre", { text: errText(e) }));
      this.validate();
    }
  }
}
