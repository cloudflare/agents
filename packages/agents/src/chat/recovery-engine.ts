/**
 * Shared chat-recovery engine (sibling-package support for `@cloudflare/ai-chat`
 * and `@cloudflare/think`). Owns the recovery orchestration both packages must
 * perform identically — scheduling policy and incident-begin sequencing — behind
 * a thin {@link ChatRecoveryAdapter} seam so the package-specific host I/O
 * (storage, clock, events, interaction predicate) stays in the package. See
 * `design/rfc-chat-recovery-foundation.md`.
 *
 * @internal Not a public API.
 */

import { ChatRecoverySupersededError } from "./turn-stop";
import type {
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ResolvedChatRecoveryConfig
} from "./lifecycle";
import type { ChatFiberSnapshot } from "./recovery";
import {
  interruptedTurnKind,
  planInterruptedTurn,
  type RecoveryLeaf
} from "./interrupted-turn";
import type { RecoveryAttemptHandle } from "./chat-turns";
import {
  handleRecoveryAttemptError,
  runRecoveredTurn
} from "./recovery-attempt";
import {
  routeStreamInterruption,
  scheduleRecoveredTurn
} from "./recovery-route";
import type {
  RecoveredTurnSchedule,
  StreamInterruptionHost,
  StreamInterruptionOutcome
} from "./recovery-route";
import { dispatchChatRecoveryToHandoff } from "./recovery-task";
import type {
  RecoveredTurnHost,
  RecoveredTurnResult,
  RecoveryAttemptData
} from "./recovery-attempt";
import {
  CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS,
  admitChatRecoveryAttempt,
  chatRecoveryIncidentId,
  chatRecoveryIncidentKey,
  evaluateChatRecoveryIncident,
  finishChatRecoveryAttempt,
  listActiveChatRecoveryIncidents,
  readChatRecoveryProgress,
  sweepStaleChatRecoveryIncidents
} from "./recovery-incident";
import type {
  ChatRecoveryAttempt,
  ChatRecoveryIncident,
  ChatRecoveryIncidentEvent,
  ChatRecoveryKind,
  ChatRecoveryTrigger
} from "./recovery-incident";

/** The scheduled-callback entrypoints a recovery schedule can target. */
export type ChatRecoveryScheduleCallback =
  | "_chatRecoveryContinue"
  | "_chatRecoveryRetry";

/**
 * Why a recovery callback is being scheduled. The idempotency of the
 * underlying Task run's `idempotencyKey` depends ONLY on this:
 *
 * - `"initial"` — the first schedule of a continuation/retry when an interrupted
 *   turn is detected on wake. A deploy rollout drops/reconnects the socket
 *   several times, re-triggering detection; idempotent scheduling (dedup on
 *   callback + payload) collapses that storm into a single enqueued continuation
 *   instead of N duplicates.
 *
 * - `"stable_timeout_retry"` — a reschedule issued from INSIDE the currently-
 *   executing recovery attempt (a continuation that timed out waiting for
 *   stable state). That attempt — a `__cf_internal_chat_recovery` Task run —
 *   settles only AFTER the callback returns, so an idempotent reschedule would
 *   dedup onto the doomed attempt and settle with it — the retry would never
 *   fire. A fresh (non-idempotent) delayed attempt survives.
 *
 * - `"chained_retry"` — the next attempt, scheduled from inside an executing
 *   recovery attempt that was interrupted again. Non-idempotent for the same
 *   reason as `"stable_timeout_retry"`.
 */
export type ChatRecoveryScheduleReason =
  | "initial"
  | "stable_timeout_retry"
  | "chained_retry"
  | "redefer";

/**
 * A reconstructed orphaned-stream partial. The engine seam is deliberately
 * **wire-vocabulary-agnostic**: `text` is the accumulated assistant text and
 * `parts` is OPAQUE to the engine (`unknown[]`) — each host casts it back to its
 * own message-part vocabulary (AI SDK `UIMessage` parts, AG-UI tool parts, …).
 * The single fact the engine needs about parts — does the partial carry settled
 * (non-idempotent) tool work that must survive a `{ persist: false }` recovery
 * (#1631)? — is precomputed by the {@link ChatRecoveryCodec} as
 * `hasSettledToolResults`. So the engine never imports a part vocabulary; the
 * codec owns it (see `partialHasSettledToolResults` in `recovery-codec.ts` for
 * the AI SDK codec's implementation of that predicate).
 */
export type RecoveryPartial = {
  text: string;
  parts: unknown[];
  hasSettledToolResults: boolean;
};

/** Lifecycle status of a recovered stream's metadata row. */
export type ChatStreamStatus = "streaming" | "completed" | "error";

/** Identity + context for opening (or re-evaluating) a recovery incident. */
export interface BeginChatRecoveryIncidentInput {
  requestId: string;
  recoveryRootRequestId?: string | null;
  latestUserMessageId?: string | null;
  recoveryKind: ChatRecoveryKind;
  /**
   * Why the incident is being opened: the replay of a turn run whose isolate
   * died (`interrupted`), or a stall a live isolate caught (`stalled`). Only
   * a replay can count against `maxInterruptedAttempts`, and only a replay
   * records itself as the attempt in flight.
   */
  trigger: "interrupted" | "stalled";
  /** Test-only clock injection for deterministic debounce/window timing. */
  nowMs?: number;
}

export interface BeginChatRecoveryIncidentResult {
  incident: ChatRecoveryIncident;
  config: ResolvedChatRecoveryConfig;
  exhausted: boolean;
  /**
   * The attempt this opening recorded as in flight (an `interrupted` trigger
   * on an incident that is not sealed), for the caller to finish. `null`
   * when nothing was recorded.
   */
  attempt: ChatRecoveryAttempt | null;
  /**
   * A user stopped the turn while it was being routed here: the incident
   * ends `skipped` with `user_cancelled`, and the caller ends the turn as
   * stopped. `exhausted` is then `false` and `attempt` `null`.
   */
  stopped?: boolean;
}

/**
 * Package-specific host operations the engine drives during incident
 * orchestration. Every method is a thin pass-through to the package's existing
 * storage / clock / event / interaction primitives — the engine owns only the
 * *sequence*, not the I/O.
 */
export interface ChatRecoveryAdapter {
  /** Resolve the effective recovery config (defaults + caller overrides). */
  resolveConfig(): ResolvedChatRecoveryConfig;
  /** Wall clock; only consulted when the input carries no test `nowMs`. */
  now(): number;
  /** Evict incidents past the TTL. Runs before the existing-record read. */
  sweepStaleIncidents(now: number): Promise<void>;
  /** Read the persisted incident for `key`, or `null` if none. */
  getIncident(key: string): Promise<ChatRecoveryIncident | null>;
  /**
   * Optional: rehydrate any state the interaction predicate depends on. Invoked
   * after the existing-incident read and BEFORE `isAwaitingClientInteraction`.
   * `Think` uses this to restore client tools from durable storage on a cold
   * boot-recovery wake (so a HITL turn is not misread as stuck); `AIChatAgent`
   * has no such state and omits it.
   */
  ensureInteractionStateLoaded?(): void;
  /** Monotonic forward-progress marker for the no-progress budget. */
  readProgress(): Promise<number>;
  /**
   * Whether the turn is parked on a pending CLIENT interaction (waiting on the
   * human, not stuck). When true the engine keeps the incident budget-free.
   * Optional: a host with no client-interaction/HITL substrate (e.g. the pi
   * fixture) omits it and the engine treats the turn as never parked (`false`).
   */
  isAwaitingClientInteraction?(): boolean;
  /**
   * Optional: list the live (not yet terminalized) incidents. Required for
   * {@link ChatRecoveryEngine.cancelScheduledRecovery}; a host that omits it
   * cannot cancel a scheduled recovery.
   */
  listActiveIncidents?(): Promise<ChatRecoveryIncident[]>;
  /** Persist the evaluated incident under `key`. */
  putIncident(key: string, incident: ChatRecoveryIncident): Promise<void>;
  /**
   * Recovery picked up the cut-off turn of these requests: the turn is
   * recovery's now. Durable admission drops their records
   * (`ChatTurns.turnAccepted`), which a reset between the turn's fiber and
   * the record's delete can leave. Optional.
   */
  turnRecovered?(requestIds: string[]): void;
  /**
   * A recovery ended, or a wake found nothing more to do: the requests
   * queued behind the turn it recovered can run
   * (`ChatTurns.resumeAdmissions`). Called outside the attempt's scope.
   * Optional.
   */
  recoverySettled?(): void;
  /**
   * Resolve once every write issued so far is durably confirmed (Durable
   * Object `storage.sync()`). {@link ChatRecoveryEngine.beginIncident} waits
   * on it before returning: the attempt that follows can run in the same
   * invocation, and a memory-limit reset discards writes that were not yet
   * confirmed, which would lose the interruption count (#2613).
   */
  syncStorage(): Promise<void>;
  /**
   * Delete the incident record under `key`. The engine calls this on the
   * terminal `completed` transition (a completed recovery is never retried, so
   * its record is dropped rather than left in storage forever).
   */
  deleteIncident(key: string): Promise<void>;
  /** Broadcast a lifecycle event produced by the evaluation or a transition. */
  emitRecoveryEvent(event: ChatRecoveryIncidentEvent): void;
  /**
   * Enqueue a recovery callback. The engine owns the surrounding orchestration
   * and the package chooses its durable transport: a Task for a root chat agent,
   * or the temporary routed-schedule fallback for a dynamic agent. `reason`
   * selects deduplication and `delaySeconds` is `0` initially or the stable
   * retry delay for a chained attempt.
   */
  scheduleRecovery(
    callback: ChatRecoveryScheduleCallback,
    data: Record<string, unknown>,
    reason: ChatRecoveryScheduleReason,
    delaySeconds: number,
    /**
     * Keys a retried enqueue of one replacement attempt, so a retry joins the
     * run an earlier try already created. Only set for `"redefer"`.
     */
    dedupeKey?: string
  ): Promise<void>;
  /**
   * What the engine needs from the host's turn machinery to run a recovery
   * attempt and route a live stream interruption. Hosts that only use the
   * incident bookkeeping omit it.
   */
  turns?: ChatRecoveryTurnBindings;
  /**
   * Set or clear the live "recovering…" status (#1620). The engine calls this on
   * the incident transitions: `scheduled` → active (keyed by the recovery-root
   * request id, falling back to the incident's request id), and
   * `completed`/`skipped`/`failed` → cleared. The package owns the underlying
   * staleness / idempotency / broadcast I/O.
   */
  setRecovering(active: boolean, requestId?: string): Promise<void>;
  /**
   * Report a throw from the caller's `shouldKeepRecovering` hook. Optional: a
   * host that does not surface this diagnostic omits it (the engine swallows the
   * report).
   */
  onShouldKeepRecoveringError?(error: unknown): void;
  /**
   * Terminalize a given-up recovery turn: deliver the exhaustion notification
   * plus the package-owned terminal record / banner / submission writes. A thin
   * pass-through to the package's `_exhaustChatRecovery` (which composes
   * {@link runChatRecoveryExhaustion}). Driven by
   * {@link ChatRecoveryEngine.exhaustRecoveryGiveUp}; the engine owns the
   * surrounding read → re-entry-guard → build → terminalize → seal sequence, the
   * package owns the terminal writes (uniformly broadcast-first; their set
   * differs — `Think` also writes a submission row).
   */
  exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    partial: RecoveryPartial,
    streamId: string,
    createdAt: number,
    /**
     * The fiber snapshot's origin ids (#2280). A restored pre-stream turn has
     * no stream row or live request to recover them from otherwise.
     */
    originMessageIds?: string[]
  ): Promise<void>;
  /**
   * Resolve the orphaned stream identity for a (recovery-root) request id —
   * `streamId` is `""` when no stream metadata survives. Drives BOTH the wake
   * path (which consumes the full {@link ResolvedRecoveryStream}) and the
   * give-up path (which reads only `.streamId`). A thin pass-through to the
   * package's stream-metadata lookup: the newest row keyed by the request id,
   * else the live active stream.
   */
  resolveRecoveryStream(requestId: string): ResolvedRecoveryStream;
  /** Reconstruct the partial text/parts buffered for `streamId`. */
  getPartialStreamText(streamId: string): RecoveryPartial;
  /**
   * The in-flight recovery-root request id, consulted as a fallback in the
   * give-up root-id chain when the payload carries no `originalRequestId` /
   * `recoveredRequestId` and no incident record survives. `undefined` when no
   * recovery chain is active. Optional: the engine keeps the id itself
   * ({@link ChatRecoveryEngine.activeRootRequestId}) for hosts that run their
   * attempts through {@link ChatRecoveryEngine.runRecoveredTurn}.
   */
  activeChatRecoveryRootRequestId?(): string | undefined;
  /**
   * Report a tolerated best-effort bookkeeping failure during give-up: the
   * incident `"read"` (before synthesizing) or the sealing `"seal"` write
   * (after terminalization). Neither aborts terminalization — see
   * {@link ChatRecoveryEngine.exhaustRecoveryGiveUp}.
   */
  onGiveUpBookkeepingError(phase: "read" | "seal", error: unknown): void;
}

