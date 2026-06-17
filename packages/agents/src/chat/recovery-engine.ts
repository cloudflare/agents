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
  ResolvedChatRecoveryConfig
} from "./lifecycle";
import type { MessagePart } from "./message-builder";
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

/** A reconstructed orphaned-stream partial (buffered text + message parts). */
export type RecoveryPartial = { text: string; parts: MessagePart[] };

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
  targetAssistantId?: string | null;
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
   */
  isAwaitingClientInteraction(): boolean;
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
  /** Report a throw from the caller's `shouldKeepRecovering` hook. */
  onShouldKeepRecoveringError(error: unknown): void;
  /**
   * Terminalize a given-up recovery turn: deliver the exhaustion notification
   * plus the package-owned terminal record / banner / submission writes. A thin
   * pass-through to the package's `_exhaustChatRecovery`. Driven by
   * {@link ChatRecoveryEngine.exhaustRecoveryGiveUp}; the engine owns the
   * surrounding read → re-entry-guard → build → terminalize → seal sequence, the
   * package owns the (legitimately divergent) terminal/broadcast ordering.
   */
  exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    partial: RecoveryPartial,
    streamId: string,
    createdAt: number
  ): Promise<void>;
  /**
   * Resolve the orphaned stream id for a (recovery-root) request id, or `""`
   * when no stream metadata survives. A thin pass-through to the package's
   * `_resolveRecoveryStreamId`.
   */
  resolveRecoveryStreamId(requestId: string): string;
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
      awaitingClientInteraction: adapter.isAwaitingClientInteraction(),
      now,
      onShouldKeepRecoveringError: (error) =>
        adapter.onShouldKeepRecoveringError(error)
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

    const streamId = adapter.resolveRecoveryStreamId(
      incident.recoveryRootRequestId ?? incident.requestId
    );
    const partial = streamId
      ? adapter.getPartialStreamText(streamId)
      : { text: "", parts: [] as MessagePart[] };

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
