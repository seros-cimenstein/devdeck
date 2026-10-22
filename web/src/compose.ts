// Compose bar: multi-line input with per-terminal drafts, send (+Enter) / long-press send (no Enter), attach.
import { bridge } from "./bridge";
import { onOutboxChange, outboxFor, retrySend } from "./outbox";
import { state } from "./state";
import { toast } from "./ui";
import { debounce, h, icon, lsGet, lsSet } from "./util";

const LONG_PRESS_MS = 450;
const DRAFTS_KEY = "dd.drafts";

export class Compose {
  readonly el: HTMLElement;
  private readonly ta: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private target = "";
  private drafts = lsGet<Record<string, string>>(DRAFTS_KEY, {});

  constructor(private readonly onSend: (target: string, text: string, enter: boolean) => void) {
    this.ta = h("textarea.c-input", { rows: 1, placeholder: "Message", enterkeyhint: "enter", autocapitalize: "sentences" }) as HTMLTextAreaElement;
    this.sendBtn = h("button.c-send", { "aria-label": "Send (long-press: without Enter)", html: icon("send") }) as HTMLButtonElement;
    const attach = h("button.ib.c-attach", { "aria-label": "Attach files", html: icon("attach"), onclick: () => bridge.pickFiles() });
    this.status = h("div.c-status", { hidden: true });
    this.el = h("div.compose", null, this.status, h("div.c-row", null, attach, this.ta, this.sendBtn));

    const saveDraft = debounce(() => {
      if (!this.target) return;
      const v = this.ta.value;
      if (v) this.drafts[this.target] = v;
      else delete this.drafts[this.target];
      lsSet(DRAFTS_KEY, this.drafts);
    }, 300);
    this.ta.addEventListener("input", () => {
      this.autosize();
      saveDraft();
    });

    let timer = 0;
    let long = false;
    this.sendBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // keep the keyboard open
      long = false;
      timer = window.setTimeout(() => {
        long = true;
        bridge.haptic();
        this.submit(false);
      }, LONG_PRESS_MS);
    });
    const cancel = () => clearTimeout(timer);
    this.sendBtn.addEventListener("pointerup", () => {
      cancel();
      if (!long) this.submit(true);
    });
    this.sendBtn.addEventListener("pointerleave", cancel);
    this.sendBtn.addEventListener("pointercancel", cancel);
    this.sendBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    this.sendBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") this.submit(true);
    });
    onOutboxChange(() => this.renderStatus());
  }

  setTarget(target: string) {
    this.target = target;
    this.ta.value = this.drafts[target] || "";
    this.autosize();
    this.renderStatus();
  }

  setPlaceholder(text: string) {
    this.ta.placeholder = text;
  }

  focus() {
    this.ta.focus();
  }

  private submit(enter: boolean) {
    if (!this.target) {
      toast("No terminal selected", "err");
      return;
    }
    const text = this.ta.value.replace(/\s+$/, "");
    if (!text && !enter) return;
    this.onSend(this.target, text, enter);
    this.ta.value = "";
    delete this.drafts[this.target];
    lsSet(DRAFTS_KEY, this.drafts);
    this.autosize();
    if (!enter) toast("Pasted without Enter");
  }

  private autosize() {
    const ta = this.ta;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`;
  }

  /** In terminal view there is no chat outbox, so pending/failed sends show here. */
  renderStatus() {
    const s = this.status;
    s.textContent = "";
    if (state.view === "chat") {
      s.hidden = true;
      return;
    }
    const items = outboxFor(this.target);
    const failed = items.filter((i) => i.failed);
    if (!items.length) {
      s.hidden = true;
      return;
    }
    s.hidden = false;
    if (failed.length) {
      const f = failed[0];
      s.className = "c-status err";
      s.append(h("span", { text: `Send failed: ${f.failed}` }), h("button.lnk", { text: "Retry", onclick: () => retrySend(f.id) }));
    } else {
      s.className = "c-status";
      s.append(h("span.spin.xs"), h("span", { text: items.length === 1 ? "Sending..." : `Sending ${items.length}...` }));
    }
  }
}