/** What a recovery attempt's async scope holds. */
export type ChatRecoveryAttemptScope = {
  /** The attempt's incident, when its payload names one. */
  incidentId?: string;
  /** The root request id of the attempt's chain. */
  rootRequestId?: string;
  /** The schedule this delivery of the attempt is for, when it has one. */
  delivery?: number;
};

/** The host's turn machinery, as the engine uses it. */
export interface ChatRecoveryTurnBindings {
  /** Prefix for the host's log lines, such as `[Think]`. */
  label: string;
  /** `ChatTurns.beginRecoveryAttempt`. */
  beginRecoveryAttempt(
    rootRequestId: string | undefined
  ): RecoveryAttemptHandle;
  /** The host's `waitUntilStable`. Resolves `false` on timeout. */
  waitUntilStable(timeoutMs: number): Promise<boolean>;
  /**
   * Durably record that a request ended with `errorText`, so a client that
   * was away learns the outcome when it reconnects (#1645).
   */
  recordTerminalError(requestId: string, errorText: string): Promise<void>;
  /**
   * Tell the tabs that a request recovery took over ended `skipped`: the
   * recovered turn found nothing to do. Optional: without it the tab that
   * waits on the request learns only that recovery is over.
   */
  endSkippedRequest?(requestId: string): void;
  /** Close agent-tool child runs a recovered turn settled. */
  reconcileAgentToolChildRuns(): Promise<void>;
  /** Keep a detached recovered turn inside the current alarm's domain. */
  trackAlarmWork(turn: Promise<void>): void;
  /**
   * An async-context scope (an `AsyncLocalStorage<ChatRecoveryAttemptScope>`)
   * the engine runs a recovery attempt in. Only code that runs inside it,
   * the attempt and the turn it starts, belongs to the attempt. A turn some
   * other request started while the attempt waits does not. The host creates
   * it, so this module needs no Node import.
   */
  attemptScope: {
    run<T>(attempt: ChatRecoveryAttemptScope, fn: () => T): T;
    getStore(): ChatRecoveryAttemptScope | undefined;
    exit<T>(fn: () => T): T;
  };
  /** The latest stored message: what a continuation turn continues. */
  latestMessage(): { id: string; role: string } | undefined;
  /**
   * An async-context scope (an `AsyncLocalStorage<string[] | undefined>`)
   * the engine runs a recovery callback in, holding the message ids the
   * interrupted request came from (#2280). The recovered turn runs under a
   * fresh request id, and the host reads the scope to stamp those ids on its
   * frames. A concurrent client request is outside the scope and never
   * inherits them.
   */
  originMessageIdsScope: {
    run<T>(originMessageIds: string[] | undefined, fn: () => T): T;
    getStore(): string[] | undefined;
    exit<T>(fn: () => T): T;
  };
  /**
   * The body of each recovery callback: one attempt. It calls
   * `onTurnStarted` once the model turn begins.
   */
  attempts: Record<
    ChatRecoveryScheduleCallback,
    (
      data: Record<string, unknown> | undefined,
      onTurnStarted: () => void
    ) => Promise<void>
  >;
}

/** Resolved orphaned-stream identity for a recovered chat turn. */
export interface ResolvedRecoveryStream {
  /** The orphaned stream id, or `""` when no stream metadata survives. */
  streamId: string;
  /**
   * Whether the orphaned stream is still the live in-flight stream (so its
   * partial has not already been persisted + completed by an ACK-driven
   * reconnect). Gates persistence and stream completion.
   */
  streamStillActive: boolean;
  /**
   * The stream metadata row's lifecycle status, when the host tracks it
   * (`Think`). `undefined` for hosts that do not model terminal streams
   * (`AIChatAgent`) — those keep every terminal-stream branch dead, per the
   * "substrate capabilities are optional" decision in the RFC.
   */
  streamStatus?: ChatStreamStatus;
}

/** Input to {@link ChatFiberWakeHooks.invokeOnChatRecovery}. */
export interface InvokeOnChatRecoveryInput {
  incident: ChatRecoveryIncident;
  recoveryKind: ChatRecoveryKind;
  recoveryRootRequestId: string;
  requestId: string;
  streamId: string;
  partial: RecoveryPartial;
  snapshot: ChatFiberSnapshot | null;
  recoveryData: unknown;
  createdAt: number;
}

/** Input to {@link ChatFiberWakeHooks.shouldPersistOrphanedPartial}. */
export interface PersistOrphanedPartialInput {
  streamId: string;
  streamStillActive: boolean;
  streamStatus?: ChatStreamStatus;
  snapshot: ChatFiberSnapshot | null;
}

/**
 * A chat turn whose isolate died before it finished, as its record left it.
 *
 * @internal
 */
export interface InterruptedChatTurn {
  /** The turn's request id. */
  requestId: string;
  /** The snapshot taken when the turn started, or `null` when none survived. */
  snapshot: ChatFiberSnapshot | null;
  /** What the turn last passed to `stash()`, or `null`. */
  recoveryData: unknown;
  /** When the turn's run was created. */
  createdAt: number;
}

/**
 * The host operations the engine drives when it recovers an interrupted chat
 * turn. Kept SEPARATE from {@link ChatRecoveryAdapter} (and passed per call to
 * {@link ChatRecoveryEngine.recoverInterruptedTurn}) so the incident/give-up
 * adapter stays focused.
 *
 * The engine owns the LIFECYCLE (stream → partial → kind → begin-incident →
 * exhausted-branch → onChatRecovery → persist → complete → plan → schedule or
 * skip → catch→failed), the shared persist clause and the plan
 * (`planInterruptedTurn`); these hooks own the package-specific I/O.
 */
export interface ChatFiberWakeHooks {
  /**
   * The latest stored message. Read before the incident opens, for the kind
   * it is opened with, and again after the partial was stored, for the plan.
   */
  latestMessage(): RecoveryLeaf | Promise<RecoveryLeaf>;
  /**
   * Whether what the turn streamed holds anything that would be stored, by
   * the host's rules for what a stored reply drops.
   */
  partialHoldsContent(partial: RecoveryPartial): boolean;
  /**
   * Build the package's `ChatRecoveryContext` and invoke the user `onChatRecovery`
   * hook, returning its (defaulted) options. The engine wraps this in the
   * incident `failed`-on-throw guard. Optional: a host with no user
   * `onChatRecovery` surface (e.g. the pi fixture) omits it and the engine
   * proceeds with empty options (`{}`).
   */
  invokeOnChatRecovery?(
    input: InvokeOnChatRecoveryInput
  ): Promise<ChatRecoveryOptions | void>;
  /**
   * The BASE persist gate: whether the orphaned partial is eligible to be
   * materialized at all (live stream, or terminal-but-not-yet-persisted). The
   * engine ANDs this with the shared `options.persist !== false ||
   * partial.hasSettledToolResults` clause, so settled work is never dropped.
   */
  shouldPersistOrphanedPartial(
    input: PersistOrphanedPartialInput
  ): boolean | Promise<boolean>;
  /** Materialize the orphaned stream's partial into a persisted assistant message. */
  persistOrphanedStream(streamId: string): Promise<void>;
  /** Mark the (still-active) recovered stream complete and schedule cleanup. */
  completeRecoveredStream(streamId: string): void | Promise<void>;
  /** The message ids the interrupted request came from, when the host still knows them. */
  originMessageIds?(requestId: string): string[] | undefined;
  /** Host fields for the recovery payload, such as `Think`'s submission id. */
  scheduleData?(input: {
    recoveryRootRequestId: string;
  }): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The turn's stream ended before the reset: there is nothing to recover. */
  onStreamEnded?(input: {
    requestId: string;
    recoveryRootRequestId: string;
    streamStatus: "completed" | "error";
  }): Promise<void>;
  /**
   * Nothing will recover the turn: the app declined to continue it
   * (`continue_disabled`), or the conversation moved on
   * (`conversation_changed`). Runs after the incident records the skip.
   */
  onSkipped?(input: {
    requestId: string;
    recoveryRootRequestId: string;
    reason: "continue_disabled" | "conversation_changed";
  }): Promise<void>;
}

