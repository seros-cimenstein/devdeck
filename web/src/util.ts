export type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

/** Tiny DOM builder: h("div.cls#id", {attrs}, ...children). */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | string,
  attrs?: Attrs | null,
  ...kids: (Node | string | null | undefined | false)[]
): HTMLElement {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const el = document.createElement((m && m[1]) || "div");
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k === "html") el.innerHTML = String(v);
      else if (k === "text") el.textContent = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const k of kids) if (k != null && k !== false) el.append(k);
  return el;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  const d = (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
  return d;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Relative age of a unix-seconds or ISO timestamp. */
export function fmtAgo(t: number | string): string {
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  if (!isFinite(ms)) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
}

export function fmtRtt(ms: number | null | undefined): string {
  if (ms == null || !(ms > 0)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

let home = "";
/** Learns the home directory from any absolute path (first two components under /home, or /root). */
export function learnHome(p: string) {
  if (home) return;
  const m = /^(\/home\/[^/]+|\/root)(\/|$)/.exec(p);
  if (m) home = m[1];
}
export function homeDir(): string {
  return home;
}
export function tildify(p: string): string {
  if (!p) return p;
  learnHome(p);
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return p;
}

export function basename(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1) || "/";
}
export function dirname(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
}
export function joinPath(a: string, b: string): string {
  return a.endsWith("/") ? a + b : a + "/" + b;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- Long-lived busy indicators (working badges, running tools, the working row, unsent items, asking
// badges) step from one 2 Hz timer instead of running CSS animations: in the WebView any running animation
// makes the whole view redraw every vsync (measured ~25% app + ~20% renderer CPU for one spinner, ~100% +
// ~25% for a working agent's indicators), a 2 Hz step a few percent. Elements opt in through `ticking()`;
// the CSS draws the phase in `data-ph` (0..3). Hidden indicators and those in a closed drawer or sheet are
// not stepped; the timer stops when none exist or the page is hidden.
const TICK_MS = 500;
const ticks = document.getElementsByClassName("tick");
let tickTimer = 0;
let tickPhase = 0;

function stepTicks() {
  if (!ticks.length || document.hidden) {
    clearInterval(tickTimer);
    tickTimer = 0;
    return;
  }
  tickPhase = (tickPhase + 1) & 3;
  const ph = String(tickPhase);
  for (const el of ticks) {
    if (el.checkVisibility() && !el.closest(".drawer:not(.open), .sheet:not(.open)")) (el as HTMLElement).dataset.ph = ph;
  }
}

function startTicks() {
  if (!tickTimer && !document.hidden && !reducedMotion()) tickTimer = window.setInterval(stepTicks, TICK_MS);
}

/** Makes `el` a stepped busy indicator (see above); returns it. */
export function ticking<T extends HTMLElement>(el: T): T {
  el.classList.add("tick");
  el.dataset.ph = String(tickPhase);
  startTicks();
  return el;
}

document.addEventListener("visibilitychange", () => {
  if (ticks.length) startTicks();
});

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function lsGet<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}
export function lsSet(key: string, v: unknown) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota: drafts and prefs are best effort */
  }
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", mjs: "javascript",
  cjs: "javascript", jsx: "javascript", py: "python", pyi: "python", rs: "rust", go: "go", java: "java",
  kt: "kotlin", kts: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", rb: "ruby", php: "php", swift: "swift", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", jsonl: "json", json5: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  conf: "ini", service: "ini", xml: "xml", html: "xml", htm: "xml", svg: "xml", css: "css", scss: "scss",
  less: "less", sql: "sql", lua: "lua", pl: "perl", r: "r", diff: "diff", patch: "diff", makefile: "makefile",
  mk: "makefile", dockerfile: "dockerfile", md: "markdown", markdown: "markdown", vb: "vbnet", gradle: "groovy",
};
export function langForPath(p: string): string | undefined {
  const name = basename(p).toLowerCase();
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === "dockerfile") return "dockerfile";
  const i = name.lastIndexOf(".");
  return i < 0 ? undefined : EXT_LANG[name.slice(i + 1)];
}

/** Stroke icons (24x24 viewBox). */
const ICON_PATHS: Record<string, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  more: "M12 5h.01M12 12h.01M12 19h.01",
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M12 5v14M5 12l7 7 7-7",
  chev: "M9 6l6 6-6 6",
  chevDown: "M6 9l6 6 6-6",
  send: "M4 12l16-8-6 16-3-7-7-1z",
  attach: "M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7",
  chat: "M4 5h16v11H9l-5 4z",
  term: "M4 4h16v16H4zM7 9l3 3-3 3M12 15h5",
  folder: "M3 6h6l2 2h10v11H3z",
  file: "M6 3h8l5 5v13H6zM14 3v5h5",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  link: "M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1",
  git: "M6 3v12M6 15a3 3 0 103 3M18 9a3 3 0 10-3-3M18 9c0 6-9 3-9 9",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12l5 5 9-10",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  wrap: "M4 6h16M4 12h13a3 3 0 010 6h-4l2-2m-2 2l2 2M4 18h5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z",
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6z",
  bell: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4",
  sun: "M12 7a5 5 0 100 10 5 5 0 000-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2",
  play: "M8 5l11 7-11 7z",
  history: "M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 3",
  info: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5v.01",
  stop: "M7 7h10v10H7z",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M18 10h-.01M7 14h10",
  edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  eraser: "M8 20h12M5 15l9-9 5 5-8 8H8z",
  compress: "M4 9h16M4 15h16M12 3v4M10 5l2 2 2-2M12 21v-4M10 19l2-2 2 2",
  plan: "M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v8",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  mic: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3M9 21h6",
  headset: "M4 15v-3a8 8 0 0116 0v3M4 14h3v6H5a1 1 0 01-1-1zM20 14h-3v6h2a1 1 0 001-1z",
  volume: "M4 9h4l5-4v14l-5-4H4zM16.5 9a4 4 0 010 6M19 6.5a8 8 0 010 11",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  micOff: "M9 9v3a3 3 0 005.1 2.1M15 9.3V6a3 3 0 00-5.9-.8M5 11a7 7 0 0011.7 5.2M19 11a7 7 0 01-.5 2.6M12 18v3M9 21h6M3 3l18 18",
  hangup: "M3 14.5c5-4.7 13-4.7 18 0l-2.6 2.6-3.4-1.6V13c-2-.8-4-.8-6 0v2.5l-3.4 1.6z",
  wave: "M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4",
  expand: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  rewind: "M11 6l-6 6 6 6M19 6l-6 6 6 6",
  btw: "M4 5h16v11H9l-5 4zM10 9a2 2 0 113 1.7c-.6.4-1 .8-1 1.3M12 14h.01",
  tree: "M6 3v18M6 7h7M6 15h7M15 7a2 2 0 104 0 2 2 0 00-4 0M15 15a2 2 0 104 0 2 2 0 00-4 0",
  gauge: "M3.5 17a8.5 8.5 0 1117 0M12 17l4-5.5M12 17h.01",
};
export function icon(name: string, cls = ""): string {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[name] || ""}"/></svg>`;
}
export function iconEl(name: string, cls = ""): HTMLElement {
  const s = document.createElement("span");
  s.className = "icw";
  s.innerHTML = icon(name, cls);
  return s;
}
