/**
 * transcript — contracts for the durable Log and the Engine services that own
 * it. The Log is ordered, branch-aware data; the Engine composes the deep
 * modules that append, claim/settle, reconcile, consume, and store referenced
 * blobs. Live streaming rides TurnDeps.write; there is no Steps sub-module
 * (ADR 0004).
 *
 * Must not know about: models, tools, channels, or context assembly. The
 * Engine sees opaque versioned payloads; only the reserved core kinds below
 * have engine-visible semantics.
 *
 * Implementer residue carried by CLIENTS of this module:
 * - handlers and consumers run at-least-once (residue 2)
 * - external effects need a claim before and a settle after (residue 1)
 * - payload schema evolution is theirs, forever (residue 5)
 *
 * Allowed imports: kernel.
 */

import type {
  BlobRef,
  BranchId,
  ClaimKey,
  ConsumerName,
  CorrelationId,
  EntryId,
  EntryRef,
  Json,
  Origin,
  ReconcilerName,
  RetryPolicy,
  Seq,
  StepId,
  TurnId,
  Versioned
} from "./kernel";

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export interface Entry<P extends Versioned = Versioned> {
  readonly ref: EntryRef;
  readonly at: number; // epoch ms, engine-assigned
  readonly origin: Origin;
  /** The turn whose execution produced this entry, if any. */
  readonly turn?: TurnId;
  /**
   * Correlates an entry with an earlier one across time — a late tool result
   * with its call, a channel delivery receipt with the message it delivered,
   * a subagent completion with the entry that spawned it.
   */
  readonly correlation?: CorrelationId;
  readonly payload: P;
}

/** What callers hand to append(); the engine assigns ref/at. */
export interface NewEntry<P extends Versioned = Versioned> {
  readonly origin: Origin;
  readonly turn?: TurnId;
  readonly correlation?: CorrelationId;
  readonly payload: P;
}

// ---------------------------------------------------------------------------
// Core payload vocabulary
// ---------------------------------------------------------------------------
// Modules add their own kinds under a "<module>/" namespace. Only the kinds
// below carry engine-visible semantics.

/**
 * "tool" is the carrier role for messages holding tool-result parts —
 * first-class so LanguageModel adapters can map results to their provider's
 * tool-message format without a smuggling convention (amended per ADR 0004).
 */
export type Role = "user" | "assistant" | "system" | "tool";

export type Part =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: Json;
    }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly output: Json | BlobRef;
      readonly isError?: boolean;
    }
  | { readonly type: "file"; readonly file: BlobRef; readonly name?: string }
  | { readonly type: "data"; readonly name: string; readonly data: Json };

export interface MessagePayload extends Versioned {
  readonly kind: "message";
  readonly v: 1;
  readonly role: Role;
  readonly parts: readonly Part[];
}

/** Written via Ledger.claim() — never appended directly. */
export interface EffectClaimedPayload extends Versioned {
  readonly kind: "effect/claimed";
  readonly v: 1;
  readonly key: ClaimKey;
  /** Namespaced effect type, e.g. "tool/send_email", "channel/telegram". */
  readonly effect: string;
  readonly input: Json | BlobRef;
  readonly inputDigest: string;
}

export type SettleOutcome =
  | { readonly status: "ok"; readonly output: Json | BlobRef }
  | {
      readonly status: "error";
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly status: "aborted"; readonly reason?: string }
  /** Reconciler gave up within policy; terminal, distinguishable from error. */
  | { readonly status: "expired"; readonly reason: string };

/** Written via Ledger.settle() — never appended directly. */
export interface EffectSettledPayload extends Versioned {
  readonly kind: "effect/settled";
  readonly v: 1;
  readonly key: ClaimKey;
  readonly result: SettleOutcome;
}

/**
 * Turn bookkeeping stamped around step commits. A cold reader can reconstruct
 * execution state from the log alone — the log is the snapshot.
 */
