// App-wide state shared by views; `hooks` are wired by main.ts.
import type { Ask, LinkMsg, Pane, PaneState } from "./types";
import { h, icon, lsGet } from "./util";

export type View = "chat" | "term";

export const state = {
  panes: [] as Pane[],
  byTarget: new Map<string, Pane>(),
  target: "",
  view: "chat" as View,
  link: null as LinkMsg | null,
  /** Agents that finished a turn while you were not looking. */
  done: new Set<string>(lsGet<string[]>("dd.done", [])),
};

export const hooks = {
  open: (_target: string, _view?: View) => {},
  openAsk: (_target: string, _ask: Ask) => {},
  openFiles: (_path?: string) => {},
  openGit: (_path: string) => {},
  openFile: (_path: string) => {},
};

export const currentPane = (): Pane | undefined => state.byTarget.get(state.target);

export function paneTitle(p: Pane | undefined, target = ""): string {
  if (!p) return target || "No terminal";
  const generic = !p.name || p.name === p.cmd || p.name === p.session;
  return generic ? p.session : `${p.session} · ${p.name}`;
}

export type BadgeKind = PaneState | "done";
export function badgeKind(p: Pane | undefined): BadgeKind {
  if (!p) return "shell";
  if (p.agent && p.state === "idle" && state.done.has(p.target)) return "done";
  return p.state;
}

const BADGE_TITLES: Record<BadgeKind, string> = {
  working: "Working",
  asking: "Needs your answer",
  done: "Finished",
  idle: "Idle",
  running: "Running",
  shell: "Shell",
};

export function badgeEl(kind: BadgeKind): HTMLElement {
  const b = h(`span.badge.b-${kind}`, { title: BADGE_TITLES[kind], "aria-label": BADGE_TITLES[kind] });
  setBadge(b, kind);
  return b;
}
export function setBadge(b: HTMLElement, kind: BadgeKind) {
  if (b.dataset.kind === kind) return;
  b.dataset.kind = kind;
  b.className = `badge b-${kind}`;
  b.title = BADGE_TITLES[kind];
  switch (kind) {
    case "working":
      b.innerHTML = '<span class="spin"></span>';
      break;
    case "asking":
      b.textContent = "?";
      break;
    case "done":
      b.innerHTML = icon("check");
      break;
    case "idle":
      b.textContent = "\u03c0";
      break;
    case "running":
      b.innerHTML = icon("play");
      break;
    default:
      b.textContent = "$";
  }
}