/**
 * Drives the shared recovery orchestration over a {@link ChatRecoveryAdapter}.
 * The incident *budget math* lives in the pure `evaluateChatRecoveryIncident`;
 * this class owns the surrounding sequence and its ordering invariants.
 */
export class ChatRecoveryEngine {
  /**
   * This object instance's identity in `attemptsInFlight` entries. A reset
   * builds a new instance, so an entry carrying a different value was left
   * by an attempt whose isolate died (#2613).
   */
  readonly #isolate = crypto.randomUUID();

  constructor(private readonly adapter: ChatRecoveryAdapter) {}

  /** Every incident write goes through here, so a terminal one is seen. */
  async #putIncident(
    key: string,
    incident: ChatRecoveryIncident
  ): Promise<void> {
    await this.adapter.putIncident(key, incident);
    if (
      incident.status !== "detected" &&
      incident.status !== "scheduled" &&
      incident.status !== "attempting"
    ) {
      this.#settled();
    }
  }

  /** The tail of the chain every incident read-modify-write runs on. */
  #incidentWrites: Promise<unknown> = Promise.resolve();

  /**
   * Read an incident, compute its next value and write it, with no other
   * incident write in between. Every read-modify-write of an incident goes
   * through here, so a cancel that lands while another write is under way
   * is never written over with the record as it was before the cancel.
   *
   * @param change - Synchronous, so nothing can wait on the chain from
   *   inside it. Returns the next record, `"delete"`, or `undefined` to
   *   write nothing.
   * @returns The record before and after. `after` is `undefined` when
   *   nothing was written.
   */
  #update(
    key: string,
    change: (
      incident: ChatRecoveryIncident | null
    ) => ChatRecoveryIncident | "delete" | undefined
  ): Promise<{
    before: ChatRecoveryIncident | null;
    after: ChatRecoveryIncident | "delete" | undefined;
  }> {
    const run = async () => {
      const before = await this.adapter.getIncident(key);
      const after = change(before);
      if (after === "delete") {
        await this.#deleteIncident(key);
      } else if (after !== undefined) {
        await this.#putIncident(key, after);
      }
      return { before, after };
    };
    return this.#inChain(run);
  }

  /** Run `write` on the incident chain, after every write queued before. */
  #inChain<T>(write: () => Promise<T>): Promise<T> {
    const next = this.#incidentWrites.then(write, write);
    this.#incidentWrites = next.catch(() => {});
    return next;
  }

  async #deleteIncident(key: string): Promise<void> {
    await this.adapter.deleteIncident(key);
    this.#settled();
  }

  /** Tell the host a recovery settled, outside any attempt's scope. */
  #settled(): void {
    try {
      this.outsideAttempt(() => this.adapter.recoverySettled?.());
    } catch (error) {
      console.error("[chat] recovery settle hook failed:", error);
    }
  }

  #newAttempt(): ChatRecoveryAttempt {
    return { isolate: this.#isolate, token: crypto.randomUUID() };
  }

  /**
   * Remove a finished attempt's entry and confirm the write, so a reset right
   * after a clean finish cannot make the attempt look interrupted.
   * Best-effort: in a reset isolate this fails too, and the entry it leaves
   * behind is exactly what tells the next isolate that this attempt died.
   */
  async #finishAttempt(
    incidentId: string,
    attempt: ChatRecoveryAttempt
  ): Promise<void> {
    const { adapter } = this;
    const key = chatRecoveryIncidentKey(incidentId);
    try {
      const { after } = await this.#update(key, (stored) =>
        stored
          ? (finishChatRecoveryAttempt(stored, attempt) ?? undefined)
          : undefined
      );
      if (after) await adapter.syncStorage();
    } catch {
      // An entry left behind costs at most one extra counted interruption.
    }
  }

  /**
   * Run one recovery attempt under the interruption budget (#2613): a
   * `_chatRecoveryContinue` / `_chatRecoveryRetry` callback and the turn it
   * starts. Before `run` does anything heavy, the attempt counts any earlier
   * attempt that died (entries another isolate left in `attemptsInFlight`)
   * and records itself, confirmed with `syncStorage`. Once
   * `maxInterruptedAttempts` attempts have died the turn is sealed with
   * `interrupted_attempts_exceeded` and `run` is never called. The entry is
   * removed when `run` settles, whatever its outcome.
   *
   * This catches deaths the replay of an interrupted turn run cannot see, such
   * as a reset before the callback starts its turn, which leaves no turn run
   * to replay. A callback for a sealed incident does nothing: the turn was
   * already terminalized, and running it would re-run the model. A payload
   * without an incident, or one whose incident is gone, runs untracked.
   *
   * @param input - The callback being run, its payload, and the work.
   */
  async runRecoveryAttempt(input: {
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown> | undefined;
    run: () => Promise<void>;
  }): Promise<void> {
    const { adapter } = this;
    const incidentId =
      typeof input.data?.incidentId === "string"
        ? input.data.incidentId
        : undefined;
    const existing = incidentId
      ? await adapter.getIncident(chatRecoveryIncidentKey(incidentId))
      : null;
    if (existing?.status === "exhausted") return;
    if (!incidentId || !existing) {
      await input.run();
      return;
    }

    adapter.ensureInteractionStateLoaded?.();
    const attempt = this.#newAttempt();
    let exhausted = false;
    await this.#update(chatRecoveryIncidentKey(incidentId), (current) => {
      // Admitted on the record as it is now: a cancel since the read above
      // is kept.
      const admitted = admitChatRecoveryAttempt({
        existing: current ?? existing,
        attempt,
        config: adapter.resolveConfig(),
        awaitingClientInteraction:
          adapter.isAwaitingClientInteraction?.() ?? false
      });
      exhausted = admitted.exhausted;
      return admitted.incident;
    });
    await adapter.syncStorage();

    if (exhausted) {
      await this.exhaustRecoveryGiveUp({
        callback: input.callback,
        data: { incidentId },
        reason: "interrupted_attempts_exceeded"
      });
      return;
    }
    try {
      await input.run();
    } finally {
      await this.#finishAttempt(incidentId, attempt);
      this.#settled();
    }
  }

  /**
   * The shared recovery LIFECYCLE for an interrupted chat turn: the replay of
   * a chat-turn Task run whose isolate died, or a legacy chat fiber row an
   * older version left. Both packages drove this exact frame; the divergent
   * organs are the {@link ChatFiberWakeHooks}. In order:
   *
   * 1. resolve the orphaned stream + reconstruct its partial;
   * 2. read the kind the incident opens with (`interruptedTurnKind`) and open it;
   * 3. if the budget is already exhausted, persist the settled partial (so
   *    non-idempotent tool results are not discarded — #1631) and terminalize
   *    BEFORE consulting `onChatRecovery`;
   * 4. otherwise, inside a `failed`-on-throw guard: invoke `onChatRecovery`,
   *    apply the shared persist gate (base eligibility AND `persist !== false ||
   *    settled tool results`), complete the live stream, then plan what the
   *    turn does next (`planInterruptedTurn`) and schedule it or skip.
   *
   * Any throw after the incident opens flips it to `failed` so it is never
   * left leaking in `attempting`.
   */
  async recoverInterruptedTurn(
    turn: InterruptedChatTurn,
    wake: ChatFiberWakeHooks
  ): Promise<void> {
    const { adapter } = this;
    const { requestId, snapshot, recoveryData, createdAt } = turn;
    adapter.turnRecovered?.(
      snapshot?.recoveryRootRequestId
        ? [requestId, snapshot.recoveryRootRequestId]
        : [requestId]
    );
    const stream = adapter.resolveRecoveryStream(requestId);
    const { streamId, streamStillActive, streamStatus } = stream;
    const partial = streamId
      ? adapter.getPartialStreamText(streamId)
      : { text: "", parts: [], hasSettledToolResults: false };

    const recoveryKind = interruptedTurnKind(
      { snapshot, streamStatus },
      wake.partialHoldsContent(partial),
      await wake.latestMessage()
    );
    const recoveryRootRequestId = snapshot?.recoveryRootRequestId ?? requestId;

    // An interrupted turn is a run whose isolate died before it finished. The
    // replay is itself an attempt: it counts the death and records itself so
    // that its own death, if it dies too, is counted by the next isolate
    // (#2613).
    const { incident, config, exhausted, attempt, stopped } =
      await this.beginIncident({
        requestId,
        recoveryRootRequestId,
        latestUserMessageId: snapshot?.latestUserMessageId,
        recoveryKind,
        trigger: "interrupted"
      });
    if (stopped) {
      // A stop of this turn's request landed: keep what it stored, close its
      // stream, and continue nothing.
      try {
        if (
          await this._shouldPersistOrphanedPartial(wake, {
            streamId,
            streamStillActive,
            streamStatus,
            snapshot,
            options: undefined,
            partial
          })
        ) {
          await wake.persistOrphanedStream(streamId);
        }
        if (streamStillActive) await wake.completeRecoveredStream(streamId);
      } finally {
        this.#settled();
      }
      return;
    }
    try {
      await this.#replayRecoveredTurn(wake, {
        createdAt,
        incident,
        config,
        exhausted,
        recoveryKind,
        requestId,
        recoveryRootRequestId,
        snapshot,
        recoveryData,
        streamId,
        streamStillActive,
        streamStatus,
        partial
      });
    } finally {
      if (attempt) await this.#finishAttempt(incident.incidentId, attempt);
      this.#settled();
    }
  }

  /** The part of {@link recoverInterruptedTurn} that runs after the incident opened. */
  async #replayRecoveredTurn(
    wake: ChatFiberWakeHooks,
    input: {
      createdAt: number;
      incident: ChatRecoveryIncident;
      config: ResolvedChatRecoveryConfig;
      exhausted: boolean;
      recoveryKind: ChatRecoveryKind;
      requestId: string;
      recoveryRootRequestId: string;
      snapshot: ChatFiberSnapshot | null;
      recoveryData: unknown;
      streamId: string;
      streamStillActive: boolean;
      streamStatus: ChatStreamStatus | undefined;
      partial: RecoveryPartial;
    }
  ): Promise<void> {
    const { adapter } = this;
    const {
      createdAt,
      incident,
      config,
      exhausted,
      recoveryKind,
      requestId,
      recoveryRootRequestId,
      snapshot,
      recoveryData,
      streamId,
      streamStillActive,
      streamStatus,
      partial
    } = input;

    if (exhausted) {
      // Preserve the settled partial before sealing. Exhaustion is decided BEFORE
      // `onChatRecovery`, so without this the settled (often non-idempotent) tool
      // results the turn already produced are discarded and the model re-runs
      // them on the next message (#1631). Same gating as the normal path (with no
      // `options`, so the persist clause collapses to base eligibility) — never
      // duplicating a partial an earlier attempt already saved.
      if (
        await this._shouldPersistOrphanedPartial(wake, {
          streamId,
          streamStillActive,
          streamStatus,
          snapshot,
          options: undefined,
          partial
        })
      ) {
        await wake.persistOrphanedStream(streamId);
      }
      await adapter.exhaustChatRecovery(
        incident,
        config,
        partial,
        streamId,
        createdAt,
        snapshot?.originMessageIds
      );
      this.#settled();
      return;
    }

    // Any throw after the incident opens (user `onChatRecovery`, orphan
    // persistence, scheduling) must flip the incident to terminal `failed` and
    // emit, otherwise it leaks in `attempting` and is never observable as stuck.
    try {
      const options =
        (await wake.invokeOnChatRecovery?.({
          incident,
          recoveryKind,
          recoveryRootRequestId,
          requestId,
          streamId,
          partial,
          snapshot,
          recoveryData,
          createdAt
        })) ?? {};

      if (
        await this._shouldPersistOrphanedPartial(wake, {
          streamId,
          streamStillActive,
          streamStatus,
          snapshot,
          options,
          partial
        })
      ) {
        await wake.persistOrphanedStream(streamId);
      }

      if (streamStillActive) {
        await wake.completeRecoveredStream(streamId);
      }

      const plan = planInterruptedTurn(
        { snapshot, streamStatus },
        options,
        await wake.latestMessage()
      );
      if (plan.action === "skip") {
        if (streamStatus === "completed" || streamStatus === "error") {
          await wake.onStreamEnded?.({
            requestId,
            recoveryRootRequestId,
            streamStatus
          });
        }
        await this.updateIncident(incident.incidentId, "skipped", plan.reason);
        if (plan.reason !== "stream_terminal") {
          await wake.onSkipped?.({
            requestId,
            recoveryRootRequestId,
            reason: plan.reason
          });
        }
        return;
      }
      await this.scheduleRecoveredTurn({
        incident,
        recoveryKind: plan.action,
        recoveryRootRequestId,
        retryUserId: plan.action === "retry" ? plan.questionId : null,
        targetAssistantId:
          plan.action === "continue" ? plan.replyId : undefined,
        requestContext: snapshot,
        originMessageIds:
          wake.originMessageIds?.(requestId) ?? snapshot?.originMessageIds,
        extra: {
          ...(plan.action === "retry" &&
            plan.regeneratedLeafId !== undefined && {
              regeneratedLeafId: plan.regeneratedLeafId
            }),
          ...(await wake.scheduleData?.({ recoveryRootRequestId }))
        }
      });
    } catch (error) {
      await this.updateIncident(
        incident.incidentId,
        "failed",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * The shared persist gate: base eligibility (the package's
   * {@link ChatFiberWakeHooks.shouldPersistOrphanedPartial}) AND the
   * never-drop-settled-work clause `options.persist !== false ||
   * partial.hasSettledToolResults`. `options: undefined` (the exhausted branch)
   * collapses the clause to the base gate. The clause lives here — not in each
   * package — because settled-work preservation is a cross-package invariant
   * (#1631), and the codec (not the engine) decides whether a partial carries
   * settled tool work, so the engine stays wire-vocabulary-agnostic.
   */
  private async _shouldPersistOrphanedPartial(
    wake: ChatFiberWakeHooks,
    input: PersistOrphanedPartialInput & {
      options: ChatRecoveryOptions | undefined;
      partial: RecoveryPartial;
    }
  ): Promise<boolean> {
    const base = await wake.shouldPersistOrphanedPartial({
      streamId: input.streamId,
      streamStillActive: input.streamStillActive,
      streamStatus: input.streamStatus,
      snapshot: input.snapshot
    });
    return (
      base &&
      (input.options?.persist !== false || input.partial.hasSettledToolResults)
    );
  }

  async beginIncident(
    input: BeginChatRecoveryIncidentInput
  ): Promise<BeginChatRecoveryIncidentResult> {
    const { adapter } = this;
    const config = adapter.resolveConfig();
    const key = chatRecoveryIncidentKey(chatRecoveryIncidentId(input));
    const now = input.nowMs ?? adapter.now();
    // Ordering invariant: sweep stale incidents BEFORE reading the existing
    // record. A TTL-expired identity is also past its no-progress window, so
    // sweeping first lets a genuinely abandoned turn start fresh instead of
    // resuming a dead budget.
    await adapter.sweepStaleIncidents(now);
    const existing = await adapter.getIncident(key);
    // Ordering invariant: rehydrate interaction state BEFORE the budget reads
    // `isAwaitingClientInteraction()` (see the adapter hook's contract).
    adapter.ensureInteractionStateLoaded?.();
    const currentProgress = await adapter.readProgress();

    const trigger: ChatRecoveryTrigger =
      input.trigger === "interrupted"
        ? { kind: "interrupted", attempt: this.#newAttempt() }
        : { kind: "stalled" };
    const { incident, exhausted, events } = await evaluateChatRecoveryIncident({
      identity: input,
      trigger,
      config,
      existing,
      currentProgress,
      awaitingClientInteraction:
        adapter.isAwaitingClientInteraction?.() ?? false,
      now,
      onShouldKeepRecoveringError: (error) =>
        adapter.onShouldKeepRecoveringError?.(error)
    });

    // Written in the incident chain, and not over a stop: one that landed
    // while the budget was evaluated, or one of the request this routes.
    // The stop is then the outcome, not the evaluation, whatever budget is
    // left.
    let stopped = false;
    const { after } = await this.#update(key, (current) => {
      if (current && isCancelled(current)) {
        stopped = true;
        return undefined;
      }
      if (this.#wasStopped(incident)) {
        stopped = true;
        return {
          ...incident,
          status: "skipped",
          reason: CHAT_RECOVERY_CANCELLED_REASON
        };
      }
      return incident;
    });
    // Confirm the record before the caller acts on it. The next attempt may
    // run in this invocation, and if it hits a memory-limit reset, writes that
    // were not yet confirmed are discarded with it.
    await adapter.syncStorage();
    if (stopped) {
      // No events for a record this did not write. One it wrote as the
      // stop's outcome says so once.
      if (after !== undefined && after !== "delete") {
        adapter.emitRecoveryEvent({
          type: "chat:recovery:skipped",
          incidentId: incident.incidentId,
          requestId: incident.requestId,
          attempt: incident.attempt,
          maxAttempts: incident.maxAttempts,
          recoveryKind: incident.recoveryKind,
          reason: CHAT_RECOVERY_CANCELLED_REASON
        });
      }
      await adapter.setRecovering(false);
      return {
        incident: after !== undefined && after !== "delete" ? after : incident,
        config,
        exhausted: false,
        attempt: null,
        stopped: true
      };
    }
    for (const event of events) {
      adapter.emitRecoveryEvent(event);
    }
    const attempt =
      trigger.kind === "interrupted" && !exhausted ? trigger.attempt : null;
    return { incident, config, exhausted, attempt };
  }

  /**
   * Schedule a recovery continuation/retry: the transition + emit + enqueue
   * triplet both packages repeat at every fiber-recovery and stall-routing
   * decision. In order:
   *
   * 1. transition the incident to `scheduled` (persist + drive the #1620
   *    "recovering…" status) via {@link updateIncident};
   * 2. emit `chat:recovery:scheduled`; and
   * 3. enqueue the callback through the adapter's transport — a Task run on
   *    a root agent, an idempotent schedule on the routed fallback.
   *
   * `recoveryKind` is passed explicitly (not read off the incident) because a
   * caller can legitimately report a different kind than the incident was opened
   * with — e.g. `AIChatAgent`'s lost-partial branch opens a `continue` incident
   * but schedules (and reports) a `retry`. `requestId` always matches
   * `incident.requestId` (the evaluation rewrites it to the current attempt), so
   * it is read from the incident.
   */
  async scheduleRecovery(input: {
    incident: ChatRecoveryIncident;
    recoveryKind: ChatRecoveryKind;
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown>;
    reason?: ChatRecoveryScheduleReason;
    delaySeconds?: number;
  }): Promise<boolean> {
    const { incident } = input;
    // One write: the status, what the scheduled attempt will do (so a turn
    // that continues a reply can tell whether this recovery was going to
    // continue the same one), and a count of schedules (so an attempt can
    // tell that its own turn scheduled the next one).
    const key = chatRecoveryIncidentKey(incident.incidentId);
    // The callback carries the number of its schedule, so a delivery of an
    // older schedule, or a second delivery of this one after its turn
    // started, can tell it is not the one to run (`recoveryDelivery`).
    let delivery: number | undefined;
    const targetMessageId =
      input.callback === "_chatRecoveryContinue" &&
      typeof input.data.targetAssistantId === "string"
        ? input.data.targetAssistantId
        : undefined;
    let stoppedInstead = false;
    const { before: stored, after } = await this.#update(key, (current) => {
      if (!current) return undefined;
      // A stop of the turn landed while it was routed here, before this
      // write: the stop is the outcome, and nothing is scheduled.
      if (isCancelled(current) || this.#wasStopped(current)) {
        stoppedInstead = true;
        return isCancelled(current)
          ? undefined
          : {
              ...current,
              status: "skipped",
              reason: CHAT_RECOVERY_CANCELLED_REASON
            };
      }
      const { deferredError: _deferredError, ...rest } = current;
      delivery = (current.scheduleCount ?? 0) + 1;
      return {
        ...rest,
        status: "scheduled",
        scheduleCount: delivery,
        scheduled: {
          callback: input.callback,
          ...(targetMessageId !== undefined && { targetMessageId })
        }
      };
    });
    if (stoppedInstead) {
      if (after !== undefined && stored) {
        this.adapter.emitRecoveryEvent({
          type: "chat:recovery:skipped",
          incidentId: incident.incidentId,
          requestId: stored.requestId,
          attempt: stored.attempt,
          maxAttempts: stored.maxAttempts,
          recoveryKind: stored.recoveryKind,
          reason: CHAT_RECOVERY_CANCELLED_REASON
        });
      }
      await this.adapter.setRecovering(false);
      return false;
    }
    if (stored) {
      await this.adapter.setRecovering(
        true,
        stored.recoveryRootRequestId ?? stored.requestId
      );
    }
    this.adapter.emitRecoveryEvent({
      type: "chat:recovery:scheduled",
      incidentId: incident.incidentId,
      requestId: incident.requestId,
      attempt: incident.attempt,
      maxAttempts: incident.maxAttempts,
      recoveryKind: input.recoveryKind
    });
    await this.adapter.scheduleRecovery(
      input.callback,
      delivery === undefined ? input.data : { ...input.data, delivery },
      input.reason ?? "initial",
      input.delaySeconds ?? 0
    );
    return true;
  }

  /**
   * Request ids a user stopped in this isolate, newest last. A stop that
   * lands while a turn is routed into recovery, before its incident is
   * `scheduled`, finds nothing to cancel; the schedule reads this instead.
   * Bounded: an id only matters while its turn is being routed.
   */
  readonly #stoppedRequestIds = new Set<string>();

  #noteStoppedRequest(requestId: string): void {
    this.#stoppedRequestIds.delete(requestId);
    this.#stoppedRequestIds.add(requestId);
    if (this.#stoppedRequestIds.size > 64) {
      const oldest = this.#stoppedRequestIds.values().next().value;
      if (oldest !== undefined) this.#stoppedRequestIds.delete(oldest);
    }
  }

  #wasStopped(incident: ChatRecoveryIncident): boolean {
    return (
      this.#stoppedRequestIds.has(incident.requestId) ||
      (incident.recoveryRootRequestId !== undefined &&
        this.#stoppedRequestIds.has(incident.recoveryRootRequestId))
    );
  }

  /**
   * Whether a delivered recovery callback is the one to run its turn.
   *
   * - `"run"`: it is. Also the answer for a payload with no schedule number
   *   (one an older version scheduled), and for an incident an older version
   *   wrote, which has no count.
   * - `"stale"`: a newer attempt was scheduled since, and that one runs; or
   *   the incident is gone, so its recovery is over.
   * - `"cut_off"`: this schedule's turn already started, so this is a second
   *   delivery after a reset cut the turn off. The interrupted turn's own
   *   recovery owns it: it stores the partial, counts the attempt and
   *   schedules the next one.
   */
  async recoveryDelivery(
    incidentId: string | undefined,
    delivery: unknown
  ): Promise<"run" | "stale" | "cut_off"> {
    if (!incidentId || typeof delivery !== "number") return "run";
    const incident = await this.readIncident(incidentId);
    // A numbered payload was scheduled by this version, which deletes an
    // incident only once its recovery completed (or a clear removed it). A
    // second delivery of it must not continue the finished reply.
    if (!incident) return "stale";
    if (incident.scheduleCount === undefined) return "run";
    if (incident.scheduleCount !== delivery) return "stale";
    return incident.startedDelivery === delivery ? "cut_off" : "run";
  }

  /** Record that the turn of the attempt's schedule has started. */
  private async markDeliveryStarted(
    attempt: ChatRecoveryAttemptScope | undefined
  ): Promise<void> {
    if (!attempt?.incidentId || attempt.delivery === undefined) return;
    const { delivery } = attempt;
    await this.#update(
      chatRecoveryIncidentKey(attempt.incidentId),
      (incident) =>
        incident?.status !== "scheduled" ||
        incident.scheduleCount !== delivery ||
        incident.startedDelivery === delivery
          ? undefined
          : { ...incident, startedDelivery: delivery }
    );
  }

  /**
   * Reschedule a recovery continuation/retry that timed out waiting for stable
   * state, from INSIDE the currently-executing recovery attempt (a
   * `__cf_internal_chat_recovery` Task run for a root agent, the routed
   * one-shot schedule row for a dynamic agent). Reads the
   * incident; if it is still under the attempt cap, bumps `attempt`, marks it
   * `scheduled` with `reason:"stable_timeout_retry"`, and issues a separate
   * delayed attempt. It must not join the currently executing attempt: Tasks
   * enqueue an unkeyed chained run, while the routed fallback creates a
   * non-idempotent schedule.
   *
   * Returns `true` when a retry was scheduled, `false` when there is no incident
   * (no id / record gone) or the attempt budget is already spent — in which case
   * the caller falls through to the give-up path. Deliberately bypasses the
   * `evaluateChatRecoveryIncident` budget (this is a coarse stable-state retry,
   * not a fresh interruption) and {@link updateIncident} (no `scheduled` event /
   * recovering-flag churn on a same-turn reschedule).
   */
  async rescheduleAfterStableTimeout(input: {
    incidentId: string | undefined;
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown> | undefined;
    fallbackMaxAttempts: number;
  }): Promise<boolean> {
    const { adapter } = this;
    if (!input.incidentId) return false;
    const key = chatRecoveryIncidentKey(input.incidentId);
    const { after } = await this.#update(key, (incident) => {
      if (!incident) return undefined;
      const attempt = incident.attempt ?? 0;
      if (attempt >= (incident.maxAttempts ?? input.fallbackMaxAttempts)) {
        return undefined;
      }
      return {
        ...incident,
        attempt: attempt + 1,
        status: "scheduled",
        lastAttemptAt: adapter.now(),
        reason: "stable_timeout_retry"
      };
    });
    if (!after) return false;
    await adapter.scheduleRecovery(
      input.callback,
      input.data ?? {},
      "stable_timeout_retry",
      CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS
    );
    return true;
  }

  /**
   * Bump the incident's durable `transientRetries` counter before scheduling a
   * recovery for a transient or rate-limited stream error, and return the new
   * count so the caller can derive its backoff. Returns `1` when the incident
   * record is gone.
   */
  async recordTransientRetry(incidentId: string): Promise<number> {
    let transientRetries = 1;
    await this.#update(chatRecoveryIncidentKey(incidentId), (incident) => {
      if (!incident) return undefined;
      transientRetries = (incident.transientRetries ?? 0) + 1;
      return { ...incident, transientRetries };
    });
    return transientRetries;
  }

  /**
   * The user stopped `requestId`. Marks every `scheduled` incident that the
   * id names as `skipped` with {@link CHAT_RECOVERY_CANCELLED_REASON}, and
   * tells the attempt running for it, if there is one, to stop. A queued
   * callback then returns when it fires (see {@link isRecoveryCancelled}),
   * and a running attempt ends at its next stop check.
   *
   * An id names an incident when it is the incident's recovery root, the
   * request id of the turn that was last cut off (what a tab that resumed
   * that stream tracks), or the request id of the turn its running attempt
   * started (what a tab sees once the recovered turn streams).
   *
   * @returns Whether any incident was cancelled.
   */
  async cancelScheduledRecovery(requestId: string): Promise<boolean> {
    this.#noteStoppedRequest(requestId);
    const incidents = (await this.adapter.listActiveIncidents?.()) ?? [];
    let cancelled = false;
    for (const incident of incidents) {
      const running = this.#runningAttempts.get(incident.incidentId);
      const named = (current: ChatRecoveryIncident): boolean =>
        current.status === "scheduled" &&
        (current.recoveryRootRequestId === requestId ||
          current.requestId === requestId ||
          running?.turnRequestId === requestId);
      if (!named(incident)) continue;
      // Checked again where it is written: two stops of one incident (a
      // tab's cancel and the stop of the turn it names) record one outcome.
      const applied = await this.updateIncident(
        incident.incidentId,
        "skipped",
        CHAT_RECOVERY_CANCELLED_REASON,
        named
      );
      running?.stopped.abort();
      if (applied) cancelled = true;
    }
    return cancelled;
  }

  /**
   * Whether the calling code runs inside a recovery attempt. Read from the
   * attempt's async scope, so a turn another request started while an attempt waits
   * for the chat to settle sees `undefined`: it is not part of that
   * attempt's chain. A turn that is interrupted inside an attempt schedules a
   * chained attempt under this root.
   */
  get inAttempt(): boolean {
    return this.adapter.turns?.attemptScope.getStore() !== undefined;
  }

  /**
   * The root request id of the recovery attempt the calling code runs
   * inside, or `undefined` when it runs inside none. See {@link inAttempt}.
   */
  get activeRootRequestId(): string | undefined {
    return this.adapter.turns?.attemptScope.getStore()?.rootRequestId;
  }

  /** The host's turn bindings. Throws for a host that did not supply them. */
  get turns(): ChatRecoveryTurnBindings {
    const turns = this.adapter.turns;
    if (!turns) {
      throw new Error(
        "ChatRecoveryEngine: the adapter has no `turns` bindings"
      );
    }
    return turns;
  }

  /** Whether a client still has a tool call or approval to answer. */
  isAwaitingClientInteraction(): boolean {
    return this.adapter.isAwaitingClientInteraction?.() ?? false;
  }

  /**
   * Run a recovery callback (`_chatRecoveryContinue` or `_chatRecoveryRetry`)
   * the Task transport delivered, up to its model handoff, then return. The
   * turn continues as tracked alarm work, and a detached platform failure
   * enqueues one replacement attempt.
   *
   * The attempt runs inside the host's origin-message-ids scope, so the
   * frames of the recovered turn carry the ids of the request it recovers.
   *
   * @param callback - The callback being run.
   * @param data - Its payload.
   */
  runRecoveryCallback(
    callback: ChatRecoveryScheduleCallback,
    data: Record<string, unknown> | undefined
  ): Promise<void> {
    const { turns } = this;
    const originMessageIds = Array.isArray(data?.originMessageIds)
      ? (data.originMessageIds as string[])
      : undefined;
    return dispatchChatRecoveryToHandoff({
      // Each run is one attempt under the interruption budget: it counts an
      // earlier attempt that died and records itself before any heavy work.
      detached: (onTurnStarted) =>
        this.runRecoveryAttempt({
          callback,
          data,
          run: () =>
            turns.originMessageIdsScope.run(originMessageIds, () =>
              turns.attempts[callback](data, onTurnStarted)
            )
        }),
      track: (turn) => turns.trackAlarmWork(turn),
      redefer: (dedupeKey) =>
        this.adapter.scheduleRecovery(
          callback,
          data ?? {},
          "redefer",
          CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS,
          dedupeKey
        ),
      onDetachedError: (error) =>
        console.error(`${turns.label} ${callback} dispatch failed`, error)
    });
  }

  /**
   * Route a live stream interruption (a stall, a transient provider error)
   * into bounded recovery. See `recovery-route.ts`.
   */
  routeStreamInterruption(
    host: StreamInterruptionHost
  ): Promise<StreamInterruptionOutcome> {
    return routeStreamInterruption(this, host);
  }

  /**
   * Schedule the recovery attempt for an interrupted turn: a retry of its
   * question or a continue of its reply. See `recovery-route.ts`.
   */
  scheduleRecoveredTurn(input: RecoveredTurnSchedule): Promise<boolean> {
    return scheduleRecoveredTurn(this, input);
  }

  /**
   * Deliver the terminal message for an incident whose budget is spent: the
   * host's exhaustion writes (`onExhausted`, the terminal frame and record).
   * {@link exhaustRecoveryGiveUp} is the entry for a give-up that still has
   * to read and seal the incident.
   */
  terminalize(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    partial: RecoveryPartial,
    streamId: string,
    createdAt: number
  ): Promise<void> {
    return this.adapter.exhaustChatRecovery(
      incident,
      config,
      partial,
      streamId,
      createdAt
    );
  }

  /**
   * Give up on every incident still live, as an out-of-memory exhaustion,
   * when the alarm circuit breaker trips at its strike budget (#1825). Runs
   * at the outermost alarm frame, so the terminal message and the sealed
   * incident can land where the mid-turn writes ran out of memory.
   */
  async sealMemoryLimitedRecovery(): Promise<void> {
    const incidents = (await this.adapter.listActiveIncidents?.()) ?? [];
    for (const incident of incidents) {
      await this.exhaustRecoveryGiveUp({
        callback:
          incident.recoveryKind === "retry"
            ? "_chatRecoveryRetry"
            : "_chatRecoveryContinue",
        data: { incidentId: incident.incidentId },
        reason: "out_of_memory"
      });
    }
  }

  /**
   * {@link cancelScheduledRecovery} for the cancel handler: a failed incident
   * write is logged, so the cancel still stops the turn it aborted.
   */
  async tryCancelScheduledRecovery(requestId: string): Promise<void> {
    try {
      await this.cancelScheduledRecovery(requestId);
    } catch (error) {
      console.error(
        `${this.adapter.turns?.label ?? "[chat]"} failed to cancel a scheduled chat recovery`,
        error
      );
    }
  }

  /**
   * Run the body of one recovery attempt: the checks around a recovered turn,
   * in the one order both hosts use. See `recovery-attempt.ts`.
   */
  runRecoveredTurn<
    TData extends RecoveryAttemptData,
    TResult extends RecoveredTurnResult
  >(host: RecoveredTurnHost<TData, TResult>): Promise<void> {
    return runRecoveredTurn(this, host);
  }

  /** Handle an error a recovery attempt threw. See `recovery-attempt.ts`. */
  handleRecoveryAttemptError(
    input: Parameters<typeof handleRecoveryAttemptError>[1]
  ): Promise<void> {
    return handleRecoveryAttemptError(this, input);
  }

  /** The host's resolved recovery config. */
  resolveConfig(): ResolvedChatRecoveryConfig {
    return this.adapter.resolveConfig();
  }

  /**
   * Record that a client stopped a running attempt. The cancel already marked
   * the incident when it was still scheduled. Record it here otherwise, so
   * the attempt's own outcome does not overwrite the user's stop.
   */
  async recordRecoveryStop(incidentId: string | undefined): Promise<void> {
    await this.updateIncident(
      incidentId,
      "skipped",
      CHAT_RECOVERY_CANCELLED_REASON,
      (incident) => !isCancelled(incident)
    );
  }

  /**
   * The recovery attempts running in this isolate, by incident: the signals
   * that tell each one to end, and the request id of the turn it started.
   */
  readonly #runningAttempts = new Map<
    string,
    {
      superseded: AbortController;
      stopped: AbortController;
      turnRequestId?: string;
      /** The schedule whose turn the attempt started. */
      turnDelivery?: number;
    }
  >();

  /**
   * Register a running recovery attempt. `superseded` aborts when another
   * turn continues the attempt's reply (see
   * {@link supersedeScheduledRecovery}), so the attempt stands down even if
   * it is past its own checks and its turn is waiting in the queue.
   * `stopped` aborts when a client stops the incident by an id the host's
   * turn core does not register the attempt under (see
   * {@link cancelScheduledRecovery}).
   */
  beginAttempt(incidentId: string | undefined): {
    superseded: AbortSignal;
    stopped: AbortSignal;
    end(): void;
  } {
    const attempt = {
      superseded: new AbortController(),
      stopped: new AbortController()
    };
    if (incidentId) this.#runningAttempts.set(incidentId, attempt);
    return {
      superseded: attempt.superseded.signal,
      stopped: attempt.stopped.signal,
      end: () => {
        if (incidentId && this.#runningAttempts.get(incidentId) === attempt) {
          this.#runningAttempts.delete(incidentId);
        }
      }
    };
  }

  /**
   * Run `fn` outside any recovery attempt's scope, and outside the
   * origin-message-ids scope that goes with it. Only the attempt's own turn
   * is the attempt's. Code that runs in the turn's async chain but is not
   * the turn must leave the scope: the app's `onChatResponse` hook, which
   * may start a turn of its own, and the firing of a continuation a tool
   * result scheduled while the recovered turn ran.
   */
  outsideAttempt<T>(fn: () => T): T {
    const turns = this.adapter.turns;
    if (!turns) return fn();
    return turns.attemptScope.exit(() => turns.originMessageIdsScope.exit(fn));
  }

  /**
   * Run a recovery attempt inside the host's attempt scope. Everything the
   * attempt awaits in its own async chain, the turn it starts included,
   * then reads as the attempt's. Other turns that run while it waits do not.
   */
  runInAttemptScope<T>(
    attempt: ChatRecoveryAttemptScope,
    run: () => Promise<T>
  ): Promise<T> {
    return this.turns.attemptScope.run(attempt, run);
  }

  /**
   * Wrap the body of a turn where its durable fiber is set up, and run the
   * returned function inside the fiber.
   *
   * Setting up reads which recovery attempt, if any, the turn belongs to
   * from the caller's async scope. The fiber may run the body outside that
   * scope, so the returned function re-enters it: a turn that is interrupted
   * inside a recovery attempt is then routed as that attempt's (see
   * `routeStreamInterruption`), and no other turn is.
   *
   * `body` receives `takeReply`. A turn that continues the latest reply (a
   * client's answer to a tool call, the app calling `continueLastTurn`, a
   * recovery attempt's own turn) calls it before the first stream chunk
   * that carries content (`takeAtFirstContent`), and not before: a model
   * call can return a stream that only carries the provider's error. From
   * then on the reply is this turn's: a
   * recovery still scheduled to continue the same reply is superseded (see
   * {@link supersedeScheduledRecovery}). A turn that ends with no content
   * must not call it, or the reply is left with no turn and no
   * recovery. Calling it inside the fiber means the turn is durably
   * registered first, so a restart cannot leave that gap either.
   *
   * @param continuation - Whether the turn continues the latest reply.
   *   `takeReply` does nothing for a turn that starts a new reply.
   * @param requestId - The turn's request id. When the turn is a recovery
   *   attempt's own, a stop by this id then reaches the attempt (see
   *   {@link cancelScheduledRecovery}).
   */
  turnBody<T>(
    continuation: boolean,
    body: (takeReply: () => Promise<void>) => Promise<T>,
    requestId?: string
  ): () => Promise<T> {
    const scope = this.adapter.turns?.attemptScope;
    const attempt = scope?.getStore();
    const running = attempt?.incidentId
      ? this.#runningAttempts.get(attempt.incidentId)
      : undefined;
    if (running && requestId) {
      running.turnRequestId = requestId;
      running.turnDelivery = attempt?.delivery;
    }
    let taken = false;
    const takeReply = async (): Promise<void> => {
      if (!continuation || taken) return;
      taken = true;
      await this.supersedeScheduledRecovery(attempt?.incidentId);
    };
    // The first write inside the fiber: from here on, a reset wakes the
    // interrupted turn's recovery, and the callback delivered again must
    // not run the turn a second time.
    const run = async (): Promise<T> => {
      await this.markDeliveryStarted(attempt);
      return body(takeReply);
    };
    return () => (scope && attempt ? scope.run(attempt, run) : run());
  }

  /**
   * A turn is continuing the latest reply. Mark each scheduled incident
   * whose recovery was going to continue that same reply `skipped` with
   * {@link CHAT_RECOVERY_CONTINUED_REASON}, and tell its attempt, if one is
   * running here. The attempt, queued or already waiting for the chat to
   * settle, then ends without asking the model to continue the reply a
   * second time (see `runRecoveredTurn`).
   *
   * Left alone: a scheduled retry (it answers a question, it does not
   * continue a reply), and a continue of some other message. Each of those
   * reaches its own leaf check.
   *
   * @param exceptIncidentId - The incident of the attempt the superseding
   *   turn belongs to, which is left alone.
   * @returns Whether any incident was marked.
   */
  async supersedeScheduledRecovery(
    exceptIncidentId?: string
  ): Promise<boolean> {
    const reply = this.adapter.turns?.latestMessage();
    // A continuation turn continues an assistant reply. With none, there is
    // nothing a recovery could have been going to continue either.
    if (reply?.role !== "assistant") return false;
    const incidents = (await this.adapter.listActiveIncidents?.()) ?? [];
    let superseded = false;
    for (const incident of incidents) {
      if (
        incident.status !== "scheduled" ||
        incident.incidentId === exceptIncidentId ||
        !continuesReply(incident, reply.id) ||
        this.#ownTurnContinuedIt(incident)
      ) {
        continue;
      }
      const applied = await this.updateIncident(
        incident.incidentId,
        "skipped",
        CHAT_RECOVERY_CONTINUED_REASON,
        (current) =>
          current.status === "scheduled" &&
          continuesReply(current, reply.id) &&
          !this.#ownTurnContinuedIt(current)
      );
      if (!applied) continue;
      this.#runningAttempts
        .get(incident.incidentId)
        ?.superseded.abort(new ChatRecoverySupersededError());
      superseded = true;
    }
    return superseded;
  }

  /**
   * Whether the attempt running for this incident already started the turn
   * of the incident's current schedule. That turn continued the reply, so a
   * later turn (a continuation armed during it) does not take the reply
   * from it. A newer schedule, which a cut-off of that turn leaves, can be
   * taken.
   */
  #ownTurnContinuedIt(incident: ChatRecoveryIncident): boolean {
    const running = this.#runningAttempts.get(incident.incidentId);
    return (
      running?.turnRequestId !== undefined &&
      running.turnDelivery !== undefined &&
      running.turnDelivery === incident.scheduleCount
    );
  }

  /** Whether a client's answer took over this incident's reply. */
  async isRecoverySuperseded(incidentId: string | undefined): Promise<boolean> {
    if (!incidentId) return false;
    const incident = await this.adapter.getIncident(
      chatRecoveryIncidentKey(incidentId)
    );
    return (
      incident?.status === "skipped" &&
      incident.reason === CHAT_RECOVERY_CONTINUED_REASON
    );
  }

  /** Read an incident, or `null` when there is none. */
  async readIncident(
    incidentId: string | undefined
  ): Promise<ChatRecoveryIncident | null> {
    if (!incidentId) return null;
    return this.adapter.getIncident(chatRecoveryIncidentKey(incidentId));
  }

  /**
   * An attempt hit a platform transient and will run again once the
   * platform is healthy. The incident stays `scheduled`, so a stop or a
   * turn that continues the reply during the deferral still finds it. Only
   * the error is recorded, for whoever inspects the incident. Best-effort:
   * in the outage that caused the transient this write can fail too.
   */
  async recordDeferral(
    incidentId: string | undefined,
    error: string
  ): Promise<void> {
    if (!incidentId) return;
    await this.#update(chatRecoveryIncidentKey(incidentId), (incident) => {
      if (incident?.status !== "scheduled") return undefined;
      // The deferred turn ended without a reset, so nothing else will run it
      // again: the same payload has to.
      const { startedDelivery: _startedDelivery, ...rest } = incident;
      return { ...rest, deferredError: error };
    });
  }

  /**
   * Record that the reply this incident continues is being removed because
   * it holds nothing, and the question it answered. Call it before the
   * removal.
   */
  async markReplyRemoved(
    incidentId: string | undefined,
    questionId?: string
  ): Promise<void> {
    if (!incidentId) return;
    await this.#update(chatRecoveryIncidentKey(incidentId), (incident) =>
      !incident || incident.replyRemoved
        ? undefined
        : {
            ...incident,
            replyRemoved: true,
            ...(questionId !== undefined && { replyRemovedFor: questionId })
          }
    );
  }

  /** The question {@link markReplyRemoved} recorded, if it recorded one. */
  async replyRemovedFor(
    incidentId: string | undefined
  ): Promise<string | undefined> {
    return (await this.readIncident(incidentId))?.replyRemovedFor;
  }

  /**
   * Whether an earlier run of this incident's attempt removed the reply it
   * was to continue. `"unknown"` when there is no incident record to ask:
   * the caller then goes by the transcript.
   */
  async isReplyRemoved(
    incidentId: string | undefined
  ): Promise<boolean | "unknown"> {
    if (!incidentId) return "unknown";
    const incident = await this.adapter.getIncident(
      chatRecoveryIncidentKey(incidentId)
    );
    return incident ? incident.replyRemoved === true : "unknown";
  }

  /** Whether the user cancelled this incident's scheduled recovery. */
  async isRecoveryCancelled(incidentId: string | undefined): Promise<boolean> {
    if (!incidentId) return false;
    const incident = await this.adapter.getIncident(
      chatRecoveryIncidentKey(incidentId)
    );
    return incident !== null && isCancelled(incident);
  }

  /**
   * Give up on a recovery turn whose retry budget drained, terminalizing it so
   * it can never become an eternal spinner (#1645). The shared spine both
   * packages repeated verbatim:
   *
   * 1. resolve config + the incident key from `data.incidentId`;
   * 2. best-effort READ the stored incident — a failed read is tolerated
   *    (reported via `onGiveUpBookkeepingError("read", …)`) and the incident is
   *    synthesized, because the read backs only the re-entry guard, not the
   *    terminal UX;
   * 3. re-entry guard: a `stored.status === "exhausted"` record means
   *    terminalization already fired, so a duplicate stale alarm returns without
   *    re-broadcasting the banner;
   * 4. build the exhausted incident (reuse `stored`, or synthesize a minimal one
   *    so a swept/missing record STILL terminalizes through `onExhausted`);
   * 5. resolve the orphaned stream id + partial;
   * 6. terminalize via `exhaustChatRecovery` — BEFORE sealing. The terminal
   *    writes can reject with a platform transient in the deploy/storage window
   *    a give-up runs in (#1730); letting that throw propagate is deliberate, so
   *    the current recovery attempt (a Task run on a root agent, a one-shot
   *    schedule row on the routed fallback) defers and the WHOLE give-up
   *    re-runs on a healthy isolate. Sealing first would arm the
   *    re-entry guard and turn that re-run into a no-op, dropping the durable
   *    terminal record. The re-run is idempotent (terminal writes overwrite the
   *    same key); a second banner is the documented at-least-once edge; and
   * 7. best-effort SEAL write so the re-entry guard sees `exhausted` on a
   *    duplicate alarm — a failed seal (reported via
   *    `onGiveUpBookkeepingError("seal", …)`) costs at most one re-delivered
   *    banner.
   *
   * The two packages diverged only in parameters the caller supplies:
   * `reason` (`Think` passes `stable_timeout` | `recovery_error`; `AIChatAgent`
   * always `stable_timeout`) and the root-id chain (`Think` includes
   * `recoveredRequestId`; `AIChatAgent` never sets it, so the unified chain
   * collapses identically). Exactly-once terminalization rests on the re-entry
   * guard alone in `AIChatAgent`; `Think` additionally short-circuits duplicate
   * alarms earlier in its durable-submission layer.
   */
  async exhaustRecoveryGiveUp(input: {
    callback: ChatRecoveryScheduleCallback;
    data:
      | {
          incidentId?: string;
          originalRequestId?: string;
          recoveredRequestId?: string;
        }
      | undefined;
    reason: string;
  }): Promise<void> {
    const { adapter } = this;
    const config = adapter.resolveConfig();
    const incidentKey = input.data?.incidentId
      ? chatRecoveryIncidentKey(input.data.incidentId)
      : null;

    let stored: ChatRecoveryIncident | null = null;
    if (incidentKey) {
      try {
        stored = await adapter.getIncident(incidentKey);
      } catch (readError) {
        adapter.onGiveUpBookkeepingError("read", readError);
      }
    }

    // Re-entry guard: a sealed incident means terminalization already happened,
    // so a duplicate stale alarm must not re-fire `onExhausted` / the banner.
    if (stored?.status === "exhausted") return;

    const rootRequestId =
      input.data?.originalRequestId ??
      input.data?.recoveredRequestId ??
      this.activeRootRequestId ??
      adapter.activeChatRecoveryRootRequestId?.() ??
      stored?.recoveryRootRequestId ??
      stored?.requestId ??
      "";

    const incident: ChatRecoveryIncident = stored
      ? { ...stored, status: "exhausted", reason: input.reason }
      : {
          // Silent-drop guard: the record is gone (no `incidentId`, or it was
          // swept/deleted before this stale alarm). Synthesize a minimal
          // incident so the turn STILL terminalizes instead of vanishing.
          incidentId: input.data?.incidentId ?? crypto.randomUUID(),
          requestId: rootRequestId,
          recoveryRootRequestId: rootRequestId,
          recoveryKind:
            input.callback === "_chatRecoveryRetry" ? "retry" : "continue",
          attempt: config.maxAttempts,
          maxAttempts: config.maxAttempts,
          status: "exhausted",
          firstSeenAt: adapter.now(),
          lastAttemptAt: adapter.now(),
          reason: input.reason
        };

    const { streamId } = adapter.resolveRecoveryStream(
      incident.recoveryRootRequestId ?? incident.requestId
    );
    const partial = streamId
      ? adapter.getPartialStreamText(streamId)
      : { text: "", parts: [], hasSettledToolResults: false };

    await adapter.exhaustChatRecovery(
      incident,
      config,
      partial,
      streamId,
      incident.firstSeenAt
    );
    this.#settled();

    if (incidentKey) {
      try {
        // The give-up was delivered: it is the outcome, whatever was written
        // meanwhile. Written in the incident chain all the same.
        await this.#inChain(() => this.#putIncident(incidentKey, incident));
      } catch (writeError) {
        adapter.onGiveUpBookkeepingError("seal", writeError);
      }
    }
  }

  /**
   * Apply a status transition to the recovery incident `incidentId`:
   *
   * - `completed` → drop the record (terminal, never retried);
   * - any other status → persist the new status (and `reason`), so the attempt
   *   budget survives restarts until the TTL sweep reclaims it;
   * - emit the matching `completed`/`skipped`/`failed` lifecycle event; and
   * - drive the live "recovering…" status (#1620): `scheduled` marks it active
   *   (keyed by the recovery-root request id), terminal states clear it.
   *
   * No-op when `incidentId` is undefined or the record is already gone. This is
   * the transition twin of {@link beginIncident}: all I/O is adapter-owned, the
   * engine owns only the state-machine shape.
   *
   * @param only - Checked on the record as it is read for the write. A
   *   record it rejects is left alone, with no event.
   * @returns Whether the transition was written.
   */
  async updateIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string,
    only?: (incident: ChatRecoveryIncident) => boolean
  ): Promise<boolean> {
    if (!incidentId) return false;
    const { adapter } = this;
    const key = chatRecoveryIncidentKey(incidentId);
    const { before: incident, after } = await this.#update(key, (current) => {
      if (!current || (only && !only(current))) return undefined;
      return status === "completed"
        ? "delete"
        : { ...current, status, ...(reason ? { reason } : {}) };
    });
    if (!incident || after === undefined) return false;

    const eventType =
      status === "completed"
        ? "chat:recovery:completed"
        : status === "skipped"
          ? "chat:recovery:skipped"
          : status === "failed"
            ? "chat:recovery:failed"
            : undefined;
    if (eventType) {
      adapter.emitRecoveryEvent({
        type: eventType,
        incidentId,
        requestId: incident.requestId,
        attempt: incident.attempt,
        maxAttempts: incident.maxAttempts,
        recoveryKind: incident.recoveryKind,
        ...(reason ? { reason } : {})
      });
    }

    if (status === "scheduled") {
      await adapter.setRecovering(
        true,
        incident.recoveryRootRequestId ?? incident.requestId
      );
    } else if (
      status === "completed" ||
      status === "skipped" ||
      status === "failed"
    ) {
      await adapter.setRecovering(false);
    }
    return true;
  }
}

