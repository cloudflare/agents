/**
 * Route a live stream interruption into bounded recovery: a turn whose stream
 * stalled, or failed with a transient provider error, while its isolate is
 * still running. Shared by `AIChatAgent` and `Think`.
 *
 * The sequence is the one a deploy or eviction interruption goes through
 * after a restart, run from inside the turn:
 *
 * 1. Decide whether there is a reply to continue or a question to retry.
 * 2. Open or re-evaluate the incident. If the budget is spent, give up with
 *    the same terminal message as any other exhaustion.
 * 3. Ask the app (`onChatRecovery`).
 * 4. Store the partial reply, or drop it when the app said `persist: false`
 *    and it holds no settled tool result.
 * 5. Stop if the app said `continue: false`.
 * 6. Schedule a retry or a continue, and mark the incident so a recovery
 *    attempt running this turn leaves the outcome to the scheduled one.
 *
 * @internal Sibling-package support for AI Chat and Think.
 */

import type { ChatRecoveryOptions } from "./lifecycle";
import { partialHasSettledToolResults } from "./recovery-codec";
import type {
  ChatRecoveryEngine,
  ChatRecoveryScheduleReason
} from "./recovery-engine";
import { chatRecoveryBackoffSeconds } from "./recovery-engine";
import type {
  ChatRecoveryIncident,
  ChatRecoveryKind
} from "./recovery-incident";
import type { MessagePart } from "./message-builder";

/**
 * What the turn does next.
 *
 * - `"scheduled"`: recovery is scheduled. The turn closes its stream cleanly
 *   and sends no terminal error.
 * - `"exhausted"`: the budget is spent and the terminal message was
 *   delivered. The turn must not send its own.
 * - `"declined"`: the app returned `continue: false`.
 * - `"failed"`: `onChatRecovery` threw, or routing itself failed. The turn
 *   delivers its ordinary terminal error.
 */
export type StreamInterruptionOutcome =
  | "scheduled"
  | "exhausted"
  | "declined"
  | "failed";

/** What the engine knows when it asks the app about a live interruption. */
export type StreamInterruptionRecoveryContext = {
  incidentId: string;
  recoveryRootRequestId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: ChatRecoveryKind;
  streamId: string;
  requestId: string;
  partialText: string;
  partialParts: MessagePart[];
  /** When the incident was first seen: the fallback for the turn's start. */
  firstSeenAt: number;
};

/** What a host supplies to route one interruption. */
export interface StreamInterruptionHost {
  /** The interrupted turn's request id. */
  requestId: string;
  /** Its stream. */
  streamId: string;
  /** What the turn had streamed of its reply. */
  partialParts: MessagePart[];
  /** Delay the recovery with exponential backoff (transient errors). */
  backoff?: boolean;
  /** A provider's `Retry-After`, which extends the backoff. */
  retryAfterSeconds?: number;
  /** The latest user message, for the incident's identity. */
  latestUserMessageId: string | null;
  /** The message ids the interrupted request came from (#2280). */
  originMessageIds?: string[];

  /**
   * The unanswered user message to retry when no part of the reply is
   * stored, or `null` when there is none and recovery continues the reply.
   * Read before the incident opens and again after a partial was dropped.
   */
  retryTargetUserId(): Promise<string | null>;
  /** Call the app's `onChatRecovery` with the rest of its context. */
  onChatRecovery(
    context: StreamInterruptionRecoveryContext
  ): Promise<ChatRecoveryOptions | void>;
  /**
   * Store the partial reply (`keep`) or drop it. Returns the id of the
   * stored assistant message recovery should continue, if there is one.
   */
  resolvePartial(keep: boolean): Promise<string | undefined>;
  /** The tools and body the interrupted request ran with. */
  requestContext(): { lastBody: unknown; lastClientTools: unknown };
  /** The app declined to continue. Runs after the incident is marked. */
  onDeclined?(): Promise<void>;
  /** Runs before the recovery is scheduled. */
  beforeSchedule?(incidentId: string, partialText: string): Promise<void>;
  /** Extra fields for the schedule payload. */
  scheduleData?(kind: ChatRecoveryKind): Promise<Record<string, unknown>>;
  /**
   * Runs after the recovery is scheduled. `chained` is true when the turn
   * was itself a recovery attempt.
   */
  afterSchedule?(chained: boolean): void;
}

/** What to schedule for an interrupted turn. */
export type RecoveredTurnSchedule = {
  incident: ChatRecoveryIncident;
  /** The kind to report. See {@link ChatRecoveryEngine.scheduleRecovery}. */
  recoveryKind: ChatRecoveryKind;
  /** The root of the chain of attempts this one belongs to. */
  recoveryRootRequestId: string;
  /**
   * The unanswered user message to answer again. When set, the attempt is a
   * retry. Otherwise it continues `targetAssistantId`.
   */
  retryUserId?: string | null;
  /** The stored reply to continue. */
  targetAssistantId?: string;
  /**
   * The tools and body the interrupted request ran with. Omitted when they
   * are not known (no snapshot survived), which leaves the stored ones.
   */
  requestContext?: { lastBody?: unknown; lastClientTools?: unknown } | null;
  /** The message ids the interrupted request came from (#2280). */
  originMessageIds?: string[];
  /** Host fields for the payload, such as `Think`'s `recoveredRequestId`. */
  extra?: Record<string, unknown>;
  delaySeconds?: number;
  reason?: ChatRecoveryScheduleReason;
};

/**
 * Schedule the recovery attempt for an interrupted turn: a retry of
 * `retryUserId`, or a continue of `targetAssistantId`. This is the one place
 * the callback payload is built, for a turn interrupted live and for one
 * found after a restart.
 */
