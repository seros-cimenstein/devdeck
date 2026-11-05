// Terminal view: plain-text pane screen from `screen` messages, quick keys, pinch zoom.
import { send } from "./bridge";
import { cacheGet, cachePut } from "./cache";
import { QuickKeys } from "./keys";
import { ScreenMirror } from "./screen";
import type { ScreenMsg } from "./types";
import { debounce, h, icon, onHide } from "./util";

const CACHE_LINES = 400;

interface CachedScreen {
  lines: string[];
}

export class TermView {
  readonly wrap: HTMLElement;
  private readonly scr: ScreenMirror;
  private readonly pill: HTMLElement;
  private target = "";
  private atBottom = true;

  constructor() {
    this.pill = h("button.jump", { onclick: () => this.scrollToBottom() }, h("span.icw", { html: icon("down") }), h("span", { text: "Bottom" }));
    const keys = new QuickKeys(() => this.target);
    this.wrap = h("div.view.term-view");
    this.scr = new ScreenMirror(this.wrap, "Waiting for screen...");
    this.wrap.append(h("div.term-box", null, this.scr.el, this.pill), keys.el);
    const el = this.scr.el;

    el.addEventListener(
      "scroll",
      () => {
        const d = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.atBottom = d < 32;
        this.pill.classList.toggle("show", d > el.clientHeight * 0.5);
      },
      { passive: true },
    );
    const ro = new ResizeObserver(() => {
      if (this.atBottom) el.scrollTop = el.scrollHeight;
    });
    ro.observe(this.scr.body);
    ro.observe(el);
    onHide(this.saveSoon.flush);
  }

  setTarget(target: string) {
    if (target === this.target) return;
    this.saveNow();
    this.target = target;
    this.scr.reset();
    void cacheGet<CachedScreen>("scr:" + target).then((c) => {
      if (!c || this.target !== target || this.scr.live) return;
      this.scr.setLines(c.lines);
      this.scrollToBottom();
    });
  }

  onScreen(m: ScreenMsg) {
    if (m.target !== this.target) return;
    if (!this.scr.apply(m)) {
      send({ t: "resync" });
      return;
    }
    if (this.atBottom) this.scr.el.scrollTop = this.scr.el.scrollHeight;
    this.saveSoon();
  }

  /** The screen stops being live (link down or view switched away). */
  suspend() {
    this.scr.live = false;
  }

  scrollToBottom() {
    this.atBottom = true;
    this.scr.el.scrollTop = this.scr.el.scrollHeight;
    this.pill.classList.remove("show");
  }

  private saveSoon = debounce(() => this.saveNow(), 2000);
  private saveNow() {
    if (!this.target || !this.scr.live || !this.scr.lines.length) return;
    void cachePut<CachedScreen>("scr:" + this.target, {
      lines: this.scr.lines.slice(-CACHE_LINES),
    });
  }
}
