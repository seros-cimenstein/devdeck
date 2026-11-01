// Sketch canvas: the omp `sketch` extension's own drawing page, fetched from the PC and shown in an
// iframe. The page's fetch() and EventSource calls are relayed over the DevDeck link by a shim
// injected in front of its scripts (README "Sketch").
import { request, send } from "./bridge";
import { paneTitle, state } from "./state";
import type { SketchEventMsg, SketchHttpMsg, SketchOpenMsg } from "./types";
import { errorEl, Panel, spinnerEl, toast } from "./ui";
import { h } from "./util";

const OPEN_TIMEOUT_MS = 50_000; // may type `/sketch url` into omp first (waits for the pane's command lock)
const SEND_TIMEOUT_MS = 120_000; // a PNG over a slow link

/** The relay end the shim talks to (same-origin iframe, so it calls the parent directly). */
interface RelaySource {
  _open(): void;
  _error(closed: boolean): void;
  _event(type: string, data: string): void;
}
interface Host {
  http(method: string, path: string, body?: string): Promise<{ status: number; type: string; body: string }>;
  attach(es: RelaySource): void;
  detach(es: RelaySource): void;
}

// Runs inside the iframe before the page's own script. The 📱 button (QR code to open the page on a
// phone) is hidden: the page already is on the phone, and its LAN link would bypass DevDeck.
const SHIM = `<style>#phone{display:none!important}</style><script>(() => {
const host = parent.__ddSketch;
window.fetch = async (input, init = {}) => {
  const path = new URL(String(input), "http://omp/").pathname;
  const r = await host.http(String(init.method || "GET").toUpperCase(), path, typeof init.body === "string" ? init.body : undefined);
  return new Response(r.body, { status: r.status, headers: { "Content-Type": r.type || "text/plain" } });
};
class RelayEventSource extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  constructor() { super(); this.readyState = 0; this.onopen = this.onerror = this.onmessage = null; host.attach(this); }
  close() { this.readyState = 2; host.detach(this); }
  _open() { this.readyState = 1; const e = new Event("open"); this.onopen?.(e); this.dispatchEvent(e); }
  _error(closed) { this.readyState = closed ? 2 : 0; const e = new Event("error"); this.onerror?.(e); this.dispatchEvent(e); }
  _event(type, data) { const e = new MessageEvent(type, { data }); if (type === "message") this.onmessage?.(e); this.dispatchEvent(e); }
}
window.EventSource = RelayEventSource;
})();</script>`;

function inject(html: string): string {
  const i = html.search(/<head[^>]*>/i);
  if (i < 0) return SHIM + html;
  const end = html.indexOf(">", i) + 1;
  return html.slice(0, end) + SHIM + html.slice(end);
}

class SketchPanel extends Panel {
  private frame: HTMLIFrameElement | null = null;
  private es: RelaySource | null = null;
  private connected = false;
  private lastState: string | null = null;
  private loaded = false;

  constructor(
    readonly target: string,
    private diagram: boolean,
  ) {
    super("Sketch", "sketch");
    this.setTitle("Sketch", paneTitle(state.byTarget.get(target), target));
    this.load();
  }

  /** Hardware back closes the page's own dialogs (diagram list) before the panel. */
  back(): boolean {
    const open = this.frame?.contentDocument?.querySelector<HTMLDialogElement>("dialog[open]");
    if (!open) return false;
    open.close();
    return true;
  }

  close() {
    super.close();
    send({ t: "sketch", op: "close", target: this.target });
    if (current === this) {
      current = null;
      listeners.forEach((fn) => fn());
    }
  }