/**
 * The incident storage half of a {@link ChatRecoveryAdapter}, on a Durable
 * Object's storage. Both chat hosts keep incidents the same way.
 */
export function chatRecoveryStorageAdapter(
  storage: DurableObjectStorage
): Pick<
  ChatRecoveryAdapter,
  | "now"
  | "sweepStaleIncidents"
  | "getIncident"
  | "listActiveIncidents"
  | "putIncident"
  | "syncStorage"
  | "deleteIncident"
> {
  return {
    now: () => Date.now(),
    sweepStaleIncidents: (now) => sweepStaleChatRecoveryIncidents(storage, now),
    getIncident: async (key) =>
      (await storage.get<ChatRecoveryIncident>(key)) ?? null,
    listActiveIncidents: async () =>
      (await listActiveChatRecoveryIncidents(storage)).map(
        ({ incident }) => incident
      ),
    putIncident: (key, incident) => storage.put(key, incident),
    syncStorage: () => storage.sync(),
    deleteIncident: async (key) => {
      await storage.delete(key);
    }
  };
}

/**
 * Build the reader for the durable recovery-progress marker: how much reply
 * content has landed in the stream log. The log only grows when new content
 * lands durably, a reconnect replay or a recovery re-persist reads it without
 * appending (#1637), and compaction rewrites the transcript, not the log
 * (#1628).
 *
 * The counter an older version kept in KV is folded in once per isolate, so
 * a marker an in-flight incident already recorded is never read lower after
 * the upgrade.
 *
 * @param storage - The Durable Object's storage.
 * @param stream - The host's stream log, read when the marker is.
 */
