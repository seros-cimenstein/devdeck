// Compose bar: multi-line input with per-terminal drafts, send (+Enter) / long-press send (no Enter), attach,
// Stop while the agent works, queue-as-follow-up, slash palette and quick keys for agent panes.
import { bridge } from "./bridge";
import { actions, PAGE_CMDS } from "./controls";
import { QuickKeys } from "./keys";
import { isOnline, isPending, onPending } from "./omp";
import { onOutboxChange, outboxFor, retrySend } from "./outbox";
import { state } from "./state";
import { openMenu, toast } from "./ui";
import { debounce, h, icon, lsGet, lsSet } from "./util";

const LONG_PRESS_MS = 450;
const DRAFTS_KEY = "dd.drafts";
const KEYS_KEY = "dd.chatKeys";

interface SlashCmd {
  name: string;
  desc: string;
  aliases?: string[];
  page?: boolean;
  run: () => void;
}

const SLASH: SlashCmd[] = [
  { name: "model", desc: "Switch model for this session", aliases: ["models", "switch"], run: actions.model },
  { name: "effort", desc: "Set the thinking level", aliases: ["thinking"], run: actions.effort },
  { name: "fast", desc: "Toggle the fast tier", run: actions.fast },
  { name: "plan", desc: "Toggle plan mode", run: () => void actions.plan() },
  { name: "compact", desc: "Compact the context (optional focus)", run: actions.compact },
  { name: "new", desc: "Start a new session", run: () => void actions.newSession() },
  { name: "resume", desc: "Resume an earlier session", run: actions.resume },
  { name: "clear", desc: "Clear the context, keep the session", run: () => void actions.clear() },
  { name: "retry", desc: "Retry the last failed turn", run: actions.retry },
  { name: "rename", desc: "Rename this session", run: actions.rename },
  ...PAGE_CMDS.map((c) => ({ name: c.cmd.slice(1), desc: c.desc, page: true, run: () => actions.page(c.cmd) })),
];

export class Compose {
  readonly el: HTMLElement;
  private readonly ta: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly keysBtn: HTMLButtonElement;
  private readonly keys: QuickKeys;
  private readonly slash: HTMLElement;
  private readonly status: HTMLElement;
  private target = "";
  private drafts = lsGet<Record<string, string>>(DRAFTS_KEY, {});
  private keysOn = lsGet<boolean>(KEYS_KEY, false);
  private mode: "send" | "stop" = "send";
  private face = "send";
  private slashSig = "";

