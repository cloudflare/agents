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

import type { FiberRecoveryContext } from "../index";
import type {
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ResolvedChatRecoveryConfig
} from "./lifecycle";
import type { ChatFiberSnapshot } from "./recovery";
import {
  CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS,
  chatRecoveryIncidentId,
  chatRecoveryIncidentKey,
  evaluateChatRecoveryIncident
} from "./recovery-incident";
import type {
  ChatRecoveryIncident,
  ChatRecoveryIncidentEvent,
  ChatRecoveryKind
} from "./recovery-incident";

/** The scheduled-callback entrypoints a recovery schedule can target. */
export type ChatRecoveryScheduleCallback =
  | "_chatRecoveryContinue"
  | "_chatRecoveryRetry";

/**
 * Why a recovery callback is being scheduled. The idempotency of the underlying
 * `schedule()` call depends ONLY on this:
 *
 * - `"initial"` — the first schedule of a continuation/retry when an interrupted
 *   turn is detected on wake. A deploy rollout drops/reconnects the socket
 *   several times, re-triggering detection; idempotent scheduling (dedup on
 *   callback + payload) collapses that storm into a single enqueued continuation
 *   instead of N duplicates.
 *
 * - `"stable_timeout_retry"` — a reschedule issued from INSIDE the currently-
 *   executing one-shot schedule row (a continuation that timed out waiting for
 *   stable state). `alarm()` deletes that row only AFTER the callback returns,
 *   so an idempotent reschedule would dedup onto the doomed row and be deleted
 *   with it — the retry would never fire. A fresh (non-idempotent) delayed row
 *   survives the deletion.
 */
export type ChatRecoveryScheduleReason = "initial" | "stable_timeout_retry";

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

/**
 * Resolve the `schedule()` idempotency option for a recovery schedule. Single
 * source of truth for both packages; see {@link ChatRecoveryScheduleReason} for
 * the rationale behind each case.
 *
 * This is a cutover invariant: flipping either case silently breaks deploy-storm
 * dedup (initial) or stalls stable-timeout retries (reschedule), and neither is
 * caught by a type error — only by the recovery suites.
 */
export function chatRecoverySchedulePolicy(
  reason: ChatRecoveryScheduleReason
): { idempotent: boolean } {
  return { idempotent: reason === "initial" };
}

/** Identity + context for opening (or re-evaluating) a recovery incident. */
export interface BeginChatRecoveryIncidentInput {
  requestId: string;
  recoveryRootRequestId?: string | null;
  latestUserMessageId?: string | null;
  recoveryKind: ChatRecoveryKind;
  /** Test-only clock injection for deterministic debounce/window timing. */
  nowMs?: number;
}

