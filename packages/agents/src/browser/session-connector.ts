import {
  CodemodeConnector,
  MAX_DURABLE_VALUE_BYTES,
  type ConnectorTool,
  type ConnectorTools,
  type ToolExecuteContext
} from "@cloudflare/codemode";
import { validateConnectorArgs } from "./connector-validation";
import {
  CDP_METHOD_NOT_FOUND,
  CdpProtocolError,
  type CdpConnection
} from "./cdp-connection";
import type { BrowserConnection } from "./browser";
import type { SearchableCdpSpec } from "./spec";

/**
 * Where a {@link BrowserSessionConnector} gets its browser. Usually a
 * `Browser` installed on the host's Lifecycle.
 */
export interface BrowserSource {
  /** The browser's name, for log messages. */
  readonly name: string;
  /** Reattach to the browser (or replace it) and open a CDP connection. */
  connect(): Promise<BrowserConnection>;
}

export interface BrowserSessionConnectorOptions {
  /** The persistent browser this connector drives. */
  browser: BrowserSource;
}

/** A tab a page opened on its own during an execution. */
export interface BrowserNewTab {
  targetId: string;
  url?: string;
  title?: string;
}

/**
 * What happened to the browser during one execution, beyond the code's own
 * result — read by the tool after the run via
 * {@link BrowserSessionConnector.takeReport}.
 */
export interface BrowserExecutionReport {
  /** The browser was replaced before this run; earlier page state is gone. */
  restarted: boolean;
  /** Tabs the page opened itself (popups, `target=_blank`). */
  newTabs: BrowserNewTab[];
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

/**
 * Codemode records every `send` result for replay and fails the run when one
 * is over {@link MAX_DURABLE_VALUE_BYTES}, telling the model to write to a
 * file, which this sandbox can't. A full-page screenshot is the usual
 * culprit, so say how to take a smaller one instead.
 */
function assertScreenshotFits(result: unknown): void {
  const data = (result as { data?: unknown } | undefined)?.data;
  if (typeof data !== "string" || data.length < MAX_DURABLE_VALUE_BYTES) {
    return;
  }
  const megabytes = (data.length / 1_000_000).toFixed(1);
  throw new Error(
    `The screenshot is ${megabytes} MB of base64, over the 1 MB limit on a ` +
      `cdp.send result. Capture just the viewport (no captureBeyondViewport ` +
      `or clip larger than the window), or pass format: "jpeg" with ` +
      `quality: 60.`
  );
}

/** {@link BrowserSessionConnector} `#liveParams`: nothing to detach. */
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
  connected: BrowserConnection;
  /** Live CDP session per target, valid on this socket only. */
  attached: Map<TargetId, LiveSessionId>;
  /** Page targets open when the pass connected. */
  initialPages: Set<TargetId>;
  /** The tab `"active"` resolves to — decided lazily on first use. */
  activeTargetId?: TargetId;
  /** Whether {@link activeTargetId} was decided (vs. never needed). */
  activeResolved: boolean;
}

/**
 * How to use the `cdp` connector, one rule per line. `codemode.describe("cdp")`
 * returns these, and `browserTool` puts them in its description. Each rule
 * fixes a mistake models make with CDP, or states something about this
 * browser they can't know; leave out what a model knows already.
 */
export const BROWSER_INSTRUCTIONS = [
  "The browser persists between runs: tabs, cookies, and logins are still there next time. You never start or close it.",
  "If the browser was replaced (idle timeout, crash), the result says restarted: true and earlier tabs and logins are gone. Before an action that matters (submitting a form, a purchase), check you're on the page you expect.",
  'Page-scoped commands (Page.*, Runtime.*, DOM.*, Input.*, Network.*, Emulation.*) need sessionId: "active", the tab you\'re working in, which is remembered between runs. Browser.* and Target.* commands take no sessionId.',
  "Target.createTarget opens a tab and makes it active. To switch to another open tab, call cdp.attachToTarget({ targetId }); the sessionId it returns keeps working in later runs, while one from a raw Target.attachToTarget only works in the current run.",
  "Tabs a page opens itself (popups, target=_blank links) don't become active; the result lists them as newTabs.",
  "Runtime.evaluate: pass returnByValue: true, or objects come back as a remote reference with no value, and awaitPromise: true for async expressions. The value is at result.value. A thrown error doesn't reject: check exceptionDetails.",
  "Page.navigate returns before the page loads and doesn't throw when it fails: check errorText, then poll document.readyState with Runtime.evaluate until it is 'complete'.",
  "Pick out what you need inside Runtime.evaluate and return only that. Results over about 24,000 characters are cut short, and a single cdp.send result over 1 MB (a full-page screenshot, say) fails the run."
].join("\n");

