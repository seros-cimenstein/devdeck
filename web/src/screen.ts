// Monospace mirror of a pane screen fed by `screen` messages (full frames + line diffs), with pinch zoom.
import type { ScreenMsg } from "./types";
import { h, lsGet, lsSet } from "./util";

const FONT_KEY = "dd.termFont";

export class ScreenMirror {
  /** Scroll container. */
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly empty: HTMLElement;
  lines: string[] = [];
  nodes: HTMLElement[] = [];
  rev = -1;
  live = false;
  private font = lsGet<number>(FONT_KEY, 12);

  /** `fontHost` gets the `--term-font` variable. */
  constructor(
    private readonly fontHost: HTMLElement,
    emptyText: string,
  ) {
    this.body = h("div.term-lines");
    this.empty = h("div.empty", { text: emptyText });
    this.el = h("div.term-scroll", null, this.body, this.empty);
    this.applyFont();
    this.setupPinch();
  }

  /** Applies a frame; false when a diff does not fit and a resync is needed. */
  apply(m: ScreenMsg): boolean {
    if (m.full) {
      this.live = true;
      this.rev = m.rev;
      this.setLines(m.lines || []);
      return true;
    }
    if (!this.live || m.base !== this.rev || m.len == null || m.len < 0) return false;
    const next = this.lines.slice(0, m.len);
    while (next.length < m.len) next.push("");
    for (const [i, s] of m.set || []) {
      if (i < 0 || i >= m.len) return false;
      next[i] = s;
    }
    this.rev = m.rev;
    this.setLines(next);
    return true;
  }

  reset() {
    this.live = false;
    this.rev = -1;
    this.setLines([]);
  }

  setLines(next: string[]) {
    const body = this.body;
    const nodes = this.nodes;
    const prev = this.lines;
    const n = next.length;
    for (let i = 0; i < Math.min(n, nodes.length); i++) {
      if (prev[i] !== next[i]) nodes[i].textContent = next[i] || "\u200b";
    }
    if (n > nodes.length) {
      const frag = document.createDocumentFragment();
      for (let i = nodes.length; i < n; i++) {
        const d = document.createElement("div");
        d.textContent = next[i] || "\u200b";
        nodes.push(d);
        frag.append(d);
      }
      body.append(frag);
    } else if (n < nodes.length) {
      for (let i = n; i < nodes.length; i++) nodes[i].remove();
      nodes.length = n;
    }
    this.lines = next;
    this.empty.hidden = n > 0;
  }

  private applyFont() {
    this.fontHost.style.setProperty("--term-font", `${this.font}px`);
  }

  private setupPinch() {
    let startDist = 0;
    let startFont = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.el.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          startDist = dist(e.touches);
          startFont = this.font;
        }
      },
      { passive: true },
    );
    this.el.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 2 || !startDist) return;
        e.preventDefault();
        const f = Math.round(Math.min(24, Math.max(6, (startFont * dist(e.touches)) / startDist)) * 2) / 2;
        if (f !== this.font) {
          this.font = f;
          this.applyFont();
        }
      },
      { passive: false },
    );
    this.el.addEventListener("touchend", (e) => {
      if (startDist && e.touches.length < 2) {
        startDist = 0;
        lsSet(FONT_KEY, this.font);
      }
    });
  }
}
