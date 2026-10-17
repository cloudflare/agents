/**
 * The CDP logic behind a persistent browser's code tools, with no runtime
 * attached: `browserTool` reaches it as the `cdp` global, and the
 * `ws:browser` module for `@cloudflare/computer` reaches it as imports.
 * Internal — not an entry point.
 */
import { validateArgs } from "./connector-validation";
import {
  CDP_METHOD_NOT_FOUND,
  CdpProtocolError,
  type CdpConnection
} from "./cdp-connection";
import type { BrowserConnection, BrowserConnectOptions } from "./browser";

/**
 * Where a {@link BrowserSessionDriver} gets its browser. Usually a
 * `Browser` installed on the host's Lifecycle.
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
  /** The persistent browser this connector drives. */
  browser: BrowserSource;
  /**
   * The scope this connector's executions work in: they share one active
   * tab, kept apart from other scopes'. Defaults to the browser's default
   * scope.
   */
  scope?: string;
}

/** A tab a page opened on its own during an execution. */
export interface BrowserNewTab {
  targetId: string;
  url?: string;
  title?: string;
}

/**
 * What happened to the browser during one execution, beyond the code's own
 * result. Read after the run with {@link BrowserSessionDriver.takeReport}.
 */
export interface BrowserExecutionReport {
  /** The browser was replaced before this run; earlier page state is gone. */
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
 * `cdp.attachToTarget` returns `{ sessionId: "target:<targetId>" }` — a
 * stable handle rather than a connection-scoped CDP session id, so replayed
 * code computes identical arguments. `send` resolves it on the live socket.
 */
const ATTACH_HANDLE_PREFIX = "target:";

/** Chrome's JSON-RPC code for a CDP session id it doesn't know. */
const CDP_SESSION_NOT_FOUND = -32001;

/** The default size limit on one `send` result. */
export const DEFAULT_MAX_SEND_RESULT_BYTES = 1_000_000;

/** {@link BrowserSessionDriver} `#liveParams`: nothing to detach. */
const DETACHED = Symbol("detached");

/** Reports awaiting their tool call; bounded in case a caller never reads. */
const MAX_PENDING_REPORTS = 100;

/**
 * Commands that would end the browser. The host owns its lifetime, so the
 * model can't close it out from under the agent (and lose its logins).
 */
const BROWSER_LIFETIME_COMMANDS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess"
]);

/** A CDP target id — for this connector, a tab. */
type TargetId = string & { readonly __brand: "TargetId" };

/** A CDP session id from `Target.attachToTarget`, valid on one socket only. */
type LiveSessionId = string & { readonly __brand: "LiveSessionId" };

/** The stable `sessionId` handle `cdp.attachToTarget` gives the model. */
type AttachHandle = `${typeof ATTACH_HANDLE_PREFIX}${string}`;

interface TargetInfo {
  targetId: TargetId;
  type: string;
  url?: string;
  title?: string;
  /** The tab that opened this one (popups, `target=_blank` links). */
  openerId?: TargetId;
}

/** Per-execution state for one pass. Dropped when the pass ends. */
interface ExecutionState {
  executionId: string;
  connected: BrowserConnection;
  /** Live CDP session per target, valid on this socket only. */
  attached: Map<TargetId, LiveSessionId>;
  /**
   * Tabs this pass attached to, through the connector or a raw
   * `Target.attachToTarget`. Their popups are this pass's new tabs.
   */
  workedIn: Set<TargetId>;
  /** Page targets open when the pass connected. */
  initialPages: Set<TargetId>;
  /** The tab `"active"` resolves to — decided lazily on first use. */
  activeTargetId?: TargetId;
  /** Whether {@link activeTargetId} was decided (vs. never needed). */
  activeResolved: boolean;
  /** Tabs this pass closed with `Target.closeTarget`. */
  closed: Set<TargetId>;
}

/**
 * How to use the `cdp` connector, one rule per line. `codemode.describe("cdp")`
 * returns these, and `browserTool` puts them in its description. Each rule
 * fixes a mistake models make with CDP, or states something about this
 * browser they can't know; leave out what a model knows already.
 */
