// omp session controls: model list cache, `cmd` requests with pending tracking, display helpers.
import { RequestError, request } from "./bridge";
import { currentPane, state } from "./state";
import type { CmdMsg, ModelInfo, ModelsMsg, OmpInfo, RolesKey, RolesMsg } from "./types";
import { toast } from "./ui";
import { lsGet, lsSet } from "./util";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABEL: Record<string, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", auto: "Auto", inherit: "Inherit" };
export const levelLabel = (l: string) => LEVEL_LABEL[l] ?? l;

/** Levels offered for a model: `off`, the model's own levels, then session-only `auto` (none without thinking). */
export function levelsFor(m: ModelInfo | undefined): string[] {
  if (!m?.thinking?.length) return [];
  return ["off", ...m.thinking.filter((l) => l !== "off" && l !== "auto"), "auto"];
}

/** The level to preselect: `want` when supported, else the closest supported concrete level. */
export function pickLevel(levels: string[], want: string | null | undefined): string {
  if (!levels.length) return "";
  if (want && levels.includes(want)) return want;
  const concrete = levels.filter((l) => l !== "off" && l !== "auto");
  const wi = THINKING_LEVELS.indexOf(want || "medium");
  let best = concrete[concrete.length - 1] ?? levels[0];
  let bestD = Infinity;
  for (const l of concrete) {
    const d = Math.abs(THINKING_LEVELS.indexOf(l) - wi);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best;
}

export function shortName(name: string): string {
  return name.replace(/^Claude\s+/, "");
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, "")}M`;
}

export const isOnline = () => state.link?.state === "online";

// ---------------------------------------------------------------- models cache

export interface ModelsData {
  models: ModelInfo[];
  fetchedAt?: number;
  /** When this client last received the list (ms). */
  at: number;
}

const MODELS_KEY = "dd.models.v2";
const MODELS_FRESH_MS = 10 * 60_000;
lsSet("dd.models", null); // pre-v2 shape (with roles), never read again
let models: ModelsData | null = lsGet<ModelsData | null>(MODELS_KEY, null);
let bySelector = indexModels(models);
let inflight: Promise<ModelsData> | null = null;
const modelListeners = new Set<(d: ModelsData) => void>();

function indexModels(d: ModelsData | null): Map<string, ModelInfo> {
  return new Map((d?.models ?? []).map((m) => [m.selector, m]));
}

export const modelsCached = (): ModelsData | null => models;
export const findModel = (selector: string | null | undefined): ModelInfo | undefined => (selector ? bySelector.get(selector) : undefined);
export function onModels(fn: (d: ModelsData) => void): () => void {
  modelListeners.add(fn);
  return () => modelListeners.delete(fn);
}

/** Fetches the model list unless the cached copy is fresh (or `force`); concurrent calls share one request. */
export function refreshModels(force = false): Promise<ModelsData> {
  if (!force && models && Date.now() - models.at < MODELS_FRESH_MS) return Promise.resolve(models);
  if (inflight) return inflight;
  inflight = request<ModelsMsg>({ t: "models" }, 120_000)
    .then((m) => {
      const d: ModelsData = { models: m.models || [], fetchedAt: m.fetchedAt, at: Date.now() };
      const changed = !models || JSON.stringify(models.models) !== JSON.stringify(d.models);
      models = d;
      bySelector = indexModels(d);
      lsSet(MODELS_KEY, d);
      if (changed) for (const fn of modelListeners) fn(d);
      return d;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------- model roles (omp config), in memory

/**
 * omp's role settings as read for one omp pane (its working directory picks the project config layer);
 * `target` "" = the global settings.
 */
let roles: { target: string; msg: RolesMsg } | null = null;
const rolesInflight = new Map<string, Promise<RolesMsg>>();
const rolesListeners = new Set<(r: RolesMsg, target: string) => void>();

export const rolesCached = (target: string): RolesMsg | null => (roles?.target === target ? roles.msg : null);
export function onRoles(fn: (r: RolesMsg, target: string) => void): () => void {
  rolesListeners.add(fn);
  return () => rolesListeners.delete(fn);
}
function setRolesState(target: string, msg: RolesMsg) {
  roles = { target, msg };
  for (const fn of rolesListeners) fn(msg, target);
}

/** Re-reads omp's role settings from the PC (for the omp pane `target`, else global); concurrent calls share one request. */
export function refreshRoles(target: string): Promise<RolesMsg> {
  let p = rolesInflight.get(target);
  if (p) return p;
  p = request<RolesMsg>(target ? { t: "roles", target } : { t: "roles" }, 30_000)
    .then((r) => {
      setRolesState(target, r);
      return r;
    })
    .finally(() => rolesInflight.delete(target));
  rolesInflight.set(target, p);
  return p;
}

/** The configured role values (`modelRoles`) as omp stores them. */
export function roleValues(r: RolesMsg): Record<string, string> {
  return Object.fromEntries(r.roles.filter((x) => x.value).map((x) => [x.name, x.value!]));
}

export type PresetsValue = Record<string, { modelRoles: Record<string, string>; defaultThinkingLevel?: string }>;
export function presetsValue(r: RolesMsg): PresetsValue {
  return Object.fromEntries(r.presets.map((p) => [p.name, { modelRoles: p.roles, ...(p.thinking ? { defaultThinkingLevel: p.thinking } : {}) }]));
}

/** The value of `key` as last received: the `base` a `roles_set` write is checked against. */
export function rolesBase(r: RolesMsg, key: RolesKey): unknown {
  switch (key) {
    case "modelRoles":
      return roleValues(r);
    case "retry.fallbackChains":
      return r.chains;
    case "cycleOrder":
      return r.cycle;
    case "compaction.modelThresholds":
      return r.thresholds;
    case "modelPresets":
      return presetsValue(r);
  }
}

/**
 * Writes one whole setting on the PC (for the omp pane `target`, else global). Resolves with the fresh state
 * (listeners re-render), or null after toasting the error; a conflict ("changed on the PC") also refetches.
 */
export async function setRoles(key: RolesKey, value: unknown, base: unknown, target: string): Promise<RolesMsg | null> {
  try {
    const msg = { t: "roles_set", key, value, base, ...(target ? { target } : {}) };
    const r = await request<RolesMsg>(msg, 60_000);
    setRolesState(target, r);
    return r;
  } catch (e) {
    const text = (e as Error).message;
    toast(text, "err");
    if (text.includes("changed on the PC")) refreshRoles(target).catch(() => {});
    return null;
  }
}

/** The pane's current model: `omp.model`, else a list entry whose display name matches the footer name. */
export function currentModel(o: OmpInfo | undefined): ModelInfo | undefined {
  if (!o) return undefined;
  const m = findModel(o.model);
  if (m || !o.modelName || !models) return m;
  const want = shortName(o.modelName).toLowerCase();
  const provider = o.model?.split("/", 1)[0];
  const hits = models.models.filter((x) => shortName(x.name).toLowerCase() === want);
  return hits.find((x) => x.provider === provider) ?? hits[0];
}

export function modelLabel(o: OmpInfo): string {
  const name = o.modelName || currentModel(o)?.name || o.model?.split("/").pop() || "";
  return shortName(name) || "Model";
}

// ---------------------------------------------------------------- commands

export type CmdName = "switch" | "effort" | "fast" | "plan" | "compact" | "new" | "clear" | "retry" | "resume" | "rename" | "stop" | "queue" | "page" | "preset";

const CMD_LABEL: Record<CmdName, string> = {
  switch: "Switching model",
  effort: "Setting thinking",
  fast: "Fast mode",
  plan: "Plan mode",
  compact: "Starting compaction",
  new: "New session",
  clear: "Clearing context",
  retry: "Retrying",
  resume: "Resuming",
  rename: "Renaming",
  stop: "Stopping",
  queue: "Queueing",
  page: "Opening page",
  preset: "Applying preset",
};

const pending = new Map<string, { cmd: CmdName; label: string }[]>();
const pendingListeners = new Set<() => void>();
export function onPending(fn: () => void) {
  pendingListeners.add(fn);
}
export function pendingFor(target: string): { cmd: CmdName; label: string } | undefined {
  const l = pending.get(target);
  return l?.[l.length - 1];
}
export function isPending(target: string, cmd: CmdName): boolean {
  return !!pending.get(target)?.some((p) => p.cmd === cmd);
}
function notifyPending() {
  for (const fn of pendingListeners) fn();
}

/**
 * Runs an omp command in the pane (live only). Resolves with the daemon's reply when `ok`;
 * rejects with the daemon's error text otherwise.
 */
export async function runCmd(target: string, cmd: CmdName, arg?: string): Promise<CmdMsg> {
  const item = { cmd, label: CMD_LABEL[cmd] };
  const list = pending.get(target) ?? [];
  list.push(item);
  pending.set(target, list);
  notifyPending();
  try {
    const msg: { t: string; target: string; cmd: string; arg?: string } = { t: "cmd", target, cmd };
    if (arg != null) msg.arg = arg;
    const m = await request<CmdMsg>(msg, 45_000);
    if (!m.ok) throw new Error(m.error || `${cmd} failed`);
    return m;
  } finally {
    const l = pending.get(target);
    if (l) {
      l.splice(l.indexOf(item), 1);
      if (!l.length) pending.delete(target);
    }
    notifyPending();
  }
}

/** Runs a command in the current omp pane and toasts the outcome; true on success. */
export async function ompCmd(cmd: CmdName, arg?: string, okText = ""): Promise<boolean> {
  const p = currentPane();
  if (!p?.agent) {
    toast("Not an omp terminal", "err");
    return false;
  }
  try {
    const m = await runCmd(p.target, cmd, arg);
    const text = m.info && m.info !== "compacting" ? m.info : okText;
    if (text) toast(text, "ok");
    return true;
  } catch (e) {
    toast((e as Error).message, "err");
    return false;
  }
}

/** User-facing text for a failed native-page request; the PC's `error.code` picks a clearer message. */
export function errText(e: unknown): string {
  const code = e instanceof RequestError ? e.code : "";
  switch (code) {
    case "no_extension":
      return "omp in this terminal hasn't loaded the devdeck extension. Restart omp in this terminal (/restart, or exit and start omp again).";
    case "busy":
      return "The agent is working. Stop it or wait for the turn to end, then try again.";
    case "btw_busy":
      return "A side question is already running in this session. Wait for it or cancel it.";
    case "live":
      return "That session is open in a terminal; it can't be deleted.";
  }
  return (e as Error)?.message || String(e);
}
