// Model hub (parity with omp's /model hub): models with search/kind/provider filters, per-model detail with
// session switch, role assignment, fallback chain and compaction limit; roles, chains, cycle order, presets.
import {
  currentModel,
  findModel,
  fmtTokens,
  isOnline,
  levelLabel,
  levelsFor,
  modelsCached,
  onModels,
  onRoles,
  ompCmd,
  pickLevel,
  presetsValue,
  refreshModels,
  refreshRoles,
  roleValues,
  rolesBase,
  rolesCached,
  runCmd,
  setRoles,
  shortName,
  THINKING_LEVELS,
} from "./omp";
import { currentPane, paneTitle, state } from "./state";
import type { ModelInfo, Pane, Preset, RoleState, RolesKey, RolesMsg } from "./types";
import { confirmSheet, errorEl, openMenu, Sheet, spinnerEl, toast } from "./ui";
import { fmtAgo, fmtRtt, h, icon } from "./util";

// ---------------------------------------------------------------- display helpers

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  "github-copilot": "GitHub Copilot",
  "google-antigravity": "Google Antigravity",
  google: "Google",
  nvidia: "NVIDIA",
  "opencode-go": "OpenCode Go",
  xai: "xAI",
  openrouter: "OpenRouter",
};

function providerName(p: string): string {
  return PROVIDER_NAMES[p] ?? p.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const KIND_LABEL: Record<string, string> = { chat: "Chat", tiny: "Tiny", image: "Image", tts: "TTS", stt: "STT", search: "Search", judge: "Judge", embedding: "Embedding" };
const KIND_ORDER = Object.keys(KIND_LABEL);
function kindLabel(k: string): string {
  return KIND_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
}
function kindRank(k: string): number {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
}

const LEVEL_GLYPH: Record<string, string> = { off: "\u25cb", minimal: "\u25d4", low: "\u25d4", medium: "\u25d1", high: "\u25d5", xhigh: "\u25cf", max: "\u25cf", auto: "\u25d0", inherit: "\u21b0" };
/** Suffixes a role value may carry after the selector. */
const ROLE_LEVELS = [...THINKING_LEVELS, "auto", "inherit"];
const RECENT_MS = 30 * 86_400_000;

/** Lowercase letters and digits only: `opus55` matches `claude-opus-5-5`. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "provider/id:high" → ["provider/id", "high"]; ids may contain ":" themselves, so only known levels split. */
function splitSpec(spec: string): [sel: string, level: string] {
  const i = spec.lastIndexOf(":");
  const lvl = i > 0 ? spec.slice(i + 1) : "";
  return ROLE_LEVELS.includes(lvl) ? [spec.slice(0, i), lvl] : [spec, ""];
}

function fmtPrice(n: number): string {
  return `$${+n.toFixed(n < 1 ? 3 : 2)}`;
}

function priceText(p: ModelInfo["price"]): string {
  if (!p) return "";
  return p.input === 0 && p.output === 0 ? "free" : `${fmtPrice(p.input)}/${fmtPrice(p.output)}`;
}

/** `🧠 58 · 1.7s · 86 t/s · 1M · vision · $4/$20`, missing parts omitted. */
function metaLine(m: ModelInfo): string {
  const u = m.usage;
  return [
    m.int != null ? `\u{1f9e0} ${Math.round(m.int)}` : "",
    fmtRtt(u?.ttft),
    u?.tps ? `${Math.round(u.tps)} t/s` : "",
    m.contextWindow ? fmtTokens(m.contextWindow) : "",
    m.vision ? "vision" : "",
    priceText(m.price),
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

/** Whether `r` can be assigned `m`: its kinds; a search-capable role takes chat models only with web search. */
function acceptsModel(r: RoleState, m: ModelInfo): boolean {
  return r.accepts.includes(m.kind) && !(m.kind === "chat" && r.accepts.includes("search") && !m.webSearch);
}

/** A ":level" suffix applies only to roles taking thinking while their model is a chat model. */
function takesLevel(r: RoleState, m: ModelInfo | undefined): boolean {
  return r.thinking && m?.kind === "chat";
}

function roleModelText(r: RoleState): string {
  if (!r.value) return r.auto === "built-in" || !r.auto ? "auto \u00b7 built-in" : `auto \u2192 ${r.auto}`;
  const m = findModel(r.selector);
  return m ? shortName(m.name) : r.selector ?? r.value;
}

function moved<T>(list: T[], i: number, d: number): T[] {
  const out = [...list];
  [out[i], out[i + d]] = [out[i + d], out[i]];
  return out;
}

const sec = (title: string, count?: number) =>
  h("div.ms-sec", null, h("span", { text: title }), count != null ? h("span.count", { text: String(count) }) : null);

function iconBtn(name: string, label: string, disabled: boolean, act: () => void): HTMLElement {
  return h("button.ib.mh-ib", { "aria-label": label, title: label, html: icon(name), disabled, onclick: act });
}

function toggleRow(label: string, desc: string, on: boolean, disabled: boolean, act: () => void, ic = ""): HTMLElement {
  return h(
    "button.ms-fast.mh-tog",
    { role: "switch", "aria-checked": String(on), disabled, onclick: act },
    ic ? h("span.icw", { html: icon(ic) }) : null,
    h("span.ms-fast-l", null, h("span", { text: label }), desc ? h("span.ms-fast-d", { text: desc }) : null),
    h(`span.switch${on ? ".on" : ""}`),
  );
}

const projectNotice = () =>
  h("p.sheet-warn.mh-note", { text: "Roles are stored in this project's omp config (modelRoleStorage: project): change them on the PC." });

interface AskTextOpts {
  title: string;
  placeholder: string;
  ok: string;
  hint: string;
  /** Error text for an invalid value, "" when valid. */
  check: (v: string) => string;
}
/** Small one-field sheet; resolves with the trimmed value, or null when dismissed. */
function askText(o: AskTextOpts): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const s = new Sheet(o.title, "", "small");
  const input = h("input.field", { type: "text", placeholder: o.placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "done" }) as HTMLInputElement;
  const err = h("p.sheet-warn", { hidden: true });
  const submit = () => {
    const v = input.value.trim();
    const e = o.check(v);
    err.textContent = e;
    err.hidden = !e;
    if (e) return;
    resolve(v);
    s.close();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  s.body.append(input, h("p.sheet-text.muted.rn-hint", { text: o.hint }), err);
  s.foot.hidden = false;
  s.foot.append(h("button.btn.primary.wide", { text: o.ok, onclick: submit }));
  s.onClose = () => resolve(null);
  setTimeout(() => input.focus(), 320);
  return promise;
}

// ---------------------------------------------------------------- session switch (/switch, /effort, /fast)

type Step = [cmd: "switch" | "effort" | "fast", arg: string];

/** Thinking level + fast tier for one model in an omp pane; `applyBtn` runs the needed commands. */
class SessionControl {
  readonly el = h("div.mh-sess");
  readonly applyBtn = h("button.btn.primary.wide") as HTMLButtonElement;
  level: string;
  private fast: boolean;
  private busy = false;

  constructor(
    private readonly target: string,
    private readonly m: ModelInfo | undefined,
    private readonly done: () => void,
    private readonly onLevel?: () => void,
  ) {
    const o = this.omp();
    this.fast = !!o?.fast;
    this.level = pickLevel(levelsFor(m), o?.thinking);
    this.applyBtn.addEventListener("click", () => void this.apply());
    this.render();
  }

  private omp() {
    return state.byTarget.get(this.target)?.omp;
  }

  private render() {
    const levels = levelsFor(this.m);
    const kids: HTMLElement[] = [];
    if (levels.length) {
      const seg = h("div.seg.ms-seg");
      for (const l of levels)
        seg.append(
          h(`button.seg-b${l === this.level ? ".on" : ""}`, {
            text: levelLabel(l),
            "aria-pressed": String(l === this.level),
            onclick: () => {
              this.level = l;
              this.render();
              this.onLevel?.();
            },
          }),
        );
      kids.push(h("div.ms-lbl", { text: "Thinking" }), seg);
    } else kids.push(h("div.ms-lbl.muted", { text: this.m ? "No thinking levels for this model" : "The current model is not in the list" }));
    kids.push(
      toggleRow("Fast tier", "Priority processing where the provider offers it", this.fast, false, () => {
        this.fast = !this.fast;
        this.render();
      }, "bolt"),
    );
    this.el.replaceChildren(...kids);
    this.updateApply();
  }

  /** What "apply" would run against the pane's current state. */
  private plan(): { label: string; steps: Step[] } {
    const o = this.omp();
    const cur = currentModel(o);
    const m = this.m;
    const steps: Step[] = [];
    if (!m) return { label: "Pick a model", steps };
    const fastChanged = this.fast !== !!o?.fast;
    const fastStep: Step = ["fast", this.fast ? "on" : "off"];
    if (m.selector !== cur?.selector) {
      // `auto` is a session-only effort, so it follows the switch as its own step.
      if (this.level === "auto") steps.push(["switch", m.selector], ["effort", "auto"]);
      else steps.push(["switch", this.level ? `${m.selector}:${this.level}` : m.selector]);
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
    this.applyBtn.replaceChildren(h("span.spin.xs"), h("span", { text: steps[0][0] === "switch" ? "Switching..." : "Applying..." }));
    try {
      for (const [cmd, arg] of steps) await runCmd(this.target, cmd, arg);
      toast(`${shortName(this.m!.name)}${this.level ? ` \u00b7 ${this.level}` : ""}${this.fast ? " \u00b7 fast" : ""}`, "ok");
      this.done();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      this.busy = false;
      this.updateApply();
    }
  }
}

/** Quick thinking-level (and fast tier) sheet for the current pane's model. */
export function openThinkingSheet() {
  const p = currentPane();
  if (!p?.agent) return;
  const target = p.target;
  const s = new Sheet("Thinking level", paneTitle(p), "small");
  s.foot.hidden = false;
  const fill = () => {
    const m = currentModel(state.byTarget.get(target)?.omp);
    const sc = new SessionControl(target, m, () => s.close());
    s.body.replaceChildren(sc.el);
    if (m) s.body.prepend(h("div.ms-selrow", null, h("span.ms-main", null, h("span.ms-name", { text: m.name }), h("span.ms-id", { text: m.selector }))));
    s.foot.replaceChildren(sc.applyBtn);
  };
  s.onClose = onModels(fill);
  if (modelsCached()) fill();
  else s.body.append(spinnerEl("Loading models..."));
  refreshModels().catch((e: Error) => {
    if (!s.isOpen || modelsCached()) return;
    fill();
    s.body.prepend(errorEl(`Couldn't load the model list: ${e.message}`));
  });
}

// ---------------------------------------------------------------- model list (search, filters, sections)

interface ListHost {
  cur(): ModelInfo | undefined;
  /** Role badges for a model, e.g. `default·high`. */
  badges(m: ModelInfo): string[];
  pick(m: ModelInfo): void;
}

/** One list row: a model, or the same model (name + kind) offered by several providers. */
interface Unit {
  key: string;
  ms: ModelInfo[];
  /** The row's numbers: the most used member, else the first. */
  m: ModelInfo;
  last: number;
}

function unitOf(ms: ModelInfo[]): Unit {
  let m = ms[0];
  let last = 0;
  for (const x of ms) {
    if ((x.usage?.count ?? 0) > (m.usage?.count ?? 0)) m = x;
    last = Math.max(last, x.usage?.last ?? 0);
  }
  return { key: ms.map((x) => x.selector).join("|"), ms, m, last };
}

function byUse(a: ModelInfo, b: ModelInfo): number {
  return (b.usage?.count ?? 0) - (a.usage?.count ?? 0) || (b.int ?? -1) - (a.int ?? -1) || a.name.localeCompare(b.name);
}

function isSubsequence(hay: string, q: string): boolean {
  let i = 0;
  for (const c of hay) if (c === q[i] && ++i === q.length) return true;
  return false;
}

class ModelList {
  readonly el: HTMLElement;
  private readonly q = h("input.ms-q", { type: "search", placeholder: "Search models", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  private readonly chips = h("div.mh-chips");
  private readonly list = h("div.mh-list", null, spinnerEl("Loading models..."));
  private all: ModelInfo[] = [];
  /** Normalized [name, id, selector+name+provider] per model, for search. */
  private keys = new Map<ModelInfo, [string, string, string]>();
  /** Built rows by unit key; dropped when models, roles or the current model change. */
  private rows = new Map<string, HTMLElement>();
  private kind: string | null = null;
  private provider = "";
  private more = false;

  constructor(
    private readonly host: ListHost,
    private readonly filter?: (m: ModelInfo) => boolean,
  ) {
    this.q.addEventListener("input", () => this.render());
    this.el = h("div.mh-ml", null, h("div.ms-top", null, h("div.ms-search", null, h("span.icw", { html: icon("search") }), this.q), this.chips), this.list);
  }

  setData(models: ModelInfo[]) {
    this.all = this.filter ? models.filter(this.filter) : models;
    this.keys = new Map(this.all.map((m) => [m, [norm(m.name), norm(m.id), norm(m.selector + m.name + providerName(m.provider))]]));
    if (this.kind === null) this.kind = this.all.some((m) => m.kind === "chat") ? "chat" : "";
    this.refresh();
  }

  refresh() {
    this.rows.clear();
    this.renderChips();
    this.render();
  }

  private chip(label: string, n: number, on: boolean, act: () => void): HTMLElement {
    return h(`button.mh-chip${on ? ".on" : ""}`, { "aria-pressed": String(on), onclick: act }, h("span", { text: label }), h("span.n", { text: String(n) }));
  }

  private renderChips() {
    const counts = new Map<string, number>();
    for (const m of this.all) if (!this.provider || m.provider === this.provider) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
    if (this.kind && !counts.has(this.kind)) this.kind = "";
    const kinds = [...counts.keys()].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
    const kids: HTMLElement[] = [];
    const setKind = (k: string) => {
      this.kind = k;
      this.refresh();
    };
    if (kinds.length > 1) {
      kids.push(this.chip("All", [...counts.values()].reduce((a, b) => a + b, 0), !this.kind, () => setKind("")));
      for (const k of kinds) kids.push(this.chip(kindLabel(k), counts.get(k)!, this.kind === k, () => setKind(k)));
    }
    const prov = h(
      `button.mh-chip.mh-prov${this.provider ? ".on" : ""}`,
      null,
      h("span", { text: this.provider ? providerName(this.provider) : "All providers" }),
      h("span.icw", { html: icon("chevDown") }),
    );
    prov.addEventListener("click", () => this.providerMenu(prov));
    kids.push(prov);
    this.chips.replaceChildren(...kids);
  }

  private providerMenu(anchor: HTMLElement) {
    const counts = new Map<string, number>();
    for (const m of this.all) if (!this.kind || m.kind === this.kind) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
    const curProv = this.host.cur()?.provider;
    const setProv = (p: string) => {
      this.provider = p;
      this.refresh();
    };
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    openMenu(anchor, [
      { label: `All providers \u00b7 ${total}`, icon: this.provider ? undefined : "check", act: () => setProv("") },
      ...[...counts.keys()]
        .sort((a, b) => Number(b === curProv) - Number(a === curProv) || providerName(a).localeCompare(providerName(b)))
        .map((p) => ({
          label: `${providerName(p)} \u00b7 ${counts.get(p)}${p === curProv ? " \u00b7 current" : ""}`,
          icon: p === this.provider ? "check" : undefined,
          act: () => setProv(p),
        })),
    ]);
  }

  private render() {
    if (this.kind === null) return; // no data yet: keep the spinner
    const q = norm(this.q.value);
    const inProv = (m: ModelInfo) => !this.provider || m.provider === this.provider;
    const pool = this.all.filter((m) => (!this.kind || m.kind === this.kind) && inProv(m));
    const frag = document.createDocumentFragment();
    if (q) {
      const hits = this.search(pool, q);
      if (hits.length) {
        frag.append(sec("Results", hits.length));
        for (const m of hits) frag.append(this.row(unitOf([m])));
      } else {
        frag.append(h("div.empty", { text: "No models match" }));
        const other = this.kind ? this.search(this.all.filter(inProv), q).length : 0;
        if (other)
          frag.append(
            h("button.btn.mh-wide", {
              text: `Show ${other} in other kinds`,
              onclick: () => {
                this.kind = "";
                this.refresh();
              },
            }),
          );
      }
    } else this.renderSections(frag, pool);
    this.list.replaceChildren(frag);
  }

  /** Exact name/id, then prefix, then substring, then subsequence matches; ties by usage. */
  private search(pool: ModelInfo[], q: string): ModelInfo[] {
    const scored: [number, ModelInfo][] = [];
    for (const m of pool) {
      const [n, id, hay] = this.keys.get(m)!;
      const s = n === q || id === q ? 0 : n.startsWith(q) || id.startsWith(q) ? 1 : hay.includes(q) ? 2 : isSubsequence(hay, q) ? 3 : -1;
      if (s >= 0) scored.push([s, m]);
    }
    return scored.sort((a, b) => a[0] - b[0] || byUse(a[1], b[1])).map((x) => x[1]);
  }

  /** Current, Recent (30 d, by last use), Top (by intelligence), then hidden rows behind "Show N more". */
  private renderSections(frag: DocumentFragment, pool: ModelInfo[]) {
    const cur = this.host.cur();
    const rest = pool.filter((m) => m.selector !== cur?.selector);
    let units: Unit[];
    if (this.provider) units = rest.map((m) => unitOf([m]));
    else {
      const groups = new Map<string, ModelInfo[]>();
      for (const m of rest) {
        const k = `${m.kind}\u0000${m.name}`;
        const g = groups.get(k);
        if (g) g.push(m);
        else groups.set(k, [m]);
      }
      units = [...groups.values()].map(unitOf);
    }
    const since = Date.now() - RECENT_MS;
    const recent: Unit[] = [];
    const top: Unit[] = [];
    const more: Unit[] = [];
    for (const u of units) (u.last > since ? recent : u.ms.every((m) => m.hidden) ? more : top).push(u);
    recent.sort((a, b) => b.last - a.last);
    top.sort((a, b) => (b.m.int ?? -1) - (a.m.int ?? -1) || a.m.name.localeCompare(b.m.name));
    more.sort((a, b) => a.m.name.localeCompare(b.m.name));
    const curIn = !!cur && pool.some((m) => m.selector === cur.selector);
    if (curIn) frag.append(sec("Current"), this.row(unitOf([cur])));
    if (recent.length) frag.append(sec("Recent", recent.length), ...recent.map((u) => this.row(u)));
    if (top.length) frag.append(sec("Top", top.length), ...top.map((u) => this.row(u)));
    if (more.length) {
      if (this.more) frag.append(sec("More", more.length), ...more.map((u) => this.row(u)));
      else
        frag.append(
          h("button.btn.mh-wide", {
            text: `Show ${more.length} more`,
            onclick: () => {
              this.more = true;
              this.render();
            },
          }),
        );
    }
    if (!curIn && !units.length) frag.append(h("div.empty", { text: "No models" }));
  }

  private row(u: Unit): HTMLElement {
    const cached = this.rows.get(u.key);
    if (cached) return cached;
    const m = u.m;
    const isCur = u.ms.length === 1 && m.selector === this.host.cur()?.selector;
    const all = u.ms.flatMap((x) => this.host.badges(x));
    const badges = all.length > 4 ? [...all.slice(0, 3), `+${all.length - 3} roles`] : all;
    const meta = metaLine(m);
    const el = h(
      `div.mh-row${isCur ? ".cur" : ""}`,
      { role: "button", tabindex: 0 },
      h("span.mh-l1", null, h("span.ms-name", { text: shortName(m.name) }), isCur ? h("span.tag.acc", { text: "Current" }) : null),
      h("span.ms-id", { text: `${m.provider} \u00b7 ${m.id}` }),
      meta ? h("span.mh-meta", { text: meta }) : null,
      badges.length ? h("span.mh-badges", null, ...badges.map((b) => h("span.mh-badge", { text: b }))) : null,
      u.ms.length > 1
        ? h(
            "span.mh-pills",
            null,
            ...u.ms.map((x) =>
              h(`button.mh-pill${x === m ? ".on" : ""}`, {
                text: providerName(x.provider),
                onclick: (e: Event) => {
                  e.stopPropagation();
                  this.host.pick(x);
                },
              }),
            ),
          )
        : null,
    );
    el.addEventListener("click", () => this.host.pick(m));
    this.rows.set(u.key, el);
    return el;
  }
}

// ---------------------------------------------------------------- the hub

type View =
  | { k: "home"; scroll: number }
  | { k: "model"; m: ModelInfo; sc?: SessionControl; thr?: string; scroll: number }
  | { k: "role"; name: string; scroll: number }
  | { k: "chain"; key: string; scroll: number }
  | { k: "pick"; title: string; list: ModelList; scroll: number };
type ModelView = Extract<View, { k: "model" }>;

/** The model hub for the current omp pane (model chip, `/model` and `/modelpreset`); `roles` opens the Roles tab. */
export function openModelHub(tab: "models" | "roles" = "models") {
  const p = currentPane();
  if (p?.agent) new ModelHub(p, tab);
}

class ModelHub {
  private readonly s: Sheet;
  private readonly target: string;
  private readonly tabs = h("div.seg.mh-tabs");
  private tab: "models" | "roles";
  private readonly views: View[] = [{ k: "home", scroll: 0 }];
  private readonly list: ModelList;
  private readonly modelsPane = h("div");
  private roles: RolesMsg | null;
  private rolesErr = "";
  /** A roles_set write is in flight. */
  private busy = false;

  constructor(p: Pane, tab: "models" | "roles") {
    this.target = p.target;
    this.tab = tab;
    this.s = new Sheet("Models", paneTitle(p), "models");
    this.list = new ModelList(this.listHost((m) => this.push({ k: "model", m, scroll: 0 })));
    for (const [id, label] of [["models", "Models"], ["roles", "Roles"]] as const)
      this.tabs.append(
        h("button.seg-b", {
          text: label,
          "data-tab": id,
          onclick: () => {
            this.tab = id;
            this.render();
            this.s.body.scrollTop = 0;
          },
        }),
      );
    this.s.body.before(this.tabs);
    this.roles = rolesCached(this.target);
    const offs = [
      onModels((d) => {
        this.list.setData(d.models);
        this.modelsPane.replaceChildren(this.list.el);
        for (const v of this.views) {
          if (v.k === "pick") v.list.setData(d.models);
          if (v.k === "model") v.m = findModel(v.m.selector) ?? v.m;
        }
        this.render();
      }),
      onRoles((r, target) => {
        if (target !== this.target) return;
        this.roles = r;
        this.rolesErr = "";
        this.list.refresh();
        for (const v of this.views) if (v.k === "pick") v.list.refresh();
        this.render();
      }),
    ];
    this.s.onClose = () => offs.forEach((off) => off());
    this.s.onBack = () => {
      if (this.views.length < 2) return false;
      this.pop();
      return true;
    };
    const cached = modelsCached();
    if (cached) {
      this.list.setData(cached.models);
      this.modelsPane.append(this.list.el);
    } else this.modelsPane.append(spinnerEl("Loading models..."));
    this.loadModels(false);
    this.loadRoles();
    this.render();
  }

  private omp() {
    return state.byTarget.get(this.target)?.omp;
  }

  private listHost(pick: (m: ModelInfo) => void): ListHost {
    return {
      cur: () => currentModel(this.omp()),
      badges: (m) => this.roles?.roles.filter((r) => r.selector === m.selector).map((r) => r.name + (r.level ? `\u00b7${r.level}` : "")) ?? [],
      pick,
    };
  }

  private loadModels(force: boolean) {
    refreshModels(force).catch((e: Error) => {
      if (modelsCached() || !this.s.isOpen) return;
      this.modelsPane.replaceChildren(
        errorEl(`Couldn't load the model list: ${e.message}`, () => {
          this.modelsPane.replaceChildren(spinnerEl("Loading models..."));
          this.loadModels(true);
        }),
      );
    });
  }

  private loadRoles() {
    this.rolesErr = "";
    refreshRoles(this.target).catch((e: Error) => {
      if (!this.s.isOpen) return;
      this.rolesErr = e.message;
      this.render();
    });
  }

  private rolesMissing(): HTMLElement {
    if (!this.rolesErr) return spinnerEl("Loading roles...");
    return errorEl(`Couldn't load omp's roles: ${this.rolesErr}`, () => {
      this.loadRoles();
      this.render();
    });
  }

  // ---- navigation

  private top(): View {
    return this.views[this.views.length - 1];
  }

  private push(v: View) {
    this.top().scroll = this.s.body.scrollTop;
    this.views.push(v);
    this.render();
    this.s.body.scrollTop = 0;
  }

  private pop() {
    this.views.pop();
    this.render();
    this.s.body.scrollTop = this.top().scroll;
  }

  /** Replaces the top view (a jump sideways, e.g. to the same model on another provider). */
  private swap(v: View) {
    this.views[this.views.length - 1] = v;
    this.render();
    this.s.body.scrollTop = 0;
  }

  private backRow(): HTMLElement {
    const prev = this.views[this.views.length - 2];
    const label =
      prev.k === "home" ? (this.tab === "models" ? "Models" : "Roles")
      : prev.k === "model" ? shortName(prev.m.name)
      : prev.k === "role" ? this.roles?.roles.find((r) => r.name === prev.name)?.label ?? prev.name
      : prev.k === "chain" ? prev.key
      : "Back";
    return h("button.ms-back", { onclick: () => this.pop() }, h("span.ms-back-ic", { text: "\u2039" }), h("span", { text: label }));
  }

  private render() {
    if (!this.s.isOpen) return;
    const v = this.top();
    const keep = this.s.body.scrollTop;
    this.tabs.hidden = v.k !== "home";
    for (const b of this.tabs.children) b.classList.toggle("on", (b as HTMLElement).dataset.tab === this.tab);
    this.s.foot.hidden = true;
    this.s.foot.replaceChildren();
    let content: HTMLElement;
    if (v.k === "home") content = this.tab === "models" ? this.modelsPane : this.rolesTab();
    else if (v.k === "model") content = this.modelView(v);
    else if (v.k === "role") content = this.roleView(v.name);
    else if (v.k === "chain") content = this.chainView(v.key);
    else content = h("div", null, this.backRow(), h("div.mh-pick-h", null, h("span", { text: v.title }), this.busy ? h("span.spin.xs") : null), v.list.el);
    if (this.s.body.firstChild !== content) this.s.body.replaceChildren(content);
    this.s.body.scrollTop = keep;
  }

  // ---- writes

  /** Write controls are live: roles loaded, online, no write in flight; `role` also needs global role storage. */
  private canWrite(role = false): boolean {
    return !!this.roles && !this.busy && isOnline() && !(role && this.roles.storage === "project");
  }

  private async write(key: RolesKey, value: unknown, okText: string): Promise<boolean> {
    const r = this.roles;
    if (!r || this.busy || !isOnline()) return false;
    this.busy = true;
    this.render();
    const res = await setRoles(key, value, rolesBase(r, key), this.target);
    this.busy = false;
    this.render();
    if (res && okText) toast(okText, "ok");
    return !!res;
  }

  /** Sets (or with null clears) a role; a new `default` also switches this session, as omp's hub does. */
  private async setRole(name: string, value: string | null, okText: string): Promise<boolean> {
    const vals = roleValues(this.roles!);
    if (value) vals[name] = value;
    else delete vals[name];
    if (!(await this.write("modelRoles", vals, okText))) return false;
    if (name === "default" && value && !value.startsWith("@") && state.byTarget.get(this.target)?.agent)
      runCmd(this.target, "switch", value).then(
        (m) => {
          const [sel, level] = splitSpec(value);
          const name = findModel(sel)?.name;
          toast(m.info || `This session now uses ${name ? shortName(name) : sel}${level ? ` \u00b7 ${level}` : ""}`, "ok");
        },
        (e: Error) => toast(`Default saved; switching this session failed: ${e.message}`, "err"),
      );
    return true;
  }

  private pickFor(title: string, accept: (m: ModelInfo) => boolean, onPick: (m: ModelInfo) => Promise<boolean>) {
    const view: View = {
      k: "pick",
      title,
      scroll: 0,
      list: new ModelList(
        this.listHost((m) => {
          void onPick(m).then((ok) => {
            if (ok && this.top() === view) this.pop();
          });
        }),
        accept,
      ),
    };
    const d = modelsCached();
    if (d) view.list.setData(d.models);
    this.push(view);
  }

  // ---- model detail

  private modelView(v: ModelView): HTMLElement {
    const m = v.m;
    const o = this.omp();
    const isCur = m.selector === currentModel(o)?.selector;
    const el = h(
      "div.mh-detail",
      null,
      this.backRow(),
      h(
        "div.mh-dh",
        null,
        h("div.mh-dname", { text: m.name }),
        h("div.ms-id", { text: m.selector }),
        h("div.mh-tags", null, isCur ? h("span.tag.acc", { text: "Current" }) : null, h("span.tag", { text: kindLabel(m.kind) }), m.hidden ? h("span.tag", { text: "Hidden" }) : null),
      ),
      this.facts(m),
    );
    const variants = (modelsCached()?.models ?? []).filter((x) => x.name === m.name && x.kind === m.kind && x.selector !== m.selector);
    if (variants.length)
      el.append(
        sec("Also on"),
        h("div.mh-pills", null, ...variants.map((x) => h("button.mh-pill", { text: providerName(x.provider), onclick: () => this.swap({ k: "model", m: x, scroll: 0 }) }))),
      );
    if (m.kind === "chat" && o) {
      v.sc ??= new SessionControl(this.target, m, () => this.s.close(), () => this.render());
      el.append(sec("Use in this session"), v.sc.el);
      this.s.foot.hidden = false;
      this.s.foot.append(v.sc.applyBtn);
    }
    el.append(sec("Roles"), this.rolesBlock(m, v.sc?.level ?? ""));
    el.append(sec("Fallback chain"), this.chainEditor(m.selector, (x) => x.kind === m.kind));
    el.append(sec("Compaction limit"), this.thresholdEditor(v));
    return el;
  }

  private facts(m: ModelInfo): HTMLElement {
    const u = m.usage;
    const p = m.price;
    const rows: [string, string][] = [];
    if (m.contextWindow) rows.push(["Context", fmtTokens(m.contextWindow)]);
    if (m.maxTokens) rows.push(["Max output", fmtTokens(m.maxTokens)]);
    rows.push(["Price", !p ? "unknown" : priceText(p) === "free" ? "free" : `${fmtPrice(p.input)} in \u00b7 ${fmtPrice(p.output)} out per M`]);
    if (p && (p.cacheRead || p.cacheWrite)) rows.push(["Cache", `${fmtPrice(p.cacheRead)} read \u00b7 ${fmtPrice(p.cacheWrite)} write per M`]);
    rows.push(["Reasoning", m.reasoning ? (m.thinking?.length ? m.thinking.join(", ") : "yes") : "no"]);
    rows.push(["Vision", m.vision ? "yes" : "no"]);
    if (m.webSearch) rows.push(["Web search", "yes"]);
    if (m.int != null) rows.push(["Intelligence", `\u{1f9e0} ${Math.round(m.int)}`]);
    if (u?.tps) rows.push(["Speed", `${Math.round(u.tps)} t/s`]);
    if (u?.ttft) rows.push(["First token", fmtRtt(u.ttft)]);
    rows.push(["Uses (30 d)", String(u?.count ?? 0)]);
    if (u?.last) {
      const ago = fmtAgo(u.last);
      rows.push(["Last used", /^\d/.test(ago) ? `${ago} ago` : ago]);
    }
    return h("div.mh-facts", null, ...rows.flatMap(([k, val]) => [h("span.mh-fk", { text: k }), h("span.mh-fv", { text: val })]));
  }

  /** One toggle per role that can take `m`; chat roles get `level` as their suffix. */
  private rolesBlock(m: ModelInfo, level: string): HTMLElement {
    const box = h("div.mh-block");
    const r = this.roles;
    if (!r) {
      box.append(this.rolesMissing());
      return box;
    }
    if (r.storage === "project") box.append(projectNotice());
    const fits = r.roles.filter((x) => acceptsModel(x, m));
    if (!fits.length) {
      box.append(h("p.sheet-text.muted", { text: "No role takes this kind of model." }));
      return box;
    }
    if (level && fits.some((x) => takesLevel(x, m))) box.append(h("p.sheet-text.muted", { text: `Roles that take thinking are set with ${levelLabel(level)} (picked above).` }));
    const can = this.canWrite(true);
    for (const x of fits) {
      const on = x.selector === m.selector;
      const sub = on ? (x.value?.startsWith("@") ? `via ${x.value}` : x.level ? `thinking ${x.level}` : "") : `now ${roleModelText(x)}`;
      box.append(
        toggleRow(x.label, sub, on, !can, () => {
          const value = m.selector + (takesLevel(x, m) && level ? `:${level}` : "");
          void (on ? this.setRole(x.name, null, `${x.label} cleared`) : this.setRole(x.name, value, `${x.label} \u2192 ${shortName(m.name)}`));
        }),
      );
    }
    return box;
  }

  /** View/edit `chains[key]`: add via the picker, reorder, remove entries or the whole chain. */
  private chainEditor(key: string, accept: (m: ModelInfo) => boolean): HTMLElement {
    const box = h("div.mh-block");
    const r = this.roles;
    if (!r) {
      box.append(this.rolesMissing());
      return box;
    }
    const list = r.chains[key];
    const can = this.canWrite();
    const save = (next: string[] | null, ok: string) => {
      const chains = { ...r.chains };
      if (next) chains[key] = next;
      else delete chains[key];
      return this.write("retry.fallbackChains", chains, ok);
    };
    if (!list) box.append(h("p.sheet-text.muted", { text: "No fallback chain set." }));
    else if (!list.length) box.append(h("p.sheet-text.muted", { text: "\u21bb none: explicitly no fallback." }));
    list?.forEach((spec, i) => {
      const [sel, lvl] = splitSpec(spec);
      const fm = findModel(sel);
      box.append(
        h(
          "div.mh-ch-row",
          null,
          h("span.mh-ch-i", { text: String(i + 1) }),
          h("span.ms-main", null, h("span.ms-name", { text: fm ? shortName(fm.name) + (lvl ? ` \u00b7 ${lvl}` : "") : spec }), h("span.ms-id", { text: spec })),
          iconBtn("up", "Move up", !can || i === 0, () => void save(moved(list, i, -1), "")),
          iconBtn("down", "Move down", !can || i === list.length - 1, () => void save(moved(list, i, 1), "")),
          iconBtn("close", "Remove", !can, () => void save(list.length > 1 ? list.filter((_, j) => j !== i) : null, "Fallback removed")),
        ),
      );
    });
    box.append(
      h(
        "div.mh-acts",
        null,
        h("button.btn.sm", {
          text: "Add fallback",
          disabled: !can,
          onclick: () => this.pickFor(`Fallback for ${key}`, accept, (m) => save([...(list ?? []), m.selector], `Fallback added: ${shortName(m.name)}`)),
        }),
        list ? h("button.btn.sm", { text: "Remove chain", disabled: !can, onclick: () => void save(null, "Fallback chain removed") }) : null,
      ),
    );
    return box;
  }

  /** `thresholds[selector]`: 90000 | "f90000" | "80%". */
  private thresholdEditor(v: ModelView): HTMLElement {
    const box = h("div.mh-block");
    const r = this.roles;
    if (!r) {
      box.append(this.rolesMissing());
      return box;
    }
    const key = v.m.selector;
    const cur = r.thresholds[key];
    const wild = Object.keys(r.thresholds).find((k) => k.endsWith("*") && (key.startsWith(k.slice(0, -1)) || v.m.id.startsWith(k.slice(0, -1))));
    const input = h("input.field.mh-thr", {
      type: "text",
      placeholder: "90000, f90000 or 80%",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "done",
      value: v.thr ?? (cur != null ? String(cur) : ""),
    }) as HTMLInputElement;
    input.addEventListener("input", () => (v.thr = input.value));
    const can = this.canWrite();
    const saveIt = () => {
      const t = input.value.trim();
      if (!/^(\d+|f\d+|\d{1,3}%)$/.test(t)) return toast("Use 90000, f90000 or 80%", "err");
      void this.write("compaction.modelThresholds", { ...r.thresholds, [key]: /^\d+$/.test(t) ? Number(t) : t }, `Compaction limit for ${shortName(v.m.name)}: ${t}`).then((ok) => {
        if (ok) v.thr = undefined;
      });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && can) saveIt();
    });
    const clear = () => {
      const next = { ...r.thresholds };
      delete next[key];
      void this.write("compaction.modelThresholds", next, "Compaction limit cleared").then((ok) => {
        if (ok) v.thr = undefined;
      });
    };
    box.append(
      h("p.sheet-text.muted", { text: cur != null ? `Set: ${cur}` : wild ? `Not set; ${wild} (${r.thresholds[wild]}) applies.` : "Not set." }),
      h(
        "div.mh-thr-row",
        null,
        input,
        h("button.btn", { text: "Save", disabled: !can, onclick: saveIt }),
        cur != null ? h("button.btn", { text: "Clear", disabled: !can, onclick: clear }) : null,
      ),
    );
    return box;
  }

  // ---- roles tab

  private rolesTab(): HTMLElement {
    const el = h("div.mh-roles");
    const r = this.roles;
    if (!r) {
      el.append(this.rolesMissing());
      return el;
    }
    const can = this.canWrite();
    if (r.storage === "project") el.append(projectNotice());
    const groups: [RoleState["group"], string][] = [
      ["chat", "Chat roles"],
      ["custom", "Custom roles"],
      ["kind", "Model-kind roles"],
    ];
    for (const [g, title] of groups) {
      const rs = r.roles.filter((x) => x.group === g);
      if (!rs.length && g !== "custom") continue;
      el.append(sec(title, rs.length), ...rs.map((x) => this.roleRow(x, r)));
      if (g === "custom") el.append(h("button.mh-add", { text: "+ New role\u2026", disabled: !this.canWrite(true), onclick: () => void this.newRole(r) }));
    }

    const names = new Set(r.roles.map((x) => x.name));
    const other = Object.keys(r.chains).filter((k) => !names.has(k));
    el.append(sec("Other fallback chains", other.length));
    for (const k of other)
      el.append(
        h(
          "button.mh-role",
          { onclick: () => this.push({ k: "chain", key: k, scroll: 0 }) },
          h("span.ms-main", null, h("span.mh-rl.mono", { text: k })),
          h("span.mh-fb", { text: r.chains[k].length ? `\u21bb ${r.chains[k].length}` : "\u21bb none" }),
        ),
      );
    el.append(h("button.mh-add", { text: "+ New fallback chain\u2026", disabled: !can, onclick: () => void this.newChain(r) }));

    el.append(sec("Cycle order"), this.cycleEditor(r, can));

    el.append(sec("Presets", r.presets.length), ...r.presets.map((p) => this.presetRow(p, can)));
    el.append(h("button.mh-add", { text: "+ Save current as\u2026", disabled: !can, onclick: () => void this.savePreset(r) }));

    el.append(
      h(
        "button.ms-link",
        {
          onclick: () => {
            this.s.close();
            void ompCmd("page", "/model");
          },
        },
        h("span.icw", { html: icon("plan") }),
        h("span", { text: "omp's own model page (provider logins)" }),
        h("span.icw", { html: icon("chev") }),
      ),
    );
    return el;
  }

  private roleRow(x: RoleState, r: RolesMsg): HTMLElement {
    const chain = r.chains[x.name];
    return h(
      "button.mh-role",
      { onclick: () => this.push({ k: "role", name: x.name, scroll: 0 }) },
      h(`span.mh-dot.mono${x.value ? ".on" : ""}`, { text: x.value ? "\u25cf" : "\u25cb" }),
      h(
        "span.ms-main",
        null,
        h("span.mh-l1", null, h("span.mh-rl", { text: x.label }), r.cycle.includes(x.name) ? h("span.mh-cyc", { title: "In the cycle" }) : null),
        h(`span.mh-rm${x.value ? "" : ".muted"}`, { text: roleModelText(x) }),
      ),
      x.level ? h("span.mh-lvl", null, h("span.mono", { text: LEVEL_GLYPH[x.level] ?? "\u25d1" }), h("span", { text: x.level })) : null,
      chain ? h("span.mh-fb", { text: chain.length ? `\u21bb ${chain.length}` : "\u21bb none" }) : null,
    );
  }

  private roleView(name: string): HTMLElement {
    const el = h("div.mh-detail", null, this.backRow());
    const r = this.roles;
    const x = r?.roles.find((y) => y.name === name);
    if (!r || !x) {
      el.append(r ? h("div.empty", { text: "This role no longer exists" }) : this.rolesMissing());
      return el;
    }
    const canRole = this.canWrite(true);
    const can = this.canWrite();
    const m = findModel(x.selector);
    /** A comma list or an alias: shown raw; its thinking is not edited here. */
    const raw = !!x.value && (x.value.includes(",") || x.value.startsWith("@"));
    const own = x.value && !raw ? splitSpec(x.value)[1] : "";
    el.append(h("div.mh-dh", null, h("div.mh-dname", { text: x.label }), h("p.sheet-text.muted", { text: x.desc })));
    if (r.storage === "project") el.append(projectNotice());

    el.append(
      sec("Model"),
      h(
        "div.mh-cur",
        null,
        h(`div.ms-name${x.value ? "" : ".muted"}`, { text: roleModelText(x) }),
        x.selector ? h("div.ms-id", { text: x.selector }) : null,
        raw ? h("div.ms-id", { text: `value: ${x.value}` }) : null,
      ),
      h(
        "div.mh-acts",
        null,
        h("button.btn.sm.primary", {
          text: x.value ? "Change model" : "Pick a model",
          disabled: !canRole,
          onclick: () =>
            this.pickFor(`Assigning ${x.label.toUpperCase()}`, (mm) => acceptsModel(x, mm), (mm) => {
              const keep = own && takesLevel(x, mm) && (own === "inherit" || levelsFor(mm).includes(own)) ? `:${own}` : "";
              return this.setRole(x.name, mm.selector + keep, `${x.label} \u2192 ${shortName(mm.name)}`);
            }),
        }),
        x.value ? h("button.btn.sm", { text: "Clear", disabled: !canRole, onclick: () => void this.clearRole(x) }) : null,
        m ? h("button.btn.sm", { text: "Model details", onclick: () => this.push({ k: "model", m, scroll: 0 }) }) : null,
      ),
    );

    if (takesLevel(x, m) && m && x.selector) {
      const seg = h("div.seg.ms-seg");
      for (const l of ["", "inherit", ...levelsFor(m)])
        seg.append(
          h(`button.seg-b${l === own ? ".on" : ""}`, {
            text: l ? levelLabel(l) : "None",
            "aria-pressed": String(l === own),
            disabled: !canRole || raw,
            onclick: () => void this.setRole(x.name, x.selector + (l ? `:${l}` : ""), `${x.label} thinking: ${l || "none"}`),
          }),
        );
      el.append(sec("Thinking"), seg);
      if (raw) el.append(h("p.sheet-text.muted", { text: "Set through an alias or a list: pick a model to set its thinking here." }));
    }

    if (x.group !== "kind") {
      const inCycle = r.cycle.includes(x.name);
      el.append(
        sec("Cycle"),
        toggleRow("In the cycle", "Ctrl+P on the PC steps through these roles", inCycle, !can, () =>
          void this.write("cycleOrder", inCycle ? r.cycle.filter((n) => n !== x.name) : [...r.cycle, x.name], inCycle ? `${x.label} left the cycle` : `${x.label} joined the cycle`),
        ),
      );
    }
    el.append(sec("Fallback chain"), this.chainEditor(x.name, (mm) => acceptsModel(x, mm)));
    return el;
  }

  private async clearRole(x: RoleState) {
    const ok = await confirmSheet({ title: `Clear ${x.label}?`, text: "The role becomes unset and omp falls back to its automatic choice.", ok: "Clear", danger: true });
    if (ok) await this.setRole(x.name, null, `${x.label} cleared`);
  }

  private async newRole(r: RolesMsg) {
    const name = await askText({
      title: "New role",
      placeholder: "role_name",
      ok: "Pick a model",
      hint: "Lowercase letters, digits and _.",
      check: (v) => (!/^[a-z0-9_]+$/.test(v) ? "Use lowercase letters, digits and _" : r.roles.some((x) => x.name === v) ? "That role exists" : ""),
    });
    if (name) this.pickFor(`Assigning ${name.toUpperCase()}`, (m) => m.kind === "chat", (m) => this.setRole(name, m.selector, `${name} \u2192 ${shortName(m.name)}`));
  }

  private chainView(key: string): HTMLElement {
    const km = findModel(key);
    return h(
      "div.mh-detail",
      null,
      this.backRow(),
      h("div.mh-dh", null, h("div.mh-dname.mono", { text: key }), h("p.sheet-text.muted", { text: km ? `Fallbacks when ${km.name} fails` : "Fallbacks for models matching this key" })),
      sec("Fallback chain"),
      this.chainEditor(key, (m) => m.kind === (km?.kind ?? "chat")),
    );
  }

  private async newChain(r: RolesMsg) {
    const key = await askText({
      title: "New fallback chain",
      placeholder: "provider/id or provider/*",
      ok: "Next",
      hint: "The model (provider/id) or all models of a provider (provider/*) the chain applies to.",
      check: (v) => (!/^[^\s/]+\/\S+$/.test(v) ? "Use provider/id or provider/*" : v in r.chains ? "That chain exists" : ""),
    });
    if (key) this.push({ k: "chain", key, scroll: 0 });
  }

  private cycleEditor(r: RolesMsg, can: boolean): HTMLElement {
    const box = h("div.mh-block");
    const save = (next: string[], ok: string) => void this.write("cycleOrder", next, ok);
    const label = (n: string) => r.roles.find((x) => x.name === n)?.label ?? n;
    const chips = h("div.mh-cycle");
    r.cycle.forEach((n, i) =>
      chips.append(
        h(
          "span.mh-cy",
          null,
          iconBtn("back", "Earlier", !can || i === 0, () => save(moved(r.cycle, i, -1), "")),
          h("span.mh-cy-n", { text: label(n) }),
          iconBtn("chev", "Later", !can || i === r.cycle.length - 1, () => save(moved(r.cycle, i, 1), "")),
          iconBtn("close", "Remove", !can, () => save(r.cycle.filter((c) => c !== n), `${label(n)} left the cycle`)),
        ),
      ),
    );
    const addable = r.roles.filter((x) => x.group !== "kind" && !r.cycle.includes(x.name));
    const add = h("button.btn.sm", { text: "Add role", disabled: !can || !addable.length });
    add.addEventListener("click", () =>
      openMenu(
        add,
        addable.map((x) => ({ label: x.label, act: () => save([...r.cycle, x.name], `${x.label} joined the cycle`) })),
      ),
    );
    box.append(
      h("p.sheet-text.muted", { text: r.cycle.length ? "Ctrl+P on the PC steps through these roles in this order." : "No roles in the cycle." }),
      chips,
      h("div.mh-acts", null, add),
    );
    return box;
  }

  private presetRow(p: Preset, can: boolean): HTMLElement {
    const def = p.roles.default;
    const [sel, lvl] = def ? splitSpec(def) : ["", ""];
    const dm = findModel(sel);
    const n = Object.keys(p.roles).length;
    const sub = [def ? (dm ? shortName(dm.name) + (lvl ? ` \u00b7 ${lvl}` : "") : def) : "no default", p.thinking ? `thinking ${p.thinking}` : "", `${n} role${n === 1 ? "" : "s"}`]
      .filter(Boolean)
      .join(" \u00b7 ");
    const row = h("button.mh-role", null, h("span.ms-main", null, h("span.mh-rl", { text: p.name }), h("span.mh-rm", { text: sub })), h("span.icw.mh-chev", { html: icon("more") }));
    row.addEventListener("click", () =>
      openMenu(row, [
        { label: "Apply", icon: "play", disabled: !isOnline() || !state.byTarget.get(this.target)?.agent, act: () => this.applyPreset(p.name) },
        { label: "Delete", icon: "close", disabled: !can, act: () => void this.deletePreset(p.name) },
      ]),
    );
    return row;
  }

  private applyPreset(name: string) {
    runCmd(this.target, "preset", name).then(
      (m) => {
        toast(m.info || `Preset ${name} applied`, "ok");
        refreshRoles(this.target).catch(() => {});
      },
      (e: Error) => toast(e.message, "err"),
    );
  }

  private async deletePreset(name: string) {
    if (!(await confirmSheet({ title: `Delete preset ${name}?`, text: "The preset is removed from omp's settings on the PC.", ok: "Delete", danger: true }))) return;
    const r = this.roles;
    if (!r) return;
    const next = presetsValue(r);
    delete next[name];
    await this.write("modelPresets", next, `Preset ${name} deleted`);
  }

  private async savePreset(r: RolesMsg) {
    const name = await askText({
      title: "Save roles as preset",
      placeholder: "Preset name",
      ok: "Save",
      hint: "Stores every configured role and the default thinking level.",
      check: (v) => (v ? "" : "Enter a name"),
    });
    if (!name) return;
    const cur = this.roles ?? r;
    if (cur.presets.some((p) => p.name === name) && !(await confirmSheet({ title: `Replace preset ${name}?`, text: "A preset with this name exists; saving overwrites it.", ok: "Replace" })))
      return;
    const next = {
      ...presetsValue(cur),
      [name]: { modelRoles: roleValues(cur), ...(cur.defaultThinking ? { defaultThinkingLevel: cur.defaultThinking } : {}) },
    };
    await this.write("modelPresets", next, `Preset ${name} saved`);
  }
}
