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
  type BrowserBinding,
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
      browser: BrowserBinding;
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
   * Close the shared (reuse/promoted) session when idle for at least this
   * many milliseconds. Defaults to the connector's `keepAliveMs`, or
   * {@link DEFAULT_SWEEP_IDLE_MS}.
   */
  maxIdleMs?: number;
  /**
   * Close *per-execution* sessions when idle for at least this many
   * milliseconds. Defaults to {@link DEFAULT_EXEC_SWEEP_IDLE_MS} (24h) —
   * deliberately at least as long as the codemode runtime's default paused
   * TTL, so a run awaiting approval is normally expired (and disposed) by
   * `expirePaused` before the sweep backstop ever touches its browser.
   */
  maxExecIdleMs?: number;
}

export interface BrowserConnectorSweepResult {
  /** Store keys (and their Browser Run session ids) closed by this sweep. */
  swept: Array<{ key: string; sessionId: string }>;
}

const EXEC_KEY_PREFIX = "cdp:exec:";
const REUSE_KEY_PREFIX = "cdp:reuse:";

/**
 * Default idle window before {@link BrowserConnector.sweep} reclaims a
 * per-execution session. Matches the codemode runtime's default paused TTL
 * (24h): an execution paused for approval keeps its browser until the run
 * itself is expired.
 */
export const DEFAULT_EXEC_SWEEP_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum interval between `updatedAt` bumps on a per-execution store entry.
 * Touching on every CDP call would write-amplify; once a minute is enough to
 * keep an active or recently-resumed execution out of sweep range.
 */
const EXEC_TOUCH_INTERVAL_MS = 60 * 1000;

function isMissingBrowserSession(error: unknown): boolean {
  return error instanceof BrowserRenderingError && error.status === 404;
}

interface CachedSocket {
  session: CdpSession;
  /** Browser Run session id the socket is attached to (undefined for cdpUrl). */
  browserSessionId?: string;
  /**
   * Live CDP session id per attach handle, valid for this socket only.
   * Rebuilt lazily after a reconnect (sockets are per-pass).
   */
  attached: Map<string, string>;
}

/**
 * `cdp.attachToTarget` returns `{ sessionId: "target:<targetId>" }` — a stable
 * handle instead of the raw CDP session id. (The object shape mirrors the real
 * `Target.attachToTarget` response, which is what models reach for.) Raw ids
 * are connection-scoped: a run that pauses
 * for approval resumes on a fresh WebSocket where the old id is invalid, and
 * the durable replay log would otherwise pin the stale value. The handle is a
 * pure function of the target, so replayed code computes identical arguments,
 * and `send` resolves it to a live session id on the current socket —
 * re-attaching lazily after a reconnect.
 */
