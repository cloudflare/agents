/**
 * kernel — shared vocabulary for every module contract.
 *
 * Rules:
 * - This file imports nothing.
 * - Everything here is data: no behavior, no engine handles.
 * - Additions are cheap; renames and removals are breaking forever.
 *   Logs outlive code, so any type that appears inside a persisted
 *   payload is an eternal commitment (residue 5: schemas are forever).
 */

/** Nominal typing helper so the id spaces cannot be cross-assigned. */
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

/**
 * Placeholder for a JSON Schema document. Deliberately untyped beyond
 * "an object": the contract does not pick a schema library.
 */
export type JSONSchema = JsonObject;

// ---------------------------------------------------------------------------
// Id spaces
// ---------------------------------------------------------------------------

export type EntryId = Brand<string, "EntryId">;
export type BranchId = Brand<string, "BranchId">;
export type TurnId = Brand<string, "TurnId">;
export type StepId = Brand<string, "StepId">;
export type ClaimKey = Brand<string, "ClaimKey">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type ConsumerName = Brand<string, "ConsumerName">;
export type ReconcilerName = Brand<string, "ReconcilerName">;
export type BlobId = Brand<string, "BlobId">;

/** Per-branch position. Strictly monotonic; gaps allowed. */
export type Seq = number;

/** Stable address of a committed entry. */
export interface EntryRef {
  readonly branch: BranchId;
  readonly seq: Seq;
  readonly id: EntryId;
}

// ---------------------------------------------------------------------------
// Payload envelope
// ---------------------------------------------------------------------------

/**
 * Every durable payload names its kind and schema version.
 *
 * Kinds are namespaced `"<module>/<name>"` (`"message"` and the effect/turn
 * kinds in transcript.ts are the reserved core vocabulary). Readers MUST be
 * tolerant: unknown kinds are skipped, unknown fields ignored, and a payload
 * with a newer `v` than the reader understands is surfaced as opaque rather
 * than an error.
 */
export interface Versioned {
  readonly kind: string;
  readonly v: number;
}

/**
 * Reference to bytes stored outside the log. Large values (media, big tool
 * outputs) MUST travel by reference — inline payload size is capped by the
 * engine. This is the generalization of media eviction (#1710): the log stays
 * hydratable because bulk never enters it.
 */
export interface BlobRef {
  readonly blob: BlobId;
  readonly bytes: number;
  readonly mediaType: string;
  readonly digest?: string;
}

/** Who wrote an entry, e.g. { module: "channel", instance: "telegram" }. */
export interface Origin {
  readonly module: string;
  readonly instance?: string;
}

// ---------------------------------------------------------------------------
// Turns (the policy/reporting envelope over steps)
// ---------------------------------------------------------------------------

export type TurnStatus = "active" | "parked" | "completed" | "failed";

/**
 * One admission of work: the sequence of steps from a trigger entry until
 * quiescence. Execution and durability are per-step; concurrency policy,
 * budgets and telemetry speak in turns.
 */
export interface TurnInfo {
  readonly turnId: TurnId;
  readonly branch: BranchId;
  readonly trigger: EntryRef;
  readonly status: TurnStatus;
  /**
   * How many times execution of the current step has been (re)started.
   * Attempt numbers appear throughout the contracts as the standing reminder
   * that every handler runs at-least-once (residue 2).
   */
  readonly attempt: number;
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// Policies — declarations, not machinery (residue 4)
// ---------------------------------------------------------------------------

export interface Backoff {
  readonly initialMs: number;
  readonly factor: number;
  readonly maxMs: number;
}

/**
 * Bounded-retry declaration. Defaults should be mined from the current
 * production constants (attempt caps, no-progress windows, OOM budgets in
 * chat recovery) — they encode years of incident learning.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: Backoff;
  /** Seal work that shows no forward progress within this window (#1637 lineage). */
  readonly maxNoProgressMs?: number;
  /** Tighter budget for attempts that died in a memory-limit reset (#1825 lineage). */
  readonly maxOomAttempts?: number;
}

export interface TokenBudget {
  readonly maxInputTokens?: number;
  readonly reserveOutputTokens?: number;
}
