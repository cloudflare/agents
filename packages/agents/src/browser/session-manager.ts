import { connectUrl } from "./cdp-session";
import {
  connectBrowser,
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  listBrowserTargets,
  type BrowserSessionInfo,
  type BrowserTargetInfo
} from "./browser-run";
import type { CdpSession } from "./cdp-session";
import type { BrowserToolsOptions } from "./shared";

type MaybePromise<T> = T | Promise<T>;

export interface StoredBrowserSession {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserSessionStore {
  get(key: string): MaybePromise<StoredBrowserSession | undefined>;
  set(key: string, session: StoredBrowserSession): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
}

export interface ReusableBrowserSessionOptions {
  mode: "reuse";
  /** Logical owner key. Think supplies this automatically. */
  key?: string;
  /** Durable storage for the Browser Run session id. */
  store?: BrowserSessionStore;
  /** Browser Run inactivity timeout. Browser Run currently caps this at 10 minutes. */
  keepAliveMs?: number;
  /** Include Live View URLs in session metadata callbacks and session_info. */
  liveView?: boolean;
  /** Called whenever session metadata is refreshed. Useful for UI broadcasts. */
  onSessionInfo?: (info: BrowserSessionInfo) => MaybePromise<void>;
}

export type BrowserSessionOptions =
  | { mode?: "one-shot" }
  | ReusableBrowserSessionOptions;

export interface BrowserLease {
  session: CdpSession;
  release(): Promise<void>;
}

export interface BrowserSessionManager {
  acquire(): Promise<BrowserLease>;
  info(): Promise<BrowserSessionInfo | undefined>;
  close(): Promise<void>;
  reset(): Promise<BrowserSessionInfo | undefined>;
}

class MemoryBrowserSessionStore implements BrowserSessionStore {
  #sessions = new Map<string, StoredBrowserSession>();

  get(key: string): StoredBrowserSession | undefined {
    return this.#sessions.get(key);
  }

  set(key: string, session: StoredBrowserSession): void {
    this.#sessions.set(key, session);
  }

  delete(key: string): void {
    this.#sessions.delete(key);
  }
}

class OneShotBrowserSessionManager implements BrowserSessionManager {
  constructor(private readonly options: BrowserToolsOptions) {}

  async acquire(): Promise<BrowserLease> {
    let session: CdpSession;
    if (this.options.cdpUrl) {
      session = await connectUrl(this.options.cdpUrl, {
        timeoutMs: this.options.timeout,
        headers: this.options.cdpHeaders
      });
    } else if (this.options.browser) {
      session = await connectBrowser(
        this.options.browser,
        this.options.timeout
      );
    } else {
      throw new Error(
        "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided"
      );
    }

    return {
      session,
      release: async () => session.close()
    };
  }

  async info(): Promise<BrowserSessionInfo | undefined> {
    return undefined;
  }

  async close(): Promise<void> {}

  async reset(): Promise<BrowserSessionInfo | undefined> {
    return undefined;
  }
}

class ReusableBrowserSessionManager implements BrowserSessionManager {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly browser: Fetcher,
    private readonly options: BrowserToolsOptions,
    private readonly sessionOptions: ReusableBrowserSessionOptions,
    private readonly store: BrowserSessionStore
  ) {}

  async acquire(): Promise<BrowserLease> {
    const previous = this.#queue;
    let releaseQueue: () => void = () => undefined;
    this.#queue = previous.then(
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        })
    );
    await previous;

    try {
      const info = await this.#ensureSession();
      const session = await connectBrowserSession(
        this.browser,
        info.sessionId,
        this.options.timeout
      );
      await this.#publishInfo(info.sessionId).catch(() => undefined);
      return {
        session,
        release: async () => {
          try {
            session.disconnect();
          } finally {
            releaseQueue();
          }
        }
      };
    } catch (error) {
      releaseQueue();
      throw error;
    }
  }

  async info(): Promise<BrowserSessionInfo | undefined> {
    await this.#queue;
    const stored = await this.store.get(this.#key());
    if (!stored) return undefined;
    try {
      return await this.#publishInfo(stored.sessionId);
    } catch {
      await this.store.delete(this.#key());
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.#queue;
    const stored = await this.store.get(this.#key());
    await this.store.delete(this.#key());
    if (stored) {
      await deleteBrowserSession(this.browser, stored.sessionId);
    }
  }

  async reset(): Promise<BrowserSessionInfo> {
    await this.#queue;
    await this.close().catch(() => undefined);
    const info = await this.#createAndStoreSession();
    return this.#publishInfo(info.sessionId);
  }

  async #ensureSession(): Promise<StoredBrowserSession> {
    const stored = await this.store.get(this.#key());
    if (stored) {
      try {
        await listBrowserTargets(this.browser, stored.sessionId);
        const refreshed = { ...stored, updatedAt: Date.now() };
        await this.store.set(this.#key(), refreshed);
        return refreshed;
      } catch {
        await this.store.delete(this.#key());
      }
    }
    return this.#createAndStoreSession();
  }

  async #createAndStoreSession(): Promise<StoredBrowserSession> {
    const info = await createBrowserSession(this.browser, {
      keepAliveMs: this.sessionOptions.keepAliveMs,
      includeTargets: this.sessionOptions.liveView
    });
    const now = Date.now();
    const stored = {
      sessionId: info.sessionId,
      createdAt: now,
      updatedAt: now
    };
    await this.store.set(this.#key(), stored);
    return stored;
  }

  async #publishInfo(sessionId: string): Promise<BrowserSessionInfo> {
    const targets = await listBrowserTargets(this.browser, sessionId);
    const info = {
      sessionId,
      targets: this.sessionOptions.liveView
        ? targets
        : targets.map(stripLiveViewUrls)
    };
    await this.sessionOptions.onSessionInfo?.(info);
    return info;
  }

  #key(): string {
    return this.sessionOptions.key ?? "default";
  }
}

function stripLiveViewUrls(target: BrowserTargetInfo): BrowserTargetInfo {
  const { devtoolsFrontendUrl: _devtoolsFrontendUrl, ...rest } = target;
  return rest;
}

export function createBrowserSessionManager(
  options: BrowserToolsOptions
): BrowserSessionManager {
  if (options.session?.mode === "reuse") {
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
    return new ReusableBrowserSessionManager(
      options.browser,
      options,
      options.session,
      options.session.store ?? new MemoryBrowserSessionStore()
    );
  }
  return new OneShotBrowserSessionManager(options);
}

export function hasReusableBrowserSession(
  options: BrowserToolsOptions
): boolean {
  return options.session?.mode === "reuse";
}
