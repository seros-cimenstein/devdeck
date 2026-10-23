// Thin wrapper around the Android `window.DD` bridge plus req/response plumbing.
import type { Msg } from "./types";

interface DDBridge {
  send(json: string): boolean;
  enqueue(json: string): string;
  pickFiles(): void;
  setWakelock(on: boolean): void;
  setNotify(on: boolean): void;
  copyText(text: string): void;
  openUrl(url: string): void;
  haptic(): void;
  ready(): void;
  backResult?(handled: boolean): void;
  // voice (absent on older shells)
  listen?(json: string): void;
  stopListening?(): void;
  stopSpeaking?(): void;
  setVoiceMode?(on: boolean): void;
  // live (GPT Live call; absent on older shells)
  liveStart?(json: string): void;
  liveStop?(): void;
  liveMute?(on: boolean): void;
}

const noop = () => {};
const stub: DDBridge = {
  send: () => false,
  enqueue: () => "",
  pickFiles: noop,
  setWakelock: noop,
  setNotify: noop,
  copyText: (t) => void navigator.clipboard?.writeText(t).catch(noop),
  openUrl: (u) => void window.open(u, "_blank", "noopener"),
  haptic: noop,
  ready: noop,
};

function dd(): DDBridge {
  // The Android shell injects DD via addJavascriptInterface; it is absent in a plain browser.
  const w: Window & { DD?: DDBridge } = window;
  return w.DD ?? stub;
}

export function send(msg: Msg): boolean {
  try {
    return !!dd().send(JSON.stringify(msg));
  } catch {
    return false;
  }
}

/** Queues a durable item (send/clip/answer); returns its id. */
export function enqueue(msg: Msg & { id: string }): string {
  return String(dd().enqueue(JSON.stringify(msg)) || msg.id);
}

export const bridge = {
  pickFiles: () => dd().pickFiles(),
  setWakelock: (on: boolean) => dd().setWakelock(on),
  setNotify: (on: boolean) => dd().setNotify(on),
  copyText: (t: string) => dd().copyText(t),
  openUrl: (u: string) => dd().openUrl(u),
  haptic: () => {
    try {
      dd().haptic();
    } catch {
      /* optional */
    }
  },
  ready: () => dd().ready(),
  hasVoice: () => typeof dd().listen === "function",
  listen: (opts: { lang: string; partial?: boolean; preferOffline?: boolean }) => dd().listen?.(JSON.stringify(opts)),
  stopListening: () => dd().stopListening?.(),
  stopSpeaking: () => dd().stopSpeaking?.(),
  setVoiceMode: (on: boolean) => dd().setVoiceMode?.(on),
  backResult: (handled: boolean) => dd().backResult?.(handled),
  hasLive: () => typeof dd().liveStart === "function",
  liveStart: (opts: { voice: string; mode: string; target?: string }) => dd().liveStart?.(JSON.stringify(opts)),
  liveStop: () => dd().liveStop?.(),
  liveMute: (on: boolean) => dd().liveMute?.(on),
};

type Pending = { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: number };
const pending = new Map<string, Pending>();
let reqSeq = 0;

/**
 * Sends a request carrying a fresh `req` and resolves with the reply that echoes it.
 * T names the reply shape the server sends for this request kind (contract-defined).
 */
export function request<T>(msg: Msg, timeoutMs = 60000): Promise<T> {
  const req = `r${Date.now().toString(36)}${(++reqSeq).toString(36)}`;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  if (!send({ ...msg, req })) {
    reject(new Error("Offline: not connected to the PC"));
    return promise;
  }
  const timer = window.setTimeout(() => {
    pending.delete(req);
    reject(new Error("Timed out waiting for the PC"));
  }, timeoutMs);
  // The reply for this req has shape T per the contract; it is checked by the caller's use.
  const typedResolve = resolve as unknown as (m: Msg) => void;
  pending.set(req, { resolve: typedResolve, reject, timer });
  return promise;
}

/** Routes a reply to its request; true if consumed. */
export function settle(msg: Msg): boolean {
  const req = msg.req;
  if (typeof req !== "string") return false;
  const p = pending.get(req);
  if (!p) return true; // late reply to a timed-out/abandoned request
  pending.delete(req);
  clearTimeout(p.timer);
  if (msg.t === "error") p.reject(new Error(String(msg.error || "error")));
  else p.resolve(msg);
  return true;
}
