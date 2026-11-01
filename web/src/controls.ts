// Chat-view session control strip (model, context, mode, tasks, side question, session menu) and the omp actions behind it.
import { bridge } from "./bridge";
import { btwChip, onBtw, openBtw } from "./btw";
import { openModelHub, openThinkingSheet } from "./models";
import { fmtTokens, isOnline, modelLabel, ompCmd, onModels, onPending, pendingFor } from "./omp";
import { requestPlanReview } from "./plan";
import { openSettings } from "./settings";
import { openCompactSheet, openHistorySheet, openRenameSheet, openRestoreSheet, openSessionInfo, openTasksSheet } from "./sheets";
import { openSketch } from "./sketch";
import { currentPane, state } from "./state";
import { openRewind, openTree } from "./tree";
import { openUsage } from "./usage";
import { confirmSheet, openMenu, toast } from "./ui";
import { h, icon, ticking } from "./util";

// ---------------------------------------------------------------- actions

function working(): boolean {
  return currentPane()?.state === "working";
}

export const actions = {
  model: () => openModelHub(),
  presets: () => openModelHub("roles"),
  effort: () => openThinkingSheet(),
  resume: () => openHistorySheet(),
  /** Sessions cut off mid-turn or closed with their terminal, every project: a checklist that reopens them. */
  restore: () => openRestoreSheet(),
  compact: () => openCompactSheet(),
  rename: () => openRenameSheet(),
  tasks: () => openTasksSheet(),
  /** Side questions; `ask` asks at once, else the sheet opens with the question box focused. */
  btw: (ask?: string) => {
    const p = currentPane();
    if (p?.agent) openBtw(p.target, ask ? { ask } : { focus: true });
  },
  planReview: () => {
    const p = currentPane();
    if (p?.agent) void requestPlanReview(p.target);
  },
  rewind: () => openRewind(),
  branch: () => openRewind(true),
  tree: () => openTree(),
  settings: () => openSettings(),
  sessionInfo: () => openSessionInfo(),
  usage: () => openUsage(),
  fast: () => {
    const on = !currentPane()?.omp?.fast;
    void ompCmd("fast", on ? "on" : "off", `Fast tier ${on ? "on" : "off"}`);
  },
  plan: async () => {
    const on = currentPane()?.omp?.mode === "plan";
    if (on && !(await confirmSheet({ title: "Leave plan mode?", text: "omp goes back to normal mode. If a plan draft exists, omp asks on the PC whether to keep it.", ok: "Leave plan mode" })))
      return;
    void ompCmd("plan", undefined, on ? "Plan mode off" : "Plan mode on");
  },
  newSession: async () => {
    if (working() && !(await confirmSheet({ title: "Start a new session?", text: "The agent is working; a new session stops the current turn. The old session stays available under Resume.", ok: "New session", danger: true })))
      return;
    void ompCmd("new", undefined, "New session started");
  },
  clear: async () => {
    if (!(await confirmSheet({ title: "Clear context?", text: "omp forgets the conversation so far and continues in the same session with an empty context. The history stays in the session file.", ok: "Clear", danger: true })))
      return;
    void ompCmd("clear", undefined, "Context cleared");
  },
  retry: () => void ompCmd("retry", undefined, "Retrying the last turn"),
  stop: async (): Promise<boolean> => {
    bridge.haptic();
    return ompCmd("stop", undefined, "Stopped");
  },
  queue: (text: string): Promise<boolean> => ompCmd("queue", text, working() ? "Queued as follow-up" : "Sent"),
  /** The sketch canvas instead of omp's `/sketch`, which would open a browser on the PC. */
  sketch: (diagram = false) => {
    const p = currentPane();
    if (p?.agent) openSketch(p.target, diagram);
  },
};

export function openSessionMenu(anchor: HTMLElement) {
  const p = currentPane();
  if (!p?.agent) return;
  const off = !isOnline();
  const busy = p.state === "working";
  const plan = p.omp?.mode === "plan";
  openMenu(anchor, [
    { label: "New session", icon: "plus", disabled: off, act: () => void actions.newSession() },
    { label: "Resume...", icon: "history", disabled: off, act: actions.resume },
    { label: "Side questions...", icon: "btw", disabled: off, act: () => actions.btw() },
    { label: "Compact...", icon: "compress", disabled: off, act: actions.compact },
    { label: "Clear context", icon: "eraser", disabled: off || busy, act: () => void actions.clear() },
    { label: "Plan mode", icon: "plan", toggle: true, on: plan, disabled: off, act: () => void actions.plan() },
    { label: "Plan review...", icon: "plan", disabled: off, act: actions.planReview },
    { label: "Retry last turn", icon: "refresh", disabled: off || busy, act: actions.retry },
    { label: "Rewind...", icon: "rewind", disabled: off, act: actions.rewind },
    { label: "Session tree...", icon: "tree", disabled: off, act: actions.tree },
    { label: "Rename...", icon: "edit", disabled: off, act: actions.rename },
    { label: "Session info", icon: "info", disabled: off, act: actions.sessionInfo },
    { label: "Usage limits...", icon: "gauge", disabled: off, act: actions.usage },
    { label: "omp settings...", icon: "sliders", disabled: off, act: actions.settings },
  ]);
}

// ---------------------------------------------------------------- strip

