/**
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !! WARNING: EXPERIMENTAL — DO NOT USE IN PRODUCTION                  !!
 * !!                                                                   !!
 * !! This API is under active development and WILL break between       !!
 * !! releases. Method names, types, behavior, and the mixin signature  !!
 * !! are all subject to change without notice.                         !!
 * !!                                                                   !!
 * !! If you use this, pin your agents version and expect to rewrite    !!
 * !! your code when upgrading.                                         !!
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *
 * Experimental fiber mixin for durable long-running execution.
 *
 * Usage:
 *   import { Agent } from "agents";
 *   import { withFibers } from "agents/experimental/forever";
 *
 *   class MyAgent extends withFibers(Agent)<Env, State> {
 *     async doWork(payload, fiberCtx) { ... }
 *   }
 *
 * This mixin adds:
 * - keepAlive() — keep the DO alive via scheduled heartbeats
 * - spawnFiber() — fire-and-forget durable execution
 * - stashFiber() — checkpoint progress that survives eviction
 * - cancelFiber() / getFiber() — manage running fibers
 * - onFiberComplete / onFiberRecovered / onFibersRecovered — lifecycle hooks
 *
 * @experimental This API is not yet stable and may change.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import type { Agent } from "../index";

console.warn(
  "[agents/experimental/forever] WARNING: You are using an experimental API that WILL break between releases. Do not use in production."
);

// ── Types ─────────────────────────────────────────────────────────────

export type FiberState = {
  id: string;
  callback: string;
  payload: unknown;
  snapshot: unknown | null;
  status: "running" | "completed" | "failed" | "interrupted" | "cancelled";
  retryCount: number;
  maxRetries: number;
  result: unknown | null;
  error: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  createdAt: number;
};

export type FiberRecoveryContext = {
  id: string;
  methodName: string;
  payload: unknown;
  snapshot: unknown | null;
  retryCount: number;
};

export type FiberContext = {
  id: string;
  snapshot: unknown | null;
  retryCount: number;
};

export type FiberCompleteContext = {
  id: string;
  methodName: string;
  payload: unknown;
  result: unknown;
};

// ── Internal types ────────────────────────────────────────────────────

type RawFiberRow = {
  id: string;
  callback: string;
  payload: string | null;
  snapshot: string | null;
  status: string;
  retry_count: number;
  max_retries: number;
  result: string | null;
  error: string | null;
  started_at: number | null;
  updated_at: number | null;
  completed_at: number | null;
  created_at: number;
};

// ── Constants ─────────────────────────────────────────────────────────

const KEEP_ALIVE_INTERVAL_MS = 10_000;
const FIBER_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const FIBER_CLEANUP_COMPLETED_MS = 24 * 60 * 60 * 1000;
const FIBER_CLEANUP_FAILED_MS = 7 * 24 * 60 * 60 * 1000;

const fiberContext = new AsyncLocalStorage<{ fiberId: string }>();

// ── Mixin ─────────────────────────────────────────────────────────────

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<
  Pick<
    Agent<Cloudflare.Env>,
    "sql" | "scheduleEvery" | "cancelSchedule" | "alarm"
  >
>;

export function withFibers<TBase extends AgentLike>(
  Base: TBase,
  options?: { debugFibers?: boolean }
) {
  const debugEnabled = options?.debugFibers ?? false;

  class FiberAgent extends Base {
    // ── Fiber state ───────────────────────────────────────────────

    /** @internal */ _fiberActiveFibers = new Set<string>();
    /** @internal */ _fiberRecoveryInProgress = false;
    /** @internal */ _fiberLastCleanupTime = 0;

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor
    constructor(...args: any[]) {
      super(...args);

      // Create the fibers table
      (this as unknown as Agent<Cloudflare.Env>).sql`
        CREATE TABLE IF NOT EXISTS cf_agents_fibers (
          id TEXT PRIMARY KEY NOT NULL,
          callback TEXT NOT NULL,
          payload TEXT,
          snapshot TEXT,
          status TEXT NOT NULL DEFAULT 'running'
            CHECK(status IN ('running', 'completed', 'failed', 'interrupted', 'cancelled')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          result TEXT,
          error TEXT,
          started_at INTEGER,
          updated_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `;
    }

    // ── Debug logging ─────────────────────────────────────────────

    /** @internal */ _fiberDebug(msg: string, ...args: unknown[]) {
      if (debugEnabled) {
        console.debug(`[fiber] ${msg}`, ...args);
      }
    }

    // ── Heartbeat callback ────────────────────────────────────────

    // Note: TypeScript `private` is compile-time only. The scheduler
    // dispatches callbacks by string name (`this[row.callback]`),
    // which works at runtime. The name is stable (stored in SQLite).
    /** @internal */ async _cf_fiberHeartbeat() {
      await this._checkInterruptedFibers();
    }

    // ── Public API ────────────────────────────────────────────────

    async keepAlive(): Promise<() => void> {
      const heartbeatSeconds = Math.ceil(KEEP_ALIVE_INTERVAL_MS / 1000);
      const schedule = await (
        this as unknown as Agent<Cloudflare.Env>
      ).scheduleEvery(
        heartbeatSeconds,
        "_cf_fiberHeartbeat" as keyof Agent<Cloudflare.Env>
      );

      this._fiberDebug("keepAlive started, schedule=%s", schedule.id);

      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        this._fiberDebug("keepAlive disposed, schedule=%s", schedule.id);
        void this.cancelSchedule(schedule.id);
      };
    }

    spawnFiber(
      methodName: keyof this,
      payload?: unknown,
      options?: { maxRetries?: number }
    ): string {
      this._maybeCleanupFibers();

      const name = methodName as string;
      if (typeof this[methodName] !== "function") {
        throw new Error(`this.${name} is not a function`);
      }

      const id = nanoid();
      const now = Date.now();
      const maxRetries = options?.maxRetries ?? 3;

      (this as unknown as Agent<Cloudflare.Env>).sql`
        INSERT INTO cf_agents_fibers (id, callback, payload, status, max_retries, retry_count, started_at, updated_at, created_at)
        VALUES (${id}, ${name}, ${JSON.stringify(payload ?? null)}, 'running', ${maxRetries}, 0, ${now}, ${now}, ${now})
      `;

      this._fiberActiveFibers.add(id);
      this._fiberDebug(
        "spawned fiber=%s method=%s maxRetries=%d",
        id,
        name,
        maxRetries
      );

      void this._startFiber(id, name, payload, maxRetries).catch((e) => {
        console.error(`Unhandled error in fiber ${id}:`, e);
      });

      return id;
    }

    stashFiber(data: unknown): void {
      const ctx = fiberContext.getStore();
      if (!ctx) {
        throw new Error(
          "stashFiber() can only be called within a fiber execution context"
        );
      }
      const now = Date.now();
      (this as unknown as Agent<Cloudflare.Env>).sql`
        UPDATE cf_agents_fibers
        SET snapshot = ${JSON.stringify(data)}, updated_at = ${now}
        WHERE id = ${ctx.fiberId}
      `;
      this._fiberDebug("stash fiber=%s", ctx.fiberId);
    }

    /**
     * Note: cancellation is cooperative. The status is set to 'cancelled'
     * in SQLite, and the _runFiber retry loop checks for this status at
     * the top of each iteration.
     */
    cancelFiber(fiberId: string): boolean {
      const fiber = this._getRawFiber(fiberId);
      if (!fiber) return false;
      if (
        fiber.status === "completed" ||
        fiber.status === "failed" ||
        fiber.status === "cancelled"
      ) {
        return false;
      }

      const now = Date.now();
      (this as unknown as Agent<Cloudflare.Env>).sql`
        UPDATE cf_agents_fibers
        SET status = 'cancelled', updated_at = ${now}
        WHERE id = ${fiberId}
      `;
      this._fiberActiveFibers.delete(fiberId);
      this._fiberDebug("cancelled fiber=%s", fiberId);
      return true;
    }

    getFiber(fiberId: string): FiberState | null {
      const raw = this._getRawFiber(fiberId);
      if (!raw) return null;
      return this._toFiberState(raw);
    }

    restartFiber(fiberId: string): void {
      const fiber = this._getRawFiber(fiberId);
      if (!fiber) {
        throw new Error(`Fiber ${fiberId} not found`);
      }

      const now = Date.now();
      (this as unknown as Agent<Cloudflare.Env>).sql`
        UPDATE cf_agents_fibers
        SET status = 'running', started_at = ${now}, updated_at = ${now}
        WHERE id = ${fiberId}
      `;

      this._fiberActiveFibers.add(fiberId);
      this._fiberDebug(
        "restarting fiber=%s method=%s retryCount=%d",
        fiberId,
        fiber.callback,
        fiber.retry_count
      );

      const parsedPayload = fiber.payload
        ? JSON.parse(fiber.payload)
        : undefined;

      void this._startFiber(
        fiberId,
        fiber.callback,
        parsedPayload,
        fiber.max_retries
      ).catch((e) => {
        console.error(`Error restarting fiber ${fiberId}:`, e);
      });
    }

    // ── Lifecycle hooks (override in subclass) ────────────────────

    /**
     * Manually trigger fiber recovery check.
     * In production, this runs automatically via the heartbeat schedule.
     * Useful for testing or when you need immediate recovery after
     * detecting an eviction.
     */
    async checkFibers(): Promise<void> {
      await this._checkInterruptedFibers();
    }

    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
    onFiberComplete(_ctx: FiberCompleteContext): void | Promise<void> {}

    onFiberRecovered(ctx: FiberRecoveryContext): void | Promise<void> {
      this.restartFiber(ctx.id);
    }

    async onFibersRecovered(fibers: FiberRecoveryContext[]): Promise<void> {
      for (const fiber of fibers) {
        await this.onFiberRecovered(fiber);
      }
    }

    // ── Private implementation ────────────────────────────────────

    /** @internal */ _getRawFiber(fiberId: string): RawFiberRow | null {
      const result = (this as unknown as Agent<Cloudflare.Env>)
        .sql<RawFiberRow>`
        SELECT * FROM cf_agents_fibers WHERE id = ${fiberId}
      `;
      return result && result.length > 0 ? result[0] : null;
    }

    /** @internal */ _safeJsonParse(value: string | null): unknown {
      if (value === null) return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }

    /** @internal */ _toFiberState(raw: RawFiberRow): FiberState {
      return {
        id: raw.id,
        callback: raw.callback,
        payload: this._safeJsonParse(raw.payload),
        snapshot: this._safeJsonParse(raw.snapshot),
        status: raw.status as FiberState["status"],
        retryCount: raw.retry_count,
        maxRetries: raw.max_retries,
        result: this._safeJsonParse(raw.result),
        error: raw.error,
        startedAt: raw.started_at,
        updatedAt: raw.updated_at,
        completedAt: raw.completed_at,
        createdAt: raw.created_at
      };
    }

    /** @internal */ async _startFiber(
      id: string,
      methodName: string,
      payload: unknown,
      maxRetries: number
    ): Promise<void> {
      const disposeKeepAlive = await this.keepAlive();
      await this._runFiber(
        id,
        methodName,
        payload,
        maxRetries,
        disposeKeepAlive
      );
    }

    /** @internal */ async _runFiber(
      id: string,
      methodName: string,
      payload: unknown,
      maxRetries: number,
      disposeKeepAlive: () => void
    ): Promise<void> {
      try {
        while (true) {
          const fiber = this._getRawFiber(id);
          if (!fiber || fiber.status === "cancelled") {
            this._fiberDebug(
              "fiber=%s exiting: %s",
              id,
              !fiber ? "not found" : "cancelled"
            );
            return;
          }

          try {
            await fiberContext.run({ fiberId: id }, async () => {
              const snapshot = this._safeJsonParse(fiber.snapshot);
              const retryCount = fiber.retry_count;

              const callback = this[methodName as keyof this];
              if (typeof callback !== "function") {
                throw new Error(`Fiber method ${methodName} not found`);
              }

              const result = await (
                callback as (p: unknown, ctx: FiberContext) => Promise<unknown>
              ).call(this, payload, { id, snapshot, retryCount });

              const now = Date.now();
              (this as unknown as Agent<Cloudflare.Env>).sql`
                UPDATE cf_agents_fibers
                SET status = 'completed',
                    result = ${JSON.stringify(result ?? null)},
                    completed_at = ${now},
                    updated_at = ${now}
                WHERE id = ${id}
              `;

              this._fiberDebug("fiber=%s completed method=%s", id, methodName);

              try {
                await this.onFiberComplete({
                  id,
                  methodName,
                  payload,
                  result
                });
              } catch (e) {
                console.error("Error in onFiberComplete:", e);
              }
            });

            return;
          } catch (e) {
            const now = Date.now();
            const currentFiber = this._getRawFiber(id);
            const newRetryCount = (currentFiber?.retry_count ?? 0) + 1;

            if (newRetryCount > maxRetries) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              (this as unknown as Agent<Cloudflare.Env>).sql`
                UPDATE cf_agents_fibers
                SET status = 'failed',
                    error = ${errorMsg},
                    retry_count = ${newRetryCount},
                    updated_at = ${now}
                WHERE id = ${id}
              `;
              this._fiberDebug(
                "fiber=%s failed after %d retries: %s",
                id,
                newRetryCount,
                errorMsg
              );
              return;
            }

            (this as unknown as Agent<Cloudflare.Env>).sql`
              UPDATE cf_agents_fibers
              SET retry_count = ${newRetryCount}, updated_at = ${now}
              WHERE id = ${id}
            `;
            this._fiberDebug(
              "fiber=%s retrying (%d/%d)",
              id,
              newRetryCount,
              maxRetries
            );
            continue;
          }
        }
      } finally {
        this._fiberActiveFibers.delete(id);
        disposeKeepAlive();
      }
    }

    /** @internal */ async _checkInterruptedFibers(): Promise<void> {
      if (this._fiberRecoveryInProgress) return;
      this._fiberRecoveryInProgress = true;

      try {
        const runningFibers = (this as unknown as Agent<Cloudflare.Env>)
          .sql<RawFiberRow>`
          SELECT * FROM cf_agents_fibers
          WHERE status = 'running'
          ORDER BY created_at ASC
        `;

        if (!runningFibers || runningFibers.length === 0) return;

        const interrupted: FiberRecoveryContext[] = [];

        for (const fiber of runningFibers) {
          if (this._fiberActiveFibers.has(fiber.id)) continue;

          const newRetryCount = fiber.retry_count + 1;
          const now = Date.now();

          if (newRetryCount > fiber.max_retries) {
            (this as unknown as Agent<Cloudflare.Env>).sql`
              UPDATE cf_agents_fibers
              SET status = 'failed',
                  error = 'max retries exceeded (eviction recovery)',
                  retry_count = ${newRetryCount},
                  updated_at = ${now}
              WHERE id = ${fiber.id}
            `;
            this._fiberDebug(
              "fiber=%s max retries exceeded on recovery",
              fiber.id
            );
          } else {
            (this as unknown as Agent<Cloudflare.Env>).sql`
              UPDATE cf_agents_fibers
              SET status = 'interrupted',
                  retry_count = ${newRetryCount},
                  updated_at = ${now}
              WHERE id = ${fiber.id}
            `;

            interrupted.push({
              id: fiber.id,
              methodName: fiber.callback,
              payload: this._safeJsonParse(fiber.payload),
              snapshot: this._safeJsonParse(fiber.snapshot),
              retryCount: newRetryCount
            });
          }
        }

        if (interrupted.length > 0) {
          this._fiberDebug(
            "recovering %d interrupted fibers",
            interrupted.length
          );

          this._cleanupOrphanedHeartbeats();

          try {
            await this.onFibersRecovered(interrupted);
          } catch (e) {
            console.error("Error in onFibersRecovered:", e);
          }
        }
      } finally {
        this._fiberRecoveryInProgress = false;
      }
    }

    /** @internal */ _cleanupOrphanedHeartbeats() {
      (this as unknown as Agent<Cloudflare.Env>).sql`
        DELETE FROM cf_agents_schedules
        WHERE callback = '_cf_fiberHeartbeat'
      `;
      this._fiberDebug("cleaned up orphaned heartbeat schedules");
    }

    /** @internal */ _maybeCleanupFibers() {
      const now = Date.now();
      if (now - this._fiberLastCleanupTime < FIBER_CLEANUP_INTERVAL_MS) {
        return;
      }
      this._fiberLastCleanupTime = now;

      const completedCutoff = now - FIBER_CLEANUP_COMPLETED_MS;
      const failedCutoff = now - FIBER_CLEANUP_FAILED_MS;

      (this as unknown as Agent<Cloudflare.Env>).sql`
        DELETE FROM cf_agents_fibers
        WHERE (status = 'completed' AND completed_at < ${completedCutoff})
           OR (status = 'failed' AND updated_at < ${failedCutoff})
           OR (status = 'cancelled' AND updated_at < ${completedCutoff})
      `;

      this._fiberDebug(
        "cleanup: checked for old completed/failed/cancelled fibers"
      );
    }
  }

  return FiberAgent;
}

// ── Standalone keepAlive ──────────────────────────────────────────────

/**
 * Keep a Durable Object alive via a scheduled heartbeat.
 * Returns a disposer function that cancels the heartbeat.
 *
 * Standalone version usable by any Agent subclass without requiring
 * the full fiber mixin. The agent must have a no-op method with the
 * given callbackName for the scheduler to invoke.
 *
 * @param agent - The agent instance (must have scheduleEvery and cancelSchedule)
 * @param callbackName - Name of a no-op method on the agent class (must exist)
 */
export async function keepAlive(
  agent: Pick<Agent<Cloudflare.Env>, "scheduleEvery" | "cancelSchedule">,
  callbackName: string
): Promise<() => void> {
  const heartbeatSeconds = Math.ceil(KEEP_ALIVE_INTERVAL_MS / 1000);
  const schedule = await agent.scheduleEvery(
    heartbeatSeconds,
    callbackName as keyof Agent<Cloudflare.Env>
  );

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    void agent.cancelSchedule(schedule.id);
  };
}
