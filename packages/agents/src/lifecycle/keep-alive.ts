/**
 * Keep a Durable Object awake while in-memory work runs.
 *
 * A Durable Object with no incoming events is evicted after a minute or two,
 * dropping work that runs outside a request (a stream pump, a detached
 * promise). While at least one hold is open, KeepAlive keeps one Lifecycle
 * job due every `intervalMs`, so an alarm fires and the object stays active.
 * The holds live in memory: an eviction drops them together with the work
 * they protected.
 */

import { LifecycleCapability } from "./capability";
import type { LifecycleJobContext, LifecycleJobOutcome } from "./job-queue";

/**
 * Default heartbeat interval: well inside the platform's idle eviction.
 *
 * @internal
 */
export const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 30_000;

/** Job ids are one namespace across owners, so this one names its owner. */
const HEARTBEAT_JOB_ID = "keep-alive:heartbeat";

/**
 * Options for {@link KeepAlive}.
 *
 * @internal
 */
export type KeepAliveOptions = {
  /** Milliseconds between heartbeats while a hold is open. Default: 30,000. */
  readonly intervalMs?: number;
};

/**
 * Holds that keep a Durable Object awake, as one heartbeat job.
 *
 * In a sub-agent the heartbeat is a job in the sub-agent's own queue, which
 * its root wakes like any other, so the whole tree stays awake.
 *
 * @internal
 */
export class KeepAlive extends LifecycleCapability {
  readonly #intervalMs: number;
  #holds = 0;

  constructor(options: KeepAliveOptions = {}) {
    super("keep-alive");
    this.#intervalMs = options.intervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
  }

  /** Open holds on this object. */
  get holds(): number {
    return this.#holds;
  }

  /**
   * Open a hold. Returns a function that releases it; calling that function
   * again does nothing.
   */
  async acquire(): Promise<() => void> {
    await this.#open();
    return this.#once(() => this.#close());
  }

  /** Run `fn` with a hold open, releasing it when `fn` settles. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The heartbeat: due again while holds are open, gone otherwise. */
  onJob(_context: LifecycleJobContext): LifecycleJobOutcome {
    return this.#holds > 0
      ? { rescheduleAt: Date.now() + this.#intervalMs }
      : undefined;
  }

  /** Count a hold; a hold whose heartbeat could not be armed is not counted. */
  async #open(): Promise<void> {
    this.#holds += 1;
    if (this.#holds > 1) return;
    try {
      await this.lifecycle.jobs.push({
        id: HEARTBEAT_JOB_ID,
        fn: "heartbeat",
        time: Date.now() + this.#intervalMs
      });
    } catch (error) {
      this.#holds -= 1;
      throw error;
    }
  }

  async #close(): Promise<void> {
    this.#holds = Math.max(0, this.#holds - 1);
    if (this.#holds === 0) await this.lifecycle.jobs.cancel(HEARTBEAT_JOB_ID);
  }

  /** A release function that runs once and reports its own failure. */
  #once(release: () => Promise<void>): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release().catch((error: unknown) => {
        console.error("[KeepAlive] Failed to release a hold:", error);
      });
    };
  }
}
