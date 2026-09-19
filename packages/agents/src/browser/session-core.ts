import type { CdpSession } from "./cdp-session";
import {
  type BrowserBinding,
  type BrowserSessionGuardrails,
  connectBrowser,
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  isMissingBrowserSession,
  listBrowserTargets
} from "./browser-run";
import {
  type BrowserSessionStore,
  DEFAULT_SWEEP_IDLE_MS,
  type StoredBrowserSession
} from "./session-manager";

/**
 * Browser Run's server-side `keep_alive` maximum (600 seconds). Named
 * sessions pin keep-alive here by default so the platform doesn't reclaim a
 * session the store still considers live between agent turns.
 */
export const BROWSER_SESSION_KEEP_ALIVE_MAX_MS = 600_000;

/**
 * Minimum interval between store `updatedAt` refreshes driven by CDP traffic
 * on sockets returned by {@link NamedBrowserSessions.connect}. Matches the
 * connector's execution-entry touch cadence.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** The session name used when a host doesn't wire one explicitly. */
export const DEFAULT_BROWSER_SESSION_NAME = "default";

const NAMED_SESSION_KEY_PREFIX = "browser:session:";

/** The store key for a named browser session. */
export function namedBrowserSessionKey(name: string): string {
  return `${NAMED_SESSION_KEY_PREFIX}${name}`;
}

/**
 * Durable host configuration reapplied on **every** session create — including
 * the reattach-or-create restart path — so options like guardrails survive a
 * session being swept and recreated.
 */
export interface BrowserSessionCreateOptions {
  /**
   * Platform `keep_alive` in milliseconds. Defaults to
   * {@link BROWSER_SESSION_KEEP_ALIVE_MAX_MS} (the platform maximum).
   */
  keepAliveMs?: number;
  /** Opt into Browser Run session recording (rrweb capture). */
  recording?: boolean;
  /** Hostname guardrails, fixed at launch for every connection. */
  guardrails?: BrowserSessionGuardrails;
}

export interface NamedBrowserSessionsOptions {
  browser: BrowserBinding;
  store: BrowserSessionStore;
  /** Applied on every create — see {@link BrowserSessionCreateOptions}. */
  create?: BrowserSessionCreateOptions;
  /** Default CDP command timeout for {@link NamedBrowserSessions.connect}. */
  timeoutMs?: number;
  /**
   * Idle window before {@link NamedBrowserSessions.sweep} closes a session
   * (and before it prunes a tombstone). Defaults to
   * {@link DEFAULT_SWEEP_IDLE_MS} (10 minutes).
   */
  sweepIdleMs?: number;
  /**
   * Minimum interval between activity-driven `updatedAt` refreshes on
   * connected sockets. Defaults to {@link SESSION_TOUCH_INTERVAL_MS} and is
   * always capped at half of `sweepIdleMs`, so continuous CDP traffic
   * refreshes the idle clock before a sweep deadline can pass. Overridable
   * primarily for tests.
   */
  touchIntervalMs?: number;
}

export interface ResolvedBrowserSession {
  name: string;
  /** The Browser Run session id — host-side only, never model-visible. */
  sessionId: string;
  /**
   * `true` when this resolution had to create a fresh browser to replace one
   * that previously existed (died, was closed, or was swept). Page state from
   * the prior browser is gone; surface this loudly to the model. `false` on
   * first-ever use — nothing was lost.
   */
  restarted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectedBrowserSession {
  name: string;
  sessionId: string;
  restarted: boolean;
  /** Closing this socket does NOT delete the named session. */
  cdp: CdpSession;
}

export interface BrowserSessionSweepResult {
  /** Idle live sessions this sweep closed (tombstones left behind). */
  swept: Array<{ name: string; sessionId: string }>;
}

export interface OneShotBrowserSessionOptions extends BrowserSessionCreateOptions {
  timeoutMs?: number;
  /** Select the browser engine. Kitesurf does not support guardrails. */
  browser?: "kitesurf";
}

/**
 * Provider-independent named browser sessions: the host wires names, models
 * never see session identity, and resolution is reattach-or-create with loud
 * mortality signaling (`restarted: true` whenever a prior browser was lost).
 *
 * Store discipline mirrors {@link BrowserConnector}: locks wrap storage
 * operations only — liveness probes and Browser Run create/delete calls always
 * happen outside any lock, with a commit re-check to detect concurrent swaps.
 */
export class NamedBrowserSessions {
  readonly #browser: BrowserBinding;
  readonly #store: BrowserSessionStore;
  readonly #create: BrowserSessionCreateOptions;
  readonly #timeoutMs?: number;
  readonly #sweepIdleMs: number;
  readonly #touchIntervalMs: number;

