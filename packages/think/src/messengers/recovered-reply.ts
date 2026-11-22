import type { OutboxSink } from "agents/chat";

/**
 * A messenger reply this agent owes after chat recovery settles, keyed by
 * the recovery incident. It is held in the Outbox from the interruption
 * until recovery settles, then released with `outcome` set.
 */
export type RecoveredMessengerReply = {
  messengerId: string;
  threadId: string;
  partialText: string;
  outcome?: "completed" | "interrupted";
  text?: string;
  /**
   * Posts already made before the reply entered the Outbox. Set only on
   * replies migrated from earlier releases.
   */
  posted?: number;
};

/** What the messenger host needs to post one part of a recovered reply. */
export type RecoveredReplyPost = {
  messengerId: string;
  threadId: string;
  outcome: "completed" | "interrupted";
  text?: string;
  partialPosted: boolean;
  chunk: number;
};

/** Outbox sink that posts recovered messenger replies. */
export const RECOVERED_REPLY_SINK = "__cf_think_messenger_recovery";

/** Storage prefix of replies written by earlier releases. */
const LEGACY_PREFIX = "cf_think_messenger_recovery:";

/** The reply with its outcome; a recovered text drops the part already posted. */
export function settleRecoveredReply(
  reply: RecoveredMessengerReply,
  outcome: "completed" | "interrupted",
  text?: string
): RecoveredMessengerReply {
  if (outcome !== "completed") return { ...reply, outcome };
  const recovered = text ?? "";
  return {
    ...reply,
    outcome,
    text: recovered.startsWith(reply.partialText)
      ? recovered.slice(reply.partialText.length)
      : recovered
  };
}

/**
 * The sink. Each post goes out at most once: the checkpoint advances
 * before it, because a rejected post may still have landed (a timeout after
 * the platform accepted it), so a retry resumes with the next post.
 * `connect` resolves the messenger host first; failing to reach it fails
 * the attempt without spending a post.
 */
export function recoveredReplySink(
  connect: () => Promise<
    (input: RecoveredReplyPost) => Promise<{ chunks: number }>
  >
): OutboxSink<RecoveredMessengerReply> {
  return {
    deliver: async (reply, delivery) => {
      const post = await connect();
      const outcome = reply.outcome ?? "interrupted";
      let next =
        typeof delivery.checkpoint === "number"
          ? delivery.checkpoint
          : (reply.posted ?? 0);
      let chunks: number | undefined;
      while (chunks === undefined || next < chunks) {
        await delivery.saveCheckpoint(next + 1);
        ({ chunks } = await post({
          messengerId: reply.messengerId,
          threadId: reply.threadId,
          outcome,
          ...(reply.text !== undefined && { text: reply.text }),
          partialPosted: reply.partialText.trim().length > 0,
          chunk: next
        }));
        next += 1;
      }
    }
  };
}

/**
 * Move replies stored by earlier releases under `cf_think_messenger_recovery:`
 * into the Outbox: held when recovery has not settled them, released
 * otherwise.
 */
export async function migrateLegacyRecoveredReplies(
  storage: DurableObjectStorage,
  send: (
    reply: RecoveredMessengerReply,
    incidentId: string,
    hold: boolean
  ) => Promise<unknown>
): Promise<void> {
  const legacy = await storage.list<RecoveredMessengerReply>({
    prefix: LEGACY_PREFIX
  });
  for (const [key, reply] of legacy) {
    await send(reply, key.slice(LEGACY_PREFIX.length), !reply.outcome);
    await storage.delete(key);
  }
}
