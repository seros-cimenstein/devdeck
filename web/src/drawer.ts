// Terminals drawer: left-edge swipe or button; lists every pane with status.
import { badgeEl, badgeKind, paneTitle, state } from "./state";
import { type Layer, pushLayer, removeLayer } from "./ui";
import { h, icon, tildify } from "./util";

const EDGE = 24;

export class Drawer implements Layer {
  private readonly el: HTMLElement;
  private readonly scrim: HTMLElement;
  private readonly list: HTMLElement;
  private readonly hostEl: HTMLElement;
  private sig = "";
  isOpen = false;

  constructor(
    private readonly onPick: (target: string) => void,
    private readonly onNew: () => void,
  ) {
    this.list = h("div.d-list");
    this.hostEl = h("div.d-host");
    this.el = h(
      "aside.drawer",
      { "aria-label": "Terminals" },
      h("div.d-head", null, h("div", null, h("div.d-title", { text: "Terminals" }), this.hostEl)),
      this.list,
      h("button.d-new", { onclick: () => (this.close(), this.onNew()) }, h("span.icw", { html: icon("plus") }), h("span", { text: "New terminal" })),
    );
    this.scrim = h("div.scrim.d-scrim", { onclick: () => this.close() });
    document.getElementById("app")!.append(this.scrim, this.el);
    this.setupSwipe();
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render(true);
    this.el.style.transform = "";
    this.scrim.style.opacity = "";
    this.el.classList.add("open");
    this.scrim.classList.add("open");
    pushLayer(this);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    removeLayer(this);
    this.el.style.transform = "";
    this.scrim.style.opacity = "";
    this.el.classList.remove("open");
    this.scrim.classList.remove("open");
  }

  render(force = false) {
    this.hostEl.textContent = state.link?.host || "";
    const sig = JSON.stringify([state.target, [...state.done], state.panes.map((p) => [p.target, p.state, p.context, p.cwd, p.name, p.cmd, !!p.ask])]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    if (!this.isOpen && !force) return;
    const frag = document.createDocumentFragment();
    if (!state.panes.length) frag.append(h("div.empty", { text: state.link?.state === "online" ? "No tmux panes" : "Not connected" }));
    for (const p of state.panes) {
      const cur = p.target === state.target;
      const sub = p.context || (p.agent ? "" : p.cmd);
      frag.append(
        h(
          `button.d-item${cur ? ".cur" : ""}${p.state === "asking" ? ".ask" : ""}`,
          { onclick: () => (this.close(), this.onPick(p.target)) },
          badgeEl(badgeKind(p)),
          h(
            "span.d-main",
            null,
            h("span.d-top", null, h("span.d-name", { text: paneTitle(p) }), h("span.d-tgt", { text: `${p.window}.${p.pane}` })),
            sub ? h("span.d-ctx", { text: sub }) : null,
            h("span.d-cwd", { text: tildify(p.cwd) }),
          ),
        ),
      );
    }
    this.list.textContent = "";
    this.list.append(frag);
  }

  private setupSwipe() {
    let startX = 0;
    let startY = 0;
    let mode: "" | "open" | "close" | "none" = "";
    let dx = 0;
    let t0 = 0;
    const width = () => this.el.offsetWidth || 320;
    document.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        dx = 0;
        t0 = performance.now();
        mode = "";
        if (!this.isOpen && startX <= EDGE && !document.querySelector(".panel.open, .sheet.open")) mode = "open";
        else if (this.isOpen) mode = "close";
        else mode = "none";
      },
      { passive: true },
    );
    document.addEventListener(
      "touchmove",
      (e) => {
        if (mode !== "open" && mode !== "close") return;
        const t = e.touches[0];
        const mx = t.clientX - startX;
        const my = t.clientY - startY;
        if (!dx && Math.abs(my) > Math.abs(mx) && Math.abs(my) > 8) {
          mode = "none";
          return;
        }
        dx = mx;
        const w = width();
        const off = mode === "open" ? Math.min(0, -w + Math.max(0, dx)) : Math.min(0, dx);
        if (mode === "close" && dx > -6) return;
        if (mode === "open" && dx < 6) return;
        this.el.classList.add("drag");
        this.scrim.classList.add("drag", "open");
        this.el.style.transform = `translateX(${off}px)`;
        this.scrim.style.opacity = String(1 + off / w);
        if (mode === "open" && !this.list.childNodes.length) this.render(true);
      },
      { passive: true },
    );
    document.addEventListener("touchend", () => {
      if (mode !== "open" && mode !== "close") return;
      const w = width();
      const v = dx / Math.max(1, performance.now() - t0);
      this.el.classList.remove("drag");
      this.scrim.classList.remove("drag");
      if (mode === "open" && dx > 6) {
        if (dx > w * 0.35 || v > 0.4) this.open();
        else {
          this.el.style.transform = "";
          this.scrim.style.opacity = "";
          this.scrim.classList.remove("open");
        }
      } else if (mode === "close" && dx < -6) {
        if (-dx > w * 0.3 || v < -0.4) this.close();
        else {
          this.el.style.transform = "";
          this.scrim.style.opacity = "";
        }
      }
      mode = "";
    });
  }
}