  constructor(options: NamedBrowserSessionsOptions) {
    this.#browser = options.browser;
    this.#store = options.store;
    this.#create = options.create ?? {};
    this.#timeoutMs = options.timeoutMs;
    this.#sweepIdleMs = options.sweepIdleMs ?? DEFAULT_SWEEP_IDLE_MS;
    // Cap the touch cadence at half the sweep window: a session with
    // continuous CDP traffic must always prove liveness before it can
    // look idle, regardless of how aggressive the sweep window is.
    this.#touchIntervalMs = Math.min(
      options.touchIntervalMs ?? SESSION_TOUCH_INTERVAL_MS,
      Math.floor(this.#sweepIdleMs / 2)
    );
  }

  /**
   * Resolve the named session: reattach when its browser is still alive,
   * otherwise create a fresh one. See {@link ResolvedBrowserSession.restarted}
   * for the mortality signal.
   */
  async resolve(
    name = DEFAULT_BROWSER_SESSION_NAME
  ): Promise<ResolvedBrowserSession> {
    const key = namedBrowserSessionKey(name);

    // Dead-session recovery consumes two attempts (tombstone, then create).
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await this.#readStored(key);

      if (existing === undefined || existing.closedAt !== undefined) {
        // First use, or a tombstone left by close()/sweep(). A tombstone is
        // evidence a prior browser existed — that's a restart.
        const outcome = await this.#createAndCommit(key, existing?.sessionId);
        if (outcome.winner) {
          if (outcome.winner.closedAt !== undefined) continue; // re-tombstoned
          return { name, restarted: existing !== undefined, ...outcome.winner };
        }
        return { name, restarted: existing !== undefined, ...outcome.stored };
      }

      // Live entry on record — probe it outside any lock.
      const alive = await this.#isAlive(existing);
      const lock = await this.#store.acquireLock(key);
      try {
        const current = await this.#store.get(key);
        if (
          current?.sessionId !== existing.sessionId ||
          current.closedAt !== undefined
        ) {
          continue; // swapped or tombstoned while we probed — revalidate
        }
        if (alive) {
          const refreshed = { ...current, updatedAt: Date.now() };
          await this.#store.set(key, refreshed);
          return { name, restarted: false, ...refreshed };
        }
        // The browser died upstream (expired or reclaimed). Tombstone the
        // record — never delete it — so evidence of the loss survives:
        // any resolver that reads this key during the replacement window
        // sees the tombstone and reports restarted: true too.
        await this.#store.set(key, { ...current, closedAt: Date.now() });
      } finally {
        await lock.release();
      }
      // Re-enter the loop: the next attempt takes the tombstone path.
    }

    throw new Error(
      `Browser session "${name}" kept changing concurrently — retry`
    );
  }

