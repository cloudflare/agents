/**
 * `Browser`: one named, persistent browser for an agent or Durable Object.
 *
 * Its tabs and logins survive between agent runs. When the browser is lost
 * (closed, idle past `keep_alive`, or crashed), the next use starts a fresh
 * one and reports `restarted: true` so the model knows its earlier state is
 * gone.
 *
 * Browser Run is the only provider today; see {@link browserRun}.
 */

import { LifecycleCapability } from "../lifecycle/capability";
import type { CdpConnection } from "./cdp-connection";
import {
  type BrowserBinding,
  type BrowserSessionGuardrails,
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  isMissingBrowserSession,
  listBrowserTargets
} from "./browser-run";
import {
  createLiveView,
  type BrowserLiveView,
  type LiveViewMode
} from "./live-view";
import {
  DurableBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession
} from "./session-store";
import { loadCdpSpec, type SearchableCdpSpec } from "./spec";

/**
 * Browser Run's server-side `keep_alive` maximum (600 seconds). A `Browser`
 * pins keep-alive here by default so it survives quiet spells between agent
 * turns; the platform reclaims it only after this long idle.
 */
export const BROWSER_SESSION_KEEP_ALIVE_MAX_MS = 600_000;

/**
 * Minimum interval between store `updatedAt` refreshes driven by CDP traffic
 * on connections returned by {@link Browser.connect}.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** The browser name used when a host doesn't pick one. */
export const DEFAULT_BROWSER_NAME = "default";

/**
 * The scope used when a caller doesn't pick one: every caller that leaves
 * `scope` out shares this one active tab. See {@link BrowserConnectOptions}.
 */
export const DEFAULT_BROWSER_SCOPE = "shared";

/**
 * Scope records kept per browser. Writing a new one past the cap deletes the
 * least recently used; a scope that comes back afterwards starts fresh.
 */
export const MAX_BROWSER_SCOPES = 100;

const NAMED_SESSION_KEY_PREFIX = "browser:session:";

/** The store key holding the named browser's current record. */
export function namedBrowserSessionKey(name: string): string {
  return `${NAMED_SESSION_KEY_PREFIX}${name}`;
}

/**
 * Where a closed or lost browser's record moves: permanent evidence that the
 * name once owned a browser, so a later resolve reports `restarted: true`.
 * Kept outside {@link NAMED_SESSION_KEY_PREFIX} so listing that prefix
 * yields only names that currently own a browser. Grows with the number of
 * distinct names the host has ever used.
 */
const RETIRED_SESSION_KEY_PREFIX = "browser:retired:";

function retiredBrowserSessionKey(name: string): string {
  return `${RETIRED_SESSION_KEY_PREFIX}${name}`;
}

/**
 * Where a browser's scope records live. The name's length is part of the
 * prefix, so one browser's prefix never matches another name's (`a` with
 * scope `b:c` vs. `a:b` with scope `c`).
 */
function browserScopeKeyPrefix(name: string): string {
  return `browser:scope:${name.length}:${name}:`;
}

/**
 * Browser Run settings applied every time a browser is created — including
 * when a lost browser is replaced — so options like guardrails survive a
 * restart.
 */
export interface BrowserRunOptions {
  /**
   * Platform `keep_alive` in milliseconds: how long an idle browser lives.
   * Defaults to {@link BROWSER_SESSION_KEEP_ALIVE_MAX_MS} (the platform
   * maximum).
   */
  keepAliveMs?: number;
  /** Opt into Browser Run session recording (rrweb capture). */
  recording?: boolean;
  /** Hostname guardrails, fixed at launch for every connection. */
  guardrails?: BrowserSessionGuardrails;
}

/** A {@link Browser} provider backed by Cloudflare Browser Run. */
export interface BrowserRunProvider {
  readonly kind: "browser-run";
  readonly binding: BrowserBinding;
  readonly options: BrowserRunOptions;
}

/** Where a {@link Browser} gets its browser from. */
export type BrowserProvider = BrowserRunProvider;