export interface TurnMarkerPayload extends Versioned {
  readonly kind: "turn/marker";
  readonly v: 1;
  readonly marker:
    | "admitted"
    | "step-committed"
    | "parked"
    | "completed"
    | "failed";
  readonly turnId: TurnId;
  readonly step?: StepId;
  readonly attempt: number;
  readonly detail?: Json;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export interface AppendOptions {
  readonly branch?: BranchId;
  /**
   * Same key + same content ⇒ the original refs are returned and nothing is
   * written. This IS the durable inbox: Think's submitMessages() collapses to
   * append-with-idempotency.
   */
  readonly idempotencyKey?: string;
  /** Optimistic concurrency: fail if the branch head has moved. */
  readonly expectedHead?: EntryRef;
}

export type AppendResult =
  | { readonly outcome: "committed"; readonly refs: readonly EntryRef[] }
  | { readonly outcome: "duplicate"; readonly refs: readonly EntryRef[] }
  | { readonly outcome: "conflict"; readonly head: EntryRef };

// ---------------------------------------------------------------------------
// Bounded reading and tailing
// ---------------------------------------------------------------------------

/**
 * Closed, indexable dimensions for a bounded newest-first LogView query.
 * Runtime invariant: at least one of after, before, or limit MUST be present.
 */
export interface Query {
  readonly kinds?: readonly string[];
  readonly correlation?: CorrelationId;
  readonly turn?: TurnId;
  /** Sequence floor, exclusive — the resume cursor. */
  readonly after?: Seq;
  /** Sequence ceiling, exclusive. */
  readonly before?: Seq;
  /** Count cap. Results remain newest-first. */
  readonly limit?: number;
}

/** Build a query for all entries after an exclusive sequence floor. */
export declare function since(seq: Seq): Query;
/** Build a query for entries strictly between two sequence bounds. */
export declare function between(after: Seq, before: Seq): Query;
/** Build a query for the newest entries of one kind (one by default). */
export declare function latest(kind: string, n?: number): Query;
/** Validate and build a bounded query from the closed Query representation. */
export declare function window(query: Query): Query;

/** Read-only projection of one branch's committed entries. */
export interface LogView {
  readonly branch: BranchId;
  head(): Promise<EntryRef | null>;
  get(id: EntryId): Promise<Entry | null>;
  getBlob(ref: BlobRef): Promise<ReadableStream<Uint8Array>>;
  /** Always bounded and newest-first; rejects an unbounded query at runtime. */
  query(q: Query): Promise<readonly Entry[]>;
}

/**
 * Deliberate unbounded escape hatch for export, debugging, and migration.
 * Results are streamed oldest-first.
 */
export interface LogExport {
  scan(branch: BranchId, from?: Seq): AsyncIterable<Entry>;
}

/** Ephemeral in-flight output of the currently executing step. */
export interface LiveChunk {
  readonly turn: TurnId;
  readonly step: StepId;
  readonly chunk: Json;
}

export type TailEvent =
  | { readonly type: "entry"; readonly entry: Entry }
  | { readonly type: "chunk"; readonly chunk: LiveChunk };

export interface TailOptions {
  readonly branch?: BranchId;
  readonly from?: Seq;
  readonly filter?: Pick<Query, "kinds" | "correlation" | "turn">;
  /** Include ephemeral live chunks (default false: committed entries only). */
  readonly live?: boolean;
}

/**
 * Durable, named, at-least-once delivery cursor. Generalizes every outbox in
 * the current system (workflow notices, channel delivery, client replay).
 * A batch not acked before failure WILL be redelivered.
 */
export interface DurableConsumer {
  readonly name: ConsumerName;
  pull(max?: number): Promise<{
    entries: readonly Entry[];
    cursor: Seq;
  } | null>;
  ack(cursor: Seq): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ledger: effect claims, settlement, and reconciliation liveness
// ---------------------------------------------------------------------------

export interface ClaimRequest {
  readonly key: ClaimKey;
  readonly effect: string;
  readonly input: Json | BlobRef;
  readonly origin: Origin;
  readonly turn?: TurnId;
  /**
   * The correlation an out-of-band settlement will carry, for effects that
   * outlive their call (pending tools, subagents, workflows). Claims are born
   * correlated so the runtime can resolve an arriving settlement entry to its
   * claim via openClaimByCorrelation (ADR 0004).
   */
  readonly correlation?: CorrelationId;
  /** After this long unsettled, the matching reconciler is invoked. */
  readonly reconcileAfterMs: number;
  readonly reconciler: ReconcilerName;
}

/**
 * The action-ledger semantics, as one return type:
 * - acquired        → you own the effect; execute it, then settle.
 * - duplicate-open  → someone claimed and hasn't settled; do NOT execute.
 * - already-settled → replay; here is the recorded result, use it.
 */
export type ClaimDecision =
  | { readonly outcome: "acquired"; readonly entry: EntryRef }
  | {
      readonly outcome: "duplicate-open";
      readonly entry: EntryRef;
      readonly claimedAt: number;
    }
  | { readonly outcome: "already-settled"; readonly result: SettleOutcome };

export interface ReconcileDeps {
  readonly claim: Entry<EffectClaimedPayload>;
  /** 1-based; increments per invocation for the same claim. At-least-once. */
  readonly attempt: number;
  readonly policy: RetryPolicy;
  readonly view: LogView;
}

/**
 * Both non-terminal outcomes re-invoke the handler later — the Ledger cannot
 * execute effects itself, so "doing it again" happens inside handle(). The
 * difference is budgetary: "retry" counts against policy.maxAttempts (a stuck
 * effect eventually expires); "wait" does not (waiting on a slow external
 * signal should not burn the retry budget).
 */
export type ReconcileOutcome =
  | { readonly action: "retry"; readonly afterMs?: number }
  | { readonly action: "settle"; readonly result: SettleOutcome }
  | { readonly action: "wait"; readonly afterMs: number };

/**
 * Registered under a STABLE name — names are persisted with claims and must
 * survive deploys.
 */
export interface Reconciler {
  readonly policy: RetryPolicy;
  handle(deps: ReconcileDeps): Promise<ReconcileOutcome>;
}

/** Double-entry effect recording plus its reconciliation-liveness half. */
export interface Ledger {
  claim(req: ClaimRequest): Promise<ClaimDecision>;
  settle(key: ClaimKey, result: SettleOutcome): Promise<void>;
  /** Open claims form the recovery worklist (a claim/settle anti-join). */
  openClaims(filter?: {
    effectPrefix?: string;
  }): Promise<readonly Entry<EffectClaimedPayload>[]>;
  /**
   * Resolve an arriving out-of-band settlement to its claim: the open claim
   * (if any) born with this correlation (ADR 0004). The claim's key is in the
   * returned payload.
   */
  openClaimByCorrelation(
    correlation: CorrelationId
  ): Promise<Entry<EffectClaimedPayload> | null>;
  /** Registration is per-wake and code-defined; the NAME is durable. */
  reconciler(name: ReconcilerName, reconciler: Reconciler): void;
}

// ---------------------------------------------------------------------------
// Engine sub-modules
// ---------------------------------------------------------------------------
// Steps/StepHandle were removed (ADR 0004): TurnDeps.commit + write are the
// shared step-agnostic primitives; a harness stamps its own markers into
// commit batches. "Step" survives as vocabulary (StepId, turn/marker.step),
// not as an engine service.

export interface Consumers {
  consumer(
    name: ConsumerName,
    opts?: { filter?: Pick<Query, "kinds" | "correlation" | "turn"> }
  ): DurableConsumer;
}

export interface Blobs {
  putBlob(
    data: ReadableStream<Uint8Array> | Uint8Array,
    meta: { mediaType: string }
  ): Promise<BlobRef>;
  getBlob(ref: BlobRef): Promise<ReadableStream<Uint8Array>>;
}

// ---------------------------------------------------------------------------
// Log data and Engine composition
// ---------------------------------------------------------------------------

/** The durable, ordered, branch-aware sequence of Entries. Data only. */
export interface Log {
  readonly root: BranchId;
}

/**
 * Behavioral service composition that owns a Log and wires its deep
 * sub-modules. Callers should receive only the sub-module they need.
 */
export interface Engine {
  readonly log: Log;
  readonly ledger: Ledger;
  readonly consumers: Consumers;
  readonly blobs: Blobs;
  readonly export: LogExport;

  append(
    entries: readonly NewEntry[],
    opts?: AppendOptions
  ): Promise<AppendResult>;
  view(branch?: BranchId): LogView;
  tail(opts?: TailOptions): AsyncIterable<TailEvent>;
  /** Non-destructive branch at an entry (regeneration, what-if, sub-lines). */
  fork(at: EntryRef): Promise<BranchId>;
}
