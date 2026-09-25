import {
  CodemodeConnector,
  type ConnectorTool,
  type ConnectorTools,
  type ExecutionEndStatus,
  type PassEndStatus,
  type ToolExecuteContext
} from "@cloudflare/codemode";
import type { BrowserBinding } from "./browser-run";
import { validateConnectorArgs } from "./connector-validation";
import type { CdpSession } from "./cdp-session";
import type { ConnectedBrowserSession } from "./session-core";
import { DEFAULT_BROWSER_SESSION_NAME } from "./session-core";
import { loadCdpSpec, type SearchableCdpSpec } from "./spec";

/**
 * Where a {@link BrowserSessionConnector} gets its browser. Usually a
 * `BrowserSessions` capability installed on the host's Lifecycle.
 */
export interface BrowserSessionSource {
  /** The Browser Rendering binding the sessions run on. */
  readonly browser: BrowserBinding;
  /** Reattach-or-create the named session and open a CDP socket to it. */
  connect(name?: string): Promise<ConnectedBrowserSession>;
}

export interface BrowserSessionConnectorOptions {
  sessions: BrowserSessionSource;
  /** The named session this connector drives. Defaults to `"default"`. */
  session?: string;
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

/** Reports awaiting their tool call; bounded in case a caller never reads. */
const MAX_PENDING_REPORTS = 100;

interface TargetInfo {
  targetId: string;
  type: string;
  url?: string;
  title?: string;
}

/** Per-execution state for one pass. Dropped when the pass ends. */
interface ExecutionState {
  connected: ConnectedBrowserSession;
  /** Live CDP session id per target, valid on this socket only. */
  attached: Map<string, string>;
  /** Page targets open when the pass connected. */
  initialPages: Set<string>;
  /** Pages the agent itself created this pass. */
  createdPages: Set<string>;
  /** The tab `"active"` resolves to — decided lazily on first use. */
  activeTargetId?: string;
  /** Whether {@link activeTargetId} was decided (vs. never needed). */
  activeResolved: boolean;
}

const INSTRUCTIONS = [
  "This browser persists between executions: tabs, cookies, and logins you leave behind are still there next time. It is managed for you — there is nothing to start, close, or reset.",
  'Page-scoped commands (Page.*, Runtime.*, DOM.*, Input.*, Network.*, Emulation.*) need sessionId: "active" — the tab you are working in, which stays the same across executions. Example: await cdp.send({ method: "Page.navigate", params: { url }, sessionId: "active" }).',
  "Browser- and Target-scoped commands (Target.getTargets, Target.createTarget, Browser.getVersion) take no sessionId.",
  'Opening a tab with Target.createTarget makes it the active tab. To switch to another open tab, call cdp.attachToTarget({ targetId }): it becomes active, and the returned sessionId works like "active" for that tab.',
  "Tabs a page opens on its own (popups, target=_blank links) do not become active; the tool result lists them as newTabs.",
  "cdp.send returns the CDP method result directly, not the JSON-RPC envelope: Target.createTarget returns { targetId }, Runtime.evaluate returns { result: { value } }, Page.captureScreenshot returns { data }.",
  "Issue CDP calls sequentially — never in parallel (no Promise.all): call order is recorded for durable replay.",
  "Page.navigate resolves before the page finishes loading. Poll Runtime.evaluate of document.readyState until it is 'complete' before reading the page.",
  "Use cdp.spec() to discover commands, events, and types when unsure. If a command fails or times out, check cdp.getDebugLog() for recent protocol traffic.",
  "Return small results. Write large page dumps to a file or workspace and pass references around."
].join("\n");

/**
 * Codemode connector exposing one host-named, persistent browser over the
 * Chrome DevTools Protocol as the `cdp` global.
 *
 * The model never manages sessions: every execution reattaches to the named
 * session (or gets a replacement, reported as `restarted`), and
 * `sessionId: "active"` addresses the tab it last worked in. The active tab
 * is stored on the session record, so it survives between executions for as
 * long as the tab does.
 *
 * The CDP socket is per pass: opened on the first call, closed when the pass
 * ends. The browser itself outlives the execution.
 */
export class BrowserSessionConnector extends CodemodeConnector {
  readonly #sessions: BrowserSessionSource;
  readonly #session: string;
  #states = new Map<string, ExecutionState>();
  #connecting = new Map<string, Promise<ExecutionState>>();
  #reports = new Map<string, BrowserExecutionReport>();

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    options: BrowserSessionConnectorOptions
  ) {
    super(ctx, {});
    this.#sessions = options.sessions;
    this.#session = options.session ?? DEFAULT_BROWSER_SESSION_NAME;
  }

  name(): string {
    return "cdp";
  }

