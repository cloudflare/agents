import type { Workspace } from "@cloudflare/workspace";
import type { ToolSet } from "ai";
import {
  beginContainerActivity,
  endContainerActivity,
  renewContainerActivity,
  type PoolEnv
} from "./pool";

const DEFAULT_LEASE_MS = 20 * 60 * 1000;
const DEFAULT_RENEW_MS = 60 * 1000;

export type RunOutcome =
  | { status: "done" }
  | { status: "error"; error: string };

export function classifyRunOutcome(input: {
  status: "completed" | "error" | "aborted";
  assistantText: string;
  error?: string;
}): RunOutcome {
  if (input.status === "completed" && input.assistantText.trim().length > 0) {
    return { status: "done" };
  }
  return {
    status: "error",
    error:
      input.error ??
      (input.assistantText.trim().length === 0
        ? "Turn ended without a final assistant report (step budget exhausted)."
        : `Turn ended with status ${input.status}.`)
  };
}

export class RunLifecycleError extends Error {
  readonly _tag = "RunLifecycleError";

  constructor(
    readonly operation: "start" | "renew" | "workspace" | "finish",
    readonly cause: unknown
  ) {
    super(`Run lifecycle ${operation} failed: ${String(cause)}`);
  }
}

export interface RunLifecycleOptions {
  env: PoolEnv;
  sessionId: string;
  workspace: Workspace;
  reportTerminal(outcome: RunOutcome): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
  fork(effect: Promise<unknown>): void;
  leaseMs?: number;
  renewMs?: number;
}

/**
 * Owns all resources for one durable agent run.
 *
 * Interface invariants:
 * - `start()` acquires/renews the container assignment lease.
 * - `withWorkspace()` is scoped: every successful acquire has a finally-release,
 *   and the final concurrent user closes all Workspace RPC streams.
 * - `finish()` is idempotent and best-effort: it closes transport before
 *   ending the lease, reports terminal status, logs cleanup failures, and never
 *   turns a completed agent run into an error because observability failed.
 * - an isolate lost without `finish()` leaves only a bounded lease, never a
 *   permanently pinned container.
 */
export class RunLifecycle {
  readonly #options: RunLifecycleOptions;
  readonly #leaseMs: number;
  readonly #renewMs: number;
  #leaseId: string | null = null;
  #renewTimer: ReturnType<typeof setInterval> | null = null;
  #workspaceUsers = 0;
  #phase: "idle" | "active" | "finishing" | "finished" = "idle";
  #finishPromise: Promise<void> | null = null;

  constructor(options: RunLifecycleOptions) {
    this.#options = options;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#renewMs = options.renewMs ?? DEFAULT_RENEW_MS;
  }

  async start(): Promise<void> {
    if (this.#phase === "finishing" && this.#finishPromise) {
      await this.#finishPromise;
    }
    if (this.#phase === "idle" || this.#phase === "finished") {
      this.#phase = "active";
      this.#finishPromise = null;
      this.#leaseId = crypto.randomUUID();
    }
    const leaseId = this.#leaseId;
    if (leaseId === null) {
      throw new RunLifecycleError("start", "lease id was not initialized");
    }
    try {
      await beginContainerActivity(
        this.#options.env,
        this.#options.sessionId,
        leaseId,
        this.#leaseMs
      );
    } catch (cause) {
      throw new RunLifecycleError("start", cause);
    }

    if (this.#renewTimer !== null) return;
    this.#renewTimer = setInterval(() => {
      this.#options.fork(
        this.renew().catch((error) =>
          this.#options.log("lease-renew-error", {
            error: String(error).slice(0, 300)
          })
        )
      );
    }, this.#renewMs);
  }

  async renew(): Promise<void> {
    const leaseId = this.#leaseId;
    if (leaseId === null) return;
    try {
      const renewed = await renewContainerActivity(
        this.#options.env,
        this.#options.sessionId,
        leaseId,
        this.#leaseMs
      );
      if (!renewed) throw new Error("active container lease was lost");
    } catch (cause) {
      throw new RunLifecycleError("renew", cause);
    }
  }

  scopeTools(tools: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute) return [name, definition];
        return [
          name,
          {
            ...definition,
            execute: (input: unknown, options: unknown) =>
              this.withWorkspace(() =>
                Promise.resolve(
                  execute(input as never, options as never) as unknown
                )
              )
          }
        ];
      })
    ) as ToolSet;
  }

  async withWorkspace<A>(use: () => Promise<A>): Promise<A> {
    await this.start();
    this.#workspaceUsers++;
    let value: A | undefined;
    let useError: unknown;
    try {
      value = await use();
    } catch (error) {
      useError = error;
    }

    let releaseError: unknown;
    this.#workspaceUsers--;
    if (this.#workspaceUsers === 0) {
      try {
        await this.#options.workspace.close();
        await this.renew();
      } catch (error) {
        releaseError = error;
      }
    }

    if (useError !== undefined && releaseError !== undefined) {
      throw new RunLifecycleError(
        "workspace",
        new AggregateError([useError, releaseError])
      );
    }
    if (useError !== undefined) throw useError;
    if (releaseError !== undefined) {
      throw new RunLifecycleError("workspace", releaseError);
    }
    return value as A;
  }

  finish(outcome: RunOutcome): Promise<void> {
    if (this.#phase === "finished") return Promise.resolve();
    if (this.#phase === "finishing" && this.#finishPromise) {
      return this.#finishPromise;
    }
    this.#phase = "finishing";
    const pending = this.#finish(outcome).finally(() => {
      this.#phase = "finished";
    });
    this.#finishPromise = pending;
    return pending;
  }

  async #finish(outcome: RunOutcome): Promise<void> {
    if (this.#renewTimer !== null) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = null;
    }
    const leaseId = this.#leaseId;
    this.#leaseId = null;

    const cleanupErrors: unknown[] = [];
    try {
      await this.#options.workspace.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (leaseId !== null) {
      try {
        await endContainerActivity(
          this.#options.env,
          this.#options.sessionId,
          leaseId
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await this.#options.reportTerminal(outcome);
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      this.#options.log("run-lifecycle-finish-error", {
        errors: cleanupErrors.map((error) => String(error).slice(0, 300))
      });
    }
  }
}
