// Live omp page panel: mirrors omp's full-screen pages (/model, /settings, pickers) inside chat view.
import { bridge, send } from "./bridge";
import { type Layer, pushLayer, removeLayer, toast } from "./ui";
import { ScreenMirror } from "./screen";
import type { ScreenMsg } from "./types";
import { h, icon, lsGet, lsSet } from "./util";

const DOUBLE_TAP_MS = 350;
const ESC_GAP_MS = 600;
const FIT_KEY = "dd.pageFit";

const BAR: { label: string; key: string; icon?: string }[] = [
  { label: "Up", key: "Up", icon: "up" },
  { label: "Down", key: "Down", icon: "down" },
  { label: "Left", key: "Left", icon: "back" },
  { label: "Right", key: "Right", icon: "chev" },
  { label: "Tab", key: "Tab" },
  { label: "Enter", key: "Enter" },
  { label: "Esc", key: "Escape" },
];

export class PagePanel implements Layer {
  readonly el: HTMLElement;
  private readonly scr: ScreenMirror;
  private readonly titleEl: HTMLElement;
  private readonly filter: HTMLInputElement;
  private target = "";
  private title = "";
  private cols = 0;
  private fit = lsGet<boolean>(FIT_KEY, false);
  private lastEsc = 0;
  private lastTap = { row: -1, at: 0 };
  private lastFrame = 0;
  private sentFilter = "";
  isOpen = false;
  /** Target whose page the user hid (until that page closes). */
  hiddenFor = "";
  /** Called when the panel opens or hides. */
  onChange?: () => void;

