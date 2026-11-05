// Compose bar: multi-line input with per-terminal drafts, send (+Enter) / long-press send (no Enter), attach,
// Stop while the agent works, queue-as-follow-up, slash palette and quick keys for agent panes.
import { bridge } from "./bridge";
import { actions } from "./controls";
import { QuickKeys } from "./keys";
import { liveStatus } from "./live";
import { isOnline, isPending, ompCmd, onPending } from "./omp";
import { onOutboxChange, outboxFor, retrySend } from "./outbox";
import { state } from "./state";
import { openMenu, toast } from "./ui";
import { debounce, h, icon, lsGet, lsSet, onHide } from "./util";
import { setEnabled, voiceEnabled } from "./voice";

const LONG_PRESS_MS = 450;
const DRAFTS_KEY = "dd.drafts";
const KEYS_KEY = "dd.chatKeys";

interface SlashCmd {
  name: string;
  desc: string;
  aliases?: string[];
  /** Native action; without one, picking the command puts `/name ` in the input to add an argument and send. */
  run?: () => void;
}

const SLASH: SlashCmd[] = [
  { name: "model", desc: "Models and roles (native hub)", aliases: ["models", "switch"], run: actions.model },
  { name: "modelpreset", desc: "Model presets (hub, Roles tab)", aliases: ["presets"], run: actions.presets },
  { name: "effort", desc: "Set the thinking level", aliases: ["thinking"], run: actions.effort },
  { name: "fast", desc: "Toggle the fast tier", run: actions.fast },
  { name: "plan", desc: "Toggle plan mode", run: () => void actions.plan() },
  { name: "plan-review", desc: "Review the current plan", run: actions.planReview },
  { name: "btw", desc: "Side question, the agent keeps working", run: () => actions.btw() },
  { name: "compact", desc: "Compact the context (optional focus)", run: actions.compact },
  { name: "new", desc: "Start a new session", run: () => void actions.newSession() },
  { name: "resume", desc: "Resume or delete sessions, all projects", run: actions.resume },
  { name: "restore", desc: "Reopen sessions cut off or closed (crash, reboot)", run: actions.restore },
  { name: "rewind", desc: "Go back to before an earlier prompt", run: actions.rewind },
  { name: "branch", desc: "Branch from an earlier prompt", run: actions.branch },
  { name: "tree", desc: "Session tree: browse and switch branches", run: actions.tree },
  { name: "clear", desc: "Clear the context, keep the session", run: () => void actions.clear() },
  { name: "retry", desc: "Retry the last failed turn", run: actions.retry },
  { name: "rename", desc: "Rename this session", run: actions.rename },
  { name: "session", desc: "Session info (id, file, tokens, cost)", run: actions.sessionInfo },
  { name: "usage", desc: "Provider limits, saved resets, session spend", run: actions.usage },
  { name: "settings", desc: "omp settings", run: actions.settings },
  { name: "sketch", desc: "Draw for the agent (/sketch diagram: mark up a diagram)", run: () => actions.sketch() },
  { name: "diagramify", desc: "SVG picture of this project (add #code or a path to zoom)" },
  { name: "basic", desc: "SVG diagram of what you describe after it" },
];

/**
 * Typed commands whose omp version would open a terminal page (or, for `/btw`, an inline panel where Esc
 * would stop the agent), or that omp has no slash command for (`/restore`): handled natively instead. The
 * argument is ignored except for `/btw` and `/resume`.
 */
const NATIVE_TYPED: Record<string, (arg: string) => void> = {
  btw: (arg) => actions.btw(arg || undefined),
  "plan-review": () => actions.planReview(),
  resume: (arg) => (arg ? void ompCmd("resume", arg) : actions.resume()),
  restore: () => actions.restore(),
  rewind: () => actions.rewind(),
  branch: () => actions.branch(),
  tree: () => actions.tree(),
  session: () => actions.sessionInfo(),
  usage: () => actions.usage(),
  settings: () => actions.settings(),
};

export class Compose {
  readonly el: HTMLElement;
  private readonly ta: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly keysBtn: HTMLButtonElement;
  private readonly voiceBtn: HTMLButtonElement;
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
    this.voiceBtn = h("button.ib.c-attach.c-voice", {
      "aria-label": "Voice mode",
      title: "Voice mode",
      html: icon("headset"),
      // Both use the microphone; Live owns it while a call runs.
      onclick: () => (!voiceEnabled() && liveStatus().active ? toast("End the Live call to use voice mode") : setEnabled(!voiceEnabled())),
    }) as HTMLButtonElement;
    this.el = h("div.compose", null, this.slash, this.status, this.keys.el, h("div.c-row", null, attach, this.keysBtn, this.ta, this.voiceBtn, this.sendBtn));

    const saveDraft = debounce(() => {
      if (!this.target) return;
      const v = this.ta.value;
      if (v) this.drafts[this.target] = v;
      else delete this.drafts[this.target];
      lsSet(DRAFTS_KEY, this.drafts);
    }, 300);
    onHide(saveDraft.flush);
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

  /** Adds `text` to the draft of `target` (after any text already there); shown at once for the open terminal. */
  putDraft(target: string, text: string) {
    const cur = target === this.target ? this.ta.value : this.drafts[target] || "";
    const next = cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${text}` : text;
    this.drafts[target] = next;
    lsSet(DRAFTS_KEY, this.drafts);
    if (target !== this.target) return;
    this.ta.value = next;
    this.autosize();
    this.refresh();
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
    this.voiceBtn.hidden = !keysAvail;
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
    const agent = !!state.byTarget.get(this.target)?.agent;
    const sketch = /^\/sketch(?:\s+(diagram))?$/.exec(text.trim());
    if (sketch && agent) {
      this.clearInput();
      actions.sketch(!!sketch[1]);
      return;
    }
    // Bare model commands would open omp's terminal page or picker; open the native hub instead.
    // `/model x` still goes to omp (the daemon rewrites it to `/switch x`).
    const modelCmd = /^\/(models?|switch|modelpreset)$/.exec(text.trim());
    if (modelCmd && agent) {
      this.clearInput();
      this.ta.blur();
      if (modelCmd[1] === "modelpreset") actions.presets();
      else actions.model();
      return;
    }
    const native = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const run = native && agent && Object.hasOwn(NATIVE_TYPED, native[1]) ? NATIVE_TYPED[native[1]] : undefined;
    if (run) {
      this.clearInput();
      this.ta.blur();
      run(native![2]?.trim() ?? "");
      return;
    }
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
    const sig = hits.map((c) => c.name).join(",") + (isOnline() ? "" : "!");
    this.slash.hidden = !hits.length;
    if (sig === this.slashSig) return;
    this.slashSig = sig;
    this.slash.textContent = "";
    const off = !isOnline();
    for (const c of hits) {
      const b = h("button.sl-item", { role: "option", disabled: off }, h("span.sl-name", { text: "/" + c.name }), h("span.sl-desc", { text: c.desc }));
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        this.slash.hidden = true;
        if (!c.run) {
          this.ta.value = `/${c.name} `;
          this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
          this.ta.dispatchEvent(new Event("input"));
          return;
        }
        this.clearInput();
        this.ta.blur();
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
