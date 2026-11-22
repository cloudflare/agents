/**
 * Options for one {@link Approvals.once} call.
 *
 * @internal
 */
export type EffectOptions<T> = {
  /**
   * The effect's identity. One key runs once: a later call with the same
   * key, name and input gets the recorded value without running.
   */
  readonly key: string;
  /** What runs under the key. Part of the identity. */
  readonly name: string;
  /**
   * The effect's input. Hashed with a stable hash (object key order does not
   * matter). The same key with a different input is a conflict.
   */
  readonly input: unknown;
  /** The side effect. Its value must be JSON to be recorded. */
  readonly run: () => Promise<T> | T;
  /**
   * How old an unfinished claim must be before a call may take it over and
   * run again. Pass a number only when running the effect twice is safe
   * (the key is the caller's promise that it is). `false`, the default,
   * never takes a claim over: the call answers `in-doubt`.
   */
  readonly reclaimAfterMs?: number | false;
  /** Stored with the claim for inspection. Not part of the identity. */
  readonly context?: Record<string, unknown>;
};

/**
 * What {@link Approvals.once} did.
 *
 * @internal
 */
export type EffectOutcome<T> =
  /** This call ran the effect and recorded its value. */
  | { readonly status: "ran"; readonly value: T }
  /** The value was recorded earlier; the effect did not run. */
  | { readonly status: "replayed"; readonly value: T }
  /** A stale claim was taken over and the effect ran again. */
  | { readonly status: "reclaimed"; readonly value: T; readonly ageMs: number }
  /**
   * An earlier attempt claimed the key and never finished (its isolate
   * ended). The effect did not run: it may or may not have happened.
   */
  | { readonly status: "in-doubt"; readonly ageMs: number }
  /** The key was used before with another name or input. Nothing ran. */
  | { readonly status: "conflict" }
  /**
   * The effect ran but its value is not JSON, so nothing was recorded and
   * the claim was released: a later call runs it again.
   */
  | { readonly status: "unrecorded"; readonly value: T };

/**
 * A recorded effect, as {@link Approvals.effect} returns it.
 *
 * @internal
 */
export type EffectRecord = {
  readonly key: string;
  readonly name: string;
  readonly inputHash: string;
  /** `pending` while claimed and unfinished, `settled` once recorded. */
  readonly status: "pending" | "settled";
  /** The recorded value. `undefined` while pending. */
  readonly value: unknown;
  readonly context: Record<string, unknown> | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * Options for {@link Approvals.park}.
 *
 * @internal
 */
export type ParkOptions = {
  /** The decision's id. Default: generated, `decision_<uuid>`. */
  readonly id?: string;
  /** The host's label for what waits, e.g. `"action"`. */
  readonly kind: string;
  /** What the continuation needs to run. Must be JSON. */
  readonly subject: unknown;
  /** What a UI shows to whoever decides. Must be JSON. */
  readonly descriptor?: unknown;
};

/**
 * A decision someone made.
 *
 * @internal
 */
export type Verdict =
  | { readonly approved: true; readonly data?: unknown }
  | {
      readonly approved: false;
      readonly reason?: string;
      readonly data?: unknown;
    };

/**
 * Where a decision is.
 *
 * @internal
 */
export type DecisionStatus = "pending" | "decided" | "settled";

/**
 * A parked decision and what became of it.
 *
 * @internal
 */
export type Decision = {
  readonly id: string;
  readonly kind: string;
  readonly subject: unknown;
  readonly descriptor: unknown;
  /**
   * `pending` until someone decides, `decided` while the continuation runs,
   * `settled` once its outcome is recorded.
   */
  readonly status: DecisionStatus;
  readonly verdict: Verdict | undefined;
  /** The continuation's outcome, once settled. */
  readonly outcome: unknown;
  /** The continuation's failure, when it failed for good. */
  readonly error: string | undefined;
  /** Whether the host has taken the outcome up ({@link Approvals.acknowledge}). */
  readonly acknowledged: boolean;
  readonly createdAt: number;
  readonly decidedAt: number | undefined;
  readonly settledAt: number | undefined;
};

/**
 * What {@link Approvals.decide} did.
 *
 * @internal
 */
export type DecideResult =
  /** This call decided it; the continuation ran and its outcome is recorded. */
  | { readonly status: "settled"; readonly decision: Decision }
  /** Someone decided it before. The record says how and, once settled, what came of it. */
  | { readonly status: "already-decided"; readonly decision: Decision }
  | { readonly status: "not-found" };

/**
 * How long records are kept. `false` keeps them until deleted.
 *
 * @internal
 */
export type ApprovalsRetention = {
  /** Recorded effects. Deleting one ends the run-once guarantee for its key. Default: 30 days. */
  readonly effectSettledMs?: number | false;
  /** Unfinished effect claims. Keep it well above any `reclaimAfterMs`. Default: 90 days. */
  readonly effectPendingMs?: number | false;
  /** Decisions nobody made. Default: 30 days. */
  readonly decisionPendingMs?: number | false;
  /** Settled, acknowledged decisions. Default: 30 days. */
  readonly decisionSettledMs?: number | false;
  /** Rows deleted per sweep, per table. Default: 500. */
  readonly maxSweepRows?: number;
};

/**
 * Options for an {@link Approvals} capability.
 *
 * @internal
 */
export type ApprovalsOptions = {
  /**
   * Run what a decision lets go on, and return its outcome (JSON). Called
   * once per decided record until it returns, at least once across resets:
   * a reset after it ran and before its outcome was written runs it again,
   * so a side effect inside it belongs in {@link Approvals.once}. Runs in
   * host context.
   */
  readonly onDecided?: (decision: Decision) => Promise<unknown> | unknown;
  /**
   * Take a recorded outcome up. Called after the outcome is written, and
   * again after a reset until {@link Approvals.acknowledge} is called
   * (`redelivered` is then `true`). Runs in host context. If it throws, the
   * decision still counts as settled and the recovery job hands the outcome
   * off again. Without it, an outcome is acknowledged as soon as it is
   * recorded.
   */
  readonly onSettled?: (
    decision: Decision,
    delivery: { readonly redelivered: boolean }
  ) => Promise<void> | void;
  /**
   * Retention. A function, so a host can read its own fields when the
   * capability starts.
   */
  readonly retention?: () => ApprovalsRetention;
  /**
   * Whether `onStart` sweeps expired rows. Default `true`. A host that
   * imports older rows after startup sets `false` and calls `sweep()` once
   * they are in.
   */
  readonly sweepOnStart?: boolean;
  /**
   * How long a decided continuation may run before its recovery job treats
   * the isolate that ran it as gone. Default: 60 seconds. A continuation
   * still running in this isolate when the job fires is left to run and
   * checked again after the same interval, with no limit: give it its own
   * timeout.
   */
  readonly resumeAfterMs?: number;
};

/**
 * Events the capability emits on `lifecycle.events`.
 *
 * @internal
 */
export type ApprovalsEventType =
  | "approvals:effect:ran"
  | "approvals:effect:replayed"
  | "approvals:effect:reclaimed"
  | "approvals:effect:in-doubt"
  | "approvals:effect:conflict"
  | "approvals:effect:unrecorded"
  | "approvals:decision:parked"
  | "approvals:decision:decided"
  | "approvals:decision:settled"
  | "approvals:decision:failed"
  | "approvals:swept";