  /**
   * Resolve the named session and attach a CDP socket to it. Commands sent
   * over the socket refresh the session's idle clock (throttled to
   * {@link SESSION_TOUCH_INTERVAL_MS}), so sweeps never reap a browser that
   * is actively in use.
   */
  async connect(
    name = DEFAULT_BROWSER_SESSION_NAME
  ): Promise<ConnectedBrowserSession> {
    const resolved = await this.resolve(name);
    const key = namedBrowserSessionKey(name);
    let lastTouchAt = Date.now();
    let touchInFlight = false;
    const cdp = await connectBrowserSession(this.#browser, resolved.sessionId, {
      timeoutMs: this.#timeoutMs,
      onActivity: () => {
        const now = Date.now();
        if (touchInFlight || now - lastTouchAt < this.#touchIntervalMs) return;
        touchInFlight = true;
        lastTouchAt = now;
        void this.#touch(key, resolved.sessionId)
          .catch((error: unknown) => {
            console.warn(
              `[agents/browser] Failed to refresh activity for browser session "${name}"`,
              error
            );
          })
          .finally(() => {
            touchInFlight = false;
          });
      }
    });
    return {
      name: resolved.name,
      sessionId: resolved.sessionId,
      restarted: resolved.restarted,
      cdp
    };
  }

  /**
   * Close the named session: tombstone the record (so the next resolve
   * reports `restarted: true`) and delete its Browser Run session. Returns
   * `false` when there was nothing live to close.
   *
   * The platform delete is best-effort: the tombstone is the durable
   * outcome, and a browser whose delete failed is unreachable through this
   * store, so the pinned `keep_alive` (≤600s) reclaims it.
   */
  async close(name: string): Promise<boolean> {
    const key = namedBrowserSessionKey(name);
    let stored: StoredBrowserSession | undefined;
    const lock = await this.#store.acquireLock(key);
    try {
      const current = await this.#store.get(key);
      if (!current || current.closedAt !== undefined) return false;
      stored = current;
      await this.#store.set(key, { ...current, closedAt: Date.now() });
    } finally {
      await lock.release();
    }
    try {
      await deleteBrowserSession(this.#browser, stored.sessionId);
    } catch (error) {
      console.warn(
        `[agents/browser] Failed to delete closed Browser Run session ${stored.sessionId}`,
        error
      );
    }
    return true;
  }

  /** Refresh `updatedAt` for an actively used session — never resurrects. */
  async #touch(key: string, sessionId: string): Promise<void> {
    const lock = await this.#store.acquireLock(key);
    try {
      const current = await this.#store.get(key);
      if (current?.sessionId !== sessionId || current.closedAt !== undefined) {
        return; // swapped, closed, or gone — activity no longer counts
      }
      await this.#store.set(key, { ...current, updatedAt: Date.now() });
    } finally {
      await lock.release();
    }
  }