const ATTACH_HANDLE_PREFIX = "target:";

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
  #connecting = new Map<string, Promise<CdpSession>>();

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
      "Browser-/Target-scoped commands (Target.createTarget, Target.getTargets) need no sessionId. Page-scoped commands (Page.navigate, Runtime.evaluate) require one: `const { sessionId } = await cdp.attachToTarget({ targetId });` then pass it to every page-scoped send.",
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
          "Send a CDP command and return its result. Page-scoped commands require a sessionId — pass the handle returned by attachToTarget.",
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
                "Session handle from attachToTarget, for page-scoped commands"
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
          const executionId = this.#executionId(ctx);
          const socket = await this.#socket(executionId);
          const resolved = await this.#resolveSessionHandle(
            executionId,
            sessionId
          );
          try {
            return await socket.send(method, params, {
              sessionId: resolved,
              timeoutMs
            });
          } catch (err) {
            // "Method wasn't found" is almost always one of two model
            // mistakes. Teach the fix instead of leaving a bare protocol
            // error: either the method is actually an event (events can't be
            // sent), or a page-scoped command went to the browser-level
            // session because no sessionId was passed.
            if (
              err instanceof Error &&
              /-32601|wasn't found/.test(err.message)
            ) {
              if (await this.#isSpecEvent(method)) {
                throw new Error(
                  `${err.message}. '${method}' is a CDP *event*, not a ` +
                    `command — it cannot be called via cdp.send. To wait for ` +
                    `page state, poll instead (e.g. Runtime.evaluate of ` +
                    `document.readyState until "complete").`
                );
              }
              if (!sessionId) {
                throw new Error(
                  `${err.message}. Page-scoped commands need a sessionId: ` +
                    `const { sessionId } = await cdp.attachToTarget({ targetId }); ` +
                    `then pass sessionId to cdp.send.`
                );
              }
            }
            throw err;
          }
        }
      },

      attachToTarget: {
        description:
          "Attach to a target (tab) and return { sessionId } — a stable session handle to pass as sessionId in page-scoped send calls. The handle stays valid across pauses/resumes.",
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
        outputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description:
                "Stable session handle for page-scoped send calls (valid across pauses/resumes)"
            }
          },
          required: ["sessionId"]
        },
        execute: async (args, ctx) => {
          const { targetId, timeoutMs } = args as {
            targetId: string;
            timeoutMs?: number;
          };
          const executionId = this.#executionId(ctx);
          await this.#attach(executionId, targetId, timeoutMs);
          return { sessionId: `${ATTACH_HANDLE_PREFIX}${targetId}` };
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
    // Decide and update storage under the lock; the Browser Rendering delete
    // happens after release (locks wrap storage only).
    let toClose: StoredBrowserSession | undefined;
    try {
      const stored = await store.get(execKey);
      if (!stored) return;

      let promoted = false;
      if (this.#mode() === "dynamic") {
        const shared = await store.get(this.#reuseKey());
        promoted = shared?.sessionId === stored.sessionId;
      }

      if (!promoted && stored.closedAt === undefined) {
        toClose = stored;
      }
      await store.delete(execKey);
    } finally {
      await lock.release();
    }

    if (toClose) {
      try {
        await deleteBrowserSession(this.#options.browser, toClose.sessionId);
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to delete Browser Run session ${toClose.sessionId} for execution ${executionId}`,
          error
        );
      }
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
   * Per-execution entries normally die with `disposeExecution` (or the
   * codemode runtime's `expirePaused`); the sweep is the backstop for crashed
   * hosts. Call it from a recurring alarm/scheduled task.
   *
   * Active executions bump their entry's `updatedAt` on use, so only runs
   * idle past `maxExecIdleMs` (default 24h) are reclaimed. A swept
   * per-execution entry is kept as a tombstone (`closedAt`) rather than
   * deleted, so a later resume fails with a clear "session expired" error
   * instead of silently continuing in a fresh browser; tombstones are
   * deleted once they age past the threshold again.
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
    const maxExecIdleMs = options?.maxExecIdleMs ?? DEFAULT_EXEC_SWEEP_IDLE_MS;

    const keys = new Set<string>([this.#reuseKey()]);
    if (store.list) {
      for (const key of (await store.list("cdp:")).keys()) {
        keys.add(key);
      }
    }

    const swept: Array<{ key: string; sessionId: string }> = [];
    for (const key of keys) {
      const isExec = key.startsWith(EXEC_KEY_PREFIX);
      const idleMs = isExec ? maxExecIdleMs : maxIdleMs;
      const lock = await store.acquireLock(key);
      let toClose: StoredBrowserSession | undefined;
      try {
        const stored = await store.get(key);
        if (!stored) continue;
        const now = Date.now();
        if (stored.closedAt !== undefined) {
          // Tombstone from a previous sweep — its session is already gone.
          // Drop it once it has aged past the threshold again.
          if (now - stored.closedAt >= idleMs) await store.delete(key);
          continue;
        }
        if (now - stored.updatedAt < idleMs) continue;
        if (isExec) {
          await store.set(key, { ...stored, closedAt: now });
        } else {
          await store.delete(key);
        }
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

  /** Attach the current socket to a target, caching the live CDP session id. */
  async #attach(
    executionId: string,
    targetId: string,
    timeoutMs?: number
  ): Promise<string> {
    const socket = await this.#socket(executionId);
    const cached = this.#sockets.get(executionId);
    const handle = `${ATTACH_HANDLE_PREFIX}${targetId}`;
    const existing = cached?.attached.get(handle);
    if (existing) return existing;
    const live = await socket.attachToTarget(targetId, { timeoutMs });
    cached?.attached.set(handle, live);
    return live;
  }

  /**
   * Resolve a model-facing session handle to the live CDP session id on the
   * current socket, re-attaching lazily after a reconnect. Raw CDP session
   * ids (from manual Target.attachToTarget sends) pass through untouched.
   */
  /**
   * True when `method` is a CDP *event* (e.g. `Page.loadEventFired`) rather
   * than a command. Used only on the `send` failure path to produce a better
   * error; any spec-loading failure just means no extra hint.
   */
  async #isSpecEvent(method: string): Promise<boolean> {
    try {
      const spec = await loadCdpSpec(this.#options);
      const domain = method.split(".")[0];
      return spec.domains.some(
        (d) => d.name === domain && d.events.some((e) => e.event === method)
      );
    } catch {
      return false;
    }
  }

  async #resolveSessionHandle(
    executionId: string,
    sessionId?: string
  ): Promise<string | undefined> {
    if (!sessionId?.startsWith(ATTACH_HANDLE_PREFIX)) return sessionId;
    const targetId = sessionId.slice(ATTACH_HANDLE_PREFIX.length);
    return this.#attach(executionId, targetId);
  }

  /**
   * Get or open the CDP socket for an execution. Concurrent calls for the
   * same execution (model code that ignores the "sequential calls" rule and
   * uses Promise.all) share one in-flight connect instead of racing and
   * leaking the loser's WebSocket.
   */
  #socket(executionId: string): Promise<CdpSession> {
    const inFlight = this.#connecting.get(executionId);
    if (inFlight) return inFlight;
    const promise = this.#socketInner(executionId).finally(() => {
      if (this.#connecting.get(executionId) === promise) {
        this.#connecting.delete(executionId);
      }
    });
    this.#connecting.set(executionId, promise);
    return promise;
  }

  async #socketInner(executionId: string): Promise<CdpSession> {
    if (this.#options.cdpUrl) {
      const cached = this.#sockets.get(executionId);
      if (cached) return cached.session;
      const session = await connectUrl(this.#options.cdpUrl, {
        timeoutMs: this.#options.timeout,
        headers: this.#options.cdpHeaders
      });
      this.#sockets.set(executionId, { session, attached: new Map() });
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
      browserSessionId: stored.sessionId,
      attached: new Map()
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
    const mode = this.#mode();
    const execKey = this.#execKey(executionId);

    if (mode === "reuse") {
      return this.#ensureStoredSession(this.#reuseKey());
    }

    // one-shot / dynamic: a session this execution already opened wins.
    const existing = await this.#readStored(execKey);
    if (existing) {
      if (existing.closedAt === undefined && (await this.#isAlive(existing))) {
        // Keep the entry fresh so the sweep backstop never reclaims an
        // active (or recently resumed) execution's session.
        if (Date.now() - existing.updatedAt >= EXEC_TOUCH_INTERVAL_MS) {
          await this.#touchStored(execKey, existing);
        }
        return existing;
      }
      await this.#deleteStoredEntry(execKey, existing.sessionId);
      throw new Error(
        `Browser session ${existing.sessionId} expired or was swept while this execution was paused — the run cannot continue. Start a new execution.`
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

    // Create a fresh per-execution session. The Browser Rendering call
    // happens outside the store lock; the lock only guards the commit, so
    // two concurrent tool calls for the same execution don't double-create
    // (the loser's session is deleted).
    return this.#createAndCommit(execKey);
  }

  /**
   * Get the stored session under `key`, validating and creating as needed.
   *
   * Network calls (the liveness probe, session creation) happen OUTSIDE the
   * store lock — locks wrap storage only, so a hung Browser Rendering call
   * can't serialize every other operation on this key. The lock is
   * re-acquired to commit, with a sessionId re-check to detect a concurrent
   * swap; on a swap the new entry is re-validated from the top.
   */
  async #ensureStoredSession(key: string): Promise<StoredBrowserSession> {
    const browser = this.#options.browser;
    if (!browser) throw new Error("BrowserConnector has no browser binding");
    const store = this.#store;

    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await store.get(key);
      if (!existing) return this.#createAndCommit(key);

      const alive = await this.#isAlive(existing);
      const lock = await store.acquireLock(key);
      try {
        const current = await store.get(key);
        if (current?.sessionId !== existing.sessionId) {
          // Entry was swapped while we probed — validate the new one.
          continue;
        }
        if (alive) {
          const refreshed = { ...current, updatedAt: Date.now() };
          await store.set(key, refreshed);
          return refreshed;
        }
        await store.delete(key);
      } finally {
        await lock.release();
      }
      // Dead entry deleted — the next iteration creates a fresh session.
    }
    throw new Error(
      `Browser session entry ${key} kept changing concurrently — retry`
    );
  }

  /**
   * Create a Browser Run session (outside any lock) and commit it under
   * `key`. If a concurrent caller committed first, their entry wins and the
   * redundant session is deleted best-effort.
   */
  async #createAndCommit(key: string): Promise<StoredBrowserSession> {
    const browser = this.#options.browser;
    if (!browser) throw new Error("BrowserConnector has no browser binding");
    const store = this.#store;

    const info = await createBrowserSession(browser, {
      keepAliveMs: this.#options.session?.keepAliveMs
    });
    const now = Date.now();
    const stored: StoredBrowserSession = {
      sessionId: info.sessionId,
      createdAt: now,
      updatedAt: now
    };

    const lock = await store.acquireLock(key);
    let winner: StoredBrowserSession | undefined;
    try {
      const raced = await store.get(key);
      if (raced) {
        winner = raced;
      } else {
        await store.set(key, stored);
      }
    } finally {
      await lock.release();
    }

    if (winner) {
      try {
        await deleteBrowserSession(browser, stored.sessionId);
      } catch (error) {
        console.warn(
          `[agents/browser] Failed to delete redundant Browser Run session ${stored.sessionId}`,
          error
        );
      }
      return winner;
    }
    return stored;
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
      if (exec && exec.closedAt === undefined) {
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