export interface BeginChatRecoveryIncidentResult {
  incident: ChatRecoveryIncident;
  config: ResolvedChatRecoveryConfig;
  exhausted: boolean;
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
  /**
   * Optional: give the package a chance to handle a NON-chat fiber before chat
   * recovery inspects it. Returns `true` if the package fully consumed the
   * fiber, in which case the engine tells the caller to skip chat-recovery
   * processing for it. `Think` uses this for its messenger/workflow reply fibers
   * (`think:messenger-reply`); `AIChatAgent` has no non-chat fibers and omits it
   * (the engine then treats every recovered fiber as a chat-recovery candidate).
   *
   * Ordering invariant: the engine dispatches this FIRST, before the
   * chat-fiber-name gate, so a non-chat fiber is never misclassified as an
   * orphaned chat turn.
   */
  tryHandleNonChatFiberRecovery?(ctx: FiberRecoveryContext): Promise<boolean>;
  /** Monotonic forward-progress marker for the no-progress budget. */
  readProgress(): Promise<number>;
  /**
   * Whether the turn is parked on a pending CLIENT interaction (waiting on the
   * human, not stuck). When true the engine keeps the incident budget-free.
   * Optional: a host with no client-interaction/HITL substrate (e.g. the pi
   * fixture) omits it and the engine treats the turn as never parked (`false`).
   */
  isAwaitingClientInteraction?(): boolean;
  /** Persist the evaluated incident under `key`. */
  putIncident(key: string, incident: ChatRecoveryIncident): Promise<void>;
  /**
   * Delete the incident record under `key`. The engine calls this on the
   * terminal `completed` transition (a completed recovery is never retried, so
   * its record is dropped rather than left in storage forever).
   */
  deleteIncident(key: string): Promise<void>;
  /** Broadcast a lifecycle event produced by the evaluation or a transition. */
  emitRecoveryEvent(event: ChatRecoveryIncidentEvent): void;
  /**
   * Enqueue a recovery callback. A thin pass-through to the package's
   * `schedule(delaySeconds, callback, data, chatRecoverySchedulePolicy(reason))`
   * — the engine owns the surrounding orchestration (the transition + emit for
   * the initial schedule in {@link ChatRecoveryEngine.scheduleRecovery}, the
   * attempt bump for {@link ChatRecoveryEngine.rescheduleAfterStableTimeout});
   * the package owns the Durable Object alarm write and the payload shape.
   * `reason` selects the idempotency policy and `delaySeconds` the alarm delay
   * (`0` for the initial enqueue, `CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS` for
   * a stable-timeout reschedule).
   */
  scheduleRecovery(
    callback: ChatRecoveryScheduleCallback,
    data: Record<string, unknown>,
    reason: ChatRecoveryScheduleReason,
    delaySeconds: number
  ): Promise<void>;
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
    createdAt: number
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
   * recovery chain is active. (`AIChatAgent` and `Think` both back this with
   * `_activeChatRecoveryRootRequestId`.)
   */
  activeChatRecoveryRootRequestId(): string | undefined;
  /**
   * Report a tolerated best-effort bookkeeping failure during give-up: the
   * incident `"read"` (before synthesizing) or the sealing `"seal"` write
   * (after terminalization). Neither aborts terminalization — see
   * {@link ChatRecoveryEngine.exhaustRecoveryGiveUp}.
   */
  onGiveUpBookkeepingError(phase: "read" | "seal", error: unknown): void;
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

/** Input to {@link ChatFiberWakeHooks.classifyRecoveredTurn}. */
export interface ClassifyRecoveredTurnInput {
  snapshot: ChatFiberSnapshot | null;
  requestId: string;
  streamId: string;
  partial: RecoveryPartial;
  streamStillActive: boolean;
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

/** Input to {@link ChatFiberWakeHooks.dispatchRecoveredTurn}. */
export interface DispatchRecoveredTurnInput<TClassify> {
  incident: ChatRecoveryIncident;
  config: ResolvedChatRecoveryConfig;
  recoveryKind: ChatRecoveryKind;
  options: ChatRecoveryOptions;
  snapshot: ChatFiberSnapshot | null;
  requestId: string;
  recoveryRootRequestId: string;
  streamId: string;
  streamStatus?: ChatStreamStatus;
  /** The package-specific classification detail produced by `classifyRecoveredTurn`. */
  detail: TClassify;
}

/**
 * The wake-dispatch host operations the engine drives when an interrupted CHAT
 * fiber is detected on restart — the divergent organs the frame-collapse map
 * flagged. Kept SEPARATE from {@link ChatRecoveryAdapter} (and passed per call to
 * {@link ChatRecoveryEngine.handleChatFiberRecovery}) so the incident/give-up
 * adapter stays focused, and generic over `TClassify` so the
 * `classifyRecoveredTurn` → `dispatchRecoveredTurn` handoff is type-safe without a
 * class-level generic.
 *
 * The engine owns the wake LIFECYCLE (gate → parse → unwrap → stream → partial →
 * classify → begin-incident → exhausted-branch → onChatRecovery → persist →
 * complete → dispatch → catch→failed) and the shared persist clause; these hooks
 * own the package-specific I/O and the retry/continue/skip decision.
 */
export interface ChatFiberWakeHooks<TClassify> {
  /** The chat-fiber name prefix (`CHAT_FIBER_NAME + ":"`) gating the wake path. */
  chatFiberPrefix(): string;
  /** Decode the fiber snapshot into the recovery snapshot + checkpointed user data. */
  unwrapRecoverySnapshot(ctx: FiberRecoveryContext): {
    snapshot: ChatFiberSnapshot | null;
    recoveryData: unknown;
  };
  /**
   * Classify the recovered turn as a `retry` or `continue` and return any
   * package-specific detail the dispatch decision needs (e.g. the pre-stream
   * retry target id). Runs before the incident is opened.
   */
  classifyRecoveredTurn(
    input: ClassifyRecoveredTurnInput
  ):
    | { recoveryKind: ChatRecoveryKind; detail: TClassify }
    | Promise<{ recoveryKind: ChatRecoveryKind; detail: TClassify }>;
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
  /**
   * The retry/continue/skip DECISION — the package-owned core. Runs after persist
   * + complete; owns the leaf/submission computation, the schedule calls (via
   * {@link ChatRecoveryEngine.scheduleRecovery}), the skip transitions, and any
   * package-specific terminal/broadcast writes.
   */
  dispatchRecoveredTurn(
    input: DispatchRecoveredTurnInput<TClassify>
  ): Promise<void>;
}

/**
 * Drives the shared recovery orchestration over a {@link ChatRecoveryAdapter}.
 * The incident *budget math* lives in the pure `evaluateChatRecoveryIncident`;
 * this class owns the surrounding sequence and its ordering invariants.
 */
export class ChatRecoveryEngine {
  constructor(private readonly adapter: ChatRecoveryAdapter) {}

