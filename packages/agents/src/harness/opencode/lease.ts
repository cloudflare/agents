/**
 * The per-session lease.
 *
 * OpenCode already owns admission (its inbox),
 * the execution claim (`session.time_suspended`), replay (its boot sweep)
 * and retries. What it cannot do on a Durable Object is bring the object
 * back after an unplanned death — its run coordinator is a `Map` in memory,
 * and an evicted object has no memory.
 *
 * The lease is that one missing piece: a single Lifecycle job per session,
 * due at `now + ttl`, which an alarm fires if nothing else does. While a
 * turn is healthy the object stays resident on its own model calls, each
 * durable log event pushes the lease out, and the terminal event cancels
 * it — so the alarm never fires. It only fires after `ttl` of real silence,
 * which means the isolate died.
 *
 * What the lease must never do is conclude "idle" from in-memory state.
 * Only durable state (the inbox, the messages, the claim) can end it.
 */

import type { LifecycleJob, LifecycleJobs } from "../../lifecycle";

/** The job's `fn`. One lease job per session, dispatched on this. */
export const LEASE_FN = "lease";

/** Silence before the lease fires. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/** Fires with no log progress before the lease gives up. */
export const DEFAULT_STALL_LIMIT = 5;

/**
 * Why the lease is held.
 *
 * `admitting` — we are handing OpenCode work it may not have yet. The window
 * between our inbox write and its `session.execution.started`. A fire here
 * may need to re-send the prompt.
 *
 * `claimed` — OpenCode has published `started`, so the durable claim is set
 * and its own sweep will resume the turn after a restart. A fire here only
 * extends.
 */
export type LeaseKind = "admitting" | "claimed";

export type LeasePayload = {
  readonly session: string;
  readonly kind: LeaseKind;
  /** Log position at the last extend, for detecting progress. */
  readonly position: number;
  /** Consecutive fires that saw no progress. */
  readonly stalls: number;
};

export function leaseJobId(session: string): string {
  return `opencode:${session}`;
}

export function isLeaseJob(job: LifecycleJob): boolean {
  return job.fn === LEASE_FN;
}

/** The payload of a lease job, or undefined when it is not one. */
export function leasePayload(job: LifecycleJob): LeasePayload | undefined {
  if (!isLeaseJob(job)) return undefined;
  const payload = job.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const { session, kind, position, stalls } = payload as Record<
    string,
    unknown
  >;
  if (typeof session !== "string" || session.length === 0) return undefined;
  return {
    session,
    kind: kind === "claimed" ? "claimed" : "admitting",
    position: typeof position === "number" ? position : -1,
    stalls: typeof stalls === "number" ? stalls : 0
  };
}

/**
 * The lease for one capability's sessions.
 *
 * Every mutation goes through `jobs.push` with the session's stable id, so a
 * push made while the job is dispatching supersedes that dispatch's outcome.
 * That is what keeps a `submit` from being lost to a lease that is
 * completing.
 */
export class SessionLeases {
  readonly #jobs: LifecycleJobs;
  readonly #ttlMs: number;
  readonly #stallLimit: number;

  constructor(options: {
    readonly jobs: LifecycleJobs;
    readonly ttlMs?: number;
    readonly stallLimit?: number;
  }) {
    this.#jobs = options.jobs;
    this.#ttlMs = positive(options.ttlMs, DEFAULT_LEASE_TTL_MS, "lease.ttlMs");
    this.#stallLimit = positive(
      options.stallLimit,
      DEFAULT_STALL_LIMIT,
      "lease.stallLimit"
    );
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  get stallLimit(): number {
    return this.#stallLimit;
  }

  /** Every held lease, oldest due first. */
  list(): LeasePayload[] {
    const leases: LeasePayload[] = [];
    for (const job of this.#jobs.list()) {
      const payload = leasePayload(job);
      if (payload) leases.push(payload);
    }
    return leases;
  }

  get(session: string): LeasePayload | undefined {
    const job = this.#jobs.get(leaseJobId(session));
    return job ? leasePayload(job) : undefined;
  }

  /**
   * Hold the lease for a session.
   *
   * `claimed` is never downgraded to `admitting`: once OpenCode owns the
   * turn, a later `submit` must not make the lease think it still has a
   * prompt to hand over.
   */
  arm(
    session: string,
    kind: LeaseKind,
    position: number
  ): Promise<LifecycleJob> {
    const held = this.get(session);
    const next: LeaseKind =
      held?.kind === "claimed" || kind === "claimed" ? "claimed" : "admitting";
    // Arming must not wipe the stall count of a lease that is already held:
    // a fire calls reconcile (and so release/arm) before it decides whether
    // the lease has stalled, and that decision needs the count intact.
    const stalls = position > (held?.position ?? -1) ? 0 : (held?.stalls ?? 0);
    return this.#push(session, next, position, stalls);
  }

  /**
   * Push the lease out, but only when less than half its life is left.
   *
   * A turn publishes many durable events, and each one calls this. The
   * threshold keeps that to one storage write per `ttl / 2` instead of one
   * per event, while still guaranteeing the lease outlives any gap shorter
   * than `ttl`.
   */
  async extend(session: string, position: number): Promise<void> {
    const job = this.#jobs.get(leaseJobId(session));
    const held = job ? leasePayload(job) : undefined;
    if (!held || !job) return;
    const remaining = job.time - Date.now();
    const progressed = position > held.position;
    if (remaining > this.#ttlMs / 2 && !progressed) return;
    await this.#push(session, held.kind, Math.max(position, held.position), 0);
  }

  /** Re-time the lease after a fire, carrying the stall count forward. */
  renew(
    session: string,
    kind: LeaseKind,
    position: number,
    stalls: number
  ): Promise<LifecycleJob> {
    return this.#push(session, kind, position, stalls);
  }

  /** Drop the lease. The caller must have checked durable state first. */
  release(session: string): Promise<boolean> {
    return this.#jobs.cancel(leaseJobId(session));
  }

  /**
   * The stall count after a fire that found the session inactive.
   *
   * Progress is the log moving. A long silent tool keeps the session active
   * with no new events, so those fires must not count — otherwise the lease
   * would be dropped in the middle of the tool.
   */
  nextStalls(held: LeasePayload, position: number): number {
    return position > held.position ? 0 : held.stalls + 1;
  }

  stalled(stalls: number): boolean {
    return stalls >= this.#stallLimit;
  }

  #push(
    session: string,
    kind: LeaseKind,
    position: number,
    stalls: number
  ): Promise<LifecycleJob> {
    // `push` and not `reschedule`: the payload carries the log position and
    // the stall count, and `reschedule` only moves the due time.
    return this.#jobs.push({
      id: leaseJobId(session),
      fn: LEASE_FN,
      time: Date.now() + this.#ttlMs,
      payload: { session, kind, position, stalls } satisfies LeasePayload,
      singleflight: true,
      recoveryLoop: true
    });
  }
}

function positive(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`OpenCodeHarness ${name} must be a positive number`);
  }
  return value;
}