  /**
   * Close named sessions idle past the configured window, leaving tombstones,
   * and prune tombstones idle past the same window. Requires a store with
   * `list` support (the auto-supplied Durable Object store has it); without
   * `list` this is a no-op.
   *
   * Hosts should run this from a recurring alarm; the agents Lifecycle wiring
   * schedules it automatically.
   */
  async sweep(): Promise<BrowserSessionSweepResult> {
    const entries = await this.#store.list?.(NAMED_SESSION_KEY_PREFIX);
    if (!entries) return { swept: [] };

    const now = Date.now();
    const swept: Array<{ name: string; sessionId: string }> = [];

    for (const [key, entry] of entries) {
      const name = key.slice(NAMED_SESSION_KEY_PREFIX.length);

      if (entry.closedAt !== undefined) {
        // Tombstone — prune once it has aged out.
        if (now - entry.closedAt >= this.#sweepIdleMs) {
          const lock = await this.#store.acquireLock(key);
          try {
            const current = await this.#store.get(key);
            if (
              current?.sessionId === entry.sessionId &&
              current.closedAt !== undefined
            ) {
              await this.#store.delete(key);
            }
          } finally {
            await lock.release();
          }
        }
        continue;
      }

      if (now - entry.updatedAt < this.#sweepIdleMs) continue;

      // Idle live session: tombstone under the lock, delete the platform
      // session after release.
      let tombstoned = false;
      const lock = await this.#store.acquireLock(key);
      try {
        const current = await this.#store.get(key);
        if (
          current?.sessionId === entry.sessionId &&
          current.closedAt === undefined &&
          now - current.updatedAt >= this.#sweepIdleMs
        ) {
          await this.#store.set(key, { ...current, closedAt: now });
          tombstoned = true;
        }
      } finally {
        await lock.release();
      }
      if (!tombstoned) continue;

      try {
        await deleteBrowserSession(this.#browser, entry.sessionId);
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to delete swept Browser Run session ${entry.sessionId}`,
          error
        );
      }
      swept.push({ name, sessionId: entry.sessionId });
    }

    return { swept };
  }

  /**
   * Create a Browser Run session (outside any lock) and commit it under
   * `key`, reapplying the durable creation options. `replaceSessionId` names
   * the tombstoned entry this create is allowed to overwrite. If a concurrent
   * caller committed a different entry first, theirs wins and the redundant
   * session is deleted best-effort.
   */
  async #createAndCommit(
    key: string,
    replaceSessionId?: string
  ): Promise<
    | { stored: StoredBrowserSession; winner?: undefined }
    | { stored?: undefined; winner: StoredBrowserSession }
  > {
    const info = await createBrowserSession(this.#browser, {
      keepAliveMs:
        this.#create.keepAliveMs ?? BROWSER_SESSION_KEEP_ALIVE_MAX_MS,
      recording: this.#create.recording,
      guardrails: this.#create.guardrails
    });
    const now = Date.now();
    const stored: StoredBrowserSession = {
      sessionId: info.sessionId,
      createdAt: now,
      updatedAt: now
    };

    let winner: StoredBrowserSession | undefined;
    const lock = await this.#store.acquireLock(key);
    try {
      const current = await this.#store.get(key);
      if (current === undefined || current.sessionId === replaceSessionId) {
        await this.#store.set(key, stored);
      } else {
        winner = current;
      }
    } finally {
      await lock.release();
    }

    if (winner) {
      try {
        await deleteBrowserSession(this.#browser, stored.sessionId);
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to delete redundant Browser Run session ${stored.sessionId}`,
          error
        );
      }
      return { winner };
    }
    return { stored };
  }

  async #isAlive(stored: StoredBrowserSession): Promise<boolean> {
    try {
      await listBrowserTargets(this.#browser, stored.sessionId);
      return true;
    } catch (error) {
      if (isMissingBrowserSession(error)) return false;
      throw error;
    }
  }

  async #readStored(key: string): Promise<StoredBrowserSession | undefined> {
    const lock = await this.#store.acquireLock(key);
    try {
      return await this.#store.get(key);
    } finally {
      await lock.release();
    }
  }
}

/**
 * Open a one-shot browser session: create, connect, and delete the platform
 * session when the returned {@link CdpSession} closes. No store involved —
 * one-shot sessions have no name and no durability.
 */
export async function openOneShotBrowserSession(
  browser: BrowserBinding,
  options: OneShotBrowserSessionOptions = {}
): Promise<CdpSession> {
  if (options.browser === "kitesurf") {
    if (options.guardrails) {
      throw new Error("Kitesurf does not support guardrails");
    }
    // Kitesurf browsers are scoped to their WebSocket — connectBrowser is
    // already one-shot there (and rejects the other Chromium-only options).
    return connectBrowser(browser, {
      browser: "kitesurf",
      timeoutMs: options.timeoutMs,
      keepAliveMs: options.keepAliveMs,
      recording: options.recording
    });
  }

  const info = await createBrowserSession(browser, {
    keepAliveMs: options.keepAliveMs,
    recording: options.recording,
    guardrails: options.guardrails
  });
  try {
    return await connectBrowserSession(browser, info.sessionId, {
      timeoutMs: options.timeoutMs,
      onClose: () => {
        deleteBrowserSession(browser, info.sessionId).catch(
          (error: unknown) => {
            console.warn(
              `[agents/browser] Failed to delete one-shot Browser Run session ${info.sessionId}`,
              error
            );
          }
        );
      }
    });
  } catch (error) {
    // The session was allocated but never got its delete-on-close owner —
    // reclaim it now instead of leaving it to expire.
    try {
      await deleteBrowserSession(browser, info.sessionId);
    } catch {
      // Best-effort: keep_alive expiry reclaims it.
    }
    throw error;
  }
}