export class ControlStrip {
  readonly el: HTMLElement;
  private readonly model: HTMLButtonElement;
  private readonly modelName: HTMLElement;
  private readonly modelLvl: HTMLElement;
  private readonly modelFast: HTMLElement;
  private readonly ctx: HTMLButtonElement;
  private readonly ctxFill: HTMLElement;
  private readonly ctxPct: HTMLElement;
  private readonly mode: HTMLButtonElement;
  private readonly tasks: HTMLButtonElement;
  private readonly tasksText: HTMLElement;
  private readonly btw: HTMLButtonElement;
  private readonly btwMark: HTMLElement;
  private btwTopic = "";
  private readonly pend: HTMLElement;
  private readonly menu: HTMLButtonElement;
  private sig = "";

  constructor() {
    this.modelName = h("span.mc-name");
    this.modelLvl = h("span.mc-lvl");
    this.modelFast = h("span.icw.mc-fast", { html: icon("bolt"), title: "Fast tier" });
    this.model = h("button.cs-chip.mc", { "aria-label": "Model", onclick: actions.model }, this.modelName, this.modelLvl, this.modelFast) as HTMLButtonElement;
    this.ctxFill = h("span.cm-fill");
    this.ctxPct = h("span.cm-pct");
    this.ctx = h("button.cs-chip.cm", { "aria-label": "Context used" }, h("span.cm-bar", null, this.ctxFill), this.ctxPct) as HTMLButtonElement;
    this.ctx.addEventListener("click", () => {
      const c = currentPane()?.omp?.ctx;
      if (c) toast(`Context: ${fmtTokens(c.used)} of ${fmtTokens(c.window)} tokens used (${Math.round((c.used / c.window) * 100)}%)`);
    });
    this.mode = h("button.cs-chip.cs-mode", { onclick: () => currentPane()?.omp?.mode === "plan" && void actions.plan() }) as HTMLButtonElement;
    this.tasksText = h("span");
    this.tasks = h("button.cs-chip.cs-tasks", { onclick: actions.tasks }, h("span.icw", { html: icon("list") }), this.tasksText) as HTMLButtonElement;
    this.btwMark = h("span.cs-btw-mk");
    this.btw = h("button.cs-chip.cs-btw", { "aria-label": "Side question" }, h("span.icw", { html: icon("btw") }), h("span", { text: "BTW" }), this.btwMark) as HTMLButtonElement;
    this.btw.addEventListener("click", () => {
      const p = currentPane();
      if (p?.agent) openBtw(p.target, { topicId: this.btwTopic });
    });
    this.pend = h("span.cs-pend", { hidden: true, role: "status" }, h("span.spin"));
    this.menu = h("button.ib.cs-menu", { "aria-label": "Session menu", html: icon("more") }) as HTMLButtonElement;
    this.menu.addEventListener("click", () => openSessionMenu(this.menu));
    this.menu.append(this.pend);
    this.el = h("div.cstrip", { hidden: true }, this.model, this.ctx, this.mode, this.tasks, this.btw, h("span.cs-gap"), this.menu);
    onPending(() => this.update());
    onModels(() => this.update());
    onBtw(() => this.update());
  }

  /** Cheap: rewrites only when the visible facts changed. */
  update() {
    const p = currentPane();
    const show = state.view === "chat" && !!p?.agent;
    const o = p?.omp;
    const online = isOnline();
    const pend = p ? pendingFor(p.target) : undefined;
    const btw = p ? btwChip(p.target) : null;
    const sig = show ? JSON.stringify([p!.target, o, online, pend?.label, p!.state, btw]) : "";
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.hidden = !show;
    if (!show || !p) return;

    this.model.hidden = !o;
    this.ctx.hidden = !o?.ctx;
    this.mode.hidden = !o || !o.mode || o.mode === "none";
    this.tasks.hidden = !o?.todo;
    this.btw.hidden = !btw;
    this.btwTopic = btw?.topicId ?? "";
    if (btw) {
      this.btw.classList.toggle("run", btw.running);
      this.btw.title = btw.running ? "A side question is running" : "Side answer ready";
      this.btwMark.replaceChildren(btw.running ? ticking(h("span.spin.xs")) : h("span.cs-dot"));
    }
    for (const b of [this.model, this.ctx, this.mode, this.tasks, this.menu]) b.disabled = !online;
    this.pend.hidden = !pend;
    this.menu.classList.toggle("pending", !!pend);
    if (pend) {
      this.pend.title = pend.label;
      this.pend.setAttribute("aria-label", pend.label);
    }
    if (!o) return;

    this.modelName.textContent = modelLabel(o);
    this.modelLvl.textContent = o.thinking ? `\u00b7 ${o.thinking}` : "";
    this.modelLvl.hidden = !o.thinking;
    this.modelFast.hidden = !o.fast;
    if (o.ctx) {
      const pct = o.ctx.window > 0 ? Math.min(100, Math.round((o.ctx.used / o.ctx.window) * 100)) : 0;
      this.ctxFill.style.transform = `scaleX(${pct / 100})`;
      this.ctxPct.textContent = `${pct}%`;
      this.ctx.className = `cs-chip cm${pct >= 90 ? " crit" : pct >= 70 ? " warn" : ""}`;
    }
    if (o.mode && o.mode !== "none") {
      this.mode.textContent = o.mode === "plan" ? "Plan" : o.mode === "plan_paused" ? "Plan paused" : o.mode;
      this.mode.className = `cs-chip cs-mode${o.mode.startsWith("plan") ? " plan" : ""}${o.mode === "plan_paused" ? " paused" : ""}`;
    }
    if (o.todo) this.tasksText.textContent = `Tasks ${o.todo.done}/${o.todo.total}`;
  }
}
