type MaybePromise<T> = T | Promise<T>;

export interface StoredBrowserSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Set when a sweep closed this entry's Browser Run session but kept the
   * entry as a tombstone, so a later resume of the owning execution fails
   * loudly instead of silently continuing in a fresh browser.
   */
  closedAt?: number;
}

export interface BrowserSessionLock {
  release(): MaybePromise<void>;
}

export interface BrowserSessionStore {
  /**
   * Acquire an exclusive lock for this session key. The lock must serialize
   * all holders using the same key. Held only around storage reads/writes —
   * never across Browser Rendering network calls.
   */
  acquireLock(key: string): MaybePromise<BrowserSessionLock>;
  get(key: string): MaybePromise<StoredBrowserSession | undefined>;
  set(key: string, session: StoredBrowserSession): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  /**
   * List stored sessions by key prefix. Optional — used by sweeps to find
   * orphaned per-execution sessions; without it only the shared session key
   * is swept.
   */
  list?(prefix: string): MaybePromise<Map<string, StoredBrowserSession>>;
}

export class DurableBrowserSessionStore implements BrowserSessionStore {
  static #queues = new WeakMap<
    DurableObjectStorage,
    Map<string, Promise<void>>
  >();

  constructor(private readonly storage: DurableObjectStorage) {}

  async acquireLock(key: string): Promise<BrowserSessionLock> {
    let queues = DurableBrowserSessionStore.#queues.get(this.storage);
    if (!queues) {
      queues = new Map();
      DurableBrowserSessionStore.#queues.set(this.storage, queues);
    }

    const previous = queues.get(key) ?? Promise.resolve();
    let releaseQueue: () => void = () => undefined;
    const current = previous.then(
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        })
    );
    queues.set(key, current);
    await previous;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (queues.get(key) === current) {
          queues.delete(key);
        }
        releaseQueue();
      }
    };
  }

  async get(key: string): Promise<StoredBrowserSession | undefined> {
    return this.storage.get<StoredBrowserSession>(this.#storageKey(key));
  }

  async set(key: string, session: StoredBrowserSession): Promise<void> {
    await this.storage.put(this.#storageKey(key), session);
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(this.#storageKey(key));
  }

  async list(prefix: string): Promise<Map<string, StoredBrowserSession>> {
    const storagePrefix = this.#storageKey(prefix);
    const entries = await this.storage.list<StoredBrowserSession>({
      prefix: storagePrefix
    });
    const result = new Map<string, StoredBrowserSession>();
    for (const [storageKey, value] of entries) {
      result.set(storageKey.slice("browser-session:".length), value);
    }
    return result;
  }

  #storageKey(key: string): string {
    return `browser-session:${key}`;
  }
}

/**
 * Default idle window used by {@link BrowserConnector.sweep} for the shared
 * (reuse/promoted) session entry.
 */
export const DEFAULT_SWEEP_IDLE_MS = 10 * 60 * 1000;