export function chatRecoveryProgressReader(
  storage: Pick<DurableObjectStorage, "get">,
  stream: () => {
    seedProgress(legacyTotal: number): void;
    progressMarker(): number;
  }
): () => Promise<number> {
  // Memoized as the promise, not a flag: two concurrent readers both wait
  // for the seed to land, so neither hands the engine an unseeded marker as
  // an incident's work baseline. A failed read is not cached, so the next
  // evaluation retries it.
  let seed: Promise<void> | null = null;
  return async () => {
    seed ??= readChatRecoveryProgress(storage).then(
      (legacy) => stream().seedProgress(legacy),
      (error: unknown) => {
        seed = null;
        throw error;
      }
    );
    await seed;
    return stream().progressMarker();
  };
}

/**
 * Whether a scheduled incident's recovery will continue the reply
 * `replyId`. An incident an older version scheduled does not say what it
 * targets: its kind decides, and a continue is taken to target the latest
 * reply, which is what `continueLastTurn` would continue.
 */
function continuesReply(
  incident: ChatRecoveryIncident,
  replyId: string
): boolean {
  const { scheduled } = incident;
  if (!scheduled) return incident.recoveryKind === "continue";
  if (scheduled.callback !== "_chatRecoveryContinue") return false;
  return (
    scheduled.targetMessageId === undefined ||
    scheduled.targetMessageId === replyId
  );
}

