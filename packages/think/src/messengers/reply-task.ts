/**
 * Messenger replies as deliveries. A webhook's reply is one delivery run:
 * its input is the event and thread, its first attempt answers live, and
 * an attempt after a reset answers again or apologizes, by how far the
 * reply got (the `stage` in its checkpoint).
 *
 * Durable: nothing of its own (the run and its checkpoint belong to Tasks).
 * In memory: the live reply, for as long as the webhook waits on it.
 */

import {
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
  isPlatformTransientError
} from "agents";
import { registerDeliverySink, sendDelivery } from "agents/internal";
import { NonRetryableError, type TaskJson, type Tasks } from "agents/tasks";
import type { MessengerReplyStage } from "./delivery";
import type { MessengerEvent } from "./events";

const MESSENGER_REPLY_SINK = "messenger-reply";

/** The checkpoint key of how far a reply got. */
const STAGE = "stage";

/** A reply's own attempt takes as long as its answer: one day at most. */
const REPLY_ATTEMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** @internal */
export type MessengerReplyPayload = {
  /** The event, as JSON. */
  event: MessengerEvent;
  /** The Chat SDK thread, as JSON. */
  thread: unknown;
};

/** Records how far a reply got. @internal */
export type RecordReplyStage = (stage: "streaming" | "completed") => void;

/** The reply the webhook that received its message waits on. @internal */
export type LiveMessengerReply = {
  answer(record: RecordReplyStage): Promise<void>;
};

/** What the messenger runtime gives the reply sink. @internal */
export type MessengerReplyRuntime = {
  recoverReply(
    payload: MessengerReplyPayload,
    stage: MessengerReplyStage,
    record: RecordReplyStage
  ): Promise<void>;
  /** After a recovered reply ended (or gave up), answer what queued behind it. */
  drainAfterRecovery(payload: MessengerReplyPayload): void;
};

const isPlatformReset = (error: unknown) =>
  isPlatformTransientError(error) ||
  isDurableObjectMemoryLimitReset(error) ||
  isDurableObjectCodeUpdateReset(error);

/**
 * Answer again or apologize for a reply a reset cut off at `stage`, then
 * answer what queued behind it. A failure `retried` says is tried again
 * (the queue waits for it); any other ends the reply, so it is never
 * answered twice.
 *
 * @internal
 */
export async function recoverMessengerReply(
  messengers: MessengerReplyRuntime,
  payload: MessengerReplyPayload,
  stage: MessengerReplyStage,
  record: RecordReplyStage,
  retried: (error: unknown) => boolean = isPlatformReset
): Promise<void> {
  try {
    await messengers.recoverReply(payload, stage, record);
  } catch (error) {
    if (retried(error)) throw error;
    messengers.drainAfterRecovery(payload);
    throw new NonRetryableError(
      error instanceof Error ? error.message : String(error)
    );
  }
  messengers.drainAfterRecovery(payload);
}

/**
 * Register the reply sink and, TEMPORARY for one release, the definition
 * replies ran on before (think@0.24.0, and main until this change): such a
 * run left open by a reset becomes a reply delivery at the stage its
 * snapshot recorded.
 *
 * @internal
 */
export function registerMessengerReplies(
  tasks: Tasks,
  storage: DurableObjectStorage,
  runtime: () => MessengerReplyRuntime | undefined
): void {
  registerDeliverySink<MessengerReplyPayload>(tasks, MESSENGER_REPLY_SINK, {
    attemptTimeoutMs: REPLY_ATTEMPT_TIMEOUT_MS,
    async deliver(payload, attempt) {
      const messengers = runtime();
      if (!messengers) throw new Error("Messenger runtime is unavailable");
      const record: RecordReplyStage = (stage) =>
        attempt.checkpoint.set(STAGE, stage);
      const live = attempt.local as LiveMessengerReply | undefined;
      if (live) {
        await live.answer(record);
        return;
      }
      await recoverMessengerReply(
        messengers,
        payload,
        attempt.checkpoint.get<MessengerReplyStage>(STAGE) ?? "accepted",
        record
      );
    },
    onGiveUp(error) {
      console.error("[Think] A messenger reply was given up", error);
    }
  });

  // TEMPORARY: remove in the next minor after this ships.
  tasks.register(RELEASED_REPLY_DEFINITION, async (_input, step) => {
    const key = `__cf_messenger_recovery:${step.id}`;
    const snapshot = releasedSnapshot(
      step.checkpoint.get("snapshot") ?? (await storage.get(key))
    );
    if (snapshot && snapshot.stage !== "completed") {
      await sendDelivery<MessengerReplyPayload>(
        tasks,
        MESSENGER_REPLY_SINK,
        // Its own id: this run's row stays until it completes.
        `${step.id}:reply`,
        { event: snapshot.event, thread: snapshot.thread },
        {
          sentAt: step.createdAt,
          attempts: 0,
          progress: { [STAGE]: snapshot.stage }
        }
      );
    }
    await storage.delete(key);
  });
}

/**
 * Accept one reply and answer it here and now. A repeated webhook (same
 * id) while the reply runs joins it.
 *
 * @internal
 */
export function sendMessengerReply(
  tasks: Tasks,
  id: string,
  payload: MessengerReplyPayload,
  live: LiveMessengerReply
): Promise<void> {
  return sendDelivery(
    tasks,
    MESSENGER_REPLY_SINK,
    id,
    payload as unknown as TaskJson,
    undefined,
    live
  );
}

/** The definition think@0.24.0 ran replies on. */
const RELEASED_REPLY_DEFINITION = "__cf_internal_messenger_reply";

/** A released reply snapshot, as think@0.24.0 kept it. */
function releasedSnapshot(
  value: unknown
):
  | { stage: MessengerReplyStage; event: MessengerEvent; thread: unknown }
  | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as {
    type?: unknown;
    stage?: unknown;
    event?: MessengerEvent;
    thread?: unknown;
  };
  if (
    candidate.type !== "think:messenger-reply" ||
    (candidate.stage !== "accepted" &&
      candidate.stage !== "streaming" &&
      candidate.stage !== "completed") ||
    candidate.event === undefined
  ) {
    return undefined;
  }
  return {
    stage: candidate.stage,
    event: candidate.event,
    thread: candidate.thread
  };
}
