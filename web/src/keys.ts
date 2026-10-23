// Two rows of quick keys sent to the pane as tmux key names; ^C/^D need a double tap.
import { bridge, send } from "./bridge";
import { h, icon } from "./util";

const DOUBLE_TAP_MS = 1000;

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

export class QuickKeys {
  readonly el: HTMLElement;
  private armed: { key: string; at: number; el: HTMLElement } | null = null;

  constructor(private readonly target: () => string) {
    this.el = h("div.qkeys");
    for (const row of KEYS) {
      const r = h("div.qrow");
      for (const k of row) {
        const b = h("button.qk", { "aria-label": k.label, "data-key": k.key });
        if (k.icon) b.innerHTML = icon(k.icon);
        else b.textContent = k.label;
        b.addEventListener("click", () => this.press(k.key, !!k.confirm, b));
        r.append(b);
      }
      this.el.append(r);
    }
  }

  private press(key: string, confirm: boolean, el: HTMLElement) {
    const target = this.target();
    if (!target) return;
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
    if (!send({ t: "keys", target, keys: [key] })) el.animate?.([{ background: "var(--error)" }, {}], 300);
  }
}