/** Whether the user cancelled this incident's recovery. */
function isCancelled(incident: ChatRecoveryIncident): boolean {
  return (
    incident.status === "skipped" &&
    incident.reason === CHAT_RECOVERY_CANCELLED_REASON
  );
}

/** `incident.reason` for a scheduled recovery the user cancelled. */
export const CHAT_RECOVERY_CANCELLED_REASON = "user_cancelled";

/**
 * `incident.reason` for a recovery whose reply a client's answer continued
 * first.
 */
export const CHAT_RECOVERY_CONTINUED_REASON = "continued_by_interaction";

/** Cap on the exponential backoff between transient-error recoveries. */
export const CHAT_RECOVERY_MAX_BACKOFF_SECONDS = 30;

/** Cap on a provider `Retry-After` honored for a rate-limited recovery. */
export const CHAT_RECOVERY_MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Delay before the `retries`-th transient-error recovery: exponential backoff
 * capped at {@link CHAT_RECOVERY_MAX_BACKOFF_SECONDS}. A provider
 * `retryAfterSeconds` (rate limits) extends it, capped at
 * {@link CHAT_RECOVERY_MAX_RETRY_AFTER_SECONDS}.
 */
export function chatRecoveryBackoffSeconds(
  retries: number,
  retryAfterSeconds?: number
): number {
  const backoff = Math.min(
    2 ** (retries - 1),
    CHAT_RECOVERY_MAX_BACKOFF_SECONDS
  );
  if (retryAfterSeconds === undefined) return backoff;
  return Math.min(
    Math.max(backoff, retryAfterSeconds),
    CHAT_RECOVERY_MAX_RETRY_AFTER_SECONDS
  );
}