  private load() {
    this.loaded = false;
    this.body.replaceChildren(spinnerEl("Opening the canvas..."));
    request<SketchOpenMsg>({ t: "sketch", op: "open", target: this.target }, OPEN_TIMEOUT_MS).then(
      (m) => {
        if (current !== this) {
          if (!current) send({ t: "sketch", op: "close", target: this.target }); // closed while opening
          return;
        }
        (window as Window & { __ddSketch?: Host }).__ddSketch = this.host;
        const frame = h("iframe.sketch-frame", { title: "Sketch canvas" }) as HTMLIFrameElement;
        frame.addEventListener("load", () => this.onFrameLoad(), { once: true });
        frame.srcdoc = inject(m.html);
        this.frame = frame;
        this.loaded = true;
        this.body.replaceChildren(frame);
      },
      (err: Error) => {
        if (current !== this) return;
        this.body.replaceChildren(errorEl(err.message, () => this.load()));
      },
    );
  }

  /** Link back after a drop: the PC forgot this phone's event relay, so subscribe again. */
  resubscribe() {
    if (!this.loaded) return this.load();
    request<SketchOpenMsg>({ t: "sketch", op: "open", target: this.target }, OPEN_TIMEOUT_MS).catch((err: Error) =>
      toast(`Sketch: ${err.message}`, "err"),
    );
  }

  offline() {
    this.setConnected(false, false);
  }

  /** `/sketch diagram`: put the newest chat diagram on the canvas once the page runs. */
  showDiagram() {
    this.diagram = true;
    if (this.frame?.contentDocument?.readyState === "complete") this.onFrameLoad();
  }

  private onFrameLoad() {
    if (!this.diagram) return;
    this.diagram = false;
    this.http("GET", "/diagrams")
      .then((r) => {
        const list = JSON.parse(r.body) as unknown[];
        if (!Array.isArray(list) || !list.length) return toast("No SVG diagram in this session yet");
        this.es?._event("diagram", JSON.stringify(list[0]));
      })
      .catch((err: Error) => toast(`Diagram: ${err.message}`, "err"));
  }

  onEvent(m: SketchEventMsg) {
    switch (m.event) {
      case "open":
        return this.setConnected(true, false);
      case "down":
        return this.setConnected(false, false);
      case "closed":
        return this.setConnected(false, true);
      default:
        if (m.data === undefined) return;
        if (m.event === "state") this.lastState = m.data;
        this.es?._event(m.event, m.data);
    }
  }

  private setConnected(on: boolean, closed: boolean) {
    this.connected = on;
    if (on) this.es?._open();
    else this.es?._error(closed);
  }

  private http(method: string, path: string, body?: string) {
    const timeout = path === "/send" ? SEND_TIMEOUT_MS : undefined;
    return request<SketchHttpMsg>({ t: "sketch", op: "http", target: this.target, method, path, ...(body !== undefined ? { body } : {}) }, timeout);
  }

  private readonly host: Host = {
    http: (method, path, body) => this.http(method, path, body),
    attach: (es) => {
      this.es = es;
      // Called from inside the page's `new EventSource()`, before it sets onopen and its
      // listeners: replay what already arrived once that statement has finished.
      queueMicrotask(() => {
        if (this.es !== es) return;
        if (this.connected) es._open();
        if (this.lastState !== null) es._event("state", this.lastState);
      });
    },
    detach: (es) => {
      if (this.es === es) this.es = null;
    },
  };
}

let current: SketchPanel | null = null;
const listeners = new Set<() => void>();

/** Target whose canvas is open, if any. */
export const sketchOpenFor = (): string | null => current?.target ?? null;

export function onSketchChange(fn: () => void) {
  listeners.add(fn);
}

export function onSketchEvent(m: SketchEventMsg) {
  if (current?.target === m.target) current.onEvent(m);
}

/** Opens the canvas for an omp terminal (the PC starts it when needed); `diagram` loads the newest chat diagram. */
export function openSketch(target: string, diagram = false) {
  if (current?.target === target) {
    if (diagram) current.showDiagram();
    return;
  }
  current?.close();
  current = new SketchPanel(target, diagram);
  listeners.forEach((fn) => fn());
}

/** Link state changes: the event relay lives on the PC per connection. */
export function sketchLink(online: boolean) {
  if (!current) return;
  if (online) current.resubscribe();
  else current.offline();
}
