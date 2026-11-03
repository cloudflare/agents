/**
 * `BrowserSession`: one run's connection to a persistent `Browser`, with the
 * rules that make CDP usable from model-written code.
 *
 * The model never manages CDP sessions. `sessionId: "active"` addresses the
 * tab the scope last worked in, `attachToTarget` returns a handle that keeps
 * working in later runs, and common protocol mistakes come back as
 * instructions. When the session closes it saves the scope's active tab and
 * reports what happened to the browser: a restart, a tab closed by someone
 * else, a tab shared with another scope, tabs the page opened.
 *
 * A session opened with `lock: true` holds its scope's lock from its first
 * call (or `lock()`) until it closes; other locking sessions in the scope
 * wait for it, in order.
 *
 * `browserTool` opens one per run.
 */

import {
  CDP_METHOD_NOT_FOUND,
  CdpProtocolError,
  type CdpConnection
} from "./cdp-connection";
import type {
  BrowserConnection,
  BrowserConnectOptions,
  BrowserInternalHosts
} from "./browser";
import {
  browserFunctions,
  type BrowserFunction,
  type SessionHosts
} from "./browser-functions";
import { DEFAULT_BROWSER_SCOPE } from "./scope";
import type { SearchableCdpSpec } from "./spec";
import { validate } from "./validate";

/**
 * What a {@link BrowserSession} connects to. Usually a `Browser` installed on
 * the host's Lifecycle.
 */
export interface BrowserSource {
  /** The browser's name, for log messages. */
  readonly name: string;
  /**
   * Reattach to the browser (or replace it) and open a CDP connection for
   * a scope. A source that ignores `scope` shares one active tab between
   * every caller.
   */
  connect(options?: BrowserConnectOptions): Promise<BrowserConnection>;
  /**
   * The browser's internal hostnames, when it has any. The docs list them,
   * and {@link BrowserSession.functions} adds the hosts functions.
   */
  readonly internalHosts?: BrowserInternalHosts;
}

export interface BrowserSessionOptions {
  /**
   * Who is driving: sessions with the same scope share an active tab, and
   * each scope keeps its own. Cookies and logins are shared by every scope.
   * Defaults to the browser's default scope.
   */
  scope?: string;
  /**
   * The largest `Page.captureScreenshot` result `send` returns, measured as
   * JSON. Defaults to 1,000,000 bytes.
   */
  maxResultBytes?: number;
  /**
   * Lock the scope on this browser: the session takes the scope's lock at
   * its first call (or at {@link BrowserSession.lock}) and holds it until it
   * closes. Other locking sessions in the scope wait for the lock, in order,
   * rather than fail, so their calls never interleave. Sessions without it
   * don't wait and aren't waited for. Locks are per isolate, which is per
   * Durable Object.
   *
   * Use it when several runs in one scope can start together (parallel
   * tool calls, say) and must not see each other's navigation.
   *
   * Only `close()` releases the lock: not aborting a signal, losing the
   * browser, or dropping the session. Close a locking session in `finally`,
   * even when connecting failed, or its scope stays locked until the
   * isolate restarts.
   */
  lock?: boolean;
}

/** {@link BrowserSession.lock}'s options. */
export interface BrowserLockOptions {
  /**
   * Bounds this call's wait: when it aborts, this call rejects with its
   * reason. The session keeps waiting while other calls still are; once
   * none is, it leaves the queue at once, so it doesn't hold up the
   * sessions behind it. A call without a signal, including the wait a
   * session's first function call makes, never gives up. The signal does
   * nothing once the lock is held: only `close()` releases it.
   */
  signal?: AbortSignal;
}

/** `send`'s input. */
export interface BrowserSendInput {
  /** CDP method, e.g. `"Page.navigate"`. */
  method: string;
  /** CDP command parameters. */
  params?: Record<string, unknown>;
  /**
   * `"active"` for the current tab, or a handle from `attachToTarget`. Omit
   * for `Browser.*` and `Target.*` commands.
   */
  sessionId?: string;
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
}

/** `attachToTarget`'s input. */
export interface BrowserAttachInput {
  /** Target id from `Target.getTargets` or `Target.createTarget`. */
  targetId: string;
  timeoutMs?: number;
}

