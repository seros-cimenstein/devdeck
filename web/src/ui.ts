// Shared UI primitives: closable layer stack (for hardware back), toast, panels, popover menu.
import { h, icon } from "./util";

export interface Layer {
  close(): void;
  /** Optional in-layer back step (e.g. a sub-page); true when handled, so the layer stays. */
  back?(): boolean;
}
const layers: Layer[] = [];

export function pushLayer(l: Layer) {
  removeLayer(l);
  layers.push(l);
}
export function removeLayer(l: Layer) {
  const i = layers.indexOf(l);
  if (i >= 0) layers.splice(i, 1);
}
/** Hardware back: an in-layer step of the topmost layer, else closes it; false when nothing was open. */
export function popLayer(): boolean {
  const l = layers.at(-1);
  if (!l) return false;
  if (l.back?.()) return true;
  layers.pop();
  l.close();
  return true;
}

// ---- toast
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
export function toast(text: string, kind: "" | "err" | "ok" = "") {
  if (!toastEl) {
    toastEl = h("div.toast", { role: "status" });
    document.body.append(toastEl);
  }
  const t = toastEl;
  t.textContent = text;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), Math.min(8000, 2200 + text.length * 40));
}

// ---- full-screen panel sliding in from the right
export class Panel implements Layer {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly subEl: HTMLElement;
  readonly actions: HTMLElement;
  readonly body: HTMLElement;
  private closed = false;
  onClose?: () => void;

  constructor(title: string, cls = "") {
    this.titleEl = h("div.p-title", { text: title });
    this.subEl = h("div.p-sub");
    this.actions = h("div.p-actions");
    this.head = h(
      "div.p-head",
      null,
      h("button.ib", { "aria-label": "Back", html: icon("back"), onclick: () => this.close() }),
      h("div.p-titles", null, this.titleEl, this.subEl),
      this.actions,
    );
    this.body = h("div.p-body");
    this.el = h(`div.panel${cls ? "." + cls : ""}`, null, this.head, this.body);
    document.getElementById("app")!.append(this.el);
    requestAnimationFrame(() => requestAnimationFrame(() => this.el.classList.add("open")));
    pushLayer(this);
  }

  setTitle(t: string, sub = "") {
    this.titleEl.textContent = t;
    this.subEl.textContent = sub;
    this.subEl.hidden = !sub;
  }

  action(iconName: string, label: string, fn: () => void): HTMLButtonElement {
    const b = h("button.ib", { "aria-label": label, title: label, html: icon(iconName), onclick: fn }) as HTMLButtonElement;
    this.actions.append(b);
    return b;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    removeLayer(this);
    this.el.classList.remove("open");
    const el = this.el;
    const done = () => el.remove();
    el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 400);
    this.onClose?.();
  }
}

export function spinnerEl(text = ""): HTMLElement {
  return h("div.loading", null, h("span.spin"), text ? h("span", { text }) : null);
}

export function errorEl(text: string, retry?: () => void): HTMLElement {
  return h(
    "div.errbox",
    null,
    h("div", { text }),
    retry ? h("button.btn", { text: "Retry", onclick: retry }) : null,
  );
}

// ---- popover menu anchored to a button
export interface MenuItem {
  label: string;
  icon?: string;
  toggle?: boolean;
  on?: boolean;
  disabled?: boolean;
  act: () => void;
}
export function openMenu(anchor: HTMLElement, items: MenuItem[]) {
  const scrim = h("div.menu-scrim");
  const menu = h("div.menu", { role: "menu" });
  const layer: Layer = {
    close() {
      removeLayer(layer);
      menu.classList.remove("open");
      scrim.remove();
      setTimeout(() => menu.remove(), 180);
    },
  };
  for (const it of items) {
    const row = h(
      "button.menu-item",
      { role: "menuitem", disabled: it.disabled },
      it.icon ? h("span.icw", { html: icon(it.icon) }) : h("span.icw"),
      h("span.mi-label", { text: it.label }),
      it.toggle ? h(`span.switch${it.on ? ".on" : ""}`) : null,
    );
    row.addEventListener("click", () => {
      layer.close();
      it.act();
    });
    menu.append(row);
  }
  scrim.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    layer.close();
  });
  document.body.append(scrim, menu);
  const r = anchor.getBoundingClientRect();
  menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  const mh = menu.offsetHeight;
  if (r.bottom + 4 + mh > innerHeight - 8 && r.top - 4 - mh >= 8) {
    menu.style.top = `${r.top - 4 - mh}px`;
    menu.style.transformOrigin = "bottom right";
  } else menu.style.top = `${r.bottom + 4}px`;
  requestAnimationFrame(() => menu.classList.add("open"));
  pushLayer(layer);
}

// ---- bottom sheet created on demand and removed when closed; later sheets stack above earlier ones
let sheetDepth = 0;
export class Sheet implements Layer {
  readonly scrim: HTMLElement;
  readonly el: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly subEl: HTMLElement;
  readonly body: HTMLElement;
  readonly foot: HTMLElement;
  isOpen = true;
  onClose?: () => void;
  onBack?: () => boolean;

  constructor(title: string, sub = "", cls = "") {
    this.titleEl = h("div.sheet-title", { text: title });
    this.subEl = h("div.sheet-sub", { text: sub, hidden: !sub });
    this.body = h("div.sheet-body");
    this.foot = h("div.sheet-foot", { hidden: true });
    this.scrim = h("div.scrim.sheet-scrim", { onclick: () => this.close() });
    this.el = h(
      `div.sheet${cls ? "." + cls : ""}`,
      { role: "dialog", "aria-modal": "true" },
      h("div.grab"),
      h(
        "div.sheet-head.pad",
        null,
        h("div.sh-titles", null, this.titleEl, this.subEl),
        h("button.ib", { "aria-label": "Close", html: icon("close"), onclick: () => this.close() }),
      ),
      this.body,
      this.foot,
    );
    const z = 30 + 2 * sheetDepth++;
    this.scrim.style.zIndex = String(z);
    this.el.style.zIndex = String(z + 1);
    document.getElementById("app")!.append(this.scrim, this.el);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!this.isOpen) return;
        this.scrim.classList.add("open");
        this.el.classList.add("open");
      }),
    );
    pushLayer(this);
  }

  setSub(sub: string) {
    this.subEl.textContent = sub;
    this.subEl.hidden = !sub;
  }

  back(): boolean {
    return this.onBack?.() ?? false;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    sheetDepth--;
    removeLayer(this);
    this.scrim.classList.remove("open");
    this.el.classList.remove("open");
    const { el, scrim } = this;
    const done = () => {
      el.remove();
      scrim.remove();
    };
    el.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 450);
    this.onClose?.();
  }
}

export interface ConfirmOpts {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
}
/** Small confirmation sheet; resolves true only when the user confirms. */
export function confirmSheet(o: ConfirmOpts): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const s = new Sheet(o.title, "", "small");
  s.body.append(h("p.sheet-text", { text: o.text }));
  s.foot.hidden = false;
  s.foot.classList.add("row");
  s.foot.append(
    h("button.btn.wide", { text: "Cancel", onclick: () => s.close() }),
    h(`button.btn.wide.primary${o.danger ? ".danger" : ""}`, {
      text: o.ok,
      onclick: () => {
        resolve(true);
        s.close();
      },
    }),
  );
  s.onClose = () => resolve(false);
  return promise;
}
