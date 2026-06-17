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

import type {
  ChatRecoveryExhaustedContext,
  ResolvedChatRecoveryConfig
} from "./lifecycle";
import {
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
   * Set or clear the live "recovering…" status (#1620). The engine calls this on
   * the incident transitions: `scheduled` → active (keyed by the recovery-root
   * request id, falling back to the incident's request id), and
   * `completed`/`skipped`/`failed` → cleared. The package owns the underlying
   * staleness / idempotency / broadcast I/O.
   */
  setRecovering(active: boolean, requestId?: string): Promise<void>;
  /** Report a throw from the caller's `shouldKeepRecovering` hook. */
  onShouldKeepRecoveringError(error: unknown): void;
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
