import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStore } from "../../ports/storage.js";

/**
 * A KeyValueStore persisted to a single JSON file — the demo's stand-in for
 * Durable Object storage. Mutations update the in-memory map synchronously
 * (the port contract) and schedule a throttled flush to disk; `flushSync()`
 * forces a write (wired to SIGINT/exit in the demo CLI so a Ctrl+C mid-turn
 * still leaves recoverable state behind).
 */
export interface FileKeyValueStore extends KeyValueStore {
  flushSync(): void;
}

export function createFileKeyValueStore(
  path: string,
  options?: { flushIntervalMs?: number },
): FileKeyValueStore {
  const flushIntervalMs = options?.flushIntervalMs ?? 100;
  let data = new Map<string, unknown>();

  try {
    const raw = readFileSync(path, "utf8");
    data = new Map(Object.entries(JSON.parse(raw) as Record<string, unknown>));
  } catch {
    // Missing or corrupt file → start fresh.
  }

  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flushSync(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!dirty) return;
    dirty = false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(data)));
  }

  function scheduleFlush(): void {
    dirty = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      flushSync();
    }, flushIntervalMs);
    timer.unref?.();
  }

  return {
    get<T>(key: string): T | undefined {
      const value = data.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    put(key, value) {
      data.set(key, structuredClone(value));
      scheduleFlush();
    },
    delete(key) {
      const existed = data.delete(key);
      if (existed) scheduleFlush();
      return existed;
    },
    list<T>(opts?: { prefix?: string; limit?: number }): Map<string, T> {
      const prefix = opts?.prefix ?? "";
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limited = opts?.limit !== undefined ? keys.slice(0, opts.limit) : keys;
      const out = new Map<string, T>();
      for (const k of limited) out.set(k, structuredClone(data.get(k)) as T);
      return out;
    },
    deleteAll(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      let n = 0;
      for (const k of [...data.keys()]) {
        if (k.startsWith(prefix)) {
          data.delete(k);
          n += 1;
        }
      }
      if (n > 0) scheduleFlush();
      return n;
    },
    flushSync,
  };
}
