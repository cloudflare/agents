/**
 * The browser-sessions Lifecycle capability: agents wiring for the
 * provider-independent named-session core in `./session-core`.
 *
 * Install it with `Lifecycle.use()` — on an Agent subclass or any plain
 * Durable Object that composes `Lifecycle` — and it supplies what the bare
 * core leaves to hosts:
 *
 * - a durable session store over the object's own storage (unless the host
 *   wires a custom {@link BrowserSessionStore}),
 * - host-only observability: {@link BrowserSessions.sessions} and
 *   {@link BrowserSessions.liveView}.
 *
 * It schedules nothing: Browser Run reclaims idle browsers itself once
 * `keep_alive` elapses, and the next resolve of that name replaces the lost
 * browser with `restarted: true`. An object with browser sessions carries
 * no alarm on their behalf.
 *
 * Everything here is host-side. Models never see session names, Browser Run
 * ids, or Live View URLs through this surface.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import {
  isMissingBrowserSession,
  listBrowserTargets,
  type BrowserBinding
} from "./browser-run";
import {
  mintLiveView,
  type BrowserLiveView,
  type LiveViewMode
} from "./live-view";
import {
  DEFAULT_BROWSER_SESSION_NAME,
  NamedBrowserSessions,
  namedBrowserSessionKey,
  type BrowserSessionCreateOptions,
  type ConnectedBrowserSession,
  type ResolvedBrowserSession
} from "./session-core";
import {
  DurableBrowserSessionStore,
  type BrowserSessionStore
} from "./session-manager";

export interface BrowserSessionsOptions {
  /** The Browser Rendering binding sessions are created against. */
  browser: BrowserBinding;
  /**
   * Session store. Defaults to a {@link DurableBrowserSessionStore} over the
   * host object's own storage. A custom store without `list` returns no
   * {@link BrowserSessions.sessions}.
   */
  store?: BrowserSessionStore;
  /** Durable creation options reapplied on every create (incl. restarts). */
  create?: BrowserSessionCreateOptions;
  /** Default CDP command timeout for {@link BrowserSessions.connect}. */
  timeoutMs?: number;
}

/** One named session as the host sees it. Never expose this to models. */
export interface BrowserSessionView {
  name: string;
  /**
   * `"expired"` once the record has gone a full `keep_alive` window without
   * agent activity: the platform has most likely reclaimed the browser, and
   * the next resolve will replace it with `restarted: true`. Advisory only —
   * a human driving it through Live View keeps the browser alive without
   * refreshing this record. Closed sessions are not listed.
   */
  status: "live" | "expired";
  createdAt: number;
  updatedAt: number;
  /** The Browser Run session id — host-side only. */
  sessionId: string;
}

/**
 * Named browser sessions as a Lifecycle capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class BrowserSessions extends LifecycleCapability {
  readonly #options: BrowserSessionsOptions;
  #store?: BrowserSessionStore;
  #core?: NamedBrowserSessions;

  constructor(options: BrowserSessionsOptions) {
    super("browser");
    this.#options = options;
  }

  // ── Session surface ──────────────────────────────────────────────────────

  /**
   * Resolve the named session — reattach-or-create with loud mortality
   * signaling. See {@link ResolvedBrowserSession.restarted}.
   */
  resolve(
    name = DEFAULT_BROWSER_SESSION_NAME
  ): Promise<ResolvedBrowserSession> {
    return this.#core_().resolve(name);
  }

  /** Resolve the named session and attach a CDP socket to it. */
  connect(
    name = DEFAULT_BROWSER_SESSION_NAME
  ): Promise<ConnectedBrowserSession> {
    return this.#core_().connect(name);
  }

  /**
   * Close the named session and delete its browser. The name's next resolve
   * reports `restarted: true`.
   */
  close(name = DEFAULT_BROWSER_SESSION_NAME): Promise<boolean> {
    return this.#core_().close(name);
  }

  // ── Host observability ───────────────────────────────────────────────────

  /**
   * Every named session that owns a browser on record, ordered by name.
   * Empty when the wired store cannot `list`.
   */
  async sessions(): Promise<BrowserSessionView[]> {
    const prefix = namedBrowserSessionKey("");
    const entries = await this.#sessionStore.list?.(prefix);
    if (!entries) return [];
    const now = Date.now();
    const keepAliveMs = this.#core_().keepAliveMs;
    return [...entries]
      .map(([key, entry]) => ({
        name: key.slice(prefix.length),
        status:
          now - entry.updatedAt < keepAliveMs
            ? ("live" as const)
            : ("expired" as const),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        sessionId: entry.sessionId
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Mint Live View URLs for the named session's open tabs, fresh from a
   * target listing. `undefined` when the name is unknown, closed, or its
   * browser is gone. The URLs are bearer credentials with a short connect
   * window (~5 min) — hand them to a trusted human, never to the model, and
   * never store them: re-mint instead.
   */
  async liveView(
    name = DEFAULT_BROWSER_SESSION_NAME,
    options?: { mode?: LiveViewMode }
  ): Promise<BrowserLiveView | undefined> {
    const entry = await this.#sessionStore.get(namedBrowserSessionKey(name));
    if (!entry) return undefined;
    try {
      const targets = await listBrowserTargets(
        this.#options.browser,
        entry.sessionId
      );
      // A human is about to look: minting counts as session activity.
      // Target listing yields to the network, so a concurrent close or
      // replacement can retire the session mid-mint — the touch and the
      // retire serialize on the per-key lock, and a lost touch means the
      // listed targets are already dead: report the session gone rather
      // than minting doomed links. Touch *errors* stay best effort — a
      // store blip must not break minting.
      try {
        const refreshed = await this.#core_().touch(name, entry.sessionId);
        if (!refreshed) return undefined;
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to refresh activity for browser session "${name}"`,
          error
        );
      }
      return mintLiveView(entry.sessionId, targets, options?.mode);
    } catch (error) {
      if (isMissingBrowserSession(error)) return undefined;
      throw error;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Lazy: `lifecycle.storage` exists only once `Lifecycle.use()` ran. */
  get #sessionStore(): BrowserSessionStore {
    this.#store ??=
      this.#options.store ??
      new DurableBrowserSessionStore(this.lifecycle.storage);
    return this.#store;
  }

  #core_(): NamedBrowserSessions {
    this.#core ??= new NamedBrowserSessions({
      browser: this.#options.browser,
      store: this.#sessionStore,
      create: this.#options.create,
      timeoutMs: this.#options.timeoutMs
    });
    return this.#core;
  }
}
