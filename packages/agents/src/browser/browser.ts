/**
 * `Browser`: one named, persistent browser for an agent or Durable Object.
 *
 * Its tabs and logins survive between agent runs. When the browser is lost
 * (closed, idle past `keep_alive`, or crashed), the next use starts a fresh
 * one and reports `restarted: true` so the model knows its earlier state is
 * gone.
 *
 * Where the browser runs is its provider: Browser Run is the only one today
 * (`browserRun` in ./providers/browser-run.ts). `Browser` holds everything
 * that doesn't depend on the provider and calls the provider's adapter for
 * the rest (see ./providers/provider-adapter.ts).
 */

import {
  LifecycleCapability,
  type LifecycleRouteContext
} from "../lifecycle/capability";
import { browserCapabilityId } from "./capability-id";
import type { CdpConnection } from "./cdp-connection";
import {
  internalHostError,
  isInternalHostMessage,
  targetJsonSchema,
  validateTarget,
  type AnyInternalHost,
  type InternalHostInfo,
  type InternalHostMessage
} from "./internal-hosts";
import type { BrowserLiveView, LiveViewMode } from "./live-view";
import {
  browserRunAdapter,
  type BrowserRunProvider
} from "./providers/browser-run";
import {
  BrowserSessionGoneError,
  type BrowserProviderAdapter,
  type InternalHostOwner
} from "./providers/provider-adapter";
import { BrowserSession, type BrowserSessionOptions } from "./session";
import {
  DurableBrowserSessionStore,
  type ListableBrowserSessionStore,
  type StoredBrowserSession
} from "./session-store";
import type { SearchableCdpSpec } from "./spec";

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
 * Where a browser's internal-host assignments live: one JSON object, keyed
 * by hostname. Length-prefixed like scope records. Kept apart from the
 * session record, so assignments survive the browser being replaced.
 */
function internalHostAssignmentsKey(name: string): string {
  return `browser:hosts:${name.length}:${name}`;
}

/** Where a {@link Browser} gets its browser from. */
export type BrowserProvider = BrowserRunProvider;

/** The adapter behind a provider: one explicit case per provider kind. */
function providerAdapterFor(provider: BrowserProvider): BrowserProviderAdapter {
  switch (provider.kind) {
    case "browser-run":
      return browserRunAdapter(provider);
  }
}

export interface BrowserOptions {
  /** Where the browser runs. Create one with `browserRun()`. */
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
   * lets the `Browser` work without Lifecycle. It must implement `list`.
   */
  store?: ListableBrowserSessionStore;
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
  /** The provider's session id — host-side only, never model-visible. */
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
   * first connection, even one that replaced a lost browser: the scope had
   * nothing to lose. This is per scope, not a browser-wide signal.
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
  /** The tabs other scopes are working in, in this browser. */
  targetsInOtherScopes(): Promise<Set<string>>;
  /**
   * The Chrome DevTools Protocol description this browser serves, read from
   * the browser itself (cached).
   */
  spec(): Promise<SearchableCdpSpec>;
}

/**
 * A browser's internal hostnames (`browserRun({ internalHosts })`), for the
 * host and the browser tool. Assignments are stored with the agent, so they
 * survive the browser being replaced, eviction, and redeploys.
 */
export interface BrowserInternalHosts {
  /** Every hostname with its description, schema, and current target. */
  list(): Promise<InternalHostInfo[]>;
  /**
   * Point an assignable host somewhere: `target` is checked against the
   * host's `target` schema and stored. The browser's next request to the
   * host uses it. Throws with what's wrong when the target doesn't match.
   */
  assign(host: string, target: unknown): Promise<{ url: string }>;
  /** Forget a host's target; its requests answer 502 until assigned again. */
  clear(host: string): Promise<boolean>;
  /** The hostnames with their descriptions and schemas, without reading storage. */
  describe(): InternalHostInfo[];
}