/** `getDebugLog`'s input. */
export interface BrowserDebugLogInput {
  /** Most entries to return, newest last. Defaults to 50; 400 are kept. */
  limit?: number;
}

/** A tab a page opened on its own during a session. */
export interface BrowserNewTab {
  targetId: string;
  url?: string;
  title?: string;
}

/**
 * What happened to the browser during one session, beyond the results of its
 * calls. {@link BrowserSession.close} returns it.
 */
export interface BrowserSessionReport {
  /** The browser was replaced before this session; earlier page state is gone. */
  restarted: boolean;
  /** Tabs the page opened itself (popups, `target=_blank`). */
  newTabs: BrowserNewTab[];
  /**
   * The tab this scope was working in was closed by someone else (another
   * scope, or a person in Live View), so `"active"` will be a new blank tab.
   */
  tabClosed: boolean;
  /** Another scope is working in this scope's active tab too. */
  tabShared: boolean;
  /**
   * The report as sentences for the model, one per thing that happened,
   * empty when nothing did. Show them after the run's result.
   */
  notices: string[];
}

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser — navigate again before relying on page state.";

const TAB_CLOSED_NOTICE =
  'The tab you were working in was closed (by another conversation using this browser, or a person). `sessionId: "active"` now opens a blank tab — navigate again before relying on page state.';

const TAB_SHARED_NOTICE =
  "Another conversation using this browser is also working in your tab, so its page may change between your runs. Open a tab of your own with Target.createTarget if you need one.";

/** What the report says, in sentences the model reads. */
function reportNotices(report: Omit<BrowserSessionReport, "notices">) {
  return [
    report.restarted && RESTARTED_NOTICE,
    report.tabClosed && !report.restarted && TAB_CLOSED_NOTICE,
    report.tabShared && TAB_SHARED_NOTICE,
    report.newTabs.length > 0 &&
      `New tabs opened by the page: ${JSON.stringify(report.newTabs)}`
  ].filter((notice) => typeof notice === "string");
}

/** One waiter in a {@link LockQueue}. */
interface LockWaiter {
  grant(): void;
}

/**
 * Who holds a scope's lock, and who waits for it, in order. A waiter that
 * gives up is removed at once, so nobody behind it waits on it.
 */
class LockQueue {
  #held = false;
  readonly #waiting: LockWaiter[] = [];

  readonly #onIdle: () => void;

  /** `onIdle` runs when the lock is freed with nobody waiting. */
  constructor(onIdle: () => void) {
    this.#onIdle = onIdle;
  }

  /** Resolve once this caller holds the lock. */
  take(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      if (!this.#held && this.#waiting.length === 0) this.#onIdle();
      return Promise.reject(signal.reason);
    }
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: LockWaiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }
      };
      this.#waiting.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Hand the lock to the next waiter, or free the scope. */
  release(): void {
    const next = this.#waiting.shift();
    if (next) {
      next.grant();
      return;
    }
    this.#held = false;
    this.#onIdle();
  }
}

/**
 * The lock queues per browser and scope. Keyed by the source, so custom
 * sources lock too, and dropped with it.
 */
const lockQueues = new WeakMap<BrowserSource, Map<string, LockQueue>>();

/**
 * The scopes with a lock queue on `browser`: held, or waited for.
 *
 * @internal For tests that check queues are cleaned up.
 */
export function lockedScopes(browser: BrowserSource): string[] {
  return [...(lockQueues.get(browser)?.keys() ?? [])];
}

/**
 * One session's wait for its lock, shared by its concurrent `lock()` calls.
 * It gives up only when every call waiting on it has: none waits without a
 * signal, and every signal has aborted.
 */
interface LockAcquisition {
  promise: Promise<void>;
  /** Calls with a signal that are still waiting. */
  bounded: number;
  /** A call without a signal is waiting, so the wait never gives up. */
  unbounded: boolean;
  giveUp: AbortController;
}

function lockQueue(browser: BrowserSource, scope: string): LockQueue {
  let queues = lockQueues.get(browser);
  if (!queues) lockQueues.set(browser, (queues = new Map()));
  let queue = queues.get(scope);
  if (!queue) {
    const scopes = queues;
    queue = new LockQueue(() => scopes.delete(scope));
    queues.set(scope, queue);
  }
  return queue;
}