/**
 * How long a provider asked the caller to wait before retrying, in whole
 * seconds. Reads `responseHeaders` (AI SDK `APICallError`) or `headers` on
 * the error, then on the errors it wraps: `lastError` and `errors` (AI SDK
 * `RetryError`, thrown once its own retries are used up; the newest attempt
 * is read first) and `cause`. `retry-after-ms` (milliseconds) wins over
 * `retry-after`, which is delta-seconds or an HTTP date. `undefined` when
 * absent or unparseable.
 */
export function retryAfterSeconds(
  error: unknown,
  now: number = Date.now()
): number | undefined {
  return retryAfterIn(error, now, new Set()).seconds;
}

/**
 * `found` separates "this error carries the header, and it does not parse"
 * (stop there, as the newest answer) from "no header here, keep looking".
 */
function retryAfterIn(
  error: unknown,
  now: number,
  seen: Set<object>
): { found: boolean; seconds?: number } {
  if (error == null || typeof error !== "object") return { found: false };
  // An error that wraps itself, directly or further down, is read once.
  if (seen.has(error)) return { found: false };
  seen.add(error);
  const record = error as {
    responseHeaders?: unknown;
    headers?: unknown;
    lastError?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  for (const headers of [record.responseHeaders, record.headers]) {
    const milliseconds = readHeader(headers, "retry-after-ms");
    if (milliseconds !== undefined && /^\d+(\.\d+)?$/.test(milliseconds)) {
      return { found: true, seconds: Math.ceil(Number(milliseconds) / 1000) };
    }
    const value = readHeader(headers, "retry-after");
    if (value !== undefined) {
      return { found: true, seconds: parseRetryAfter(value, now) };
    }
  }
  const wrapped = [
    record.lastError,
    ...(Array.isArray(record.errors) ? [...record.errors].reverse() : []),
    record.cause
  ];
  for (const inner of wrapped) {
    const result = retryAfterIn(inner, now, seen);
    if (result.found) return result;
  }
  return { found: false };
}

function readHeader(headers: unknown, header: string): string | undefined {
  if (headers == null || typeof headers !== "object") return undefined;
  if (headers instanceof Headers) {
    // `Headers` strips the whitespace around a value itself.
    return headers.get(header) ?? undefined;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === header && typeof value === "string") {
      return value.trim();
    }
  }
  return undefined;
}