export const BROWSER_INSTRUCTIONS = browserInstructions("cdp");

/**
 * The rules in {@link BROWSER_INSTRUCTIONS}, worded for where the model
 * meets the browser: the `cdp` global of `browserTool`, whose result
 * carries the browser report, or the `ws:browser` module, whose report is
 * written to standard error.
 */
export function browserInstructions(surface: "cdp" | "module"): string {
  const cdp = surface === "cdp";
  const call = cdp ? "cdp." : "";
  return [
    "The browser persists between runs: tabs, cookies, and logins are still there next time. You never start or close it.",
    `If the browser was replaced (idle timeout, crash), ${cdp ? "the result says restarted: true" : "standard error says so"} and earlier tabs and logins are gone. Before an action that matters (submitting a form, a purchase), check you're on the page you expect.`,
    'Page-scoped commands (Page.*, Runtime.*, DOM.*, Input.*, Network.*, Emulation.*) need sessionId: "active", your tab, which is remembered between runs. Browser.* and Target.* commands take no sessionId.',
    "Other open tabs (Target.getTargets) may belong to other conversations using this browser: don't close, navigate, or attach to a tab you didn't open unless the user asks.",
    `Target.createTarget opens a tab and makes it active. To switch to another open tab, call ${call}attachToTarget({ targetId }); the sessionId it returns keeps working in later runs, while one from a raw Target.attachToTarget only works in the current run.`,
    `Tabs a page opens itself (popups, target=_blank links) don't become active; ${cdp ? "the result lists them as newTabs" : "standard error lists them"}.`,
    "Runtime.evaluate: pass returnByValue: true, or objects come back as a remote reference with no value, and awaitPromise: true for async expressions. The value is at result.value. A thrown error doesn't reject: check exceptionDetails.",
    "Page.navigate returns before the page loads and doesn't throw when it fails: check errorText, then poll document.readyState with Runtime.evaluate until it is 'complete'.",
    cdp
      ? "Pick out what you need inside Runtime.evaluate and return only that. Results over about 24,000 characters are cut short, and a single cdp.send result over 1 MB (a full-page screenshot, say) fails the run."
      : "Pick out what you need inside Runtime.evaluate and return only that. A single send result over 1 MB (a full-page screenshot, say) fails the call."
  ].join("\n");
}

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser — navigate again before relying on page state.";

const TAB_CLOSED_NOTICE =
  'The tab you were working in was closed (by another conversation using this browser, or a person). `sessionId: "active"` now opens a blank tab — navigate again before relying on page state.';

const TAB_SHARED_NOTICE =
  "Another conversation using this browser is also working in your tab, so its page may change between your runs. Open a tab of your own with Target.createTarget if you need one.";

/**
 * Sentences telling the model what happened to its browser during a run:
 * it was restarted, its tab was closed by someone else, or another scope
 * is working in its tab too.
 */
export function browserReportNotices(report: BrowserExecutionReport): string[] {
  return [
    report.restarted && RESTARTED_NOTICE,
    report.tabClosed && !report.restarted && TAB_CLOSED_NOTICE,
    report.tabShared && TAB_SHARED_NOTICE
  ].filter((notice) => typeof notice === "string");
}

