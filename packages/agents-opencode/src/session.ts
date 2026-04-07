import { getSandbox, parseSSEStream, type Sandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  type OpencodeServer
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Config } from "@opencode-ai/sdk/v2";

import type {
  ProviderCredentials,
  AllProviderCredentials,
  ResolvedProvider,
  OpenCodeRunOutput,
  OpenCodeRunOptions,
  OpenCodeSessionState
} from "./types";
import {
  resolveProviders,
  detectProviders,
  describeRequiredEnvVars
} from "./providers";
import { OpenCodeStreamAccumulator } from "./stream";
import { FileWatcher, type FileChangeCallback } from "./file-watcher";
import {
  backupSession,
  restoreSession,
  updateSessionState,
  type RestoreResult
} from "./backup";

/**
 * Manages the full lifecycle of an OpenCode agent session inside a
 * sandbox container. This is the main entry point for the library.
 *
 * Responsibilities:
 * - Sandbox provisioning and lifecycle
 * - OpenCode server/client startup and credential registration
 * - One-shot runs (prompt → async generator of snapshots)
 * - File change observation during runs
 * - Backup/restore of sandbox FS + OpenCode session state
 * - Resumption of in-flight runs after eviction
 *
 * Usage:
 * ```ts
 * const session = new OpenCodeSession(env.Sandbox, agentName);
 * await session.start(env, storage);
 *
 * for await (const snapshot of session.run("Build a TODO app")) {
 *   // snapshot is OpenCodeRunOutput with UIMessage[] etc.
 * }
 * ```
 */
export class OpenCodeSession<S extends Sandbox<unknown> = Sandbox<unknown>> {
  #sandboxBinding: DurableObjectNamespace<S>;
  #sandboxName: string;
  #sandbox: S | null = null;
  #server: OpencodeServer | null = null;
  #client: OpencodeClient | null = null;
  #provider: ResolvedProvider | null = null;
  #started = false;
  #currentSessionId: string | null = null;
  #runInFlight = false;
  #runPrompt: string | null = null;
  #fileWatcher = new FileWatcher();

  constructor(sandboxBinding: DurableObjectNamespace<S>, sandboxName: string) {
    this.#sandboxBinding = sandboxBinding;
    this.#sandboxName = sandboxName;
  }

  /** The underlying sandbox instance. Available after `start()`. */
  get sandbox(): S {
    if (!this.#sandbox) {
      this.#sandbox = getSandbox(this.#sandboxBinding, this.#sandboxName);
    }
    return this.#sandbox;
  }

  /** Whether the session has been started. */
  get isStarted(): boolean {
    return this.#started;
  }

  /** The current OpenCode session ID, if any. */
  get currentSessionId(): string | null {
    return this.#currentSessionId;
  }

  /** Whether a run is currently in-flight. */
  get isRunning(): boolean {
    return this.#runInFlight;
  }

  /** Whether the file watcher is active. */
  get isWatching(): boolean {
    return this.#fileWatcher.isRunning;
  }