  /**
   * Open or re-evaluate the recovery incident for `input`, persist the result,
   * and broadcast its lifecycle events. Returns the incident, the resolved
   * config, and whether the budget is now exhausted.
   */
  /**
   * Dispatch a recovered fiber to the package's non-chat handler (the
   * messenger/workflow seam) before any chat-recovery processing. Returns `true`
   * when the package consumed the fiber — the caller must then skip chat
   * recovery for it. The engine owns the *ordering* (this runs before the
   * chat-fiber gate); the *behavior* is adapter-owned. No-op (`false`) when the
   * adapter omits {@link ChatRecoveryAdapter.tryHandleNonChatFiberRecovery}.
   */
  async handleNonChatFiber(ctx: FiberRecoveryContext): Promise<boolean> {
    return (await this.adapter.tryHandleNonChatFiberRecovery?.(ctx)) ?? false;
  }

  /**
   * The shared wake-recovery LIFECYCLE for an interrupted chat fiber. Both
   * packages drove this exact frame; the divergent organs are the
   * {@link ChatFiberWakeHooks}. In order:
   *
   * 1. non-chat dispatch ({@link handleNonChatFiber}) FIRST, then the chat-fiber
   *    name gate — a non-chat fiber is never misread as an orphaned chat turn;
   * 2. parse the request id, unwrap the snapshot, resolve the orphaned stream +
   *    reconstruct its partial;
   * 3. classify the turn (retry/continue + package detail) and open the incident;
   * 4. if the budget is already exhausted, persist the settled partial (so
   *    non-idempotent tool results are not discarded — #1631) and terminalize
   *    BEFORE consulting `onChatRecovery`;
   * 5. otherwise, inside a `failed`-on-throw guard: invoke `onChatRecovery`,
   *    apply the shared persist gate (base eligibility AND `persist !== false ||
   *    settled tool results`), complete the live stream, then hand the
   *    retry/continue/skip DECISION to {@link ChatFiberWakeHooks.dispatchRecoveredTurn}.
   *
   * Returns `true` when the fiber was a chat (or non-chat) recovery the engine
   * handled, `false` when it was not a chat fiber (the caller keeps looking). Any
   * throw after the incident opens flips it to `failed` so it is never left
   * leaking in `attempting`.
   */
  async handleChatFiberRecovery<TClassify>(
    ctx: FiberRecoveryContext,
    wake: ChatFiberWakeHooks<TClassify>
  ): Promise<boolean> {
    const { adapter } = this;

    // Ordering invariant: non-chat (messenger/workflow) fibers dispatch BEFORE
    // the chat-fiber gate.
    if (await this.handleNonChatFiber(ctx)) return true;

    const chatPrefix = wake.chatFiberPrefix();
    if (!ctx.name.startsWith(chatPrefix)) return false;

    const requestId = ctx.name.slice(chatPrefix.length);
    const { snapshot, recoveryData } = wake.unwrapRecoverySnapshot(ctx);
    const stream = adapter.resolveRecoveryStream(requestId);
    const { streamId, streamStillActive, streamStatus } = stream;
    const partial = streamId
      ? adapter.getPartialStreamText(streamId)
      : { text: "", parts: [], hasSettledToolResults: false };

    const { recoveryKind, detail } = await wake.classifyRecoveredTurn({
      snapshot,
      requestId,
      streamId,
      partial,
      streamStillActive,
      streamStatus
    });
    const recoveryRootRequestId = snapshot?.recoveryRootRequestId ?? requestId;

    const { incident, config, exhausted } = await this.beginIncident({
      requestId,
      recoveryRootRequestId,
      latestUserMessageId: snapshot?.latestUserMessageId,
      recoveryKind
    });

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
        ctx.createdAt
      );
      return true;
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
          createdAt: ctx.createdAt
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

