import { connectUrl } from "./cdp-session";
import type { CdpSession } from "./cdp-session";
import {
  connectBrowser,
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  listBrowserTargets,
  BrowserRenderingError,
  type BrowserBinding,
  type BrowserSessionInfo
} from "./browser-run";

type MaybePromise<T> = T | Promise<T>;

/**
 * How to reach a browser: either the Browser Rendering binding (production)
 * or a raw CDP base URL (local Chrome, tunnels). SDK-owned session reuse
 * requires the binding — `cdpUrl` sessions are externally managed.
 */
export type BrowserConnectionOptions =
  | {
      /** Browser Rendering binding (Fetcher) — used in production */
      browser: BrowserBinding;
      cdpUrl?: never;
      cdpHeaders?: never;
      /** Optional browser session lifecycle. Defaults to one fresh session per execution. */
      session?: BrowserSessionOptions;
    }
  | {
      /** Optional CDP base URL override (e.g. http://localhost:9222) */
      cdpUrl: string;
      /** Headers to send with CDP URL discovery requests (e.g. Access headers) */
      cdpHeaders?: Record<string, string>;
      browser?: never;
      /** cdpUrl sessions are externally managed and cannot use SDK-owned reuse. */
      session?: { mode?: "one-shot" };
    };

/** Connection options plus the CDP command timeout. */
export type BrowserManagerOptions = BrowserConnectionOptions & {
  /** CDP command timeout in milliseconds (default: 10000) */
  timeout?: number;
};

export interface StoredBrowserSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserSessionLock {
  release(): MaybePromise<void>;
}

export interface BrowserSessionStore {
  /**
   * Acquire an exclusive lock for this session key. The lock must serialize
   * all managers using the same key and is held for the full browser lease.
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

/** Shared configuration for the store-backed session modes (`reuse`, `dynamic`). */
export interface StoredBrowserSessionOptions {
  /** Logical owner key for the stored Browser Run session id. */
  key?: string;
  /** Durable storage for the Browser Run session id. */
  store: BrowserSessionStore;
  /** Browser Run inactivity timeout. Browser Run currently caps this server-side. */
  keepAliveMs?: number;
}

export interface ReusableBrowserSessionOptions extends StoredBrowserSessionOptions {
  mode: "reuse";
}

export interface DynamicBrowserSessionOptions extends StoredBrowserSessionOptions {
  mode: "dynamic";
}

export type BrowserSessionOptions =
  | { mode?: "one-shot" }
  | ReusableBrowserSessionOptions
  | DynamicBrowserSessionOptions;

export interface BrowserLease {
  session: CdpSession;
  release(): Promise<void>;
}

export interface SweepOptions {
  /**
   * Close the stored session if it has been idle (no acquire/start/reset)
   * for at least this many milliseconds. Defaults to the session's
   * `keepAliveMs`, or {@link DEFAULT_SWEEP_IDLE_MS} when neither is set.
   */
  maxIdleMs?: number;
}

export interface SweepResult {
  /** Whether a stored session was closed by this sweep. */
  swept: boolean;
  /** The session id that was closed, if any. */
  sessionId?: string;
}

export interface BrowserSessionManager {
  acquire(): Promise<BrowserLease>;
  start(): Promise<BrowserSessionInfo | undefined>;
  info(): Promise<BrowserSessionInfo | undefined>;
  close(): Promise<void>;
  reset(): Promise<BrowserSessionInfo | undefined>;
  /**
   * Close the stored reusable session if it has been idle past the threshold.
   * Intended to be called from a recurring alarm/scheduled task so orphaned
   * Browser Run sessions are reclaimed deterministically instead of lingering
   * until Browser Run's own inactivity timeout. No-op for one-shot sessions.
   */
  sweep(options?: SweepOptions): Promise<SweepResult>;
}

/** Default idle window used by {@link BrowserSessionManager.sweep}. */
export const DEFAULT_SWEEP_IDLE_MS = 10 * 60 * 1000;

const MISSING_BROWSER_CONFIG =
  "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided";

function isMissingBrowserSession(error: unknown): boolean {
  return error instanceof BrowserRenderingError && error.status === 404;
}

class OneShotBrowserSessionManager implements BrowserSessionManager {
  constructor(private readonly options: BrowserManagerOptions) {}

