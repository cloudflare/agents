import type { LifecycleJob, LifecycleJobs } from "../../lifecycle";

export const LEASE_FN = "lease";

export const DEFAULT_LEASE_TTL_MS = 60_000;

export const DEFAULT_STALL_LIMIT = 5;

export type LeaseKind = "admitting" | "claimed";

export type LeasePayload = {
  readonly session: string;
  readonly kind: LeaseKind;

  readonly position: number;

  readonly stalls: number;
};

export function leaseJobId(session: string): string {
  return `opencode:${session}`;
}

export function isLeaseJob(job: LifecycleJob): boolean {
  return job.fn === LEASE_FN;
}

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

  arm(
    session: string,
    kind: LeaseKind,
    position: number
  ): Promise<LifecycleJob> {
    const held = this.get(session);
    const next: LeaseKind =
      held?.kind === "claimed" || kind === "claimed" ? "claimed" : "admitting";

    // Re-arming during reconciliation must not erase the stall count from
    // the lease that is currently firing.
    const stalls = position > (held?.position ?? -1) ? 0 : (held?.stalls ?? 0);
    return this.#push(session, next, position, stalls);
  }

  async extend(session: string, position: number): Promise<void> {
    const job = this.#jobs.get(leaseJobId(session));
    const held = job ? leasePayload(job) : undefined;
    if (!held || !job) return;
    const remaining = job.time - Date.now();
    const progressed = position > held.position;
    if (remaining > this.#ttlMs / 2 && !progressed) return;
    await this.#push(session, held.kind, Math.max(position, held.position), 0);
  }

  renew(
    session: string,
    kind: LeaseKind,
    position: number,
    stalls: number
  ): Promise<LifecycleJob> {
    return this.#push(session, kind, position, stalls);
  }

  release(session: string): Promise<boolean> {
    return this.#jobs.cancel(leaseJobId(session));
  }

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
    // reschedule() moves only the due time; push() also stores the new
    // log position and stall count used by recovery.
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