/**
 * Run the browser on Cloudflare Browser Run.
 *
 * @example
 * ```ts
 * new Browser({ provider: browserRun(env.BROWSER, { recording: true }) });
 * ```
 */
export function browserRun(
  binding: BrowserBinding,
  options: BrowserRunOptions = {}
): BrowserRunProvider {
  return { kind: "browser-run", binding, options };
}

export interface BrowserOptions {
  /** Where the browser runs. Create one with {@link browserRun}. */
  provider: BrowserProvider;
  /**
   * Which browser this is. Two `Browser` objects on the same Durable Object
   * need different names. Defaults to {@link DEFAULT_BROWSER_NAME}.
   */
  name?: string;
  /**
   * Where the browser's record lives. Defaults to a
   * {@link DurableBrowserSessionStore} over the host object's storage, which
   * requires installing the `Browser` with `Lifecycle.use()`. Passing a store
   * lets the `Browser` work without Lifecycle.
   */
  store?: BrowserSessionStore;
  /** Default CDP command timeout for {@link Browser.connect}. */
  timeoutMs?: number;
  /**
   * Minimum interval between activity-driven `updatedAt` refreshes.
   * Defaults to {@link SESSION_TOUCH_INTERVAL_MS}, capped at half the
   * keep-alive window.
   *
   * @internal For tests.
   */
  touchIntervalMs?: number;
}

export interface ResolvedBrowser {
  name: string;
  /** The Browser Run session id — host-side only, never model-visible. */
  sessionId: string;
  /**
   * `true` when this resolution had to create a fresh browser to replace one
   * that previously existed (was closed, or expired or died upstream). Page
   * state from the prior browser is gone; surface this loudly to the model.
   * `false` only on first-ever use of the name — nothing was lost.
   */
  restarted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserConnectOptions {
  /**
   * Who is driving. Connections with the same scope share an active tab, and
   * each scope keeps its own, so two conversations on one browser don't
   * drive each other's page. Cookies, logins, and the tabs themselves are
   * shared by every scope: a scope splits "which tab is mine", not the
   * browser. Defaults to {@link DEFAULT_BROWSER_SCOPE}.
   */
  scope?: string;
}

export interface BrowserConnection {
  name: string;
  sessionId: string;
  /** The scope this connection works in; see {@link BrowserConnectOptions}. */
  scope: string;
  /**
   * `true` when this scope worked in an earlier browser that has since been
   * replaced, whichever scope's connection replaced it. Its tabs and page
   * state are gone; surface this loudly to the model. `false` on a scope's
   * first connection: it had nothing to lose.
   */
  restarted: boolean;
  /**
   * The tab this scope last worked in, when it recorded one in this
   * browser.
   */
  activeTargetId?: string;
  /** Closing this connection does NOT close the browser. */
  cdp: CdpConnection;
  /**
   * Record the tab this scope is working in (or clear it with `undefined`).
   * Never resurrects: returns `false` when the browser was closed or
   * replaced since this connection resolved it.
   */
  setActiveTarget(targetId: string | undefined): Promise<boolean>;
  /**
   * Make `targetId` this scope's tab only if no other scope is working in
   * it. Returns `false` when another scope has it, or the browser was closed
   * or replaced.
   */
  claimTarget(targetId: string): Promise<boolean>;
  /** The tabs other scopes are working in, in this browser. */
  targetsInOtherScopes(): Promise<Set<string>>;
  /**
   * The Chrome DevTools Protocol description this browser serves, read from
   * the browser itself (cached per binding).
   */
  spec(): Promise<SearchableCdpSpec>;
}

/**
 * One named, persistent browser.
 *
 * Install it with `Lifecycle.use()` — on an Agent subclass or any Durable
 * Object that composes `Lifecycle` — and it stores its record in the
 * object's own storage. It schedules nothing: Browser Run reclaims idle
 * browsers itself once `keep_alive` elapses, and the next use replaces the
 * lost browser with `restarted: true`.
 *
 * Everything here is host-side. Models never see browser names, Browser Run
 * ids, or Live View URLs through this surface.
 *
 * Store discipline: locks wrap storage operations only — liveness probes and
 * Browser Run create/delete calls always happen outside any lock, with a
 * commit re-check to detect concurrent swaps.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Browser extends LifecycleCapability {
  /** Which browser this is; see {@link BrowserOptions.name}. */
  readonly name: string;
  readonly #options: BrowserOptions;
  readonly #key: string;
  #store?: BrowserSessionStore;

