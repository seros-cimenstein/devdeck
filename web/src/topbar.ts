// Top bar: drawer button with attention dot, current terminal, view toggle, Live entry / pill, link indicator, overflow.
import { badgeEl, badgeKind, currentPane, paneTitle, setBadge, state } from "./state";
import type { LinkMsg } from "./types";
import { fmtRtt, h, icon } from "./util";

export interface TopBarHandlers {
  drawer(): void;
  toggleView(): void;
  more(anchor: HTMLElement): void;
  linkInfo(): void;
  /** Long-press on the terminal name (agent panes). */
  sessionMenu(anchor: HTMLElement): void;
  /** Live entry: starts a call, or returns to the running one. */
  live(): void;
}

export class TopBar {
  readonly el: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly title: HTMLElement;
  private readonly ctx: HTMLElement;
  private readonly viewBtn: HTMLButtonElement;
  private readonly linkDot: HTMLElement;
  private readonly linkText: HTMLElement;
  private readonly queued: HTMLElement;
  private readonly upload: HTMLElement;
  private readonly uploadFill: HTMLElement;
  private readonly uploadText: HTMLElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly liveText: HTMLElement;

  constructor(hd: TopBarHandlers) {
    this.dot = h("span.att-dot");
    const menu = h("button.ib.tb-menu", { "aria-label": "Terminals", onclick: hd.drawer }, h("span.icw", { html: icon("menu") }), this.dot);
    this.badge = badgeEl("shell");
    this.title = h("span.tb-name");
    this.ctx = h("div.tb-ctx");
    const titles = h("button.tb-titles", null, h("div.tb-line", null, this.badge, this.title), this.ctx);
    let pressTimer = 0;
    let longPressed = false;
    titles.addEventListener("pointerdown", () => {
      longPressed = false;
      pressTimer = window.setTimeout(() => {
        if (!currentPane()?.agent) return;
        longPressed = true;
        hd.sessionMenu(titles);
      }, 500);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) titles.addEventListener(ev, () => clearTimeout(pressTimer));
    titles.addEventListener("contextmenu", (e) => e.preventDefault());
    titles.addEventListener("click", () => {
      if (!longPressed) hd.drawer();
      longPressed = false;
    });
    this.viewBtn = h("button.ib.tb-view", { onclick: hd.toggleView }) as HTMLButtonElement;
    this.linkDot = h("span.l-dot");
    this.linkText = h("span.l-rtt");
    this.queued = h("span.l-q", { hidden: true });
    const link = h("button.tb-link", { onclick: hd.linkInfo, "aria-label": "Connection" }, this.linkDot, this.linkText, this.queued);
    const more = h("button.ib", { "aria-label": "More", html: icon("more") });
    more.addEventListener("click", () => hd.more(more));
    this.uploadFill = h("div.up-fill");
    this.uploadText = h("span.up-text");
    this.upload = h("div.upload", { hidden: true }, this.uploadFill, this.uploadText);
    this.liveText = h("span.tb-live-t");
    this.liveBtn = h("button.tb-live", { "aria-label": "Start Live voice chat", onclick: hd.live }, h("span.tb-orb"), this.liveText) as HTMLButtonElement;
    this.el = h("header.topbar", null, h("div.tb-row", null, menu, titles, this.viewBtn, this.liveBtn, link, more), this.upload);
  }

  update() {
    const p = currentPane();
    setBadge(this.badge, badgeKind(p));
    this.badge.hidden = !state.target;
    const title = paneTitle(p, state.target);
    if (this.title.textContent !== title) this.title.textContent = title;
    const closed = !!state.target && !p && state.panes.length > 0;
    const ctx = closed ? "Terminal closed" : p ? p.context || (p.agent ? "" : p.cmd) || p.target : state.target ? "" : "Pick a terminal";
    if (this.ctx.textContent !== ctx) this.ctx.textContent = ctx;
    this.ctx.classList.toggle("warn", closed);
    const agent = !!p?.agent;
    this.viewBtn.hidden = !agent;
    const view = state.view === "chat" ? "term" : "chat";
    if (this.viewBtn.dataset.icon !== view) {
      this.viewBtn.dataset.icon = view;
      this.viewBtn.innerHTML = icon(view);
    }
    this.viewBtn.setAttribute("aria-label", state.view === "chat" ? "Terminal view" : "Chat view");
  }

  setAttention(on: boolean) {
    this.dot.classList.toggle("on", on);
  }

  /** Idle: an orb button that starts Live; during a call: a "Live" pill (with elapsed time) that returns to it. */
  setLive(s: { active: boolean; elapsed: string; muted: boolean }) {
    this.liveBtn.classList.toggle("on", s.active);
    this.liveBtn.classList.toggle("muted", s.active && s.muted);
    this.liveText.textContent = s.active ? (s.elapsed ? `Live ${s.elapsed}` : "Live") : "";
    this.liveBtn.setAttribute("aria-label", s.active ? "Return to the Live call" : "Start Live voice chat");
  }

  setLink(l: LinkMsg) {
    this.linkDot.className = `l-dot l-${l.state}`;
    this.linkText.textContent = l.state === "online" ? fmtRtt(l.rtt) : l.state === "connecting" ? "..." : l.state === "unpaired" ? "unpaired" : l.state === "idle" ? "idle" : "offline";
    const q = l.queued || 0;
    this.queued.hidden = q <= 0;
    this.queued.textContent = String(q);
    const up = l.uploading;
    this.upload.hidden = !up;
    if (up) {
      const pct = Math.max(0, Math.min(100, Math.round(up.pct)));
      this.uploadFill.style.transform = `scaleX(${pct / 100})`;
      this.uploadText.textContent = `Uploading ${up.name} ${pct}%`;
    }
  }
}
