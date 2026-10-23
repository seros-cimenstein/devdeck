// Native sheets for omp session controls: model/thinking, session history, tasks, compact, rename.
import { request } from "./bridge";
import {
  currentModel,
  fmtTokens,
  isOnline,
  levelLabel,
  levelsFor,
  modelsCached,
  type ModelsData,
  onModels,
  ompCmd,
  pickLevel,
  refreshModels,
  runCmd,
  shortName,
  THINKING_LEVELS,
} from "./omp";
import { currentPane, paneTitle, state } from "./state";
import type { HistoryMsg, HistorySession, ModelInfo, OmpInfo, Pane } from "./types";
import { confirmSheet, errorEl, Sheet, spinnerEl, toast } from "./ui";
import { fmtAgo, h, icon, tildify } from "./util";

// ---------------------------------------------------------------- model + thinking

interface RoleChoice {
  model: ModelInfo;
  roles: string[];
  level: string;
}

function parseRoles(d: ModelsData, find: (sel: string) => ModelInfo | undefined): RoleChoice[] {
  const out = new Map<string, RoleChoice>();
  for (const [role, spec] of Object.entries(d.roles)) {
    const i = spec.lastIndexOf(":");
    const suffix = i > 0 ? spec.slice(i + 1) : "";
    const known = THINKING_LEVELS.includes(suffix) || suffix === "auto";
    const sel = known ? spec.slice(0, i) : spec;
    const m = find(sel);
    if (!m) continue;
    const c = out.get(sel);
    if (c) c.roles.push(role);
    else out.set(sel, { model: m, roles: [role], level: known ? suffix : "" });
  }
  return [...out.values()].sort((a, b) => Number(b.roles.includes("default")) - Number(a.roles.includes("default")) || b.roles.length - a.roles.length);
}

/** Quick session-only model switch (mode "model") or thinking-level change (mode "effort"). */
export function openModelSheet(mode: "model" | "effort") {
  const p = currentPane();
  if (!p?.agent) return;
  new ModelSheet(p, mode);
}

