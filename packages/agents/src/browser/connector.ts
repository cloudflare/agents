import {
  CodemodeConnector,
  type ConnectorTools,
  type ExecutionEndStatus,
  type PassEndStatus,
  type ToolExecuteContext
} from "@cloudflare/codemode";
import { CdpSession, connectUrl } from "./cdp-session";
import {
  connectBrowserSession,
  createBrowserSession,
  deleteBrowserSession,
  listBrowserTargets,
  BrowserRenderingError,
  type BrowserSessionInfo
} from "./browser-run";
import { loadCdpSpec, type SearchableCdpSpec } from "./spec";
import type {
  BrowserSessionStore,
  StoredBrowserSession
} from "./session-manager";
import { DEFAULT_SWEEP_IDLE_MS } from "./session-manager";

/** Browser session lifecycle for the connector (binding-backed only). */
export interface BrowserConnectorSessionOptions {
  /**
   * - `"one-shot"` (default) — one Browser Run session per codemode
   *   execution, deleted when the execution ends.
   * - `"reuse"` — all executions share one stored session under `key`.
   * - `"dynamic"` — per-execution sessions by default; the model can call
   *   `cdp.startSession()` to promote the current session into the shared
   *   slot so later executions reuse it.
   */
  mode?: "one-shot" | "reuse" | "dynamic";
  /** Logical owner key for the shared (reuse/promoted) session. Default `"default"`. */
  key?: string;
  /** Browser Run inactivity timeout. Browser Run currently caps this server-side. */
  keepAliveMs?: number;
}

export type BrowserConnectorOptions = (
  | {
      /** Browser Rendering binding (Fetcher) — used in production. */
      browser: Fetcher;
      /**
       * Durable store for Browser Run session ids. Required with the binding:
       * a session must survive a pause (approval) and resume on a fresh
       * instance, so its id cannot live in connector memory.
       */
      store: BrowserSessionStore;
      session?: BrowserConnectorSessionOptions;
      cdpUrl?: never;
      cdpHeaders?: never;
    }
  | {
      /**
       * CDP base URL override (e.g. http://localhost:9222). The browser is
       * externally managed: no Browser Run sessions are created or deleted,
       * and session modes don't apply.
       */
      cdpUrl: string;
      /** Headers to send with CDP URL discovery requests (e.g. Access headers). */
      cdpHeaders?: Record<string, string>;
      browser?: never;
      store?: never;
      session?: never;
    }
) & {
  /** CDP command timeout in milliseconds (default: 10000). */
  timeout?: number;
};

export interface BrowserConnectorSweepOptions {
  /**
   * Close stored sessions idle for at least this many milliseconds.
   * Defaults to the connector's `keepAliveMs`, or {@link DEFAULT_SWEEP_IDLE_MS}.
   */
  maxIdleMs?: number;
}

export interface BrowserConnectorSweepResult {
  /** Store keys (and their Browser Run session ids) closed by this sweep. */
  swept: Array<{ key: string; sessionId: string }>;
}

const EXEC_KEY_PREFIX = "cdp:exec:";
const REUSE_KEY_PREFIX = "cdp:reuse:";

function isMissingBrowserSession(error: unknown): boolean {
  return error instanceof BrowserRenderingError && error.status === 404;
}

interface CachedSocket {
  session: CdpSession;
  /** Browser Run session id the socket is attached to (undefined for cdpUrl). */
  browserSessionId?: string;
}

/**
 * Codemode connector exposing a live browser over the Chrome DevTools
 * Protocol as the `cdp` global.
 *
 * Per-execution resources are keyed by the codemode `executionId`:
 *
 * - The Browser Run session id is stored durably under `cdp:exec:<id>`, so a
 *   run that pauses for approval reconnects to the *same* browser when it
 *   resumes — even on a fresh instance.
 * - The CDP WebSocket is per-pass: `onPassEnd` disconnects it (a paused run
 *   holds no socket), and the next pass reconnects from the stored id.
 * - `disposeExecution` deletes the session unless it was promoted to the
 *   shared slot via `cdp.startSession()` (dynamic mode).
 *
 * Locks on the session store are held only around store reads/writes, never
 * across network calls to Browser Run or while a socket is open.
 */