  constructor(options: BrowserOptions) {
    const name = options.name ?? DEFAULT_BROWSER_NAME;
    super(`browser:${name}`);
    if (name.trim() === "") {
      throw new Error("Browser names must be non-empty");
    }
    this.name = name;
    this.#options = options;
    this.#key = namedBrowserSessionKey(name);
  }

  /**
   * Reattach to the browser when it is still alive, otherwise create a fresh
   * one. See {@link ResolvedBrowser.restarted} for the mortality signal.
   */
  async resolve(): Promise<ResolvedBrowser> {
    const { name } = this;
    const key = this.#key;

    // Dead-browser recovery consumes two attempts (retire, then create).
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await this.#readStored();

      if (existing === undefined) {
        // No browser on record: create one. The commit reports whether the
        // name was ever used before (see #createAndCommit).
        const { session, restarted } = await this.#createAndCommit();
        return { name, restarted, ...resolvedFields(session) };
      }

      // Live entry on record — probe it outside any lock.
      const alive = await this.#isAlive(existing);
      const lock = await this.#sessionStore.acquireLock(key);
      try {
        const current = await this.#sessionStore.get(key);
        if (current?.sessionId !== existing.sessionId) {
          continue; // swapped or retired while we probed — revalidate
        }
        if (alive) {
          const refreshed = { ...current, updatedAt: Date.now() };
          await this.#sessionStore.set(key, refreshed);
          return { name, restarted: false, ...resolvedFields(refreshed) };
        }
        // The browser died upstream (expired or reclaimed). Retire the
        // record under this lock, so any resolver that reads it during the
        // replacement window sees the marker and reports restarted: true
        // too.
        await this.#retire(current);
      } finally {
        await lock.release();
      }
      // Re-enter the loop: the next attempt takes the create path.
    }