/** `sessionId` value that addresses the tab the agent is working in. */
export const ACTIVE_PAGE_SESSION = "active";

/**
 * `attachToTarget` returns `{ sessionId: "target:<targetId>" }`, a stable
 * handle rather than a connection-scoped CDP session id, so it keeps working
 * in later runs. `send` resolves it on the live socket.
 */
const ATTACH_HANDLE_PREFIX = "target:";

/** Chrome's JSON-RPC code for a CDP session id it doesn't know. */
const CDP_SESSION_NOT_FOUND = -32001;

/**
 * Screenshots are kept whole in the chat message for the UI, and a stored
 * message must fit SQLite's 2 MB row (see `ROW_MAX_BYTES` in chat/sanitize.ts),
 * or the image is compacted away. Failing early lets the model retake it
 * smaller. Other results are cut to a preview before they're stored.
 *
 * @internal The tools also refuse to keep a returned screenshot over it.
 */
export const DEFAULT_MAX_RESULT_BYTES = 1_000_000;

/** `#liveParams`: nothing to detach. */
const DETACHED = Symbol("detached");

const MANAGED_BROWSER =
  "this browser is managed for you and persists between runs. To close a " +
  "tab, send Target.closeTarget with its targetId.";
const HOST_ONLY = "it is for the host, not your code.";
const NO_TUNNELING =
  "send each command with browser.cdp instead, passing sessionId to reach a tab.";

/**
 * Commands model code can't send, and why.
 *
 * - Ending the browser: the host owns its lifetime, so the model can't close
 *   it out from under the agent (and lose its logins).
 * - Live View and handoff: a Live View link controls the whole browser, so it
 *   goes to a trusted person through `Browser.liveView()`, never to the model.
 * - Tunnels: these carry raw protocol messages past this check.
 */
const REFUSED_COMMANDS = new Map([
  ["Browser.close", MANAGED_BROWSER],
  ["Browser.crash", MANAGED_BROWSER],
  ["Browser.crashGpuProcess", MANAGED_BROWSER],
  ["Cloudflare.getLiveView", HOST_ONLY],
  ["Cloudflare.handoff", HOST_ONLY],
  ["Target.sendMessageToTarget", NO_TUNNELING],
  ["Target.exposeDevToolsProtocol", NO_TUNNELING]
]);

/** A CDP target id: for this session, a tab. */
type TargetId = string & { readonly __brand: "TargetId" };

/** A CDP session id from `Target.attachToTarget`, valid on one socket only. */
type LiveSessionId = string & { readonly __brand: "LiveSessionId" };

/** The stable `sessionId` handle `attachToTarget` gives the model. */
type AttachHandle = `${typeof ATTACH_HANDLE_PREFIX}${string}`;

interface TargetInfo {
  targetId: TargetId;
  type: string;
  url?: string;
  title?: string;
  /** The tab that opened this one (popups, `target=_blank` links). */
  openerId?: TargetId;
}

/** The session's connection and what it learned. Dropped when it closes. */
interface ConnectedState {
  connected: BrowserConnection;
  /** Live CDP session per target, valid on this socket only. */
  attached: Map<TargetId, LiveSessionId>;
  /**
   * Tabs this session attached to, through `attachToTarget` or a raw
   * `Target.attachToTarget`. Their popups are this session's new tabs.
   */
  workedIn: Set<TargetId>;
  /** Page targets open when the session connected. */
  initialPages: Set<TargetId>;
  /** The tab `"active"` resolves to, decided on first use. */
  activeTargetId?: TargetId;
  /** Whether {@link activeTargetId} was decided (vs. never needed). */
  activeResolved: boolean;
  /** Tabs this session closed with `Target.closeTarget`. */
  closed: Set<TargetId>;
  report: Omit<BrowserSessionReport, "notices">;
}

const SEND_SCHEMA = {
  type: "object",
  properties: {
    method: { type: "string", minLength: 1 },
    params: { type: "object" },
    sessionId: { type: "string" },
    timeoutMs: { type: "number", exclusiveMinimum: 0 }
  },
  required: ["method"]
} as const;