export class BrowserConnector extends CodemodeConnector {
  #options: BrowserConnectorOptions;
  #sockets = new Map<string, CachedSocket>();

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    options: BrowserConnectorOptions
  ) {
    super(ctx, {});
    if (!options.cdpUrl && !options.browser) {
      throw new Error(
        "BrowserConnector requires either 'browser' (Fetcher binding) or 'cdpUrl'"
      );
    }
    if (options.browser && !options.store) {
      throw new Error(
        "BrowserConnector requires 'store' when using the Browser Rendering binding"
      );
    }
    this.#options = options;
  }

  name(): string {
    return "cdp";
  }

  protected instructions(): string {
    const mode = this.#mode();
    const lines = [
      "Issue CDP calls sequentially — never in parallel (no Promise.all): call order is recorded for durable replay.",
      "Browser-/Target-scoped commands (Target.createTarget, Target.getTargets) need no sessionId. Page-scoped commands (Page.navigate, Runtime.evaluate) require a sessionId from cdp.attachToTarget({ targetId }).",
      "Write large outputs (screenshots, page dumps) to a file or workspace immediately and pass around small references — large return values fail to record.",
      "Use cdp.spec() to discover commands, events, and types when unsure.",
      "If a command fails or times out, check cdp.getDebugLog() for recent protocol traffic."
    ];
    if (mode === "one-shot") {
      lines.push(
        "The browser session lasts for this execution only and is closed when it ends."
      );
    } else if (mode === "reuse") {
      lines.push(
        "The browser session is shared and persists across executions — tabs and state you leave behind will still be there next time."
      );
    } else {
      lines.push(
        "The browser session is one-shot by default. If browser state must persist after this execution (e.g. a logged-in page), call cdp.startSession() to keep it alive for later executions."
      );
    }
    return lines.join("\n");
  }

  protected tools(): ConnectorTools {
    const tools: ConnectorTools = {
      send: {
        description:
          "Send a CDP command and return its result. Page-scoped commands require a sessionId from attachToTarget.",
        inputSchema: {
          type: "object",
          properties: {
            method: {
              type: "string",
              description: 'CDP method, e.g. "Target.createTarget"'
            },
            params: {
              type: "object",
              description: "CDP command parameters"
            },
            sessionId: {
              type: "string",
              description:
                "Target session id from attachToTarget, for page-scoped commands"
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
            params?: unknown;
            sessionId?: string;
            timeoutMs?: number;
          };
          const socket = await this.#socket(this.#executionId(ctx));
          return socket.send(method, params, { sessionId, timeoutMs });
        }
      },

      attachToTarget: {
        description:
          "Attach to a target (tab) and return the sessionId to use for page-scoped commands.",
        inputSchema: {
          type: "object",
          properties: {
            targetId: {
              type: "string",
              description: "Target id from Target.createTarget/getTargets"
            },
            timeoutMs: { type: "number" }
          },
          required: ["targetId"]
        },
        execute: async (args, ctx) => {
          const { targetId, timeoutMs } = args as {
            targetId: string;
            timeoutMs?: number;
          };
          const socket = await this.#socket(this.#executionId(ctx));
          return socket.attachToTarget(targetId, { timeoutMs });
        }
      },

      spec: {
        description:
          "Return the searchable Chrome DevTools Protocol spec: domains with their commands, events, and types. Use it to discover method names and capabilities.",
        replay: "reexecute",
        inputSchema: { type: "object", properties: {} },
        execute: async (): Promise<SearchableCdpSpec> =>
          loadCdpSpec(this.#options)
      },

      getDebugLog: {
        description:
          "Return recent CDP protocol traffic (sends, receives, warnings) for this execution's connection — useful to diagnose failures and timeouts.",
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
          const socket = await this.#socket(this.#executionId(ctx));
          return socket.getDebugLog(limit);
        }
      },

      clearDebugLog: {
        description: "Clear the CDP debug log for this execution's connection.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx) => {
          const socket = await this.#socket(this.#executionId(ctx));
          socket.clearDebugLog();
          return null;
        }
      }
    };

    const mode = this.#mode();
    if (mode === "reuse" || mode === "dynamic") {
      tools.startSession = {
        description:
          mode === "dynamic"
            ? "Promote the current browser session into the shared slot so it persists after this execution. Later executions reuse it. Returns the session info."
            : "Ensure the shared browser session exists and return its info.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx) =>
          this.#startSession(this.#executionId(ctx))
      };
      tools.sessionInfo = {
        description:
          "Return info about the shared browser session (id and open targets), or null when none exists.",
        replay: "reexecute",
        inputSchema: { type: "object", properties: {} },
        execute: async () => (await this.sessionInfo()) ?? null
      };
      tools.closeSession = {
        description:
          "Close the shared browser session, discarding its tabs and state.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx) => {
          await this.#closeReusableFor(this.#executionId(ctx));
          return null;
        }
      };
      tools.resetSession = {
        description:
          "Close the shared browser session and start a fresh one. Returns the new session info.",
        inputSchema: { type: "object", properties: {} },
        execute: async (_args, ctx) =>
          this.#resetSession(this.#executionId(ctx))
      };
    }

    return tools;
  }

  // ---------------------------------------------------------------------
  // Lifecycle hooks
  // ---------------------------------------------------------------------

  /**
   * A pass is over (completed, errored, or paused awaiting approval) — drop
   * the CDP socket. The Browser Run session itself stays alive; a resume
   * reconnects from the durably stored session id.
   */
  override async onPassEnd(
    executionId: string,
    _status: PassEndStatus
  ): Promise<void> {
    this.#dropSocket(executionId);
  }

  /**
   * The execution is terminal — delete its Browser Run session unless it was
   * promoted to the shared slot via `cdp.startSession()`.
   */
  override async disposeExecution(
    executionId: string,
    _status: ExecutionEndStatus
  ): Promise<void> {
    this.#dropSocket(executionId);
    if (!this.#options.browser) return;

    const store = this.#options.store;
    const execKey = this.#execKey(executionId);
    const lock = await store.acquireLock(execKey);
    try {
      const stored = await store.get(execKey);
      if (!stored) return;

      let promoted = false;
      if (this.#mode() === "dynamic") {
        const shared = await store.get(this.#reuseKey());
        promoted = shared?.sessionId === stored.sessionId;
      }

      if (!promoted) {
        try {
          await deleteBrowserSession(this.#options.browser, stored.sessionId);
        } catch (error) {
          console.warn(
            `[agents/browser] Failed to delete Browser Run session ${stored.sessionId} for execution ${executionId}`,
            error
          );
        }
      }
      await store.delete(execKey);
    } finally {
      await lock.release();
    }
  }

  // ---------------------------------------------------------------------
  // Host-side helpers — for callables and scheduled tasks on the agent.
  // ---------------------------------------------------------------------

  /** Info about the shared (reuse/promoted) session, if one exists. */
  async sessionInfo(): Promise<BrowserSessionInfo | undefined> {
    if (!this.#options.browser) return undefined;
    const store = this.#options.store;
    const key = this.#reuseKey();
    const lock = await store.acquireLock(key);
    let stored: StoredBrowserSession | undefined;
    try {
      stored = await store.get(key);
    } finally {
      await lock.release();
    }
    if (!stored) return undefined;
    try {
      return {
        sessionId: stored.sessionId,
        targets: await listBrowserTargets(
          this.#options.browser,
          stored.sessionId
        )
      };
    } catch (error) {
      if (isMissingBrowserSession(error)) {
        await this.#deleteStoredEntry(key, stored.sessionId);
        return undefined;
      }
      throw error;
    }
  }

  /** Close the shared (reuse/promoted) session, if one exists. */
  async closeSession(): Promise<void> {
    if (!this.#options.browser) return;
    await this.#closeStoredSession(this.#reuseKey());
  }

  /**
   * Close stored sessions (shared and per-execution) idle past the threshold.
   * Per-execution entries normally die with `disposeExecution`; the sweep is
   * the backstop for crashed hosts and abandoned paused runs. Call it from a
   * recurring alarm/scheduled task.
   */
  async sweep(
    options?: BrowserConnectorSweepOptions
  ): Promise<BrowserConnectorSweepResult> {
    if (!this.#options.browser) return { swept: [] };
    const store = this.#options.store;
    const maxIdleMs =
      options?.maxIdleMs ??
      this.#options.session?.keepAliveMs ??
      DEFAULT_SWEEP_IDLE_MS;

    const keys = new Set<string>([this.#reuseKey()]);
    if (store.list) {
      for (const key of (await store.list("cdp:")).keys()) {
        keys.add(key);
      }
    }

    const swept: Array<{ key: string; sessionId: string }> = [];
    for (const key of keys) {
      const lock = await store.acquireLock(key);
      let toClose: StoredBrowserSession | undefined;
      try {
        const stored = await store.get(key);
        if (!stored || Date.now() - stored.updatedAt < maxIdleMs) continue;
        await store.delete(key);
        toClose = stored;
      } finally {
        await lock.release();
      }
      try {
        await deleteBrowserSession(this.#options.browser, toClose.sessionId);
      } catch (error) {
        console.warn(
          `[agents/browser] Sweep failed to delete Browser Run session ${toClose.sessionId}`,
          error
        );
      }
      swept.push({ key, sessionId: toClose.sessionId });
    }
    return { swept };
  }

  // ---------------------------------------------------------------------
  // Session + socket resolution
  // ---------------------------------------------------------------------

  #mode(): "one-shot" | "reuse" | "dynamic" {
    return this.#options.session?.mode ?? "one-shot";
  }

  #execKey(executionId: string): string {
    return `${EXEC_KEY_PREFIX}${executionId}`;
  }

  #reuseKey(): string {
    return `${REUSE_KEY_PREFIX}${this.#options.session?.key ?? "default"}`;
  }

  #executionId(ctx?: ToolExecuteContext): string {
    if (!ctx?.executionId) {
      throw new Error(
        "BrowserConnector requires an execution context — use it through createCodemodeRuntime"
      );
    }
    return ctx.executionId;
  }

  #dropSocket(executionId: string): void {
    const cached = this.#sockets.get(executionId);
    if (!cached) return;
    this.#sockets.delete(executionId);
    cached.session.disconnect();
  }

  /** Get or open the CDP socket for an execution. */
  async #socket(executionId: string): Promise<CdpSession> {
    if (this.#options.cdpUrl) {
      const cached = this.#sockets.get(executionId);
      if (cached) return cached.session;
      const session = await connectUrl(this.#options.cdpUrl, {
        timeoutMs: this.#options.timeout,
        headers: this.#options.cdpHeaders
      });
      this.#sockets.set(executionId, { session });
      return session;
    }

    const browser = this.#options.browser;
    if (!browser) throw new Error("BrowserConnector has no browser binding");
    const stored = await this.#resolveSession(executionId);
    const cached = this.#sockets.get(executionId);
    if (cached?.browserSessionId === stored.sessionId) {
      return cached.session;
    }
    if (cached) this.#dropSocket(executionId);

    const session = await connectBrowserSession(
      browser,
      stored.sessionId,
      this.#options.timeout
    );
    this.#sockets.set(executionId, {
      session,
      browserSessionId: stored.sessionId
    });
    return session;
  }

  /**
   * Resolve the Browser Run session for an execution:
   *
   * - An existing `cdp:exec:<id>` entry wins. If its session is gone (e.g.
   *   expired while the run was paused), the run fails with a clear error
   *   rather than silently continuing in a fresh browser.
   * - In `reuse` mode the shared session is used (created if missing).
   * - In `dynamic` mode an alive shared session is used; otherwise a fresh
   *   per-execution session is created.
   * - In `one-shot` mode a fresh per-execution session is created.
   */
  async #resolveSession(executionId: string): Promise<StoredBrowserSession> {
    const browser = this.#options.browser;
    if (!browser) throw new Error("BrowserConnector has no browser binding");
    const store = this.#options.store;
    const mode = this.#mode();
    const execKey = this.#execKey(executionId);

    if (mode === "reuse") {
      return this.#ensureStoredSession(this.#reuseKey());
    }

    // one-shot / dynamic: a session this execution already opened wins.
    const existing = await this.#readStored(execKey);
    if (existing) {
      if (await this.#isAlive(existing)) {
        return existing;
      }
      await this.#deleteStoredEntry(execKey, existing.sessionId);
      throw new Error(
        `Browser session ${existing.sessionId} expired while this execution was paused — the run cannot continue. Start a new execution.`
      );
    }

    if (mode === "dynamic") {
      const shared = await this.#readStored(this.#reuseKey());
      if (shared) {
        if (await this.#isAlive(shared)) {
          await this.#touchStored(this.#reuseKey(), shared);
          return shared;
        }
        await this.#deleteStoredEntry(this.#reuseKey(), shared.sessionId);
      }
    }

    // Create a fresh per-execution session under the lock, so two concurrent
    // tool calls for the same execution don't double-create.
    const lock = await store.acquireLock(execKey);
    try {
      const raced = await store.get(execKey);
      if (raced) return raced;
      const info = await createBrowserSession(browser, {
        keepAliveMs: this.#options.session?.keepAliveMs
      });
      const now = Date.now();
      const stored = {
        sessionId: info.sessionId,
        createdAt: now,
        updatedAt: now
      };
      await store.set(execKey, stored);
      return stored;
    } finally {
      await lock.release();
    }
  }

  /** Get the stored session under `key`, validating and creating as needed. */
  async #ensureStoredSession(key: string): Promise<StoredBrowserSession> {
    const browser = this.#options.browser;
    if (!browser) throw new Error("BrowserConnector has no browser binding");
    const store = this.#store;

    const lock = await store.acquireLock(key);
    try {
      const existing = await store.get(key);
      if (existing) {
        if (await this.#isAlive(existing)) {
          const refreshed = { ...existing, updatedAt: Date.now() };
          await store.set(key, refreshed);
          return refreshed;
        }
        await store.delete(key);
      }

      const info = await createBrowserSession(browser, {
        keepAliveMs: this.#options.session?.keepAliveMs
      });
      const now = Date.now();
      const stored = {
        sessionId: info.sessionId,
        createdAt: now,
        updatedAt: now
      };
      await store.set(key, stored);
      return stored;
    } finally {
      await lock.release();
    }
  }

  async #isAlive(stored: StoredBrowserSession): Promise<boolean> {
    const browser = this.#options.browser;
    if (!browser) return false;
    try {
      await listBrowserTargets(browser, stored.sessionId);
      return true;
    } catch (error) {
      if (isMissingBrowserSession(error)) return false;
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Session tools (reuse/dynamic)
  // ---------------------------------------------------------------------

  async #startSession(executionId: string): Promise<BrowserSessionInfo> {
    const browser = this.#options.browser;
    if (!browser) {
      throw new Error("startSession requires the Browser Rendering binding");
    }
    const store = this.#options.store;
    const reuseKey = this.#reuseKey();

    if (this.#mode() === "dynamic") {
      // Promote this execution's session into the shared slot, if it has one.
      const exec = await this.#readStored(this.#execKey(executionId));
      if (exec) {
        const lock = await store.acquireLock(reuseKey);
        let replaced: StoredBrowserSession | undefined;
        try {
          const shared = await store.get(reuseKey);
          if (shared?.sessionId !== exec.sessionId) {
            replaced = shared;
            await store.set(reuseKey, { ...exec, updatedAt: Date.now() });
          }
        } finally {
          await lock.release();
        }
        if (replaced) {
          try {
            await deleteBrowserSession(browser, replaced.sessionId);
          } catch (error) {
            console.warn(
              `[agents/browser] Failed to delete replaced Browser Run session ${replaced.sessionId}`,
              error
            );
          }
        }
        return {
          sessionId: exec.sessionId,
          targets: await listBrowserTargets(browser, exec.sessionId)
        };
      }
    }

    const stored = await this.#ensureStoredSession(reuseKey);
    return {
      sessionId: stored.sessionId,
      targets: await listBrowserTargets(browser, stored.sessionId)
    };
  }

  async #resetSession(executionId: string): Promise<BrowserSessionInfo> {
    const browser = this.#options.browser;
    if (!browser) {
      throw new Error("resetSession requires the Browser Rendering binding");
    }
    await this.#closeReusableFor(executionId);
    const stored = await this.#ensureStoredSession(this.#reuseKey());
    return {
      sessionId: stored.sessionId,
      targets: await listBrowserTargets(browser, stored.sessionId)
    };
  }

  /**
   * Close the shared session from inside an execution. If this execution's
   * socket is attached to that session, drop it first.
   */
  async #closeReusableFor(executionId: string): Promise<void> {
    const reuseKey = this.#reuseKey();
    const stored = await this.#readStored(reuseKey);
    if (!stored) return;
    const cached = this.#sockets.get(executionId);
    if (cached?.browserSessionId === stored.sessionId) {
      this.#dropSocket(executionId);
    }
    await this.#closeStoredSession(reuseKey);
    // In reuse mode the execution continues against a fresh shared session on
    // the next send. In dynamic mode the exec entry (if any) still points at
    // the closed session; clear it so the next send fails loudly instead of
    // silently targeting a deleted browser.
    const exec = await this.#readStored(this.#execKey(executionId));
    if (exec?.sessionId === stored.sessionId) {
      await this.#deleteStoredEntry(this.#execKey(executionId), exec.sessionId);
    }
  }

  // ---------------------------------------------------------------------
  // Store access — locks held only around the store operation itself.
  // ---------------------------------------------------------------------

  get #store(): BrowserSessionStore {
    const store = this.#options.store;
    if (!store) {
      throw new Error(
        "BrowserConnector session storage requires the Browser Rendering binding"
      );
    }
    return store;
  }

  async #readStored(key: string): Promise<StoredBrowserSession | undefined> {
    const store = this.#store;
    const lock = await store.acquireLock(key);
    try {
      return await store.get(key);
    } finally {
      await lock.release();
    }
  }

  async #writeStored(key: string, value: StoredBrowserSession): Promise<void> {
    const store = this.#store;
    const lock = await store.acquireLock(key);
    try {
      await store.set(key, value);
    } finally {
      await lock.release();
    }
  }

  async #touchStored(key: string, value: StoredBrowserSession): Promise<void> {
    await this.#writeStored(key, { ...value, updatedAt: Date.now() });
  }

  /** Delete the store entry only if it still points at `sessionId`. */
  async #deleteStoredEntry(key: string, sessionId: string): Promise<void> {
    const store = this.#store;
    const lock = await store.acquireLock(key);
    try {
      const current = await store.get(key);
      if (current?.sessionId === sessionId) {
        await store.delete(key);
      }
    } finally {
      await lock.release();
    }
  }

  /** Delete the stored entry under `key` and its Browser Run session. */
  async #closeStoredSession(key: string): Promise<void> {
    const browser = this.#options.browser;
    if (!browser) return;
    const store = this.#options.store;
    const lock = await store.acquireLock(key);
    let stored: StoredBrowserSession | undefined;
    try {
      stored = await store.get(key);
      if (stored) await store.delete(key);
    } finally {
      await lock.release();
    }
    if (stored) {
      await deleteBrowserSession(browser, stored.sessionId);
    }
  }
}