  constructor(private readonly onSend: (target: string, text: string, enter: boolean) => void) {
    this.ta = h("textarea.c-input", { rows: 1, placeholder: "Message", enterkeyhint: "enter", autocapitalize: "sentences" }) as HTMLTextAreaElement;
    this.sendBtn = h("button.c-send", { "aria-label": "Send (long-press: without Enter)", html: icon("send") }) as HTMLButtonElement;
    const attach = h("button.ib.c-attach", { "aria-label": "Attach files", html: icon("attach"), onclick: () => bridge.pickFiles() });
    this.keysBtn = h("button.ib.c-attach.c-keys", { "aria-label": "Quick keys", title: "Quick keys", html: icon("keyboard") }) as HTMLButtonElement;
    this.keysBtn.addEventListener("click", () => {
      this.keysOn = !this.keysOn;
      lsSet(KEYS_KEY, this.keysOn);
      this.refresh();
    });
    this.keys = new QuickKeys(() => this.target);
    this.keys.el.classList.add("c-qkeys");
    this.slash = h("div.slash", { role: "listbox", hidden: true });
    this.status = h("div.c-status", { hidden: true });
    this.el = h("div.compose", null, this.slash, this.status, this.keys.el, h("div.c-row", null, attach, this.keysBtn, this.ta, this.sendBtn));

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
      this.refresh();
    });
    this.ta.addEventListener("blur", () => setTimeout(() => this.renderSlash(), 150));
    this.ta.addEventListener("focus", () => this.renderSlash());

    let timer = 0;
    let long = false;
    this.sendBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // keep the keyboard open
      long = false;
      if (this.mode === "stop") return;
      timer = window.setTimeout(() => {
        long = true;
        bridge.haptic();
        if (this.agentWorking() && this.ta.value.trim()) this.openSendMenu();
        else this.submit(false);
      }, LONG_PRESS_MS);
    });
    const cancel = () => clearTimeout(timer);
    this.sendBtn.addEventListener("pointerup", () => {
      cancel();
      if (long) return;
      if (this.mode === "stop") void this.stop();
      else this.submit(true);
    });
    this.sendBtn.addEventListener("pointerleave", cancel);
    this.sendBtn.addEventListener("pointercancel", cancel);
    this.sendBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    this.sendBtn.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (this.mode === "stop") void this.stop();
      else this.submit(true);
    });
    onOutboxChange(() => this.renderStatus());
    onPending(() => this.refresh());
  }

  setTarget(target: string) {
    this.target = target;
    this.ta.value = this.drafts[target] || "";
    this.autosize();
    this.renderStatus();
    this.refresh();
  }

  focus() {
    this.ta.focus();
  }

  private agentWorking(): boolean {
    const p = state.byTarget.get(this.target);
    return !!p?.agent && p.state === "working";
  }

  /** Re-derives the send/stop button, placeholder, keys row and palette from pane state. */
  refresh() {
    const p = state.byTarget.get(this.target);
    const agent = !!p?.agent;
    const busy = this.agentWorking();
    const empty = !this.ta.value.trim();
    const stopping = busy && empty && isPending(this.target, "stop");
    const mode = busy && empty ? "stop" : "send";
    const face = stopping ? "stopping" : mode;
    if (face !== this.face) {
      this.face = face;
      this.sendBtn.classList.toggle("stop", mode === "stop");
      this.sendBtn.classList.toggle("busy", stopping);
      this.sendBtn.innerHTML = stopping ? '<span class="spin"></span>' : icon(mode === "stop" ? "stop" : "send");
    }
    this.mode = mode;
    this.sendBtn.setAttribute("aria-label", mode === "stop" ? "Stop the agent" : busy ? "Steer (long-press: queue or paste)" : "Send (long-press: without Enter)");
    this.sendBtn.classList.toggle("off", mode === "stop" && !isOnline());
    this.ta.placeholder = !p || agent ? (busy ? "Steer (hold send to queue)" : "Message") : "Type a command";
    const keysAvail = agent && state.view === "chat";
    this.keysBtn.hidden = !keysAvail;
    this.keysBtn.classList.toggle("on", this.keysOn);
    this.keys.el.hidden = !(keysAvail && this.keysOn);
    this.renderSlash();
  }

  private async stop() {
    if (isPending(this.target, "stop")) return;
    if (!isOnline()) return toast("Offline: cannot stop the agent", "err");
    await actions.stop();
    this.refresh();
  }

  private openSendMenu() {
    openMenu(this.sendBtn, [
      {
        label: "Queue as follow-up",
        icon: "list",
        disabled: !isOnline(),
        act: () => {
          const text = this.ta.value.replace(/\s+$/, "");
          if (!text) return;
          const target = this.target;
          void actions.queue(text).then((ok) => {
            if (ok && this.target === target && this.ta.value.replace(/\s+$/, "") === text) this.clearInput();
          });
        },
      },
      { label: "Send without Enter", icon: "send", act: () => this.submit(false) },
    ]);
  }

  private clearInput() {
    this.ta.value = "";
    delete this.drafts[this.target];
    lsSet(DRAFTS_KEY, this.drafts);
    this.autosize();
    this.refresh();
  }

  private submit(enter: boolean) {
    if (!this.target) {
      toast("No terminal selected", "err");
      return;
    }
    const text = this.ta.value.replace(/\s+$/, "");
    if (!text && !enter) return;
    this.onSend(this.target, text, enter);
    this.clearInput();
    if (!enter) toast("Pasted without Enter");
  }

  private renderSlash() {
    const p = state.byTarget.get(this.target);
    const m = /^\/([\w-]*)$/.exec(this.ta.value);
    const show = !!p?.agent && !!m && document.activeElement === this.ta;
    const q = m?.[1].toLowerCase() ?? "";
    const hits = show ? SLASH.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))) : [];
    const sig = hits.map((c) => c.name + (c.page ? "*" : "")).join(",") + (isOnline() ? "" : "!");
    this.slash.hidden = !hits.length;
    if (sig === this.slashSig) return;
    this.slashSig = sig;
    this.slash.textContent = "";
    const off = !isOnline();
    let pageHeader = false;
    for (const c of hits) {
      if (c.page && !pageHeader) {
        pageHeader = true;
        this.slash.append(h("div.sl-sec", { text: "omp pages (live)" }));
      }
      const b = h(
        "button.sl-item",
        { role: "option", disabled: off },
        h("span.sl-name", { text: "/" + c.name }),
        h("span.sl-desc", { text: c.desc }),
        c.page ? h("span.tag", { text: "page" }) : null,
      );
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        this.clearInput();
        this.ta.blur();
        this.slash.hidden = true;
        c.run();
      });
      this.slash.append(b);
    }
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
