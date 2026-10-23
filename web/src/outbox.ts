// Text sends queued through DD.enqueue, tracked until the server acks them.
import { enqueue } from "./bridge";
import type { AckMsg } from "./types";
import { lsGet, lsSet, uuid } from "./util";

export interface OutItem {
  id: string;
  target: string;
  text: string;
  enter: boolean;
  ts: number;
  failed?: string;
}

const KEY = "dd.outbox";
const MAX_AGE = 24 * 3600_000;
const items = new Map<string, OutItem>(
  lsGet<OutItem[]>(KEY, [])
    .filter((i) => Date.now() - i.ts < MAX_AGE)
    .map((i) => [i.id, i]),
);
const listeners = new Set<() => void>();

function changed() {
  lsSet(KEY, [...items.values()].slice(-50));
  for (const l of listeners) l();
}

export function onOutboxChange(fn: () => void) {
  listeners.add(fn);
}

/** Queues a text send; returns the outbox id its ack will carry. */
export function sendText(target: string, text: string, enter: boolean): string {
  const id = uuid();
  const real = enqueue({ t: "send", id, target, text, enter });
  items.set(real, { id: real, target, text, enter, ts: Date.now() });
  changed();
  return real;
}

export function retrySend(id: string) {
  const it = items.get(id);
  if (!it) return;
  items.delete(id);
  sendText(it.target, it.text, it.enter);
}

export function dismissSend(id: string) {
  if (items.delete(id)) changed();
}

/** Consumes acks for text sends; true if the id was ours. */
export function outboxAck(m: AckMsg): boolean {
  const it = items.get(m.id);
  if (!it) return false;
  if (m.ok) items.delete(m.id);
  else it.failed = m.error || "Failed";
  changed();
  return true;
}

export function outboxFor(target: string): OutItem[] {
  return [...items.values()].filter((i) => i.target === target);
}
