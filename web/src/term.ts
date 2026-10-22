// Terminal view: plain-text pane screen from `screen` messages, quick keys, pinch zoom.
import { bridge, send } from "./bridge";
import { cacheGet, cachePut } from "./cache";
import type { ScreenMsg } from "./types";
import { debounce, h, icon, lsGet, lsSet } from "./util";

const CACHE_LINES = 400;
const FONT_KEY = "dd.termFont";
const DOUBLE_TAP_MS = 1000;

interface CachedScreen {
  lines: string[];
}

const KEYS: { label: string; key: string; confirm?: boolean; icon?: string }[][] = [
  [
    { label: "Up", key: "Up", icon: "up" },
    { label: "Down", key: "Down", icon: "down" },
    { label: "Space", key: "Space" },
    { label: "Enter", key: "Enter" },
    { label: "Esc", key: "Escape" },
    { label: "Tab", key: "Tab" },
  ],
  [
    { label: "Left", key: "Left", icon: "back" },
    { label: "Right", key: "Right", icon: "chev" },
    { label: "^C", key: "C-c", confirm: true },
    { label: "^D", key: "C-d", confirm: true },
    { label: "PgUp", key: "PageUp" },
    { label: "PgDn", key: "PageDown" },
  ],
];

export class TermView {
  readonly wrap: HTMLElement;
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly empty: HTMLElement;
  private lines: string[] = [];
  private nodes: HTMLElement[] = [];
  private rev = -1;
  private target = "";
  private live = false;
  private atBottom = true;
  private font = lsGet<number>(FONT_KEY, 12);
  private armed: { key: string; at: number; el: HTMLElement } | null = null;

  constructor() {
    this.body = h("div.term-lines");
    this.empty = h("div.empty", { text: "Waiting for screen..." });
    this.el = h("div.term-scroll", null, this.body, this.empty);
    this.pill = h("button.jump", { onclick: () => this.scrollToBottom() }, h("span.icw", { html: icon("down") }), h("span", { text: "Bottom" }));
    this.keys = h("div.qkeys");
    for (const row of KEYS) {
      const r = h("div.qrow");
      for (const k of row) {
        const b = h("button.qk", { "aria-label": k.label, "data-key": k.key });
        if (k.icon) b.innerHTML = icon(k.icon);
        else b.textContent = k.label;
        b.addEventListener("click", () => this.press(k.key, !!k.confirm, b));
        r.append(b);
      }
      this.keys.append(r);
    }
    this.wrap = h("div.view.term-view", null, h("div.term-box", null, this.el, this.pill), this.keys);
    this.applyFont();

    this.el.addEventListener(
      "scroll",
      () => {
        const d = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
        this.atBottom = d < 32;
        this.pill.classList.toggle("show", d > this.el.clientHeight * 0.5);
      },
      { passive: true },
    );
    const ro = new ResizeObserver(() => {
      if (this.atBottom) this.el.scrollTop = this.el.scrollHeight;
    });
    ro.observe(this.body);
    ro.observe(this.el);
    this.setupPinch();
  }

  setTarget(target: string) {
    if (target === this.target) return;
    this.saveNow();
    this.target = target;
    this.live = false;
    this.rev = -1;
    this.setLines([]);
    this.wrap.classList.remove("stale");
    void cacheGet<CachedScreen>("scr:" + target).then((c) => {
      if (!c || this.target !== target || this.live) return;
      this.setLines(c.lines);
      this.wrap.classList.add("stale");
      this.scrollToBottom();
    });
  }

  onScreen(m: ScreenMsg) {
    if (m.target !== this.target) return;
    if (m.full) {
      this.live = true;
      this.wrap.classList.remove("stale");
      this.rev = m.rev;
      this.setLines(m.lines || []);
    } else {
      if (!this.live || m.base !== this.rev || m.len == null || m.len < 0) {
        send({ t: "resync" });
        return;
      }
      const next = this.lines.slice(0, m.len);
      while (next.length < m.len) next.push("");
      for (const [i, s] of m.set || []) {
        if (i < 0 || i >= m.len) {
          send({ t: "resync" });
          return;
        }
        next[i] = s;
      }
      this.rev = m.rev;
      this.setLines(next);
    }
    if (this.atBottom) this.el.scrollTop = this.el.scrollHeight;
    this.saveSoon();
  }

  /** Mark the screen stale (link down or view switched away). */
  setStale(stale: boolean) {
    this.wrap.classList.toggle("stale", stale);
    if (stale) this.live = false;
  }

  private setLines(next: string[]) {
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

  scrollToBottom() {
    this.atBottom = true;
    this.el.scrollTop = this.el.scrollHeight;
    this.pill.classList.remove("show");
  }

  private press(key: string, confirm: boolean, el: HTMLElement) {
    if (!this.target) return;
    if (confirm) {
      const now = Date.now();
      if (!this.armed || this.armed.key !== key || now - this.armed.at > DOUBLE_TAP_MS) {
        this.armed?.el.classList.remove("armed");
        this.armed = { key, at: now, el };
        el.classList.add("armed");
        const a = this.armed;
        setTimeout(() => {
          if (this.armed === a) {
            a.el.classList.remove("armed");
            this.armed = null;
          }
        }, DOUBLE_TAP_MS);
        return;
      }
      el.classList.remove("armed");
      this.armed = null;
    }
    bridge.haptic();
    if (!send({ t: "keys", target: this.target, keys: [key] })) el.animate?.([{ background: "var(--error)" }, {}], 300);
  }

  private applyFont() {
    this.wrap.style.setProperty("--term-font", `${this.font}px`);
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

  private saveSoon = debounce(() => this.saveNow(), 2000);
  private saveNow() {
    if (!this.target || !this.live || !this.lines.length) return;
    void cachePut<CachedScreen>("scr:" + this.target, {
      lines: this.lines.slice(-CACHE_LINES),
    });
  }
}