const ATTACH_SCHEMA = {
  type: "object",
  properties: {
    targetId: { type: "string", minLength: 1 },
    timeoutMs: { type: "number", exclusiveMinimum: 0 }
  },
  required: ["targetId"]
} as const;

const DEBUG_LOG_SCHEMA = {
  type: "object",
  properties: { limit: { type: "number", minimum: 1 } }
} as const;

/**
 * One run's connection to a persistent browser, for one scope.
 *
 * It connects on its first call and stays connected until {@link close}.
 * Concurrent first calls share one connect. Every method takes one options
 * object, validated before anything touches the browser, because the input
 * usually comes from model-written code.
 *
 * Create one per run with `browser.session({ scope })`, and close it when
 * the run ends. The browser itself stays open. Pass `lock: true` when
 * runs in one scope may overlap; see {@link BrowserSessionOptions.lock}.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class BrowserSession {
  readonly #browser: BrowserSource;
  readonly #scope: string | undefined;
  readonly #maxResultBytes: number;
  readonly #locksScope: boolean;
  #state?: ConnectedState;
  #connecting?: Promise<ConnectedState>;
  #closed = false;
  #functions?: Readonly<Record<string, BrowserFunction>>;
  /** The wait for the lock, until it settles. */
  #acquiring?: LockAcquisition;
  /** The queue this session holds the lock in, until it closes. */
  #heldLock?: LockQueue;
  /** Aborts this session's wait for the lock when it closes. */
  readonly #closing = new AbortController();
  #waitedForLockMs = 0;

  constructor(browser: BrowserSource, options: BrowserSessionOptions = {}) {
    this.#browser = browser;
    this.#scope = options.scope;
    this.#maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.#locksScope = options.lock ?? false;
  }

  /**
   * The `browser.*` functions bound to this session, by name: the ones
   * `Browser.functionDocs()` describes. Each takes one input object and
   * validates it, so model-written code can call them directly. Like the
   * session's methods, every one rejects once the session is closed, and
   * waits for the scope's lock when the session locks.
   */
  get functions(): Readonly<Record<string, BrowserFunction>> {
    this.#functions ??= Object.freeze(
      browserFunctions(this, this.#sessionHosts())
    );
    return this.#functions;
  }

  /**
   * Take this scope's lock now rather than at the first call, and hold it
   * until {@link close}. For sessions opened with `lock: true`; a
   * caller with its own time limit calls it first, so the wait doesn't count
   * against the limit, or passes `signal` to bound the wait.
   *
   * Resolves once the session holds the lock, after the locking sessions
   * ahead of it close; later and concurrent calls resolve with the same
   * lock. Rejects when the session closes while waiting. Each call's
   * `signal` bounds only that call's wait: it rejects with the signal's
   * reason, and the session leaves the queue once no call is still
   * waiting (see {@link BrowserLockOptions.signal}); a later call or first
   * call waits again.
   */
  lock(options: BrowserLockOptions = {}): Promise<void> {
    if (!this.#locksScope) {
      return Promise.reject(
        new Error(
          "This browser session doesn't lock its scope. Open it with { lock: true }."
        )
      );
    }
    if (this.#closed) {
      return Promise.reject(new Error("This browser session is closed."));
    }
    if (this.#heldLock) return Promise.resolve();
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const acquisition = (this.#acquiring ??= this.#acquire());
    if (acquisition.giveUp.signal.aborted) {
      // Every earlier call gave up and the wait is ending: wait again once
      // it has, unless it got the lock first.
      return acquisition.promise.then(
        () => undefined,
        () => this.lock(options)
      );
    }
    if (!signal) {
      acquisition.unbounded = true;
      return acquisition.promise;
    }
    acquisition.bounded++;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        acquisition.bounded--;
        if (acquisition.bounded === 0 && !acquisition.unbounded) {
          acquisition.giveUp.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      acquisition.promise.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  /**
   * How long this session waited for its lock, in milliseconds: `0` until
   * it has waited, and for sessions that don't lock.
   */
  get waitedForLockMs(): number {
    return this.#waitedForLockMs;
  }

  /**
   * Send a CDP command and resolve with its result, without the JSON-RPC
   * envelope. `sessionId: "active"` runs it in the scope's tab.
   */
  async send(input: BrowserSendInput): Promise<unknown> {
    const { method, params, sessionId, timeoutMs } = validate(
      "browser.cdp",
      SEND_SCHEMA,
      input
    ) as BrowserSendInput;
    const refused = REFUSED_COMMANDS.get(method);
    if (refused) throw new Error(`${method} is not available: ${refused}`);
    const state = await this.#connect();
    const live = await this.#resolveSessionId(state, sessionId);
    const liveParams = this.#liveParams(state, method, params);
    if (liveParams === DETACHED) return {};
    let result: unknown;
    try {
      result = await state.connected.cdp.send(method, liveParams, {
        sessionId: live,
        timeoutMs
      });
    } catch (error) {
      throw await this.#teach(state, error, method, sessionId);
    }
    this.#observe(state, method, liveParams, result);
    if (method === "Page.captureScreenshot") this.#assertFits(result);
    return result;
  }

  /**
   * Make an open tab the scope's active tab, and resolve with a `sessionId`
   * handle for it that keeps working in later runs.
   */
  async attachToTarget(
    input: BrowserAttachInput
  ): Promise<{ sessionId: string }> {
    const { targetId, timeoutMs } = validate(
      "browser.attachToTarget",
      ATTACH_SCHEMA,
      input
    ) as BrowserAttachInput;
    const state = await this.#connect();
    // SAFETY: Chrome rejects a target id it doesn't know.
    const target = targetId as TargetId;
    await this.#attach(state, target, timeoutMs);
    this.#setActive(state, target);
    return { sessionId: attachHandle(target) };
  }

  /** The Chrome DevTools Protocol description the browser serves. */
  async spec(): Promise<SearchableCdpSpec> {
    return (await this.#connect()).connected.spec();
  }

  /** Recent CDP traffic on this session's connection, newest last. */
  async getDebugLog(input?: BrowserDebugLogInput): Promise<unknown[]> {
    const { limit } = validate(
      "browser.getDebugLog",
      DEBUG_LOG_SCHEMA,
      input
    ) as BrowserDebugLogInput;
    return (await this.#connect()).connected.cdp.getDebugLog(limit);
  }

  /** Forget the CDP traffic recorded so far. */
  async clearDebugLog(): Promise<null> {
    (await this.#connect()).connected.cdp.clearDebugLog();
    return null;
  }

  /**
   * End the session: save the scope's active tab, work out what happened to
   * the browser, and close the connection. The browser stays open.
   *
   * Resolves with the report, or `undefined` when the session never
   * connected. Never rejects: failures to read the browser's state are
   * logged and leave the report incomplete. Later calls resolve with
   * `undefined`, and other methods reject.
   *
   * A locking session releases the lock once the active tab is saved, or
   * stops waiting for it if it was still waiting.
   */
  async close(): Promise<BrowserSessionReport | undefined> {
    if (this.#closed) return undefined;
    this.#closed = true;
    // Stop waiting for the lock, if this session is.
    this.#closing.abort(new Error("This browser session is closed."));
    try {
      let state: ConnectedState | undefined;
      try {
        state = this.#state ?? (await this.#connecting);
      } catch {
        return undefined; // the connect failed; its caller got the error
      }
      if (!state) return undefined;
      this.#state = undefined;
      try {
        const open = await this.#recordNewTabs(state);
        const active = await this.#saveActiveTarget(state, open);
        if (active && state.activeResolved) {
          await this.#recordSharedTab(state, active);
        }
      } finally {
        state.connected.cdp.disconnect();
      }
      return { ...state.report, notices: reportNotices(state.report) };
    } finally {
      // Release the lock only after the active tab is saved, so the next
      // session in the scope finds where this one left off.
      await this.#acquiring?.promise.catch(() => undefined);
      this.#heldLock?.release();
      this.#heldLock = undefined;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Connect once, after taking the lock if this session locks its scope.
   * Concurrent first calls share one connect.
   */
  #connect(): Promise<ConnectedState> {
    if (this.#closed) {
      return Promise.reject(new Error("This browser session is closed."));
    }
    if (this.#state) return Promise.resolve(this.#state);
    this.#connecting ??= this.#admitThenOpen().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  /** The browser's internal hosts, behind this session's admission check. */
  #sessionHosts(): SessionHosts | undefined {
    const hosts = this.#browser.internalHosts;
    return hosts && { hosts, admit: () => this.#admit() };
  }

  async #admitThenOpen(): Promise<ConnectedState> {
    await this.#admit();
    return this.#open();
  }

  /**
   * The check every function makes before it touches the browser: reject
   * once the session is closed, and wait for the lock when the session
   * locks. It doesn't connect.
   */
  async #admit(): Promise<void> {
    if (this.#closed) throw new Error("This browser session is closed.");
    if (!this.#locksScope) return;
    await this.lock();
    if (this.#closed) throw new Error("This browser session is closed.");
  }

  /** Start waiting for the lock, given up when its calls do or on close. */
  #acquire(): LockAcquisition {
    const giveUp = new AbortController();
    const promise: Promise<void> = this.#waitForLock(
      AbortSignal.any([giveUp.signal, this.#closing.signal])
    ).finally(() => {
      if (this.#acquiring?.promise === promise) this.#acquiring = undefined;
    });
    // Callers get the error; this keeps a wait nobody awaits from going
    // unhandled.
    promise.catch(() => undefined);
    return { promise, bounded: 0, unbounded: false, giveUp };
  }

  async #waitForLock(signal: AbortSignal): Promise<void> {
    // Before the queue exists, so a wait given up at once leaves none.
    signal.throwIfAborted();
    const queue = lockQueue(
      this.#browser,
      this.#scope ?? DEFAULT_BROWSER_SCOPE
    );
    const started = Date.now();
    try {
      await queue.take(signal);
      this.#heldLock = queue;
    } finally {
      this.#waitedForLockMs += Date.now() - started;
    }
  }

  async #open(): Promise<ConnectedState> {
    const connected = await this.#browser.connect(
      this.#scope === undefined ? undefined : { scope: this.#scope }
    );
    let initialPages: TargetInfo[];
    try {
      initialPages = await this.#pages(connected.cdp);
    } catch (error) {
      connected.cdp.disconnect();
      throw error;
    }
    const state: ConnectedState = {
      connected,
      attached: new Map(),
      workedIn: new Set(),
      initialPages: new Set(initialPages.map((page) => page.targetId)),
      activeResolved: false,
      closed: new Set(),
      report: {
        restarted: connected.restarted,
        newTabs: [],
        tabClosed: false,
        tabShared: false
      }
    };
    if (this.#closed) {
      // Closed while connecting: close() is waiting on this state.
      return state;
    }
    this.#state = state;
    return state;
  }

  /**
   * A screenshot over the limit is too big to keep in the chat message
   * (see `DEFAULT_MAX_RESULT_BYTES`), so fail with how to take a smaller one.
   */
  #assertFits(result: unknown): void {
    // Measure the result as JSON, not just the data, so a screenshot just
    // under the limit can't slip past with its JSON framing.
    const size = JSON.stringify(result ?? null).length;
    if (size <= this.#maxResultBytes) return;
    const megabytes = (size / 1_000_000).toFixed(1);
    const limit = (this.#maxResultBytes / 1_000_000).toFixed(0);
    throw new Error(
      `The screenshot result is ${megabytes} MB, over the ${limit} MB limit on a ` +
        `send result. Capture just the viewport (no captureBeyondViewport ` +
        `or clip larger than the window), or pass format: "jpeg" with ` +
        `quality: 60.`
    );
  }

  /**
   * Add tabs the page opened during this session to the report. Returns the
   * open tabs, or `undefined` when the browser couldn't be asked.
   */
  async #recordNewTabs(
    state: ConnectedState
  ): Promise<Set<TargetId> | undefined> {
    let pages: TargetInfo[];
    try {
      pages = await this.#pages(state.connected.cdp);
    } catch (error) {
      this.#warn("list the open tabs", error);
      return undefined;
    }
    const opened = new Set<string>();
    // A new tab is this session's when its opener is a tab this session
    // worked in, or another of its new tabs (a popup's popup). Chrome sets
    // openerId only on tabs a page opened, never on Target.createTarget
    // tabs, and a popup another scope's page opened meanwhile has that
    // scope's tab as its opener.
    let grew = true;
    while (grew) {
      grew = false;
      for (const page of pages) {
        const opener = page.openerId;
        if (
          !opener ||
          opened.has(page.targetId) ||
          state.initialPages.has(page.targetId)
        ) {
          continue;
        }
        if (state.workedIn.has(opener) || opened.has(opener)) {
          opened.add(page.targetId);
          grew = true;
        }
      }
    }
    state.report.newTabs = pages
      .filter((page) => opened.has(page.targetId))
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
    return new Set(pages.map((page) => page.targetId));
  }

  /**
   * Save the tab this session settled on, forgetting one that has since
   * closed, and return it. Without the list of open tabs, save the choice
   * unchecked: the next session checks the stored tab is still open before
   * using it.
   */
  async #saveActiveTarget(
    state: ConnectedState,
    open: Set<TargetId> | undefined
  ): Promise<TargetId | undefined> {
    const stored = state.connected.activeTargetId as TargetId | undefined;
    // A session that never used "active" still sees the stored tab is gone;
    // say so now, since the next session won't know there was one.
    if (
      !state.activeResolved &&
      stored &&
      open &&
      !open.has(stored) &&
      !state.closed.has(stored)
    ) {
      state.report.tabClosed = true;
    }
    const candidate = state.activeResolved ? state.activeTargetId : stored;
    const active =
      candidate && (!open || open.has(candidate)) ? candidate : undefined;
    if (active === stored) return active;
    try {
      await state.connected.setActiveTarget(active);
    } catch (error) {
      this.#warn("save the active tab", error);
    }
    return active;
  }

  /** Report when another scope is working in this session's tab too. */
  async #recordSharedTab(
    state: ConnectedState,
    active: TargetId
  ): Promise<void> {
    try {
      const others = await state.connected.targetsInOtherScopes();
      if (others.has(active)) state.report.tabShared = true;
    } catch (error) {
      this.#warn("check whether the active tab is shared", error);
    }
  }

  #warn(action: string, error: unknown): void {
    console.warn(
      `[agents/browser] Failed to ${action} for browser "${this.#browser.name}"`,
      error
    );
  }

  async #pages(cdp: CdpConnection): Promise<TargetInfo[]> {
    const result = (await cdp.send("Target.getTargets")) as {
      targetInfos?: TargetInfo[];
    };
    return (result?.targetInfos ?? []).filter((info) => info.type === "page");
  }

  async #resolveSessionId(
    state: ConnectedState,
    sessionId: string | undefined
  ): Promise<LiveSessionId | undefined> {
    if (sessionId === ACTIVE_PAGE_SESSION) {
      return this.#attach(state, await this.#activeTarget(state));
    }
    if (isAttachHandle(sessionId)) {
      return this.#attach(state, targetOfHandle(sessionId));
    }
    // Omitted, or a raw CDP session id the model got from send().
    return sessionId as LiveSessionId | undefined;
  }

  /**
   * Decide which tab `"active"` means, once per session: the scope's stored
   * tab if it is still open, else a new blank tab. Never a tab the scope
   * didn't open, even a blank one: it may be another scope's, or a popup.
   */
  async #activeTarget(state: ConnectedState): Promise<TargetId> {
    if (state.activeTargetId) return state.activeTargetId;
    const { connected } = state;
    const pages = await this.#pages(connected.cdp);
    const stored = connected.activeTargetId as TargetId | undefined;
    let targetId = pages.find((page) => page.targetId === stored)?.targetId;
    if (!targetId && stored && !state.closed.has(stored)) {
      state.report.tabClosed = true;
    }
    if (!targetId) {
      const created = (await connected.cdp.send("Target.createTarget", {
        url: "about:blank"
      })) as { targetId: TargetId };
      targetId = created.targetId;
    }
    this.#setActive(state, targetId);
    return targetId;
  }

  #setActive(state: ConnectedState, targetId: TargetId | undefined): void {
    state.activeTargetId = targetId;
    state.activeResolved = true;
  }

  async #attach(
    state: ConnectedState,
    targetId: TargetId,
    timeoutMs?: number
  ): Promise<LiveSessionId> {
    const existing = state.attached.get(targetId);
    if (existing) return existing;
    const live = (await state.connected.cdp.attachToTarget(targetId, {
      timeoutMs
    })) as LiveSessionId;
    state.attached.set(targetId, live);
    state.workedIn.add(targetId);
    return live;
  }

  /** Track tab changes the model makes through raw Target commands. */
  #observe(
    state: ConnectedState,
    method: string,
    params: Record<string, unknown> | undefined,
    result: unknown
  ): void {
    const targetId =
      typeof params?.targetId === "string"
        ? (params.targetId as TargetId)
        : undefined;
    if (method === "Target.createTarget") {
      const created = (result as { targetId?: unknown } | undefined)?.targetId;
      if (typeof created === "string") {
        this.#setActive(state, created as TargetId);
      }
    } else if (method === "Target.attachToTarget" && targetId) {
      this.#setActive(state, targetId);
      state.workedIn.add(targetId);
    } else if (method === "Target.closeTarget" && targetId) {
      state.attached.delete(targetId);
      state.closed.add(targetId);
      // The next "active" use picks a tab afresh.
      if (state.activeTargetId === targetId) state.activeTargetId = undefined;
    } else if (method === "Target.detachFromTarget") {
      // Forget a session the model detached, so the next use reattaches.
      for (const [target, live] of state.attached) {
        if (target === targetId || live === params?.sessionId) {
          state.attached.delete(target);
        }
      }
    }
  }

  /**
   * Swap a handle in `Target.detachFromTarget`'s `sessionId` param for the
   * live CDP session id. Returns {@link DETACHED} when the handle's tab isn't
   * attached on this socket, so there is nothing to detach.
   */
  #liveParams(
    state: ConnectedState,
    method: string,
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined | typeof DETACHED {
    const handle = params?.sessionId;
    if (method !== "Target.detachFromTarget" || typeof handle !== "string") {
      return params;
    }
    if (!isAttachHandle(handle)) return params;
    const live = state.attached.get(targetOfHandle(handle));
    return live ? { ...params, sessionId: live } : DETACHED;
  }

  /**
   * Turn the common protocol mistakes into instructions: an expired CDP
   * session id, an event sent as a command, and a page-scoped command
   * without a session.
   */
  async #teach(
    state: ConnectedState,
    error: unknown,
    method: string,
    sessionId: string | undefined
  ): Promise<unknown> {
    if (!(error instanceof CdpProtocolError)) return error;
    if (
      error.code === CDP_SESSION_NOT_FOUND &&
      sessionId &&
      sessionId !== ACTIVE_PAGE_SESSION &&
      !isAttachHandle(sessionId)
    ) {
      return new Error(
        `${error.message}. CDP session ids don't carry over between runs. ` +
          `Use sessionId: "active" for the current tab, or the handle from ` +
          `browser.attachToTarget({ targetId }) for another tab.`
      );
    }
    if (error.code !== CDP_METHOD_NOT_FOUND) return error;
    if (await this.#isEvent(state, method)) {
      return new Error(
        `${error.message}. '${method}' is a CDP *event*, not a command, so it ` +
          `cannot be sent. To wait for page state, poll instead (e.g. ` +
          `Runtime.evaluate of document.readyState until "complete").`
      );
    }
    if (!sessionId) {
      return new Error(
        `${error.message}. '${method}' is page-scoped: pass sessionId: ` +
          `"active" to run it in the current tab: ` +
          `browser.cdp({ method: "${method}", params, sessionId: "active" }).`
      );
    }
    return error;
  }

  async #isEvent(state: ConnectedState, method: string): Promise<boolean> {
    try {
      const spec = await state.connected.spec();
      const domain = method.split(".")[0];
      return spec.domains.some(
        (d) => d.name === domain && d.events.some((e) => e.event === method)
      );
    } catch {
      return false;
    }
  }
}

function attachHandle(targetId: TargetId): AttachHandle {
  return `${ATTACH_HANDLE_PREFIX}${targetId}`;
}

function isAttachHandle(
  sessionId: string | undefined
): sessionId is AttachHandle {
  return sessionId?.startsWith(ATTACH_HANDLE_PREFIX) ?? false;
}

function targetOfHandle(handle: AttachHandle): TargetId {
  return handle.slice(ATTACH_HANDLE_PREFIX.length) as TargetId;
}
