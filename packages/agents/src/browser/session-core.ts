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
import type {
  BrowserSessionStore,
  StoredBrowserSession
} from "./session-manager";

/**
 * Browser Run's server-side `keep_alive` maximum (600 seconds). Named
 * sessions pin keep-alive here by default so a browser survives quiet spells
 * between agent turns; the platform reclaims it only after this long idle.
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
 * Where a closed or lost session's record moves: permanent evidence that the
 * name once owned a browser, so a later resolve reports `restarted: true`.
 * Kept outside {@link NAMED_SESSION_KEY_PREFIX} so listing named sessions
 * yields only names that currently own a browser. Grows with the number of
 * distinct names the host has ever used.
 */
const RETIRED_SESSION_KEY_PREFIX = "browser:retired:";

function retiredBrowserSessionKey(name: string): string {
  return `${RETIRED_SESSION_KEY_PREFIX}${name}`;
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
   * Minimum interval between activity-driven `updatedAt` refreshes on
   * connected sockets. Defaults to {@link SESSION_TOUCH_INTERVAL_MS} and is
   * always capped at half of the keep-alive window, so continuous CDP
   * traffic never lets a record look older than the window the platform
   * reclaims idle browsers after. Overridable primarily for tests.
   */
  touchIntervalMs?: number;
}

export interface ResolvedBrowserSession {
  name: string;
  /** The Browser Run session id — host-side only, never model-visible. */
  sessionId: string;
  /**
   * `true` when this resolution had to create a fresh browser to replace one
   * that previously existed (was closed, or expired or died upstream). Page state from
   * the prior browser is gone; surface this loudly to the model. `false` only
   * on first-ever use of the name — nothing was lost.
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

/** One-shot session options for the default Chromium engine. */
export interface OneShotChromiumSessionOptions extends BrowserSessionCreateOptions {
  /** Select the browser engine. Defaults to Chromium. */
  browser?: "chromium";
  timeoutMs?: number;
}

/**
 * One-shot session options for Kitesurf. The Chromium-only options —
 * `guardrails`, `keepAliveMs`, `recording` — do not exist on this arm:
 * Kitesurf does not support them.
 */
export interface OneShotKitesurfSessionOptions {
  browser: "kitesurf";
  timeoutMs?: number;
}

/**
 * Engine-discriminated {@link openOneShotBrowserSession} options: selecting
 * `browser: "kitesurf"` removes the Chromium-only options at the type level.
 */
export type OneShotBrowserSessionOptions =
  | OneShotChromiumSessionOptions
  | OneShotKitesurfSessionOptions;

/**
 * Provider-independent named browser sessions: the host wires names, models
 * never see session identity, and resolution is reattach-or-create with loud
 * mortality signaling (`restarted: true` whenever a prior browser was lost).
 *
 * Idle browsers are reclaimed by Browser Run itself once `keep_alive`
 * elapses without activity; there is no host-side sweep. A record whose
 * browser the platform reclaimed stays on file until the next resolve of
 * that name detects the loss and replaces it.
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
  readonly #touchIntervalMs: number;

  constructor(options: NamedBrowserSessionsOptions) {
    this.#browser = options.browser;
    this.#store = options.store;
    this.#create = options.create ?? {};
    this.#timeoutMs = options.timeoutMs;
    // Cap the touch cadence at half the keep-alive window: a session with
    // continuous CDP traffic must never look older than the window the
    // platform uses to reclaim it.
    this.#touchIntervalMs = Math.min(
      options.touchIntervalMs ?? SESSION_TOUCH_INTERVAL_MS,
      Math.floor(this.keepAliveMs / 2)
    );
  }

  /** The platform `keep_alive` every create applies. */
  get keepAliveMs(): number {
    return this.#create.keepAliveMs ?? BROWSER_SESSION_KEEP_ALIVE_MAX_MS;
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

    // Dead-session recovery consumes two attempts (retire, then create).
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await this.#readStored(key);

      if (existing === undefined) {
        // No browser on record: create one. The commit reports whether the
        // name was ever used before (see #createAndCommit).
        const { session, restarted } = await this.#createAndCommit(name);
        return { name, restarted, ...session };
      }

      // Live entry on record — probe it outside any lock.
      const alive = await this.#isAlive(existing);
      const lock = await this.#store.acquireLock(key);
      try {
        const current = await this.#store.get(key);
        if (current?.sessionId !== existing.sessionId) {
          continue; // swapped or retired while we probed — revalidate
        }
        if (alive) {
          const refreshed = { ...current, updatedAt: Date.now() };
          await this.#store.set(key, refreshed);
          return { name, restarted: false, ...refreshed };
        }
        // The browser died upstream (expired or reclaimed). Retire the
        // record under this lock, so any resolver that reads this name
        // during the replacement window sees the marker and reports
        // restarted: true too.
        await this.#retire(name, current);
      } finally {
        await lock.release();
      }
      // Re-enter the loop: the next attempt takes the create path.
    }