    throw new Error(`Browser "${name}" kept changing concurrently — retry`);
  }

  /**
   * Resolve the browser and open a CDP connection to it for one scope (see
   * {@link BrowserConnectOptions.scope}). Commands sent over the connection
   * refresh the record's `updatedAt` (throttled to
   * {@link SESSION_TOUCH_INTERVAL_MS}), so hosts can tell an actively used
   * browser from one the platform has likely reclaimed.
   *
   * If the browser expires between the liveness probe and the WebSocket
   * upgrade, the record is retired and the browser resolved once more, so
   * the caller gets a fresh browser instead of an error.
   */
  async connect(
    options: BrowserConnectOptions = {}
  ): Promise<BrowserConnection> {
    const scope = options.scope ?? DEFAULT_BROWSER_SCOPE;
    if (scope.trim() === "") {
      throw new Error("Browser scopes must be non-empty");
    }
    let resolved = await this.resolve();
    let cdp: CdpConnection;
    try {
      cdp = await this.#open(resolved);
    } catch (error) {
      if (!isMissingBrowserSession(error)) throw error;
      await this.#retireIfCurrent(resolved.sessionId);
      resolved = await this.resolve();
      cdp = await this.#open(resolved);
    }
    try {
      const entered = await this.#enterScope(scope, resolved.sessionId);
      return this.#connection(resolved, scope, cdp, entered);
    } catch (error) {
      cdp.disconnect();
      throw error;
    }
  }

  #connection(
    resolved: ResolvedBrowser,
    scope: string,
    cdp: CdpConnection,
    entered: { restarted: boolean; activeTargetId?: string }
  ): BrowserConnection {
    const { sessionId } = resolved;
    const { binding } = this.#provider;
    return {
      name: resolved.name,
      sessionId,
      scope,
      restarted: entered.restarted,
      activeTargetId: entered.activeTargetId,
      cdp,
      setActiveTarget: (targetId) =>
        this.#updateScope(scope, sessionId, () => targetId),
      claimTarget: (targetId) =>
        this.#updateScope(scope, sessionId, (others) =>
          others.has(targetId) ? false : targetId
        ),
      targetsInOtherScopes: async () =>
        activeTargets(await this.#listScopes(), scope, sessionId),
      spec: () => loadCdpSpec({ browser: binding, sessionId })
    };
  }

  async #open(resolved: ResolvedBrowser): Promise<CdpConnection> {
    let lastTouchAt = Date.now();
    let touchInFlight = false;
    return connectBrowserSession(this.#provider.binding, resolved.sessionId, {
      timeoutMs: this.#options.timeoutMs,
      onActivity: () => {
        const now = Date.now();
        if (touchInFlight || now - lastTouchAt < this.#touchIntervalMs) {
          return;
        }
        touchInFlight = true;
        lastTouchAt = now;
        void this.#touch(resolved.sessionId)
          .catch((error: unknown) => {
            console.warn(
              `[agents/browser] Failed to refresh activity for browser "${this.name}"`,
              error
            );
          })
          .finally(() => {
            touchInFlight = false;
          });
      }
    });
  }

  /**
   * Close the browser: retire the record (so the next resolve reports
   * `restarted: true`) and delete its Browser Run session. Returns `false`
   * when there was nothing to close.
   *
   * The platform delete is best-effort: the retired record is the durable
   * outcome, and a browser whose delete failed is unreachable through this
   * store, so the pinned `keep_alive` (≤600s) reclaims it.
   */
  async close(): Promise<boolean> {
    let stored: StoredBrowserSession | undefined;
    const lock = await this.#sessionStore.acquireLock(this.#key);
    try {
      const current = await this.#sessionStore.get(this.#key);
      if (!current) return false;
      stored = current;
      await this.#retire(current);
    } finally {
      await lock.release();
    }
    try {
      await deleteBrowserSession(this.#provider.binding, stored.sessionId);
    } catch (error) {
      console.warn(
        `[agents/browser] Failed to delete closed Browser Run session ${stored.sessionId}`,
        error
      );
    }
    return true;
  }

  /**
   * Mint Live View URLs for the browser's open tabs, fresh from a target
   * listing. `undefined` when the browser was never created, is closed, or
   * is gone. The URLs are bearer credentials with a short connect window
   * (~5 min) — hand them to a trusted human, never to the model, and never
   * store them: re-mint instead.
   */
  async liveView(options?: {
    mode?: LiveViewMode;
  }): Promise<BrowserLiveView | undefined> {
    const entry = await this.#sessionStore.get(this.#key);
    if (!entry) return undefined;
    try {
      const targets = await listBrowserTargets(
        this.#provider.binding,
        entry.sessionId
      );
      // A human is about to look: minting counts as activity. Target
      // listing yields to the network, so a concurrent close or replacement
      // can retire the browser mid-mint — the touch and the retire
      // serialize on the key lock, and a lost touch means the listed
      // targets are already dead: report the browser gone rather than
      // minting doomed links. Touch *errors* stay best effort — a store
      // blip must not break minting.
      try {
        if (!(await this.#touch(entry.sessionId))) return undefined;
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to refresh activity for browser "${this.name}"`,
          error
        );
      }
      return createLiveView(entry.sessionId, targets, options?.mode);
    } catch (error) {
      if (isMissingBrowserSession(error)) return undefined;
      throw error;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  get #provider(): BrowserRunProvider {
    return this.#options.provider;
  }

  /** The platform `keep_alive` every create applies. */
  get #keepAliveMs(): number {
    return (
      this.#provider.options.keepAliveMs ?? BROWSER_SESSION_KEEP_ALIVE_MAX_MS
    );
  }

  /**
   * Capped at half the keep-alive window: a browser with continuous CDP
   * traffic must never look older than the window the platform uses to
   * reclaim it.
   */
  get #touchIntervalMs(): number {
    return Math.min(
      this.#options.touchIntervalMs ?? SESSION_TOUCH_INTERVAL_MS,
      Math.floor(this.#keepAliveMs / 2)
    );
  }

  /** Lazy: `lifecycle.storage` exists only once `Lifecycle.use()` ran. */
  get #sessionStore(): BrowserSessionStore {
    this.#store ??=
      this.#options.store ??
      new DurableBrowserSessionStore(this.lifecycle.storage);
    return this.#store;
  }

  /**
   * Refresh `updatedAt` while the record still holds `sessionId`. Returns
   * false when a concurrent close or replacement already retired it.
   */
  #touch(sessionId: string): Promise<boolean> {
    return this.#update(sessionId, (current) => ({
      ...current,
      updatedAt: Date.now()
    }));
  }

  /**
   * Rewrite the record only while it still holds `sessionId`: a replaced or
   * retired record is never resurrected.
   */
  async #update(
    sessionId: string,
    change: (current: StoredBrowserSession) => StoredBrowserSession
  ): Promise<boolean> {
    const lock = await this.#sessionStore.acquireLock(this.#key);
    try {
      const current = await this.#sessionStore.get(this.#key);
      if (current?.sessionId !== sessionId) {
        return false; // replaced or gone — the caller's view is stale
      }
      await this.#sessionStore.set(this.#key, change(current));
      return true;
    } finally {
      await lock.release();
    }
  }

  // ── Scopes ───────────────────────────────────────────────────────────────
  //
  // Each scope has a small record next to the browser's: the browser it last
  // worked in (`sessionId`) and its tab there. All of a browser's scope
  // records share one lock, so claiming a tab can check the others.

  #scopeKey(scope: string): string {
    return `${browserScopeKeyPrefix(this.name)}${scope}`;
  }

  /** The lock every scope record of this browser is written under. */
  get #scopesLockKey(): string {
    return browserScopeKeyPrefix(this.name);
  }

  /** Every scope record of this browser, by scope. Empty without `list`. */
  async #listScopes(): Promise<Map<string, StoredBrowserSession>> {
    const prefix = browserScopeKeyPrefix(this.name);
    const entries = (await this.#sessionStore.list?.(prefix)) ?? new Map();
    const scopes = new Map<string, StoredBrowserSession>();
    for (const [key, entry] of entries) {
      scopes.set(key.slice(prefix.length), entry);
    }
    return scopes;
  }

  /**
   * Start a connection's scope: a scope whose record names an earlier
   * browser was restarted, and its record moves to this one. A new record
   * past {@link MAX_BROWSER_SCOPES} evicts the least recently used.
   */
  async #enterScope(
    scope: string,
    sessionId: string
  ): Promise<{ restarted: boolean; activeTargetId?: string }> {
    const key = this.#scopeKey(scope);
    const lock = await this.#sessionStore.acquireLock(this.#scopesLockKey);
    try {
      const entry = await this.#sessionStore.get(key);
      const now = Date.now();
      if (entry?.sessionId === sessionId) {
        await this.#sessionStore.set(key, { ...entry, updatedAt: now });
        return { restarted: false, activeTargetId: entry.activeTargetId };
      }
      await this.#sessionStore.set(key, {
        sessionId,
        createdAt: now,
        updatedAt: now
      });
      if (!entry) await this.#evictScopes();
      return { restarted: entry !== undefined };
    } finally {
      await lock.release();
    }
  }

  /** Delete the least recently used scope records past the cap. */
  async #evictScopes(): Promise<void> {
    const scopes = await this.#listScopes();
    if (scopes.size <= MAX_BROWSER_SCOPES) return;
    const oldest = [...scopes]
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
      .slice(0, scopes.size - MAX_BROWSER_SCOPES);
    for (const [scope] of oldest) {
      await this.#sessionStore.delete(this.#scopeKey(scope));
    }
  }

  /**
   * Set a scope's tab to what `choose` returns, given the tabs other scopes
   * are working in; `false` from `choose` leaves it as is. Never
   * resurrects: does nothing (and returns `false`) once the browser this
   * connection resolved was closed or replaced.
   */
  async #updateScope(
    scope: string,
    sessionId: string,
    choose: (others: Set<string>) => string | undefined | false
  ): Promise<boolean> {
    const key = this.#scopeKey(scope);
    const lock = await this.#sessionStore.acquireLock(this.#scopesLockKey);
    try {
      const current = await this.#sessionStore.get(this.#key);
      const entry = await this.#sessionStore.get(key);
      if (current?.sessionId !== sessionId || entry?.sessionId !== sessionId) {
        return false;
      }
      const others = activeTargets(await this.#listScopes(), scope, sessionId);
      const targetId = choose(others);
      if (targetId === false) return false;
      await this.#sessionStore.set(key, {
        ...entry,
        activeTargetId: targetId,
        updatedAt: Date.now()
      });
      return true;
    } finally {
      await lock.release();
    }
  }

  /** Retire the record if it still holds `sessionId`. */
  async #retireIfCurrent(sessionId: string): Promise<void> {
    const lock = await this.#sessionStore.acquireLock(this.#key);
    try {
      const current = await this.#sessionStore.get(this.#key);
      if (current?.sessionId === sessionId) await this.#retire(current);
    } finally {
      await lock.release();
    }
  }

  /**
   * Move the record to its retired marker. Callers hold the key lock, so a
   * resolver always sees either the record or the marker.
   */
  async #retire(current: StoredBrowserSession): Promise<void> {
    await this.#sessionStore.set(retiredBrowserSessionKey(this.name), {
      ...current,
      closedAt: Date.now()
    });
    await this.#sessionStore.delete(this.#key);
  }

  /**
   * Create a Browser Run session (outside any lock) and commit it, applying
   * the provider's creation options. If a concurrent caller committed an
   * entry first, theirs wins and the redundant session is deleted
   * best-effort.
   *
   * `restarted` is read under the commit lock: a retired marker — left by
   * close() or a dead-browser recovery — is evidence a prior browser
   * existed, and only first-ever use of the name is not a restart. Markers
   * are permanent, so reading at commit time also catches a browser that
   * was created and closed while this create was in flight.
   */
  async #createAndCommit(): Promise<{
    session: StoredBrowserSession;
    restarted: boolean;
  }> {
    const { binding, options } = this.#provider;
    const info = await createBrowserSession(binding, {
      keepAliveMs: this.#keepAliveMs,
      recording: options.recording,
      guardrails: options.guardrails
    });
    const now = Date.now();
    const stored: StoredBrowserSession = {
      sessionId: info.sessionId,
      createdAt: now,
      updatedAt: now
    };

    let winner: StoredBrowserSession | undefined;
    let restarted: boolean;
    const lock = await this.#sessionStore.acquireLock(this.#key);
    try {
      restarted =
        (await this.#sessionStore.get(retiredBrowserSessionKey(this.name))) !==
        undefined;
      const current = await this.#sessionStore.get(this.#key);
      if (current === undefined) {
        await this.#sessionStore.set(this.#key, stored);
      } else {
        winner = current;
      }
    } finally {
      await lock.release();
    }

    if (winner) {
      try {
        await deleteBrowserSession(binding, stored.sessionId);
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
      await listBrowserTargets(this.#provider.binding, stored.sessionId);
      return true;
    } catch (error) {
      if (isMissingBrowserSession(error)) return false;
      throw error;
    }
  }

  async #readStored(): Promise<StoredBrowserSession | undefined> {
    const lock = await this.#sessionStore.acquireLock(this.#key);
    try {
      return await this.#sessionStore.get(this.#key);
    } finally {
      await lock.release();
    }
  }
}

/** A store record without fields that belong to scope records. */
function resolvedFields(session: StoredBrowserSession) {
  const { sessionId, createdAt, updatedAt } = session;
  return { sessionId, createdAt, updatedAt };
}

/** The tabs scopes other than `scope` are working in, in `sessionId`. */
function activeTargets(
  scopes: Map<string, StoredBrowserSession>,
  scope: string,
  sessionId: string
): Set<string> {
  const targets = new Set<string>();
  for (const [other, entry] of scopes) {
    if (other === scope || entry.sessionId !== sessionId) continue;
    if (entry.activeTargetId) targets.add(entry.activeTargetId);
  }
  return targets;
}