class ModelSheet {
  private readonly s: Sheet;
  private readonly target: string;
  private readonly list = h("div.ms-list");
  private readonly rolesEl = h("div.ms-roles");
  private readonly search = h("input.ms-q", { type: "search", placeholder: "Search models", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  private readonly footMain = h("div.ms-foot");
  private readonly applyBtn = h("button.btn.primary.wide") as HTMLButtonElement;
  private readonly statusEl = h("div.ms-status", { hidden: true });
  private rows: { el: HTMLElement; m: ModelInfo; hay: string }[] = [];
  private groups: { el: HTMLElement; rows: HTMLElement[]; count: HTMLElement }[] = [];
  private sel: ModelInfo | undefined;
  private level = "";
  private fast = false;
  private busy = false;
  private offModels: () => void;

  constructor(
    p: Pane,
    private readonly mode: "model" | "effort",
  ) {
    this.target = p.target;
    this.s = new Sheet(mode === "effort" ? "Thinking level" : "Model", paneTitle(p), mode === "effort" ? "small" : "models");
    if (mode === "model") {
      const link = h(
        "button.ms-link",
        {
          onclick: () => {
            this.s.close();
            void ompCmd("page", "/model");
          },
        },
        h("span.icw", { html: icon("plan") }),
        h("span", { text: "Open omp's full model page (roles, defaults)" }),
        h("span.icw", { html: icon("chev") }),
      );
      this.search.addEventListener("input", () => this.filter());
      this.s.body.append(h("div.ms-top", null, h("div.ms-search", null, h("span.icw", { html: icon("search") }), this.search)), this.rolesEl, link, this.list);
    }
    this.s.foot.hidden = false;
    this.s.foot.append(this.footMain, this.statusEl, this.applyBtn);
    this.applyBtn.addEventListener("click", () => void this.apply());
    this.offModels = onModels((d) => this.load(d));
    this.s.onClose = () => this.offModels();

    const o = this.omp();
    this.fast = !!o?.fast;
    const cached = modelsCached();
    if (cached) this.load(cached);
    else {
      this.list.append(spinnerEl("Loading models..."));
      this.renderFoot();
    }
    refreshModels().catch((e: Error) => {
      if (modelsCached() || !this.s.isOpen) return;
      this.list.textContent = "";
      this.list.append(errorEl(`Couldn't load the model list: ${e.message}`, () => {
        this.list.textContent = "";
        this.list.append(spinnerEl("Loading models..."));
        refreshModels(true).catch((err: Error) => toast(err.message, "err"));
      }));
    });
  }

  private omp(): OmpInfo | undefined {
    return state.byTarget.get(this.target)?.omp;
  }

  private load(d: ModelsData) {
    const o = this.omp();
    const cur = currentModel(o);
    if (!this.sel || !d.models.some((m) => m.selector === this.sel!.selector)) {
      this.sel = cur;
      this.level = pickLevel(levelsFor(cur), o?.thinking);
    }
    if (this.mode === "model") this.renderList(d, cur);
    this.renderFoot();
  }

  private renderList(d: ModelsData, cur: ModelInfo | undefined) {
    const find = (s: string) => d.models.find((m) => m.selector === s);
    this.rolesEl.textContent = "";
    const roles = parseRoles(d, find);
    if (roles.length) {
      const row = h("div.ms-chips");
      for (const r of roles) {
        const chip = h(
          `button.ms-chip${r.model.selector === cur?.selector ? ".cur" : ""}`,
          { "data-sel": r.model.selector },
          h("span.ms-chip-n", { text: shortName(r.model.name) + (r.level ? ` · ${r.level}` : "") }),
          h("span.ms-chip-r", { text: r.roles.join(", ") }),
        );
        chip.addEventListener("click", () => this.select(r.model, r.level || undefined));
        row.append(chip);
      }
      this.rolesEl.append(h("div.ms-sec", { text: "Roles" }), row);
    }

    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of d.models) {
      const l = byProvider.get(m.provider);
      if (l) l.push(m);
      else byProvider.set(m.provider, [m]);
    }
    const providers = [...byProvider.keys()];
    if (cur) providers.sort((a, b) => Number(b === cur.provider) - Number(a === cur.provider));
    const frag = document.createDocumentFragment();
    this.rows = [];
    this.groups = [];
    for (const prov of providers) {
      const models = byProvider.get(prov)!;
      const count = h("span.count", { text: String(models.length) });
      const g = h("section.ms-group", null, h("div.ms-sec", null, h("span", { text: prov }), count));
      const gRows: HTMLElement[] = [];
      for (const m of models) {
        const isCur = m.selector === cur?.selector;
        const el = h(
          `button.ms-row${isCur ? ".cur" : ""}${m.selector === this.sel?.selector ? ".sel" : ""}`,
          { "data-sel": m.selector },
          h("span.ms-main", null, h("span.ms-name", { text: m.name }), h("span.ms-id", { text: m.id })),
          m.contextWindow ? h("span.ms-ctx", { text: fmtTokens(m.contextWindow) }) : null,
          isCur ? h("span.ms-cur", { text: "Current" }) : null,
        );
        el.addEventListener("click", () => this.select(m));
        this.rows.push({ el, m, hay: `${m.name} ${m.id} ${m.provider}`.toLowerCase() });
        gRows.push(el);
        g.append(el);
      }
      this.groups.push({ el: g, rows: gRows, count });
      frag.append(g);
    }
    this.list.textContent = "";
    this.list.append(frag, h("div.empty.ms-none", { text: "No models match", hidden: true }));
    this.filter();
    const selEl = this.list.querySelector<HTMLElement>(".ms-row.sel");
    if (selEl && !this.search.value) requestAnimationFrame(() => selEl.scrollIntoView({ block: "center" }));
  }

  private filter() {
    const terms = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const r of this.rows) r.el.hidden = !terms.every((t) => r.hay.includes(t));
    for (const g of this.groups) {
      const vis = g.rows.reduce((n, r) => n + Number(!r.hidden), 0);
      g.el.hidden = !vis;
      g.count.textContent = String(vis);
      any ||= vis > 0;
    }
    this.rolesEl.hidden = terms.length > 0;
    const none = this.list.querySelector<HTMLElement>(".ms-none");
    if (none) none.hidden = any || !this.rows.length;
  }