    throw new Error(
      `Browser session "${name}" kept changing concurrently — retry`
    );
  }

  /**
   * Resolve the named session and attach a CDP socket to it. Commands sent
   * over the socket refresh the record's `updatedAt` (throttled to
   * {@link SESSION_TOUCH_INTERVAL_MS}), so hosts can tell an actively used
   * browser from one the platform has likely reclaimed.
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
   * Close the named session: retire the record (so the next resolve reports
   * `restarted: true`) and delete its Browser Run session. Returns `false`
   * when there was nothing to close.
   *
   * The platform delete is best-effort: the retired record is the durable
   * outcome, and a browser whose delete failed is unreachable through this
   * store, so the pinned `keep_alive` (≤600s) reclaims it.
   */
  async close(name: string): Promise<boolean> {
    const key = namedBrowserSessionKey(name);
    let stored: StoredBrowserSession | undefined;
    const lock = await this.#store.acquireLock(key);
    try {
      const current = await this.#store.get(key);
      if (!current) return false;
      stored = current;
      await this.#retire(name, current);
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

  /**
   * Record activity for the named session beyond CDP traffic — e.g. a host
   * minting a Live View link for a human. Refreshes `updatedAt` only while
   * the same session remains stored; a replaced or retired entry is never
   * resurrected.
   *
   * @returns True when the same session's clock was refreshed; false when a
   * concurrent close or replacement already retired it — the caller's
   * knowledge of that session is definitively stale.
   */
  async touch(name: string, sessionId: string): Promise<boolean> {
    return this.#touch(namedBrowserSessionKey(name), sessionId);
  }

  /** Refresh `updatedAt` for an actively used session — never resurrects. */
  async #touch(key: string, sessionId: string): Promise<boolean> {
    const lock = await this.#store.acquireLock(key);
    try {
      const current = await this.#store.get(key);
      if (current?.sessionId !== sessionId) {
        return false; // replaced or gone — activity no longer counts
      }
      await this.#store.set(key, { ...current, updatedAt: Date.now() });
      return true;
    } finally {
      await lock.release();
    }
  }

  /**
   * Move the named record to its retired marker. Callers hold the name's
   * key lock, so a resolver always sees either the record or the marker.
   */
  async #retire(name: string, current: StoredBrowserSession): Promise<void> {
    await this.#store.set(retiredBrowserSessionKey(name), {
      ...current,
      closedAt: Date.now()
    });
    await this.#store.delete(namedBrowserSessionKey(name));
  }

  /**
   * Create a Browser Run session (outside any lock) and commit it under the
   * name, reapplying the durable creation options. If a concurrent caller
   * committed an entry first, theirs wins and the redundant session is
   * deleted best-effort.
   *
   * `restarted` is read under the commit lock: a retired marker — left by
   * close() or a dead-session recovery — is evidence a prior browser
   * existed, and only first-ever use of the name is not a restart. Markers
   * are permanent, so reading at commit time also catches a browser that
   * was created and closed while this create was in flight.
   */
  async #createAndCommit(
    name: string
  ): Promise<{ session: StoredBrowserSession; restarted: boolean }> {
    const key = namedBrowserSessionKey(name);
    const info = await createBrowserSession(this.#browser, {
      keepAliveMs: this.keepAliveMs,
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
    let restarted: boolean;
    const lock = await this.#store.acquireLock(key);
    try {
      restarted =
        (await this.#store.get(retiredBrowserSessionKey(name))) !== undefined;
      const current = await this.#store.get(key);
      if (current === undefined) {
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
      return { session: winner, restarted };
    }
    return { session: stored, restarted };
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
    // The options union already rejects these at the type level for literal
    // call sites; plain-JS callers and spreads can still smuggle them in, so
    // fail loudly in one place with one message.
    const smuggled = options as {
      guardrails?: unknown;
      keepAliveMs?: unknown;
      recording?: unknown;
    };
    if (smuggled.guardrails || smuggled.keepAliveMs || smuggled.recording) {
      throw new Error(
        "Kitesurf does not support guardrails, keepAliveMs, or recording"
      );
    }
    // Kitesurf browsers are scoped to their WebSocket — connectBrowser is
    // already one-shot there.
    return connectBrowser(browser, {
      browser: "kitesurf",
      timeoutMs: options.timeoutMs
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
