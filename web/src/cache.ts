// Small key/value cache for last transcripts and screens, LRU-capped per prefix. In the app it lives
// in the shell's durable store (JSON per key); in a plain browser in IndexedDB.
import { nativeStore } from "./bridge";

const DB = "devdeck";
const STORE = "kv";
const CAPS: Record<string, number> = { tx: 24, scr: 32 };

interface Row<T> {
  k: string;
  v: T;
  at: number;
}

let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  const { promise, resolve } = Promise.withResolvers<IDBDatabase | null>();
  dbp = promise;
  try {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "k" }).createIndex("at", "at");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
  } catch {
    resolve(null);
  }
  return promise;
}

function done<T>(r: IDBRequest<T>): Promise<T | undefined> {
  const { promise, resolve } = Promise.withResolvers<T | undefined>();
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => resolve(undefined);
  return promise;
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (nativeStore) {
    try {
      const v = nativeStore.get(key);
      return v == null ? undefined : (JSON.parse(v) as T);
    } catch {
      return undefined;
    }
  }
  const d = await db();
  if (!d) return undefined;
  const row = await done<Row<T> | undefined>(d.transaction(STORE).objectStore(STORE).get(key));
  return row?.v;
}

/** In the app the write is queued before this returns (no await first), so a following flush covers it. */
export async function cachePut<T>(key: string, v: T): Promise<void> {
  const prefix = key.slice(0, key.indexOf(":") + 1);
  const cap = CAPS[prefix.slice(0, -1)];
  if (nativeStore) {
    nativeStore.put(key, JSON.stringify(v));
    if (!cap) return;
    const mine = nativeStore.keys(prefix); // oldest first
    for (let i = 0; i < mine.length - cap; i++) nativeStore.put(mine[i], null);
    return;
  }
  const d = await db();
  if (!d) return;
  // Strict: committed to disk before the transaction completes (the relaxed default can lose it on power loss).
  const tx = d.transaction(STORE, "readwrite", { durability: "strict" });
  const st = tx.objectStore(STORE);
  st.put({ k: key, v, at: Date.now() } satisfies Row<T>);
  if (!cap) return;
  // Primary keys in ascending `at` order, so the oldest come first.
  const keys = (await done(st.index("at").getAllKeys())) ?? [];
  const mine = keys.map(String).filter((k) => k.startsWith(prefix));
  for (let i = 0; i < mine.length - cap; i++) st.delete(mine[i]);
}
