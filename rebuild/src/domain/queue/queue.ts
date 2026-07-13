import { toErrorValue } from "../../kernel/errors.js";
import type { EventBus } from "../../kernel/events.js";
import type { IdSource } from "../../kernel/ids.js";
import type { Clock } from "../../ports/clock.js";
import { scoped, type KeyValueStore } from "../../ports/storage.js";

export interface QueueItem<T = unknown> {
  id: string;
  callback: string;
  payload: T;
  createdAt: number;
  attempts: number;
}

export interface TaskQueue {
  enqueue<T>(callback: string, payload: T): Promise<string>;
  dequeue(id: string): void;
  dequeueAll(): void;
  dequeueAllByCallback(callback: string): void;
  get(id: string): QueueItem | undefined;
  find(predicate: (item: QueueItem) => boolean): QueueItem[];
  /** Drain pending rows now (called on startup and after enqueue). */
  flush(): Promise<void>;
  size(): number;
}

/** Row shape as persisted: adds a monotonic sequence number used purely for FIFO key ordering. */
interface StoredItem extends QueueItem {
  seq: number;
}

const ITEM_PREFIX = "item:";
const SEQ_KEY = "meta:seq";

function itemKey(seq: number): string {
  // Zero-padded so lexicographic key order == insertion order.
  return `${ITEM_PREFIX}${String(seq).padStart(15, "0")}`;
}

function toPublic(item: StoredItem): QueueItem {
  const { seq: _seq, ...rest } = item;
  return rest;
}

export function createTaskQueue(deps: {
  store: KeyValueStore;
  clock: Clock;
  ids: IdSource;
  bus: EventBus;
  dispatch: (callback: string, payload: unknown, item: QueueItem) => Promise<void>;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  /** Injectable delay for retry backoff; defaults to real setTimeout. */
  delay?: (ms: number) => Promise<void>;
}): TaskQueue {
  const store = scoped(deps.store, "queue:");
  const maxAttempts = deps.retry?.maxAttempts ?? 3;
  const baseDelayMs = deps.retry?.baseDelayMs ?? 1000;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let flushing: Promise<void> | null = null;

  function nextSeq(): number {
    const current = store.get<number>(SEQ_KEY) ?? 0;
    const next = current + 1;
    store.put(SEQ_KEY, next);
    return next;
  }

  function allEntries(): Array<{ key: string; item: StoredItem }> {
    const raw = store.list<StoredItem>({ prefix: ITEM_PREFIX });
    return [...raw.entries()]
      .map(([key, item]) => ({ key, item }))
      .sort((a, b) => a.item.seq - b.item.seq);
  }

  async function runFlush(): Promise<void> {
    for (;;) {
      const entries = allEntries();
      const next = entries[0];
      if (!next) return;
      const { key, item } = next;

      try {
        await deps.dispatch(item.callback, item.payload, toPublic(item));
        store.delete(key);
      } catch (err) {
        // Re-read: the row may have been dequeued while dispatch was in flight.
        const current = store.get<StoredItem>(key);
        if (!current) continue;

        const attempts = current.attempts + 1;
        if (attempts >= maxAttempts) {
          store.delete(key);
          deps.bus.emit("queue:error", {
            id: item.id,
            callback: item.callback,
            error: toErrorValue(err),
            attempts,
          });
          continue;
        }

        store.put(key, { ...current, attempts });
        deps.bus.emit("queue:retry", { id: item.id, callback: item.callback, attempts });
        await delay(baseDelayMs * 2 ** (attempts - 1));
      }
    }
  }

  function triggerFlush(): Promise<void> {
    if (!flushing) {
      flushing = runFlush().finally(() => {
        flushing = null;
      });
    }
    return flushing;
  }

  return {
    async enqueue<T>(callback: string, payload: T): Promise<string> {
      const id = deps.ids.newId("task");
      const seq = nextSeq();
      const item: StoredItem = { id, callback, payload, createdAt: deps.clock.now(), attempts: 0, seq };
      store.put(itemKey(seq), item);
      deps.bus.emit("queue:create", { id, callback });
      // Deferred: flush starts on a fresh microtask, never inline with enqueue,
      // so synchronous callers can still dequeue/dequeueAll before it begins.
      queueMicrotask(() => {
        void triggerFlush();
      });
      return id;
    },

    dequeue(id: string): void {
      const found = allEntries().find((e) => e.item.id === id);
      if (found) store.delete(found.key);
    },

    dequeueAll(): void {
      store.deleteAll({ prefix: ITEM_PREFIX });
    },

    dequeueAllByCallback(callback: string): void {
      for (const { key, item } of allEntries()) {
        if (item.callback === callback) store.delete(key);
      }
    },

    get(id: string): QueueItem | undefined {
      const found = allEntries().find((e) => e.item.id === id);
      return found ? toPublic(found.item) : undefined;
    },

    find(predicate: (item: QueueItem) => boolean): QueueItem[] {
      return allEntries().map((e) => toPublic(e.item)).filter(predicate);
    },

    flush(): Promise<void> {
      return triggerFlush();
    },

    size(): number {
      return store.list({ prefix: ITEM_PREFIX }).size;
    },
  };
}