  async acquire(): Promise<BrowserLease> {
    const session = this.options.cdpUrl
      ? await connectUrl(this.options.cdpUrl, {
          timeoutMs: this.options.timeout,
          headers: this.options.cdpHeaders
        })
      : this.options.browser
        ? await connectBrowser(this.options.browser, this.options.timeout)
        : undefined;

    if (!session) {
      throw new Error(MISSING_BROWSER_CONFIG);
    }

    return {
      session,
      release: async () => session.close()
    };
  }

  async info(): Promise<BrowserSessionInfo | undefined> {
    return undefined;
  }

  async start(): Promise<BrowserSessionInfo | undefined> {
    return undefined;
  }

  async close(): Promise<void> {}

  async reset(): Promise<BrowserSessionInfo | undefined> {
    return undefined;
  }

  async sweep(): Promise<SweepResult> {
    return { swept: false };
  }
}

class ReusableBrowserSessionManager implements BrowserSessionManager {
  constructor(
    private readonly browser: BrowserBinding,
    private readonly options: BrowserManagerOptions,
    private readonly sessionOptions:
      | ReusableBrowserSessionOptions
      | DynamicBrowserSessionOptions
  ) {}

  async acquire(): Promise<BrowserLease> {
    const lock = await this.sessionOptions.store.acquireLock(this.#key());
    try {
      const stored = await this.#ensureSession();
      return await this.#connectLease(stored, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** Acquire an existing session if it exists, otherwise return undefined.
   * Useful to prevent implicit creation of a new session when a
   * previously-existing one is no longer available. */
  async acquireExisting(): Promise<BrowserLease | undefined> {
    const lock = await this.sessionOptions.store.acquireLock(this.#key());
    try {
      const stored = await this.#getExistingSession();
      if (!stored) {
        await lock.release();
        return undefined;
      }
      return await this.#connectLease(stored, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async info(): Promise<BrowserSessionInfo | undefined> {
    return this.#withLock(async () => {
      const stored = await this.sessionOptions.store.get(this.#key());
      if (!stored) return undefined;
      try {
        return {
          sessionId: stored.sessionId,
          targets: await listBrowserTargets(this.browser, stored.sessionId)
        };
      } catch (error) {
        if (isMissingBrowserSession(error)) {
          await this.sessionOptions.store.delete(this.#key());
          return undefined;
        }
        throw error;
      }
    });
  }

  async start(): Promise<BrowserSessionInfo> {
    return this.#withLock(async () => {
      const stored = await this.#ensureSession();
      return {
        sessionId: stored.sessionId,
        targets: await listBrowserTargets(this.browser, stored.sessionId)
      };
    });
  }

  async close(): Promise<void> {
    return this.#withLock(async () => {
      await this.#closeCurrentSession();
    });
  }

  async reset(): Promise<BrowserSessionInfo> {
    return this.#withLock(async () => {
      await this.#closeCurrentSession();
      const stored = await this.#createAndStoreSession();
      return {
        sessionId: stored.sessionId,
        targets: await listBrowserTargets(this.browser, stored.sessionId)
      };
    });
  }

  async sweep(options?: SweepOptions): Promise<SweepResult> {
    return this.#withLock(async () => {
      const stored = await this.sessionOptions.store.get(this.#key());
      if (!stored) return { swept: false };

      const maxIdleMs =
        options?.maxIdleMs ??
        this.sessionOptions.keepAliveMs ??
        DEFAULT_SWEEP_IDLE_MS;
      const idleMs = Date.now() - stored.updatedAt;
      if (idleMs < maxIdleMs) {
        return { swept: false };
      }

      await deleteBrowserSession(this.browser, stored.sessionId);
      await this.sessionOptions.store.delete(this.#key());
      return { swept: true, sessionId: stored.sessionId };
    });
  }

  async #ensureSession(): Promise<StoredBrowserSession> {
    return (await this.#getExistingSession()) ?? this.#createAndStoreSession();
  }