  protected instructions(): string {
    return INSTRUCTIONS;
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
          const state = await this.#state(this.#executionId(ctx));
          const live = await this.#resolveSessionId(state, sessionId);
          let result: unknown;
          try {
            result = await state.connected.cdp.send(method, params, {
              sessionId: live,
              timeoutMs
            });
          } catch (error) {
            throw await this.#teach(state, error, method, sessionId);
          }
          this.#observe(state, method, params, result);
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
            targetId: string;
            timeoutMs?: number;
          };
          const state = await this.#state(this.#executionId(ctx));
          await this.#attach(state, targetId, timeoutMs);
          this.#setActive(state, targetId);
          return { sessionId: `${ATTACH_HANDLE_PREFIX}${targetId}` };
        }
      },

      spec: {
        description:
          "Return the searchable Chrome DevTools Protocol spec: domains with their commands, events, and types.",
        replay: "reexecute",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx): Promise<SearchableCdpSpec> => {
          const state = await this.#state(this.#executionId(ctx));
          return loadCdpSpec({
            browser: this.#sessions.browser,
            sessionId: state.connected.sessionId
          });
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
              description: "Max entries to return (default 50)"
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

  // ── Lifecycle hooks ──────────────────────────────────────────────────────

  /**
   * The pass is over: note tabs the page opened, save the active tab on the
   * session record, and drop the socket. The browser stays alive.
   */
  override async onPassEnd(
    executionId: string,
    _status: PassEndStatus
  ): Promise<void> {
    const state = this.#states.get(executionId);
    if (!state) return;
    this.#states.delete(executionId);
    try {
      const pages = await this.#pages(state.connected.cdp);
      const open = new Set(pages.map((page) => page.targetId));
      const report = this.#report(executionId, state.connected.restarted);
      report.newTabs = pages
        .filter(
          (page) =>
            !state.initialPages.has(page.targetId) &&
            !state.createdPages.has(page.targetId)
        )
        .map(({ targetId, url, title }) => ({ targetId, url, title }));

      // Save the tab this pass settled on; forget one that has since closed.
      const stored = state.connected.activeTargetId;
      const candidate = state.activeResolved ? state.activeTargetId : stored;
      const active = candidate && open.has(candidate) ? candidate : undefined;
      if (active !== stored) await state.connected.setActiveTarget(active);
    } catch (error) {
      console.warn(
        `[agents/browser] Failed to record tab state for browser session "${this.#session}"`,
        error
      );
    } finally {
      state.connected.cdp.disconnect();
    }
  }

  /** Nothing per execution outlives the pass; the named browser persists. */
  override async disposeExecution(
    executionId: string,
    _status: ExecutionEndStatus
  ): Promise<void> {
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
    const connected = await this.#sessions.connect(this.#session);
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
      createdPages: new Set(),
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

  async #pages(cdp: CdpSession): Promise<TargetInfo[]> {
    const result = (await cdp.send("Target.getTargets")) as {
      targetInfos?: TargetInfo[];
    };
    return (result?.targetInfos ?? []).filter((info) => info.type === "page");
  }

  async #resolveSessionId(
    state: ExecutionState,
    sessionId: string | undefined
  ): Promise<string | undefined> {
    if (sessionId === ACTIVE_PAGE_SESSION) {
      return this.#attach(state, await this.#activeTarget(state));
    }
    if (sessionId?.startsWith(ATTACH_HANDLE_PREFIX)) {
      return this.#attach(state, sessionId.slice(ATTACH_HANDLE_PREFIX.length));
    }
    return sessionId; // omitted, or a raw CDP session id
  }

  /**
   * Decide which tab `"active"` means, once per pass: the stored tab if it
   * is still open, else the only open tab, else a new blank tab when none
   * are open, else the first listed tab.
   */
  async #activeTarget(state: ExecutionState): Promise<string> {
    if (state.activeTargetId) return state.activeTargetId;
    const pages = await this.#pages(state.connected.cdp);
    const stored = state.connected.activeTargetId;
    let targetId = pages.find((page) => page.targetId === stored)?.targetId;
    if (!targetId && pages.length === 0) {
      const created = (await state.connected.cdp.send("Target.createTarget", {
        url: "about:blank"
      })) as { targetId: string };
      targetId = created.targetId;
      state.createdPages.add(targetId);
    }
    targetId ??= pages[0].targetId;
    this.#setActive(state, targetId);
    return targetId;
  }

  #setActive(state: ExecutionState, targetId: string | undefined): void {
    state.activeTargetId = targetId;
    state.activeResolved = true;
  }

  async #attach(
    state: ExecutionState,
    targetId: string,
    timeoutMs?: number
  ): Promise<string> {
    const existing = state.attached.get(targetId);
    if (existing) return existing;
    const live = await state.connected.cdp.attachToTarget(targetId, {
      timeoutMs
    });
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
      typeof params?.targetId === "string" ? params.targetId : undefined;
    if (method === "Target.createTarget") {
      const created = (result as { targetId?: unknown } | undefined)?.targetId;
      if (typeof created === "string") {
        state.createdPages.add(created);
        this.#setActive(state, created);
      }
    } else if (method === "Target.attachToTarget" && targetId) {
      this.#setActive(state, targetId);
    } else if (method === "Target.closeTarget" && targetId) {
      state.attached.delete(targetId);
      // The next "active" use picks a tab afresh.
      if (state.activeTargetId === targetId) state.activeTargetId = undefined;
    }
  }

  /**
   * Turn the two common protocol mistakes into instructions: sending an
   * event as a command, and a page-scoped command without a session.
   */
  async #teach(
    state: ExecutionState,
    error: unknown,
    method: string,
    sessionId: string | undefined
  ): Promise<unknown> {
    if (!(error instanceof Error) || !/-32601|wasn't found/.test(error.message))
      return error;
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
      const spec = await loadCdpSpec({
        browser: this.#sessions.browser,
        sessionId: state.connected.sessionId
      });
      const domain = method.split(".")[0];
      return spec.domains.some(
        (d) => d.name === domain && d.events.some((e) => e.event === method)
      );
    } catch {
      return false;
    }
  }
}