  /**
   * Start the session: wake the sandbox, detect/resolve the provider,
   * start the OpenCode server, and restore any previous state.
   *
   * @param env - Environment bindings (must include provider credentials)
   * @param storage - DO storage for backup/restore
   * @param options - Optional overrides:
   *   - `credentials`: Explicit provider credentials; if not provided,
   *     auto-detects from env vars.
   *   - `userConfig`: Partial OpenCode config from the user, merged
   *     recursively on top of auto-detected config. Takes precedence.
   *     If `userConfig.model` is set (e.g. `"anthropic/claude-sonnet-4"`),
   *     it also determines the default provider.
   */
  async start(
    env: Record<string, unknown>,
    storage: DurableObjectStorage,
    options?: {
      credentials?: ProviderCredentials[];
      userConfig?: Partial<Config>;
    }
  ): Promise<RestoreResult> {
    if (this.#started) return { fsRestored: false, sessionState: null };
    this.#started = true;

    await this.sandbox.exec("true");

    const userModel = options?.userConfig?.model;
    const allCreds: AllProviderCredentials | null = options?.credentials
      ? {
          credentials: options.credentials,
          defaultProvider: options.credentials[0].provider
        }
      : detectProviders(env, userModel);

    if (!allCreds || allCreds.credentials.length === 0) {
      throw new Error(
        `No provider credentials found.\n${describeRequiredEnvVars()}`
      );
    }
    this.#provider = resolveProviders(allCreds, options?.userConfig);

    const result = await restoreSession(this.sandbox, storage);

    await this.#ensureOpenCode();

    if (result.sessionState) {
      this.#currentSessionId = result.sessionState.sessionId;
      this.#runInFlight = result.sessionState.runInFlight;
      this.#runPrompt = result.sessionState.runPrompt ?? null;
    }

    return result;
  }

  /**
   * Ensure the OpenCode server and client are running inside the sandbox.
   *
   * This is separate from `start()` because the OpenCode process may need
   * to be re-established independently — for example after a container
   * eviction and restore cycle where `start()` was already called but the
   * sandbox process was recycled. Keeping it as an idempotent helper lets
   * `run()` call it defensively without duplicating the setup logic.
   */
  async #ensureOpenCode(): Promise<OpencodeClient> {
    if (this.#client && this.#server) {
      return this.#client;
    }

    if (!this.#provider) {
      throw new Error("Provider not resolved — call start() first");
    }

    const { client, server } = await createOpencode<OpencodeClient>(
      this.sandbox,
      {
        directory: "/workspace",
        config: this.#provider.config,
        env: this.#provider.env
      }
    );

    for (const auth of this.#provider.auths) {
      await client.auth.set(auth);
    }

    this.#server = server;
    this.#client = client;
    return client;
  }