function parseRetryAfter(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * Build the `ChatRecoveryExhaustedContext` delivered to `onExhausted` and the
 * `chat:recovery:exhausted` event. Pure field-mapping shared by both packages;
 * the `reason` falls back to `max_attempts_exceeded` when the incident did not
 * record a more specific cause.
 */
export function buildChatRecoveryExhaustedContext(input: {
  incident: ChatRecoveryIncident;
  config: ResolvedChatRecoveryConfig;
  partialText: string;
  partialParts: ChatRecoveryExhaustedContext["partialParts"];
  streamId: string;
  createdAt: number;
}): ChatRecoveryExhaustedContext {
  const { incident, config } = input;
  return {
    incidentId: incident.incidentId,
    requestId: incident.requestId,
    recoveryRootRequestId: incident.recoveryRootRequestId ?? incident.requestId,
    attempt: incident.attempt,
    maxAttempts: incident.maxAttempts,
    recoveryKind: incident.recoveryKind,
    streamId: input.streamId,
    createdAt: input.createdAt,
    partialText: input.partialText,
    partialParts: input.partialParts,
    reason: incident.reason ?? "max_attempts_exceeded",
    terminalMessage: config.terminalMessage
  };
}

/**
 * Run the shared exhaustion notification: emit `chat:recovery:exhausted`, then
 * invoke the caller's `onExhausted` hook. A throwing hook is swallowed (and
 * reported via `onError`) so it can NEVER prevent the caller from delivering
 * terminal UX — a tested invariant in both packages. The terminal record /
 * banner / submission writes that follow are intentionally package-owned (their
 * ordering legitimately diverges), so they are NOT part of this helper.
 */
export async function notifyChatRecoveryExhausted(
  ctx: ChatRecoveryExhaustedContext,
  hooks: {
    emit: (ctx: ChatRecoveryExhaustedContext) => void;
    onExhausted?: (ctx: ChatRecoveryExhaustedContext) => void | Promise<void>;
    onError: (error: unknown) => void;
  }
): Promise<void> {
  hooks.emit(ctx);
  try {
    await hooks.onExhausted?.(ctx);
  } catch (error) {
    hooks.onError(error);
  }
}

/**
 * The complete give-up choreography from a single call: build the exhausted
 * context, fire the shared notification ({@link notifyChatRecoveryExhausted}),
 * then hand that context to the host's `terminalize` step. Folds the
 * `buildChatRecoveryExhaustedContext` → `notifyChatRecoveryExhausted` → host
 * terminalize sequence that every host's `_exhaustChatRecovery` repeated.
 *
 * What this OWNS (the invariant, so it cannot drift per host):
 * - the notification ALWAYS runs before any terminal write, and
 * - a throwing `onExhausted` can NEVER block terminal delivery — it is swallowed
 *   via `onError` (a tested invariant in both published packages).
 *
 * What it deliberately does NOT own: the terminal-record / broadcast /
 * recovering-clear writes — their exact set diverges per host (both
 * `AIChatAgent` and `Think` broadcast the banner first so it survives a storage
 * write that rejects mid-deploy; `Think` additionally writes a submission row)
 * — see {@link ChatRecoveryAdapter.exhaustChatRecovery}. The host expresses
 * those writes inside `terminalize`. A `terminalize` that throws DOES propagate,
 * so the whole give-up re-runs on a healthy isolate (#1730); see
 * {@link ChatRecoveryEngine.exhaustRecoveryGiveUp}.
 *
 * `partialParts` is passed explicitly (not derived from a `RecoveryPartial`) so a
 * foreign-vocabulary host can pass `[]` rather than fabricate AI-SDK parts — the
 * engine seam stays parts-vocabulary-agnostic.
 */
export async function runChatRecoveryExhaustion(
  input: {
    incident: ChatRecoveryIncident;
    config: ResolvedChatRecoveryConfig;
    partialText: string;
    partialParts: ChatRecoveryExhaustedContext["partialParts"];
    streamId: string;
    createdAt: number;
  },
  hooks: {
    emit: (ctx: ChatRecoveryExhaustedContext) => void;
    onExhausted?: (ctx: ChatRecoveryExhaustedContext) => void | Promise<void>;
    onError: (error: unknown) => void;
    terminalize: (ctx: ChatRecoveryExhaustedContext) => void | Promise<void>;
  }
): Promise<void> {
  const ctx = buildChatRecoveryExhaustedContext({
    incident: input.incident,
    config: input.config,
    partialText: input.partialText,
    partialParts: input.partialParts,
    streamId: input.streamId,
    createdAt: input.createdAt
  });
  await notifyChatRecoveryExhausted(ctx, {
    emit: hooks.emit,
    onExhausted: hooks.onExhausted,
    onError: hooks.onError
  });
  await hooks.terminalize(ctx);
}