/** One call a {@link BrowserSessionDriver} answers. */
export interface BrowserFunctionDefinition {
  description: string;
  /** A draft-7 JSON Schema for the call's single argument. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** The calls a {@link BrowserSessionDriver} answers, as code sees them. */
export const BROWSER_FUNCTIONS = {
  send: {
    description:
      'Send a CDP command and return its method result directly. Pass sessionId: "active" for page-scoped commands; omit it for Browser/Target commands.',
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: 'CDP method, e.g. "Page.navigate"'
        },
        params: {
          type: "object",
          description: "CDP command parameters"
        },
        sessionId: {
          type: "string",
          description:
            '"active" for the current tab, or a handle from attachToTarget. Omit for Browser/Target commands.'
        },
        timeoutMs: {
          type: "number",
          description: "Per-command timeout override in milliseconds"
        }
      },
      required: ["method"]
    }
  },
  attachToTarget: {
    description:
      "Switch to an open tab: make it the active tab and return { sessionId } — a handle you can pass to page-scoped send calls for that tab.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: {
          type: "string",
          description: "Target id from Target.getTargets/createTarget"
        },
        timeoutMs: { type: "number" }
      },
      required: ["targetId"]
    },
    outputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session handle for page-scoped send calls"
        }
      },
      required: ["sessionId"]
    }
  },
  spec: {
    description:
      "Return the searchable Chrome DevTools Protocol spec: domains with their commands, events, and types.",
    inputSchema: { type: "object", properties: {} }
  },
  getDebugLog: {
    description:
      "Return recent CDP protocol traffic (sends, receives, warnings) for this execution — useful to diagnose failures and timeouts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description:
            "Max entries to return, newest last (default 50; only the last 400 are kept)"
        }
      }
    }
  },
  clearDebugLog: {
    description: "Clear the CDP debug log for this execution.",
    inputSchema: { type: "object", properties: {} }
  }
} satisfies Record<string, BrowserFunctionDefinition>;

/** The name of a call a {@link BrowserSessionDriver} answers. */
export type BrowserFunctionName = keyof typeof BROWSER_FUNCTIONS;

export function isBrowserFunctionName(
  name: string
): name is BrowserFunctionName {
  return Object.hasOwn(BROWSER_FUNCTIONS, name);
}

export interface BrowserSessionDriverOptions extends BrowserSessionOptions {
  /**
   * The largest `Page.captureScreenshot` result `send` returns, measured as
   * JSON. Defaults to {@link DEFAULT_MAX_SEND_RESULT_BYTES}.
   */
  maxResultBytes?: number;
}

/**
 * Drives one host-named, persistent browser over the Chrome DevTools
 * Protocol, one execution at a time per id.
 *
 * The model never manages sessions: every execution reattaches to the
 * browser (or gets a replacement, reported as `restarted`), and
 * `sessionId: "active"` addresses the tab it last worked in. The active tab
 * is stored per scope (see {@link BrowserSessionOptions.scope}), so it
 * survives between executions for as long as the tab does, and one scope's
 * executions never land in another scope's tab unless the model attaches to
 * it.
 *
 * The CDP socket is per execution: opened on the first call, closed by
 * {@link end}. The browser itself outlives the execution.
 */
export class BrowserSessionDriver {
  readonly #browser: BrowserSource;
  readonly #scope: string | undefined;
  readonly #maxResultBytes: number;
  #states = new Map<string, ExecutionState>();
  #connecting = new Map<string, Promise<ExecutionState>>();
  /**
   * In memory, on this instance. The report for an execution covers every
   * pass this instance ran for it.
   *
   * Raw CDP session ids from `Target.attachToTarget` sent through `send`
   * belong to one pass's socket, so a later pass would reuse a dead id. The
   * stable handles from `attachToTarget` work across passes.
   */
  #reports = new Map<string, BrowserExecutionReport>();

  constructor(options: BrowserSessionDriverOptions) {
    this.#browser = options.browser;
    this.#scope = options.scope;
    this.#maxResultBytes =
      options.maxResultBytes ?? DEFAULT_MAX_SEND_RESULT_BYTES;
  }

  /** The browser's name, for log messages. */
  get browserName(): string {
    return this.#browser.name;
  }