  #errorOutput(sessionId: string, error: string): OpenCodeRunOutput {
    return {
      status: "error",
      sessionId,
      messages: [],
      filesEdited: [],
      fileChanges: [],
      diffs: [],
      diagnostics: [],
      processes: [],
      todos: [],
      error
    };
  }

  /**
   * Run a one-shot prompt against the OpenCode agent. Returns an async
   * generator that yields `OpenCodeRunOutput` snapshots as the agent
   * works — each containing the growing `UIMessage[]` sub-conversation.
   *
   * The final yield has `status: "complete"` or `status: "error"`.
   */
  async *run(
    prompt: string,
    options?: OpenCodeRunOptions
  ): AsyncGenerator<OpenCodeRunOutput> {
    const client = await this.#ensureOpenCode();

    let sessionId: string;

    if (options?.sessionId) {
      // Reuse an existing session
      sessionId = options.sessionId;
    } else {
      // Create a new session
      const session = await client.session.create({
        title: prompt.slice(0, 80)
      });

      if (!session.data) {
        yield this.#errorOutput(
          "",
          `Failed to create OpenCode session: ${JSON.stringify(session.error ?? session)}`
        );
        return;
      }

      sessionId = session.data.id;
    }

    this.#currentSessionId = sessionId;
    this.#runInFlight = true;
    this.#runPrompt = prompt;

    const accumulator = new OpenCodeStreamAccumulator(sessionId);

    yield accumulator.getSnapshot();

    const server = this.#server;
    if (!server) {
      yield this.#errorOutput(sessionId, "OpenCode server not running");
      return;
    }

    const sseResp = await this.sandbox.containerFetch(
      new Request(`${server.url}/event`),
      server.port
    );
    if (!sseResp.ok || !sseResp.body) {
      yield this.#errorOutput(
        sessionId,
        `Event stream failed: ${sseResp.status} ${sseResp.statusText}`
      );
      return;
    }

    await client.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: prompt }]
    });

    const INACTIVITY_TIMEOUT_MS = 120_000;
    const THROTTLE_MS = 200;
    const BACKUP_INTERVAL_MS = options?.backupIntervalMs ?? 30_000;
    let lastYieldAt = Date.now();
    let lastBackupAt = Date.now();
    let backupInFlight = false;

    const cancelStream = () => {
      try {
        const body = sseResp.body;
        if (body) {
          body.cancel();
        }
      } catch {
        /* stream already closing */
      }
    };

    let inactivityTimer = setTimeout(cancelStream, INACTIVITY_TIMEOUT_MS);

    try {
      for await (const ev of parseSSEStream<{
        type: string;
        properties?: Record<string, unknown>;
      }>(sseResp.body, options?.signal)) {
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(cancelStream, INACTIVITY_TIMEOUT_MS);

        accumulator.processEvent(ev);

        const now = Date.now();
        if (accumulator.dirty && now - lastYieldAt >= THROTTLE_MS) {
          yield accumulator.getSnapshot();
          lastYieldAt = now;
        }

        if (
          options?.storage &&
          now - lastBackupAt >= BACKUP_INTERVAL_MS &&
          !backupInFlight
        ) {
          lastBackupAt = now;
          backupInFlight = true;
          this.backup(options.storage)
            .catch((err) =>
              console.warn("[opencode/session] Periodic backup failed:", err)
            )
            .finally(() => {
              backupInFlight = false;
            });
        }

        if (
          accumulator.status === "complete" ||
          accumulator.status === "error"
        ) {
          break;
        }
      }
    } catch (err) {
      if (accumulator.status === "working") {
        accumulator.processEvent({
          type: "session.error",
          properties: {
            sessionID: sessionId,
            error: err instanceof Error ? err.message : "Event stream failed"
          }
        });
      }
    }
    clearTimeout(inactivityTimer);

    this.#runInFlight = false;
    this.#runPrompt = null;

    if (options?.onComplete) {
      try {
        await options.onComplete();
      } catch (err) {
        console.warn("[opencode/session] onComplete callback failed:", err);
      }
    }

    yield accumulator.getSnapshot();
  }

  /**
   * Start watching /workspace for file changes.
   * The callback receives JSON-serialized ServerMessage strings.
   */
  startFileWatcher(onEvent: FileChangeCallback): void {
    if (!this.#started) return;
    this.#fileWatcher.start(this.sandbox, onEvent);
  }

  /** Stop the file watcher. */
  stopFileWatcher(): void {
    this.#fileWatcher.stop();
  }

  /**
   * Create a backup of the sandbox workspace and OpenCode session state.
   */
  async backup(storage: DurableObjectStorage): Promise<void> {
    const sessionState: OpenCodeSessionState | undefined =
      this.#currentSessionId && this.#provider
        ? {
            sessionId: this.#currentSessionId,
            providerId: this.#provider.id,
            runInFlight: this.#runInFlight,
            runPrompt: this.#runPrompt ?? undefined
          }
        : undefined;

    await backupSession(this.sandbox, storage, sessionState);
  }

  /**
   * Update just the session state in DO storage (without a full FS backup).
   */
  async updateState(storage: DurableObjectStorage): Promise<void> {
    if (!this.#currentSessionId || !this.#provider) return;

    await updateSessionState(storage, {
      sessionId: this.#currentSessionId,
      providerId: this.#provider.id,
      runInFlight: this.#runInFlight,
      runPrompt: this.#runPrompt ?? undefined
    });
  }

  /**
   * Get context about the restored session state, suitable for
   * including in the agent's system prompt or next message.
   *
   * Returns null if there's nothing notable to report.
   */
  getRestoreContext(): string | null {
    if (!this.#runInFlight || !this.#runPrompt) return null;

    return [
      "<restore-context>",
      "The sandbox was restored from a backup.",
      `A previous OpenCode run was in-flight with prompt: "${this.#runPrompt}"`,
      "Any long-running processes (dev servers, watchers, etc.) that were",
      "running in the sandbox may need to be restarted.",
      "The OpenCode session has been reconnected.",
      "</restore-context>"
    ].join("\n");
  }
}
