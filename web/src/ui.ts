// Shared UI primitives: closable layer stack (for hardware back), toast, panels, popover menu.
import { h, icon } from "./util";

export interface Layer {
  close(): void;
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
/** Closes the topmost layer; false when nothing was open. */
export function popLayer(): boolean {
  const l = layers.pop();
  if (!l) return false;
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
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  requestAnimationFrame(() => menu.classList.add("open"));
  pushLayer(layer);
}