export async function scheduleRecoveredTurn(
  engine: ChatRecoveryEngine,
  input: RecoveredTurnSchedule
): Promise<void> {
  const { incident, requestContext } = input;
  await engine.scheduleRecovery({
    incident,
    delaySeconds: input.delaySeconds,
    reason: input.reason,
    recoveryKind: input.recoveryKind,
    callback: input.retryUserId
      ? "_chatRecoveryRetry"
      : "_chatRecoveryContinue",
    data: {
      ...(input.retryUserId
        ? { targetUserId: input.retryUserId }
        : input.targetAssistantId
          ? { targetAssistantId: input.targetAssistantId }
          : {}),
      originalRequestId: input.recoveryRootRequestId,
      incidentId: incident.incidentId,
      ...(requestContext
        ? {
            lastBody: requestContext.lastBody ?? null,
            lastClientTools: requestContext.lastClientTools ?? null
          }
        : {}),
      ...(input.originMessageIds
        ? { originMessageIds: input.originMessageIds }
        : {}),
      ...input.extra
    }
  });
}

/**
 * Route one live stream interruption. A failure of the routing itself (a
 * rejected incident write, say) degrades to `"failed"`, so the turn still
 * delivers its terminal error frame.
 */
export async function routeStreamInterruption(
  engine: ChatRecoveryEngine,
  host: StreamInterruptionHost
): Promise<StreamInterruptionOutcome> {
  try {
    return await route(engine, host);
  } catch (error) {
    console.error(
      `${engine.turns.label} routing a stream interruption into recovery failed; delivering the terminal error`,
      error
    );
    return "failed";
  }
}

async function route(
  engine: ChatRecoveryEngine,
  host: StreamInterruptionHost
): Promise<StreamInterruptionOutcome> {
  const { requestId, streamId, partialParts } = host;
  // Inside a recovery attempt the interrupted turn belongs to that attempt's
  // chain, and the next attempt must not join the run that schedules it.
  const chained = engine.activeRootRequestId !== undefined;
  const recoveryRootRequestId = engine.activeRootRequestId ?? requestId;

  // A turn that failed before it produced any part has nothing to continue.
  // Continuing would merge into the previous reply (#1691), so retry the
  // question, as a restart's recovery does.
  const lostReplyUserId =
    partialParts.length === 0 ? await host.retryTargetUserId() : null;
  const recoveryKind: ChatRecoveryKind = lostReplyUserId ? "retry" : "continue";

  const { incident, config, exhausted } = await engine.beginIncident({
    requestId,
    recoveryRootRequestId,
    latestUserMessageId: host.latestUserMessageId,
    recoveryKind,
    trigger: "stalled"
  });
  const partialText = partialParts
    .filter(
      (part): part is MessagePart & { type: "text"; text: string } =>
        (part as { type?: string }).type === "text"
    )
    .map((part) => part.text)
    .join("");

  if (exhausted) {
    // The same give-up as deploy recovery, not the raw stream error.
    // `firstSeenAt` is the closest thing to the turn's start here.
    await host.resolvePartial(true);
    await engine.terminalize(
      incident,
      config,
      {
        text: partialText,
        parts: partialParts,
        hasSettledToolResults: partialHasSettledToolResults(partialParts)
      },
      streamId,
      incident.firstSeenAt
    );
    return "exhausted";
  }

  let options: ChatRecoveryOptions;
  try {
    options =
      (await host.onChatRecovery({
        incidentId: incident.incidentId,
        recoveryRootRequestId,
        attempt: incident.attempt,
        maxAttempts: incident.maxAttempts,
        recoveryKind,
        streamId,
        requestId,
        partialText,
        partialParts,
        firstSeenAt: incident.firstSeenAt
      })) ?? {};
  } catch (error) {
    console.error(
      `${engine.turns.label} onChatRecovery threw during stream recovery:`,
      error
    );
    await host.resolvePartial(true);
    await engine.updateIncident(
      incident.incidentId,
      "failed",
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }

  // `persist: false` drops the partial unless it holds settled tool results:
  // work that is not idempotent and must not run again.
  const targetAssistantId = await host.resolvePartial(
    options.persist !== false || partialHasSettledToolResults(partialParts)
  );

  if (options.continue === false) {
    await engine.updateIncident(
      incident.incidentId,
      "skipped",
      "continue_disabled"
    );
    await host.onDeclined?.();
    return "declined";
  }

  // A dropped partial can leave the user's message as the latest, so read
  // the retry target again.
  const retryUserId = targetAssistantId
    ? null
    : partialParts.length === 0
      ? lostReplyUserId
      : await host.retryTargetUserId();

  await host.beforeSchedule?.(incident.incidentId, partialText);
  // Stalls count too: a turn that streams a little and then stalls resets
  // the progress-keyed attempt cap every time, so this is its only bound.
  const retries = await engine.recordTransientRetry(incident.incidentId);
  const delaySeconds = host.backoff
    ? chatRecoveryBackoffSeconds(retries, host.retryAfterSeconds)
    : undefined;
  const kind: ChatRecoveryKind = retryUserId ? "retry" : "continue";
  await scheduleRecoveredTurn(engine, {
    incident,
    recoveryKind: kind,
    recoveryRootRequestId,
    retryUserId,
    targetAssistantId,
    requestContext: host.requestContext(),
    originMessageIds: host.originMessageIds,
    extra: await host.scheduleData?.(kind),
    delaySeconds,
    reason: chained ? "chained_retry" : undefined
  });
  engine.markRescheduled(incident.incidentId);
  host.afterSchedule?.(chained);
  return "scheduled";
}
