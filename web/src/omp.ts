// omp session controls: model list cache, `cmd` requests with pending tracking, display helpers.
import { request } from "./bridge";
import { currentPane, state } from "./state";
import type { CmdMsg, ModelInfo, ModelsMsg, OmpInfo } from "./types";
import { toast } from "./ui";
import { lsGet, lsSet } from "./util";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABEL: Record<string, string> = { off: "Off", minimal: "Min", low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", auto: "Auto" };
export const levelLabel = (l: string) => LEVEL_LABEL[l] ?? l;

/** Levels offered for a model: omp always allows `off` in front of the model's own levels. */
export function levelsFor(m: ModelInfo | undefined): string[] {
  if (!m?.thinking?.length) return [];
  return ["off", ...m.thinking.filter((l) => l !== "off")];
}

/** The level to preselect: `want` when supported, else the closest supported one. */
export function pickLevel(levels: string[], want: string | null | undefined): string {
  if (!levels.length) return "";
  if (want && levels.includes(want)) return want;
  const wi = THINKING_LEVELS.indexOf(want || "medium");
  let best = levels[levels.length - 1];
  let bestD = Infinity;
  for (const l of levels) {
    const d = Math.abs(THINKING_LEVELS.indexOf(l) - wi);
    if (l !== "off" && d < bestD) {
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
  roles: Record<string, string>;
  fetchedAt?: number;
  /** When this client last received the list (ms). */
  at: number;
}

const MODELS_KEY = "dd.models";
const MODELS_FRESH_MS = 10 * 60_000;
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
      const d: ModelsData = { models: m.models || [], roles: m.roles || {}, fetchedAt: m.fetchedAt, at: Date.now() };
      const changed = !models || JSON.stringify(models.models) !== JSON.stringify(d.models) || JSON.stringify(models.roles) !== JSON.stringify(d.roles);
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

export type CmdName = "switch" | "effort" | "fast" | "plan" | "compact" | "new" | "clear" | "retry" | "resume" | "rename" | "stop" | "queue" | "page";

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