      await wake.dispatchRecoveredTurn({
        incident,
        config,
        recoveryKind,
        options,
        snapshot,
        requestId,
        recoveryRootRequestId,
        streamId,
        streamStatus,
        detail
      });

      return true;
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
  private async _shouldPersistOrphanedPartial<TClassify>(
    wake: ChatFiberWakeHooks<TClassify>,
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

    const { incident, exhausted, events } = await evaluateChatRecoveryIncident({
      identity: input,
      config,
      existing,
      currentProgress,
      awaitingClientInteraction:
        adapter.isAwaitingClientInteraction?.() ?? false,
      now,
      onShouldKeepRecoveringError: (error) =>
        adapter.onShouldKeepRecoveringError?.(error)
    });

    await adapter.putIncident(key, incident);
    for (const event of events) {
      adapter.emitRecoveryEvent(event);
    }
    return { incident, config, exhausted };
  }

  /**
   * Schedule a recovery continuation/retry: the transition + emit + enqueue
   * triplet both packages repeat at every fiber-recovery and stall-routing
   * decision. In order:
   *
   * 1. transition the incident to `scheduled` (persist + drive the #1620
   *    "recovering…" status) via {@link updateIncident};
   * 2. emit `chat:recovery:scheduled`; and
   * 3. enqueue the callback through the adapter's idempotent schedule.
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
  }): Promise<void> {
    const { incident } = input;
    await this.updateIncident(incident.incidentId, "scheduled");
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
      input.data,
      input.reason ?? "initial",
      0
    );
  }

  /**
   * Reschedule a recovery continuation/retry that timed out waiting for stable
   * state, INSIDE the currently-executing one-shot schedule row. Reads the
   * incident; if it is still under the attempt cap, bumps `attempt`, marks it
   * `scheduled` with `reason:"stable_timeout_retry"`, and issues a delayed,
   * NON-idempotent schedule (`alarm()` deletes the executing row only after this
   * returns, so an idempotent reschedule would dedup onto that doomed row and
   * never fire — see {@link chatRecoverySchedulePolicy}).
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
    const incident = await adapter.getIncident(key);
    if (!incident) return false;
    const attempt = incident.attempt ?? 0;
    if (attempt >= (incident.maxAttempts ?? input.fallbackMaxAttempts)) {
      return false;
    }
    await adapter.putIncident(key, {
      ...incident,
      attempt: attempt + 1,
      status: "scheduled",
      lastAttemptAt: adapter.now(),
      reason: "stable_timeout_retry"
    });
    await adapter.scheduleRecovery(
      input.callback,
      input.data ?? {},
      "stable_timeout_retry",
      CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS
    );
    return true;
  }

  /**
   * Record that a recovery callback observed a Durable Object memory-limit reset
   * (the isolate exceeded its 128 MB limit — `isDurableObjectMemoryLimitReset`)
   * and decide what to do next (#1825).
   *
   * Bumps the incident's durable `oomAttempts` counter, then:
   *  - if it is still within `maxOomRetries`, issues a delayed, NON-idempotent
   *    reschedule of the SAME callback (same machinery as
   *    {@link rescheduleAfterStableTimeout}: the executing one-shot row is
   *    deleted only after the callback returns, so an idempotent reschedule
   *    would dedup onto that doomed row) and returns `"rescheduled"`. The small
   *    delay lets a transient memory spike clear before the re-run;
   *  - otherwise leaves the incremented count persisted (so a begin-path
   *    re-evaluation agrees) and returns `"exhausted"` — the caller then
   *    terminalizes via the give-up path with `reason="out_of_memory"`.
   *
   * Returns `"exhausted"` when there is no incident to track against (no id /
   * record gone): an OOM we cannot bound must seal rather than loop. Unlike a
   * stable-state retry this is gated by the OOM-specific budget, NOT the generic
   * attempt cap — re-running an OOM streams a little "progress" that would
   * otherwise reset the attempt cap forever (the #1825 loop).
   */
  async recordOomAndDecide(input: {
    incidentId: string | undefined;
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown> | undefined;
    maxOomRetries: number;
  }): Promise<"rescheduled" | "exhausted"> {
    const { adapter } = this;
    if (!input.incidentId) return "exhausted";
    const key = chatRecoveryIncidentKey(input.incidentId);
    const incident = await adapter.getIncident(key);
    if (!incident) return "exhausted";
    const oomAttempts = (incident.oomAttempts ?? 0) + 1;
    if (oomAttempts > input.maxOomRetries) {
      // Persist the crossed count so the begin-path backstop in
      // `evaluateChatRecoveryIncident` agrees, then let the caller terminalize.
      await adapter.putIncident(key, {
        ...incident,
        oomAttempts,
        lastAttemptAt: adapter.now(),
        reason: "out_of_memory"
      });
      return "exhausted";
    }
    await adapter.putIncident(key, {
      ...incident,
      oomAttempts,
      status: "scheduled",
      lastAttemptAt: adapter.now(),
      reason: "oom_retry"
    });
    await adapter.scheduleRecovery(
      input.callback,
      input.data ?? {},
      "stable_timeout_retry",
      CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS
    );
    return "rescheduled";
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
   *    `Agent._executeScheduleCallback` defers the one-shot row and the WHOLE
   *    give-up re-runs on a healthy isolate. Sealing first would arm the
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
      adapter.activeChatRecoveryRootRequestId() ??
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

    if (incidentKey) {
      try {
        await adapter.putIncident(incidentKey, incident);
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
   */
  async updateIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string
  ): Promise<void> {
    if (!incidentId) return;
    const { adapter } = this;
    const key = chatRecoveryIncidentKey(incidentId);
    const incident = await adapter.getIncident(key);
    if (!incident) return;

    if (status === "completed") {
      await adapter.deleteIncident(key);
    } else {
      await adapter.putIncident(key, {
        ...incident,
        status,
        ...(reason ? { reason } : {})
      });
    }

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
  }
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