  private select(m: ModelInfo, level?: string) {
    this.sel = m;
    const levels = levelsFor(m);
    this.level = pickLevel(levels, level ?? (this.level || this.omp()?.thinking));
    for (const r of this.rows) r.el.classList.toggle("sel", r.m === m || r.m.selector === m.selector);
    this.renderFoot();
  }

  private renderFoot() {
    const f = this.footMain;
    f.textContent = "";
    const m = this.sel;
    const o = this.omp();
    if (!m) {
      f.append(h("div.ms-pick", { text: modelsCached() ? (o?.model || o?.modelName ? "Current model is not in the list" : "Pick a model") : "Loading..." }));
    } else {
      f.append(
        h(
          "div.ms-selrow",
          null,
          h("span.ms-main", null, h("span.ms-name", { text: m.name }), h("span.ms-id", { text: m.selector })),
          m.contextWindow ? h("span.ms-ctx", { text: `${fmtTokens(m.contextWindow)} ctx` }) : null,
        ),
      );
      const levels = levelsFor(m);
      if (levels.length) {
        const seg = h("div.seg.ms-seg");
        for (const l of levels) {
          const b = h(`button.seg-b${l === this.level ? ".on" : ""}`, { text: levelLabel(l), "aria-pressed": String(l === this.level) });
          b.addEventListener("click", () => {
            this.level = l;
            this.renderFoot();
          });
          seg.append(b);
        }
        f.append(h("div.ms-lbl", { text: "Thinking" }), seg);
      } else f.append(h("div.ms-lbl.muted", { text: "No thinking levels for this model" }));
    }
    const sw = h(`span.switch${this.fast ? ".on" : ""}`);
    const fastRow = h("button.ms-fast", { role: "switch", "aria-checked": String(this.fast) }, h("span.icw", { html: icon("bolt") }), h("span.ms-fast-l", null, h("span", { text: "Fast tier" }), h("span.ms-fast-d", { text: "Priority processing where the provider offers it" })), sw);
    fastRow.addEventListener("click", () => {
      this.fast = !this.fast;
      this.renderFoot();
    });
    f.append(fastRow);
    this.updateApply();
  }

  /** What "apply" would run against the pane's current state. */
  private plan(): { label: string; steps: [cmd: "switch" | "effort" | "fast", arg: string][] } {
    const o = this.omp();
    const cur = currentModel(o);
    const m = this.sel;
    const steps: [cmd: "switch" | "effort" | "fast", arg: string][] = [];
    if (!m) return { label: "Pick a model", steps };
    const fastChanged = this.fast !== !!o?.fast;
    const fastStep: [cmd: "fast", arg: string] = ["fast", this.fast ? "on" : "off"];
    if (m.selector !== cur?.selector) {
      steps.push(["switch", this.level ? `${m.selector}:${this.level}` : m.selector]);
      if (fastChanged) steps.push(fastStep);
      return { label: "Switch for this session", steps };
    }
    const levelChanged = !!this.level && this.level !== o?.thinking;
    if (levelChanged) steps.push(["effort", this.level]);
    if (fastChanged) steps.push(fastStep);
    if (levelChanged && fastChanged) return { label: "Apply", steps };
    if (levelChanged) return { label: `Set thinking to ${levelLabel(this.level)}`, steps };
    if (fastChanged) return { label: `Turn fast tier ${this.fast ? "on" : "off"}`, steps };
    return { label: "No changes", steps };
  }

  private updateApply() {
    if (this.busy) return;
    const { label, steps } = this.plan();
    const online = isOnline();
    this.applyBtn.textContent = online ? label : "Offline";
    this.applyBtn.disabled = !online || !steps.length;
  }