/**
 * Codemode connector exposing one host-named, persistent browser over the
 * Chrome DevTools Protocol as the `cdp` global.
 *
 * The model never manages sessions: every execution reattaches to the
 * browser (or gets a replacement, reported as `restarted`), and
 * `sessionId: "active"` addresses the tab it last worked in. The active tab
 * is stored on the browser's record, so it survives between executions for as
 * long as the tab does.
 *
 * The CDP socket is per pass: opened on the first call, closed when the pass
 * ends. The browser itself outlives the execution.
 */
export class BrowserSessionConnector extends CodemodeConnector {
  readonly #browser: BrowserSource;
  #states = new Map<string, ExecutionState>();
  #connecting = new Map<string, Promise<ExecutionState>>();
  /**
   * In memory, on this instance. An execution resumed after an approval
   * pause may run on a fresh connector, whose report starts over. Nothing
   * pauses today — the browser tool wires no approval tools — so reporting
   * across a resume is left for when approvals are added.
   *
   * The same goes for raw CDP session ids from `Target.attachToTarget` sent
   * through `send`: they belong to one pass's socket, so a replay after a
   * pause would reuse a dead id. The stable handles from `attachToTarget`
   * are the replay-safe path.
   */
  #reports = new Map<string, BrowserExecutionReport>();

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    options: BrowserSessionConnectorOptions
  ) {
    super(ctx, {});
    this.#browser = options.browser;
  }

  name(): string {
    return "cdp";
  }

  protected instructions(): string {
    return BROWSER_INSTRUCTIONS;
  }

  protected override tool(name: string, tool: ConnectorTool): ConnectorTool {
    return validateConnectorArgs(this.name(), name, tool);
  }

  protected tools(): ConnectorTools {
    return {
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
        },
        execute: async (args, ctx) => {
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
          const state = await this.#state(this.#executionId(ctx));
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
            assertScreenshotFits(result);
          }
          return result;
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
        },
        execute: async (args, ctx) => {
          const { targetId, timeoutMs } = args as {
            targetId: TargetId;
            timeoutMs?: number;
          };
          const state = await this.#state(this.#executionId(ctx));
          await this.#attach(state, targetId, timeoutMs);
          this.#setActive(state, targetId);
          return { sessionId: attachHandle(targetId) };
        }
      },

      spec: {
        description:
          "Return the searchable Chrome DevTools Protocol spec: domains with their commands, events, and types.",
        replay: "reexecute",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx): Promise<SearchableCdpSpec> => {
          const state = await this.#state(this.#executionId(ctx));
          return state.connected.spec();
        }
      },

      getDebugLog: {
        description:
          "Return recent CDP protocol traffic (sends, receives, warnings) for this execution — useful to diagnose failures and timeouts.",
        replay: "reexecute",
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
        },
        execute: async (args, ctx) => {
          const { limit } = (args ?? {}) as { limit?: number };
          const state = await this.#state(this.#executionId(ctx));
          return state.connected.cdp.getDebugLog(limit);
        }
      },

      clearDebugLog: {
        description: "Clear the CDP debug log for this execution.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx) => {
          const state = await this.#state(this.#executionId(ctx));
          state.connected.cdp.clearDebugLog();
          return null;
        }
      }
    };
  }

  // ── Codemode execution hooks ─────────────────────────────────────────────

  /**
   * The pass is over: note tabs the page opened, save the active tab on the
   * browser's record, and drop the socket. The browser stays alive.
   */
  override async onPassEnd(executionId: string): Promise<void> {
    const state = this.#states.get(executionId);
    if (!state) return;
    this.#states.delete(executionId);
    try {
      const open = await this.#recordNewTabs(executionId, state);
      await this.#saveActiveTarget(state, open);
    } finally {
      state.connected.cdp.disconnect();
    }
  }

  /** Nothing per execution outlives the pass; the named browser persists. */
  override async disposeExecution(executionId: string): Promise<void> {
    const state = this.#states.get(executionId);
    if (!state) return;
    this.#states.delete(executionId);
    state.connected.cdp.disconnect();
  }

  /**
   * Take (and forget) what happened to the browser during an execution.
   * `undefined` when the execution never touched the browser. Covers the
   * passes this instance ran; see the note on `#reports`.
   */
  takeReport(executionId: string): BrowserExecutionReport | undefined {
    const report = this.#reports.get(executionId);
    this.#reports.delete(executionId);
    return report;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #executionId(ctx: ToolExecuteContext | undefined): string {
    if (!ctx?.executionId) {
      throw new Error("Browser tools must run inside a codemode execution");
    }
    return ctx.executionId;
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
    const connected = await this.#browser.connect();
    let initialPages: TargetInfo[];
    try {
      initialPages = await this.#pages(connected.cdp);
    } catch (error) {
      connected.cdp.disconnect();
      throw error;
    }
    const state: ExecutionState = {
      connected,
      attached: new Map(),
      initialPages: new Set(initialPages.map((page) => page.targetId)),
      activeResolved: false
    };
    this.#states.set(executionId, state);
    this.#report(executionId, connected.restarted);
    return state;
  }

  #report(executionId: string, restarted: boolean): BrowserExecutionReport {
    let report = this.#reports.get(executionId);
    if (!report) {
      report = { restarted, newTabs: [] };
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
    for (const page of pages) {
      // Chrome sets openerId only on tabs a page opened, never on
      // Target.createTarget tabs — including ones another execution sharing
      // this browser created meanwhile.
      if (!state.initialPages.has(page.targetId) && page.openerId) {
        opened.add(page.targetId);
      }
    }
    report.newTabs = pages
      .filter((page) => opened.has(page.targetId))
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
    return new Set(pages.map((page) => page.targetId));
  }

  /**
   * Save the tab this pass settled on, forgetting one that has since closed.
   * Without the list of open tabs, save the choice unchecked: the next
   * execution checks the stored tab is still open before using it.
   */
  async #saveActiveTarget(
    state: ExecutionState,
    open: Set<TargetId> | undefined
  ): Promise<void> {
    const stored = state.connected.activeTargetId as TargetId | undefined;
    const candidate = state.activeResolved ? state.activeTargetId : stored;
    const active =
      candidate && (!open || open.has(candidate)) ? candidate : undefined;
    if (active === stored) return;
    try {
      await state.connected.setActiveTarget(active);
    } catch (error) {
      this.#warn("save the active tab", error);
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
   * Decide which tab `"active"` means, once per pass: the stored tab if it
   * is still open, else the only open tab, else a new blank tab when none
   * are open, else the first listed tab.
   */
  async #activeTarget(state: ExecutionState): Promise<TargetId> {
    if (state.activeTargetId) return state.activeTargetId;
    const pages = await this.#pages(state.connected.cdp);
    const stored = state.connected.activeTargetId;
    let targetId = pages.find((page) => page.targetId === stored)?.targetId;
    if (!targetId && pages.length === 0) {
      const created = (await state.connected.cdp.send("Target.createTarget", {
        url: "about:blank"
      })) as { targetId: TargetId };
      targetId = created.targetId;
    }
    targetId ??= pages[0].targetId;
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
    } else if (method === "Target.closeTarget" && targetId) {
      state.attached.delete(targetId);
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