  async #getExistingSession(): Promise<StoredBrowserSession | undefined> {
    const stored = await this.sessionOptions.store.get(this.#key());
    if (stored) {
      try {
        await listBrowserTargets(this.browser, stored.sessionId);
        const refreshed = { ...stored, updatedAt: Date.now() };
        await this.sessionOptions.store.set(this.#key(), refreshed);
        return refreshed;
      } catch (error) {
        if (!isMissingBrowserSession(error)) {
          throw error;
        }
        await this.sessionOptions.store.delete(this.#key());
      }
    }

    return undefined;
  }

  async #connectLease(
    stored: StoredBrowserSession,
    lock: BrowserSessionLock
  ): Promise<BrowserLease> {
    const session = await connectBrowserSession(
      this.browser,
      stored.sessionId,
      this.options.timeout
    );
    let released = false;
    return {
      session,
      release: async () => {
        if (released) return;
        released = true;
        try {
          session.disconnect();
        } finally {
          await lock.release();
        }
      }
    };
  }

  async #createAndStoreSession(): Promise<StoredBrowserSession> {
    const info = await createBrowserSession(this.browser, {
      keepAliveMs: this.sessionOptions.keepAliveMs,
      includeTargets: true
    });
    const now = Date.now();
    const stored = {
      sessionId: info.sessionId,
      createdAt: now,
      updatedAt: now
    };
    await this.sessionOptions.store.set(this.#key(), stored);
    return stored;
  }

  async #closeCurrentSession(): Promise<void> {
    const stored = await this.sessionOptions.store.get(this.#key());
    if (stored) {
      await deleteBrowserSession(this.browser, stored.sessionId);
      await this.sessionOptions.store.delete(this.#key());
    }
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = await this.sessionOptions.store.acquireLock(this.#key());
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  #key(): string {
    return this.sessionOptions.key ?? "default";
  }
}

class DynamicBrowserSessionManager implements BrowserSessionManager {
  #oneShot: OneShotBrowserSessionManager;
  #reusable: ReusableBrowserSessionManager;

  constructor(
    browser: BrowserBinding,
    options: BrowserManagerOptions,
    sessionOptions: DynamicBrowserSessionOptions
  ) {
    this.#oneShot = new OneShotBrowserSessionManager(options);
    this.#reusable = new ReusableBrowserSessionManager(
      browser,
      options,
      sessionOptions
    );
  }

  async acquire(): Promise<BrowserLease> {
    return (await this.#reusable.acquireExisting()) ?? this.#oneShot.acquire();
  }

  async start(): Promise<BrowserSessionInfo> {
    return this.#reusable.start();
  }

  async info(): Promise<BrowserSessionInfo | undefined> {
    return this.#reusable.info();
  }

  async close(): Promise<void> {
    return this.#reusable.close();
  }

  async reset(): Promise<BrowserSessionInfo | undefined> {
    return this.#reusable.reset();
  }

  async sweep(options?: SweepOptions): Promise<SweepResult> {
    return this.#reusable.sweep(options);
  }
}

export function createBrowserSessionManager(
  options: BrowserManagerOptions
): BrowserSessionManager {
  if (
    options.session?.mode === "reuse" ||
    options.session?.mode === "dynamic"
  ) {
    if (options.cdpUrl) {
      throw new Error(
        "Reusable browser sessions require a Browser Rendering binding, not cdpUrl"
      );
    }
    if (!options.browser) {
      throw new Error(
        "Reusable browser sessions require a Browser Rendering binding"
      );
    }
    if (!options.session.store) {
      throw new Error(
        "Reusable browser sessions require session.store for storing Browser Run session ids"
      );
    }
    if (options.session.mode === "dynamic") {
      return new DynamicBrowserSessionManager(
        options.browser,
        options,
        options.session
      );
    }
    return new ReusableBrowserSessionManager(
      options.browser,
      options,
      options.session
    );
  }

  return new OneShotBrowserSessionManager(options);
}

export function hasReusableBrowserSession(
  options: BrowserManagerOptions
): boolean {
  return options.session?.mode === "reuse";
}

export function hasDynamicBrowserSession(
  options: BrowserManagerOptions
): boolean {
  return options.session?.mode === "dynamic";
}