/**
 * One named, persistent browser.
 *
 * Install it with `Lifecycle.use()` — on an Agent subclass or any Durable
 * Object that composes `Lifecycle` — and it stores its record in the
 * object's own storage. It schedules nothing: the provider reclaims idle
 * browsers itself (Browser Run once `keep_alive` elapses), and the next use
 * replaces the lost browser with `restarted: true`.
 *
 * Everything here is host-side. Models never see browser names, provider
 * session ids, or Live View URLs through this surface.
 *
 * Store discipline: locks wrap storage operations only — liveness probes and
 * provider create/close calls always happen outside any lock, with a commit
 * re-check to detect concurrent swaps.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Browser extends LifecycleCapability {
  /** Which browser this is; see {@link BrowserOptions.name}. */
  readonly name: string;
  readonly #options: BrowserOptions;
  readonly #key: string;
  readonly #adapter: BrowserProviderAdapter;
  #store?: ListableBrowserSessionStore;

  constructor(options: BrowserOptions) {
    const name = options.name ?? DEFAULT_BROWSER_NAME;
    super(browserCapabilityId(name));
    if (name.trim() === "") {
      throw new Error("Browser names must be non-empty");
    }
    this.name = name;
    this.#options = options;
    this.#key = namedBrowserSessionKey(name);
    this.#adapter = providerAdapterFor(options.provider);
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

      // Live entry on record — probe it outside any lock. A session started
      // with other internal hostnames counts as lost: its routes can't change.
      const routesMatch =
        existing.internalHosts === this.#adapter.internalHostsSignature;
      const alive =
        routesMatch && (await this.#adapter.isAlive(existing.sessionId));
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
        // The browser died upstream (expired or reclaimed), or has stale
        // routes. Retire the record under this lock, so any resolver that
        // reads it during the replacement window sees the marker and
        // reports restarted: true too.
        await this.#retire(current);
      } finally {
        await lock.release();
      }
      if (!routesMatch) await this.#closeQuietly(existing.sessionId);
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
      if (!(error instanceof BrowserSessionGoneError)) throw error;
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

  /**
   * Start a session on this browser for one run: connects on its first
   * call, resolves `sessionId: "active"` to the scope's tab, and reports
   * what happened to the browser when you close it. `browserTool` opens
   * one per run.
   */
  session(options?: BrowserSessionOptions): BrowserSession {
    return new BrowserSession(this, options);
  }

  #connection(
    resolved: ResolvedBrowser,
    scope: string,
    cdp: CdpConnection,
    entered: { restarted: boolean; activeTargetId?: string }
  ): BrowserConnection {
    const { sessionId } = resolved;
    return {
      name: resolved.name,
      sessionId,
      scope,
      restarted: entered.restarted,
      activeTargetId: entered.activeTargetId,
      cdp,
      setActiveTarget: (targetId) =>
        this.#updateScope(scope, sessionId, targetId),
      targetsInOtherScopes: async () =>
        activeTargets(await this.#listScopes(), scope, sessionId),
      spec: () => this.#adapter.spec(sessionId)
    };
  }

  async #open(resolved: ResolvedBrowser): Promise<CdpConnection> {
    let lastTouchAt = Date.now();
    let touchInFlight = false;
    return this.#adapter.connect(resolved.sessionId, {
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
   * `restarted: true`) and close its provider session. Returns `false` when
   * there was nothing to close.
   *
   * The provider close is best-effort: the retired record is the durable
   * outcome, and a browser whose close failed is unreachable through this
   * store, so the provider reclaims it once idle (Browser Run: after
   * `keepAliveMs`, at most 20 minutes).
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
      await this.#adapter.close(stored.sessionId);
    } catch (error) {
      console.warn(
        `[agents/browser] Failed to close browser session ${stored.sessionId}`,
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
    const view = await this.#adapter.liveView(entry.sessionId, options?.mode);
    if (!view) return undefined;
    // A human is about to look: minting counts as activity. Target listing
    // yields to the network, so a concurrent close or replacement can retire
    // the browser mid-mint — the touch and the retire serialize on the key
    // lock, and a lost touch means the listed targets are already dead:
    // report the browser gone rather than handing out doomed links. Touch
    // *errors* stay best effort — a store blip must not break minting.
    try {
      if (!(await this.#touch(entry.sessionId))) return undefined;
    } catch (error) {
      console.warn(
        `[agents/browser] Failed to refresh activity for browser "${this.name}"`,
        error
      );
    }
    return view;
  }

  // ── Internal hostnames ───────────────────────────────────────────────────

  /**
   * The browser's internal hostnames, or `undefined` when its provider has
   * none. See {@link BrowserInternalHosts}.
   */
  get internalHosts(): BrowserInternalHosts | undefined {
    const config = this.#adapter.internalHosts;
    if (!config) return undefined;
    const hosts = config.hosts as Record<string, AnyInternalHost>;
    const describe = (): InternalHostInfo[] =>
      Object.entries(hosts).map(([host, entry]) => ({
        host,
        url: `http://${host}/`,
        ...(entry.description ? { description: entry.description } : {}),
        assignable: entry.target !== undefined,
        ...(entry.target !== undefined
          ? { targetSchema: targetJsonSchema(host, entry.target) }
          : {})
      }));
    const assignable = (host: string) => {
      const entry = hosts[host];
      if (!entry || !Object.hasOwn(hosts, host)) {
        throw new Error(
          `"${host}" isn't an internal hostname. The hostnames are: ${Object.keys(hosts).join(", ")}`
        );
      }
      if (entry.target === undefined) {
        throw new Error(
          `"${host}" always serves the same thing; it has no target to assign`
        );
      }
      return entry.target;
    };
    return {
      describe,
      list: async () => {
        const assigned = await this.#readAssignments();
        return describe().map((info) =>
          Object.hasOwn(assigned, info.host)
            ? { ...info, target: assigned[info.host] }
            : info
        );
      },
      assign: async (host, target) => {
        const schema = assignable(host);
        if (target === undefined) {
          throw new Error(
            `browser.assignHost needs a target for ${host}; use browser.clearHost to unassign it`
          );
        }
        // Stored as JSON, so check what will be stored.
        const json: unknown = JSON.parse(JSON.stringify(target));
        const checked = await validateTarget(schema, json);
        if (!checked.ok) {
          throw new Error(`Invalid target for ${host}: ${checked.error}`);
        }
        await this.#writeAssignment(host, json);
        return { url: `http://${host}/` };
      },
      clear: async (host) => {
        assignable(host);
        return this.#writeAssignment(host, undefined);
      }
    };
  }

  /**
   * Serve one browser request to an internal hostname. `InternalHostRouter`
   * calls the agent's `fetchInternalHost()` with the message; `Agent` passes
   * it here on its own. A plain Durable Object passes it on itself:
   *
   * ```ts
   * fetchInternalHost(message: InternalHostMessage) {
   *   return this.browser.fetchInternalHost(message);
   * }
   * ```
   *
   * Answers 502 with the reason when this browser doesn't serve the host.
   */
  async fetchInternalHost(message: InternalHostMessage): Promise<Response> {
    if (message.browser !== this.name) {
      return internalHostError(
        502,
        `${message.host} belongs to browser "${message.browser}", but was passed to browser "${this.name}"`
      );
    }
    return this.#serveInternalHost(message.host, message.request);
  }

  /**
   * `Agent.fetchInternalHost()` routes here through Lifecycle, so `Agent`
   * needn't import the browser.
   *
   * @internal Called by Lifecycle; not part of the host API.
   */
  async onRoute(context: LifecycleRouteContext): Promise<unknown> {
    const { payload } = context;
    if (!isInternalHostMessage(payload)) {
      throw new Error(`Browser "${this.name}" got an unknown routed message`);
    }
    return this.fetchInternalHost(payload);
  }

  async #serveInternalHost(host: string, request: Request): Promise<Response> {
    const hosts = this.#adapter.internalHosts?.hosts as
      | Record<string, AnyInternalHost>
      | undefined;
    const entry = hosts && Object.hasOwn(hosts, host) ? hosts[host] : undefined;
    if (!entry?.fetch) {
      return internalHostError(
        502,
        `${host} is no longer an internal hostname of browser "${this.name}"`
      );
    }
    let target: unknown;
    if (entry.target !== undefined) {
      const assigned = await this.#readAssignments();
      if (!Object.hasOwn(assigned, host)) {
        return internalHostError(
          502,
          `${host} isn't pointed anywhere yet. Call browser.assignHost({ host: "${host}", target }) first.`
        );
      }
      // Validate again: the schema may have changed since the assignment.
      const checked = await validateTarget(entry.target, assigned[host]);
      if (!checked.ok) {
        return internalHostError(
          502,
          `${host}'s target no longer matches its schema (${checked.error}). Call browser.assignHost again.`
        );
      }
      target = checked.value;
    }
    const fetch = entry.fetch;
    try {
      const response = await this.lifecycle.runInHostContext(
        () => fetch(request, target),
        { request }
      );
      if (response instanceof Response) return response;
      return internalHostError(
        502,
        `${host}: its fetch didn't return a Response`
      );
    } catch (error) {
      // Logged, not shown: the page on this host can read the response.
      console.error(`[agents/browser] ${host}: its fetch threw`, error);
      return internalHostError(502, `${host}: its fetch failed`);
    }
  }

  /**
   * Which agent and browser the session's routes lead back to. `undefined`
   * without internal hostnames.
   */
  #internalHostOwner(): InternalHostOwner | undefined {
    if (!this.#adapter.internalHosts) return undefined;
    const services = this.lifecycleServices;
    if (!services) {
      throw new Error(
        `Browser "${this.name}" has internal hostnames, which need it installed with Lifecycle.use()`
      );
    }
    if (services.routes.source !== undefined) {
      throw new Error(
        `Browser "${this.name}" has internal hostnames, which sub-agents don't support yet`
      );
    }
    return {
      className: services.className,
      name: services.name,
      browser: this.name
    };
  }

  async #readAssignments(): Promise<Record<string, unknown>> {
    return (
      (await this.lifecycle.storage.get<Record<string, unknown>>(
        internalHostAssignmentsKey(this.name)
      )) ?? {}
    );
  }

  /** Set (or with `undefined`, clear) one host's target. Returns whether it changed. */
  async #writeAssignment(host: string, target: unknown): Promise<boolean> {
    const key = internalHostAssignmentsKey(this.name);
    const lock = await this.#sessionStore.acquireLock(key);
    try {
      const assigned = await this.#readAssignments();
      const had = Object.hasOwn(assigned, host);
      if (target === undefined) {
        if (!had) return false;
        delete assigned[host];
      } else {
        assigned[host] = target;
      }
      await this.lifecycle.storage.put(key, assigned);
      return true;
    } finally {
      await lock.release();
    }
  }

  async #closeQuietly(sessionId: string): Promise<void> {
    try {
      await this.#adapter.close(sessionId);
    } catch (error) {
      console.warn(
        `[agents/browser] Failed to close browser session ${sessionId}`,
        error
      );
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Capped at half the provider's keep-alive window: a browser with
   * continuous CDP traffic must never look older than the window the
   * provider uses to reclaim it.
   */
  get #touchIntervalMs(): number {
    const interval = this.#options.touchIntervalMs ?? SESSION_TOUCH_INTERVAL_MS;
    const { keepAliveMs } = this.#adapter;
    return keepAliveMs === undefined
      ? interval
      : Math.min(interval, Math.floor(keepAliveMs / 2));
  }

  /** Lazy: `lifecycle.storage` exists only once `Lifecycle.use()` ran. */
  get #sessionStore(): ListableBrowserSessionStore {
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

  /** Every scope record of this browser, by scope. */
  async #listScopes(): Promise<Map<string, StoredBrowserSession>> {
    const prefix = browserScopeKeyPrefix(this.name);
    const entries = await this.#sessionStore.list(prefix);
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
   * Set a scope's tab (or clear it with `undefined`). Never resurrects:
   * does nothing (and returns `false`) once the browser this connection
   * resolved was closed or replaced.
   */
  async #updateScope(
    scope: string,
    sessionId: string,
    targetId: string | undefined
  ): Promise<boolean> {
    const key = this.#scopeKey(scope);
    const lock = await this.#sessionStore.acquireLock(this.#scopesLockKey);
    try {
      const current = await this.#sessionStore.get(this.#key);
      const entry = await this.#sessionStore.get(key);
      if (current?.sessionId !== sessionId || entry?.sessionId !== sessionId) {
        return false;
      }
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
   * Create a provider session (outside any lock) and commit it. The adapter
   * applies the provider's creation options. If a concurrent caller
   * committed an entry first, theirs wins and the redundant session is
   * closed best-effort.
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
    const info = await this.#adapter.create({
      owner: this.#internalHostOwner()
    });
    const now = Date.now();
    const signature = this.#adapter.internalHostsSignature;
    const stored: StoredBrowserSession = {
      sessionId: info.sessionId,
      createdAt: now,
      updatedAt: now,
      ...(signature !== undefined ? { internalHosts: signature } : {})
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
        await this.#adapter.close(stored.sessionId);
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to close redundant browser session ${stored.sessionId}`,
          error
        );
      }
      return { session: winner, restarted };
    }
    return { session: stored, restarted };
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