  private async apply() {
    const { steps } = this.plan();
    if (!steps.length || this.busy) return;
    this.busy = true;
    this.applyBtn.disabled = true;
    this.applyBtn.textContent = "";
    this.applyBtn.append(h("span.spin.xs"), h("span", { text: steps[0][0] === "switch" ? "Switching..." : "Applying..." }));
    this.statusEl.hidden = true;
    try {
      for (const [cmd, arg] of steps) await runCmd(this.target, cmd, arg);
      const m = this.sel!;
      toast(`${shortName(m.name)}${this.level ? ` · ${this.level}` : ""}${this.fast ? " · fast" : ""}`, "ok");
      this.s.close();
    } catch (e) {
      this.statusEl.hidden = false;
      this.statusEl.textContent = (e as Error).message;
      toast((e as Error).message, "err");
    } finally {
      this.busy = false;
      this.updateApply();
    }
  }
}

// ---------------------------------------------------------------- history (resume)

export function openHistorySheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const target = p.target;
  const s = new Sheet("Resume session", tildify(p.omp?.cwd || p.cwd));
  const load = () => {
    s.body.textContent = "";
    s.body.append(spinnerEl("Loading sessions..."));
    request<HistoryMsg>({ t: "history", target }, 30_000)
      .then((m) => {
        if (!s.isOpen) return;
        if (m.cwd) s.setSub(tildify(m.cwd));
        s.body.textContent = "";
        if (!m.sessions?.length) {
          s.body.append(h("div.empty", { text: "No earlier sessions in this folder" }));
          return;
        }
        const list = h("div.hs-list");
        for (const it of m.sessions) list.append(historyRow(it, target, s));
        s.body.append(list);
      })
      .catch((e: Error) => {
        if (!s.isOpen) return;
        s.body.textContent = "";
        s.body.append(errorEl(e.message, load));
      });
  };
  load();
}

function historyRow(it: HistorySession, target: string, s: Sheet): HTMLElement {
  const meta = h("span.hs-meta", null, h("span", { text: fmtAgo(it.mtime) }));
  if (it.pinned) meta.prepend(h("span.icw.hs-pin", { html: icon("pin"), title: "Pinned" }));
  if (it.current) meta.append(h("span.tag.acc", { text: "Current" }));
  else if (it.live) meta.append(h("span.tag.live", { text: "Live" }));
  const row = h(
    `button.hs-row${it.current ? ".cur" : ""}`,
    null,
    h("span.hs-top", null, h("span.hs-title", { text: it.title || "Untitled session" }), meta),
    it.recap ? h("span.hs-recap", { text: it.recap }) : null,
  );
  row.addEventListener("click", async () => {
    if (it.current) return toast("This is the session that is open now");
    const p = state.byTarget.get(target);
    const working = p?.state === "working";
    if (working || it.live) {
      const ok = await confirmSheet({
        title: "Resume this session?",
        text: [
          working ? "The agent is working; switching sessions stops the current turn." : "",
          it.live ? "It is open in another terminal, so omp resumes a copy of it here." : "",
        ]
          .filter(Boolean)
          .join(" "),
        ok: "Resume",
        danger: working,
      });
      if (!ok) return;
    }
    row.classList.add("busy");
    row.append(h("span.spin.xs.hs-spin"));
    try {
      const m = await runCmd(target, "resume", it.id);
      toast(m.info || `Resumed: ${it.title || "session"}`, "ok");
      s.close();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      row.classList.remove("busy");
      row.querySelector(".hs-spin")?.remove();
    }
  });
  return row;
}

// ---------------------------------------------------------------- tasks

interface TodoItem {
  done: boolean;
  active: boolean;
  text: string;
}
interface TodoPhase {
  name: string;
  items: TodoItem[];
}

