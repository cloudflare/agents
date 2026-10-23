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
 * `browserTool` opens one per run.
 */

import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import {
  CDP_METHOD_NOT_FOUND,
  CdpProtocolError,
  type CdpConnection
} from "./cdp-connection";
import type { BrowserConnection, BrowserConnectOptions } from "./browser";
import type { SearchableCdpSpec } from "./spec";

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
  report: BrowserSessionReport;
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
 * the run ends. The browser itself stays open.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class BrowserSession {
  readonly #browser: BrowserSource;
  readonly #scope: string | undefined;
  readonly #maxResultBytes: number;
  #state?: ConnectedState;
  #connecting?: Promise<ConnectedState>;
  #closed = false;

  constructor(browser: BrowserSource, options: BrowserSessionOptions = {}) {
    this.#browser = browser;
    this.#scope = options.scope;
    this.#maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
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
   */
  async close(): Promise<BrowserSessionReport | undefined> {
    if (this.#closed) return undefined;
    this.#closed = true;
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
    return state.report;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Connect once. Concurrent first calls share one connect. */
  #connect(): Promise<ConnectedState> {
    if (this.#closed) {
      return Promise.reject(new Error("This browser session is closed."));
    }
    if (this.#state) return Promise.resolve(this.#state);
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
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

const validators = new WeakMap<object, Validator>();

/**
 * Check a method's input against its schema before it touches the browser,
 * so the model gets a precise error. An omitted input counts as `{}`.
 *
 * @internal Also used by `browser-functions.ts`.
 */
export function validate(
  name: string,
  schema: object,
  input: unknown
): unknown {
  let validator = validators.get(schema);
  if (!validator) {
    // SAFETY: The schemas above are draft-7 objects; @cfworker's `Schema`
    // type is only narrower around boolean subschemas, which they don't use.
    validator = new Validator(schema as Schema, "7", false);
    validators.set(schema, validator);
  }
  const value = input ?? {};
  const result = validator.validate(value);
  if (!result.valid) {
    throw new Error(formatValidationError(name, result.errors));
  }
  return value;
}

function formatValidationError(name: string, errors: OutputUnit[]): string {
  // A failing property emits both a generic parent `properties` error and a
  // specific child error. Prefer the latter so the model sees what to fix.
  const specific = errors.filter((error) => error.keyword !== "properties");
  const relevant = specific.length > 0 ? specific : errors;
  const details = relevant.map((error) => {
    const location = error.instanceLocation
      .replace(/^#\/?/, "")
      .replaceAll("~1", "/")
      .replaceAll("~0", "~")
      .replaceAll("/", ".");
    return `${location ? ` at ${location}` : ""}: ${error.error}`;
  });
  return `Invalid arguments for ${name}${details.join(";")}`;
}