  /**
   * Answer one call from `executionId`'s code. The arguments are checked
   * against the call's input schema first.
   */
  async call(
    executionId: string,
    name: BrowserFunctionName,
    args: unknown
  ): Promise<unknown> {
    const input = validateArgs(
      "cdp",
      name,
      BROWSER_FUNCTIONS[name].inputSchema,
      args
    );
    switch (name) {
      case "send":
        return this.#send(executionId, input);
      case "attachToTarget":
        return this.#attachToTarget(executionId, input);
      case "spec":
        return (await this.#state(executionId)).connected.spec();
      case "getDebugLog": {
        const { limit } = input as { limit?: number };
        const state = await this.#state(executionId);
        return state.connected.cdp.getDebugLog(limit);
      }
      case "clearDebugLog": {
        const state = await this.#state(executionId);
        state.connected.cdp.clearDebugLog();
        return null;
      }
    }
  }

  /**
   * The pass is over: note tabs the page opened, save the scope's active
   * tab, note whether another scope shares it, and drop the socket. The
   * browser stays alive.
   */
  async end(executionId: string): Promise<void> {
    const state = this.#states.get(executionId);
    if (!state) return;
    this.#states.delete(executionId);
    try {
      const open = await this.#recordNewTabs(executionId, state);
      const active = await this.#saveActiveTarget(state, open);
      if (active && state.activeResolved) {
        await this.#recordSharedTab(state, active);
      }
    } finally {
      state.connected.cdp.disconnect();
    }
  }

  /** Drop an execution's socket without saving anything. */
  dispose(executionId: string): void {
    const state = this.#states.get(executionId);
    if (!state) return;
    this.#states.delete(executionId);
    state.connected.cdp.disconnect();
  }

  /**
   * Take (and forget) what happened to the browser during an execution.
   * `undefined` when the execution never touched the browser.
   */
  takeReport(executionId: string): BrowserExecutionReport | undefined {
    const report = this.#reports.get(executionId);
    this.#reports.delete(executionId);
    return report;
  }

  async #send(executionId: string, args: unknown): Promise<unknown> {
    const { method, params, sessionId, timeoutMs } = args as {
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      timeoutMs?: number;
    };
    if (BROWSER_LIFETIME_COMMANDS.has(method)) {
      throw new Error(
        `${method} is not available: this browser is managed for you ` +
          `and persists between runs. To close a tab, send ` +
          `Target.closeTarget with its targetId.`
      );
    }
    const state = await this.#state(executionId);
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
    if (method === "Page.captureScreenshot") {
      this.#assertFits(result);
    }
    return result;
  }