  constructor() {
    this.titleEl = h("div.p-title");
    const fitBtn = h("button.ib", { "aria-label": "Fit width", title: "Fit width", html: icon("wrap") });
    fitBtn.classList.toggle("on", this.fit);
    fitBtn.addEventListener("click", () => {
      this.fit = !this.fit;
      lsSet(FIT_KEY, this.fit);
      fitBtn.classList.toggle("on", this.fit);
      this.applyFit();
    });
    const head = h(
      "div.p-head",
      null,
      h("button.ib", { "aria-label": "Hide", title: "Hide (page stays open on the PC)", html: icon("chevDown"), onclick: () => this.hide() }),
      h("div.p-titles", null, this.titleEl, h("div.p-sub.pg-hint", { text: "Tap a row to select, double-tap to open" })),
      fitBtn,
      h("button.ib", { "aria-label": "Close page (Esc)", title: "Close page (Esc)", html: icon("close"), onclick: () => this.escape() }),
    );
    this.el = h("div.panel.page-panel");
    this.scr = new ScreenMirror(this.el, "Waiting for the page...");
    this.scr.el.classList.add("pg-screen");
    this.scr.body.addEventListener("click", (e) => this.onTap(e));

    const bar = h("div.qrow.pg-keys");
    for (const k of BAR) {
      const b = h("button.qk", { "aria-label": k.label });
      if (k.icon) b.innerHTML = icon(k.icon);
      else b.textContent = k.label;
      b.addEventListener("click", () => (k.key === "Escape" ? this.escape() : this.keys([k.key], b)));
      bar.append(b);
    }
    this.filter = h("input.field.pg-filter", { type: "text", placeholder: "Type to filter", autocomplete: "off", autocapitalize: "none", spellcheck: "false", enterkeyhint: "go" }) as HTMLInputElement;
    this.filter.addEventListener("input", () => this.onFilter());
    this.filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.keys(["Enter"]);
      }
    });
    const bs = h("button.qk.pg-bs", { "aria-label": "Backspace", text: "\u232b" });
    bs.addEventListener("click", () => {
      this.keys(["BSpace"], bs);
      this.filter.value = this.sentFilter = this.sentFilter.slice(0, -1);
    });
    this.el.append(head, h("div.term-box", null, this.scr.el), h("div.qkeys.pg-bar", null, bar, h("div.pg-frow", null, this.filter, bs)));
    document.getElementById("app")!.append(this.el);
  }

  get openFor(): string {
    return this.isOpen ? this.target : "";
  }

  /** Pane state for the watched target; page frames are authoritative for a short while after they arrive. */
  sync(target: string, page: { title?: string } | null | undefined) {
    if (target !== this.target) {
      this.reset();
      this.target = target;
    }
    if (!page) {
      if (Date.now() - this.lastFrame > 2500) this.reset();
      return;
    }
    this.setTitle(page.title || "omp page");
    if (this.hiddenFor !== target) this.show();
  }

  /** A `screen` message carrying `page`. */
  onScreen(m: ScreenMsg) {
    if (m.page === false) {
      if (m.target === this.target) this.reset();
      return;
    }
    if (m.target !== this.target) {
      this.reset();
      this.target = m.target;
    }
    this.lastFrame = Date.now();
    if (!this.scr.apply(m)) {
      send({ t: "resync" });
      return;
    }
    if (m.cols !== this.cols) {
      this.cols = m.cols;
      this.applyFit();
    }
    if (!this.title) this.setTitle("omp page");
    if (this.hiddenFor !== m.target) this.show();
  }

  /** Back button / close: one Escape to omp; the panel goes away when omp reports the page closed. */
  close() {
    this.escape();
    if (this.isOpen) pushLayer(this);
  }

  /** Hides the panel locally; the page stays open in omp. */
  hide() {
    if (!this.isOpen) return;
    this.hiddenFor = this.target;
    this.setOpen(false);
  }

  show() {
    if (this.hiddenFor === this.target) this.hiddenFor = "";
    if (!this.isOpen && this.target) this.setOpen(true);
  }

  /** Forgets the page (closed in omp, or the watched pane changed). */
  reset() {
    this.lastFrame = 0;
    this.hiddenFor = "";
    this.title = "";
    this.cols = 0;
    this.sentFilter = "";
    this.filter.value = "";
    this.scr.reset();
    this.setOpen(false);
  }

  private setOpen(open: boolean) {
    if (open === this.isOpen) return;
    this.isOpen = open;
    if (open) {
      this.el.classList.add("open");
      pushLayer(this);
    } else {
      this.el.classList.remove("open");
      removeLayer(this);
      this.filter.blur();
    }
    this.onChange?.();
  }

  private setTitle(t: string) {
    this.title = t;
    this.titleEl.textContent = t;
  }

  private applyFit() {
    const s = this.scr.el.style;
    if (!this.fit || !this.cols) {
      s.removeProperty("--fit-font");
      this.el.classList.remove("fit");
      return;
    }
    const w = this.scr.el.clientWidth || innerWidth;
    // JetBrains Mono advance is 0.6em; keep 20px of padding.
    s.setProperty("--fit-font", `${Math.max(5, Math.floor(((w - 20) / (this.cols * 0.6)) * 10) / 10)}px`);
    this.el.classList.add("fit");
  }

  private keys(keys: string[], el?: HTMLElement) {
    if (!this.target) return;
    bridge.haptic();
    if (!send({ t: "keys", target: this.target, keys })) {
      el?.animate?.([{ background: "var(--error)" }, {}], 300);
      toast("Offline", "err");
    }
  }

  private escape() {
    const now = Date.now();
    if (now - this.lastEsc < ESC_GAP_MS) return;
    this.lastEsc = now;
    this.keys(["Escape"]);
  }

  private onTap(e: MouseEvent) {
    const line = (e.target as HTMLElement).closest(".term-lines > div");
    if (!line || !this.target) return;
    const row = this.scr.nodes.indexOf(line as HTMLElement);
    if (row < 0) return;
    const now = Date.now();
    const double = this.lastTap.row === row && now - this.lastTap.at < DOUBLE_TAP_MS;
    this.lastTap = double ? { row: -1, at: 0 } : { row, at: now };
    line.classList.remove("tapped");
    void (line as HTMLElement).offsetWidth;
    line.classList.add("tapped");
    if (double) {
      this.keys(["Enter"]);
      return;
    }
    bridge.haptic();
    if (!send({ t: "tap", target: this.target, row })) toast("Offline", "err");
  }

  private onFilter() {
    const v = this.filter.value.replace(/\n/g, "");
    const prev = this.sentFilter;
    let common = 0;
    while (common < v.length && common < prev.length && v[common] === prev[common]) common++;
    const del = prev.length - common;
    const add = v.slice(common);
    if (del > 0) this.keys(Array(Math.min(del, 64)).fill("BSpace"));
    if (add && this.target && !send({ t: "type", target: this.target, text: add.slice(0, 200) })) toast("Offline", "err");
    this.sentFilter = v;
  }
}