/** Parses omp's todo tool output (phase headers + `- [X]`/`- [ ]` rows); empty when the format is unknown. */
function parseTodo(text: string): TodoPhase[] {
  const phases: TodoPhase[] = [];
  let cur: TodoPhase | null = null;
  for (const line of text.split("\n")) {
    const item = /^\s*- \[([ xX])\] (.*)$/.exec(line);
    if (item) {
      if (!cur) phases.push((cur = { name: "", items: [] }));
      const active = /\s\(in progress\)$/.test(item[2]);
      cur.items.push({ done: item[1] !== " ", active, text: active ? item[2].replace(/\s\(in progress\)$/, "") : item[2] });
      continue;
    }
    const ph = /^ {2}(\S.*):$/.exec(line);
    if (ph) phases.push((cur = { name: ph[1], items: [] }));
  }
  return phases.filter((p) => p.items.length);
}

export function openTasksSheet() {
  const p = currentPane();
  const todo = p?.omp?.todo;
  if (!p || !todo) return;
  const s = new Sheet("Tasks", `${todo.done}/${todo.total} done · ${paneTitle(p)}`);
  const phases = parseTodo(todo.text);
  if (!phases.length) {
    s.body.append(h("pre.todo-raw", { text: todo.text }));
    return;
  }
  const box = h("div.todo");
  for (const ph of phases) {
    const done = ph.items.filter((i) => i.done).length;
    if (ph.name) box.append(h("div.ms-sec", null, h("span", { text: ph.name }), h("span.count", { text: `${done}/${ph.items.length}` })));
    for (const it of ph.items)
      box.append(
        h(
          `div.todo-it${it.done ? ".done" : ""}${it.active ? ".active" : ""}`,
          null,
          h("span.todo-mk", { html: it.done ? icon("check") : "" }),
          h("span.todo-t", { text: it.text }),
        ),
      );
  }
  s.body.append(box);
}

// ---------------------------------------------------------------- compact / rename

export function openCompactSheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const s = new Sheet("Compact context", paneTitle(p), "small");
  const ctx = p.omp?.ctx;
  const focus = h("textarea.field", { rows: 2, placeholder: "Focus (optional): what the summary should keep", maxlength: 500 }) as HTMLTextAreaElement;
  s.body.append(h("p.sheet-text", { text: "omp summarises the conversation so far and continues from the summary. This runs a model call on the PC and can take a minute." }));
  if (ctx) s.body.append(h("p.sheet-text.muted", { text: `Context now: ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.window)} tokens (${Math.round((ctx.used / ctx.window) * 100)}%)` }));
  s.body.append(focus);
  if (p.state === "working") s.body.append(h("p.sheet-warn", { text: "The agent is working: compacting now stops the current turn." }));
  const go = h(`button.btn.primary.wide${p.state === "working" ? ".danger" : ""}`, { text: "Compact" }) as HTMLButtonElement;
  go.disabled = !isOnline();
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "";
    go.append(h("span.spin.xs"), h("span", { text: "Starting..." }));
    const ok = await ompCmd("compact", focus.value.trim().replace(/\s+/g, " ") || undefined, "Compacting...");
    if (ok) s.close();
    else {
      go.disabled = false;
      go.textContent = "Compact";
    }
  });
  s.foot.hidden = false;
  s.foot.append(go);
}

export function openRenameSheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const s = new Sheet("Rename session", paneTitle(p), "small");
  const input = h("input.field", { type: "text", placeholder: "Session title", maxlength: 120, enterkeyhint: "done" }) as HTMLInputElement;
  const go = h("button.btn.primary.wide", { text: "Rename" }) as HTMLButtonElement;
  const sync = () => (go.disabled = !input.value.trim() || !isOnline());
  const submit = async () => {
    const title = input.value.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return;
    go.disabled = true;
    go.textContent = "";
    go.append(h("span.spin.xs"), h("span", { text: "Renaming..." }));
    try {
      const m = await runCmd(p.target, "rename", title);
      toast(`Renamed: ${m.info || title}`, "ok");
      s.close();
    } catch (e) {
      toast((e as Error).message, "err");
      go.textContent = "Rename";
      sync();
    }
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  go.addEventListener("click", () => void submit());
  sync();
  s.body.append(input, h("p.sheet-text.muted.rn-hint", { text: "omp may reformat the title (it runs a short model call)." }));
  s.foot.hidden = false;
  s.foot.append(go);
  setTimeout(() => input.focus(), 320);
}