  async #attachToTarget(
    executionId: string,
    args: unknown
  ): Promise<{ sessionId: string }> {
    const { targetId, timeoutMs } = args as {
      targetId: TargetId;
      timeoutMs?: number;
    };
    const state = await this.#state(executionId);
    await this.#attach(state, targetId, timeoutMs);
    this.#setActive(state, targetId);
    return { sessionId: attachHandle(targetId) };
  }

  /**
   * Codemode records every `send` result for replay, and Computer's bridge
   * caps each call's response, so a result over the limit fails. A
   * full-page screenshot is the usual culprit, so say how to take a smaller
   * one instead.
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
        `cdp.send result. Capture just the viewport (no captureBeyondViewport ` +
        `or clip larger than the window), or pass format: "jpeg" with ` +
        `quality: 60.`
    );
  }

  /**
   * Connect once per pass. Concurrent first calls (model code that uses
   * Promise.all despite the instructions) share one connect.
   */
  #state(executionId: string): Promise<ExecutionState> {
    const existing = this.#states.get(executionId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.#connecting.get(executionId);
    if (inFlight) return inFlight;
    const promise = this.#connect(executionId).finally(() => {
      this.#connecting.delete(executionId);
    });
    this.#connecting.set(executionId, promise);
    return promise;
  }

  async #connect(executionId: string): Promise<ExecutionState> {
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
    const state: ExecutionState = {
      executionId,
      connected,
      attached: new Map(),
      workedIn: new Set(),
      initialPages: new Set(initialPages.map((page) => page.targetId)),
      activeResolved: false,
      closed: new Set()
    };
    this.#states.set(executionId, state);
    this.#report(executionId, connected.restarted);
    return state;
  }

  #report(executionId: string, restarted: boolean): BrowserExecutionReport {
    let report = this.#reports.get(executionId);
    if (!report) {
      report = { restarted, newTabs: [], tabClosed: false, tabShared: false };
      this.#reports.set(executionId, report);
      if (this.#reports.size > MAX_PENDING_REPORTS) {
        const oldest = this.#reports.keys().next().value;
        if (oldest !== undefined) this.#reports.delete(oldest);
      }
    }
    // A replacement on any pass means earlier page state is gone.
    report.restarted ||= restarted;
    return report;
  }

  /**
   * Add tabs the page opened this pass to the execution's report, and drop
   * earlier ones that have since closed: `newTabs` lists page-opened tabs
   * still open when the execution ends, across every pass. Returns the open
   * tabs, or `undefined` when the browser couldn't be asked.
   */
  async #recordNewTabs(
    executionId: string,
    state: ExecutionState
  ): Promise<Set<TargetId> | undefined> {
    let pages: TargetInfo[];
    try {
      pages = await this.#pages(state.connected.cdp);
    } catch (error) {
      this.#warn("list the open tabs", error);
      return undefined;
    }
    const report = this.#report(executionId, state.connected.restarted);
    const opened = new Set<string>(report.newTabs.map((tab) => tab.targetId));
    // A new tab is this execution's when its opener is a tab this pass
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
    report.newTabs = pages
      .filter((page) => opened.has(page.targetId))
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
    return new Set(pages.map((page) => page.targetId));
  }

  /**
   * Save the tab this pass settled on, forgetting one that has since closed,
   * and return it. Without the list of open tabs, save the choice
   * unchecked: the next execution checks the stored tab is still open
   * before using it.
   */
  async #saveActiveTarget(
    state: ExecutionState,
    open: Set<TargetId> | undefined
  ): Promise<TargetId | undefined> {
    const stored = state.connected.activeTargetId as TargetId | undefined;
    // A pass that never used "active" still sees the stored tab is gone;
    // say so now, since the next pass won't know there was one.
    if (
      !state.activeResolved &&
      stored &&
      open &&
      !open.has(stored) &&
      !state.closed.has(stored)
    ) {
      this.#report(state.executionId, state.connected.restarted).tabClosed =
        true;
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

  /** Report when another scope is working in this pass's tab too. */
  async #recordSharedTab(
    state: ExecutionState,
    active: TargetId
  ): Promise<void> {
    try {
      const others = await state.connected.targetsInOtherScopes();
      if (others.has(active)) {
        this.#report(state.executionId, state.connected.restarted).tabShared =
          true;
      }
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
    state: ExecutionState,
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
   * Decide which tab `"active"` means, once per pass: the scope's stored tab
   * if it is still open, else a new blank tab. Never a tab the scope didn't
   * open, even a blank one: it may be another scope's, or a popup.
   */
  async #activeTarget(state: ExecutionState): Promise<TargetId> {
    if (state.activeTargetId) return state.activeTargetId;
    const { connected } = state;
    const pages = await this.#pages(connected.cdp);
    const stored = connected.activeTargetId as TargetId | undefined;
    let targetId = pages.find((page) => page.targetId === stored)?.targetId;
    if (!targetId && stored && !state.closed.has(stored)) {
      this.#report(state.executionId, connected.restarted).tabClosed = true;
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

  #setActive(state: ExecutionState, targetId: TargetId | undefined): void {
    state.activeTargetId = targetId;
    state.activeResolved = true;
  }

  async #attach(
    state: ExecutionState,
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
    state: ExecutionState,
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
    state: ExecutionState,
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
   * Turn the common protocol mistakes into instructions: sending an
   * event as a command, and a page-scoped command without a session.
   */
  async #teach(
    state: ExecutionState,
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
          `cdp.attachToTarget({ targetId }) for another tab.`
      );
    }
    if (error.code !== CDP_METHOD_NOT_FOUND) return error;
    if (await this.#isEvent(state, method)) {
      return new Error(
        `${error.message}. '${method}' is a CDP *event*, not a command — it ` +
          `cannot be sent. To wait for page state, poll instead (e.g. ` +
          `Runtime.evaluate of document.readyState until "complete").`
      );
    }
    if (!sessionId) {
      return new Error(
        `${error.message}. '${method}' is page-scoped: pass sessionId: ` +
          `"active" to run it in the current tab — ` +
          `cdp.send({ method: "${method}", params, sessionId: "active" }).`
      );
    }
    return error;
  }

  async #isEvent(state: ExecutionState, method: string): Promise<boolean> {
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
