/**
 * @internal Teardown that survives being cut short (#1625).
 *
 * `destroy()` is a run of storage deletes. On the `waitUntil` of a request
 * whose client already left (the MCP session DELETE), the runtime can cancel
 * it halfway. So the decision is written first, as a durable marker, and the
 * teardown itself runs in an alarm invocation with its own time budget. If
 * that is cut short too, the marker is still there and the next alarm
 * finishes the job. `deleteAll()` at the end of a teardown removes the
 * marker, so "marker present" always means an unfinished teardown.
 *
 * The marker is read before Lifecycle startup (the host's alarm preamble), so
 * a condemned object never re-initializes its state. It is only consulted on
 * alarms: a request that lands before the teardown alarm runs normally.
 */

import { LifecycleCapability } from "./capability";
import type { LifecycleJobOutcome } from "./job-queue";

/** KV key of the marker; unchanged from when Agent owned it. */
const DESTROY_PENDING_KEY = "cf_agents_destroy_pending";
const WAKE_JOB_ID = "deferred-destroy:wake";

/**
 * Delay before the teardown alarm. The caller (the MCP session DELETE) awaits
 * `schedule()` and then returns its response; an immediate alarm aborts the
 * isolate fast enough to race that response and turn a 204 into a 500
 * (seen in production, not in the local runtime).
 */
const DESTROY_ALARM_DELAY_MS = 1_000;

/** @internal The durable destroy marker and the alarm that acts on it. */
export class DeferredDestroy extends LifecycleCapability {
  constructor() {
    super("deferred-destroy");
  }

  /** Re-arm the wake for a marker left by a dead process. */
  async onStart(): Promise<void> {
    if (this.lifecycle.routes.source) return;
    const at = await this.pendingAt();
    if (at !== null) await this.#arm(at);
  }

  /** Condemn the object: write the marker, then arm an exclusive wake. */
  async schedule(): Promise<void> {
    const at = Date.now() + DESTROY_ALARM_DELAY_MS;
    await this.lifecycle.storage.put(DESTROY_PENDING_KEY, at);
    await this.#arm(at);
  }

  /** Record that a teardown has begun, before its first delete. */
  async begin(): Promise<void> {
    await this.lifecycle.storage.put(DESTROY_PENDING_KEY, true);
  }

  /**
   * When the pending teardown is due, or `null` with none. Reads storage
   * directly, so it works before startup.
   */
  async pendingAt(): Promise<number | null> {
    const pending = await this.lifecycle.storage.get<boolean | number>(
      DESTROY_PENDING_KEY
    );
    if (typeof pending === "number") return pending;
    return pending === true ? Date.now() : null;
  }

  /**
   * The host's alarm preamble consumes a pending teardown before the event
   * loop runs, so a wake that gets here is stale.
   */
  onJob(): LifecycleJobOutcome {
    return undefined;
  }

  async #arm(at: number): Promise<void> {
    // Exclusive: other jobs (a held keep-alive) cannot delay the teardown.
    await this.lifecycle.jobs.push({
      id: WAKE_JOB_ID,
      fn: "wake",
      time: at,
      exclusive: true
    });
  }
}
