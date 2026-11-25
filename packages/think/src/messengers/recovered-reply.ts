import type { DeliverySink } from "agents/internal";

/**
 * Where a messenger reply goes that chat recovery will finish: the
 * delivery's payload, sent when the turn is interrupted. The reply is held
 * until recovery settles and releases it with its {@link RecoveredReplyOutcome}.
 *
 * @internal
 */
export type RecoveredReplyClaim = {
  messengerId: string;
  threadId: string;
  /** What the interrupted turn already posted. */
  partialText: string;
};

/**
 * What recovery settled: the delivery's checkpoint once released. `text`
 * is the recovered answer without what was already posted.
 *
 * @internal
 */
export type RecoveredReplyOutcome = {
  outcome: "completed" | "interrupted";
  text?: string;
};

/** What the messenger host needs to post one part of a recovered reply. */
type RecoveredReplyPost = {
  messengerId: string;
  threadId: string;
  outcome: "completed" | "interrupted";
  text?: string;
  partialPosted: boolean;
  chunk: number;
};

/** The sink recovered messenger replies are delivered through. @internal */
export const RECOVERED_REPLY_SINK = "think-messenger-recovery";

/** One delivery per recovery incident. @internal */
export function recoveredReplyId(incidentId: string): string {
  return `messenger-recovery:${incidentId}`;
}

/**
 * Most bytes of reply text kept for delivery, so it fits the run's
 * checkpoint with room to spare. No messenger posts a reply anywhere near
 * this long.
 */
const MAX_REPLY_TEXT_BYTES = 900_000;

const encoder = new TextEncoder();

function capText(text: string): string {
  if (encoder.encode(text).byteLength <= MAX_REPLY_TEXT_BYTES) return text;
  let end = Math.min(text.length, MAX_REPLY_TEXT_BYTES);
  while (
    end > 0 &&
    encoder.encode(text.slice(0, end)).byteLength > MAX_REPLY_TEXT_BYTES - 3
  ) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end)}…`;
}

/** The claim, cut to fit a delivery. @internal */
export function recoveredReplyClaim(
  claim: RecoveredReplyClaim
): RecoveredReplyClaim {
  return { ...claim, partialText: capText(claim.partialText) };
}

/**
 * The outcome to release a claim with: a recovered text drops the part
 * already posted.
 *
 * @internal
 */
export function recoveredReplyOutcome(
  claim: RecoveredReplyClaim,
  outcome: "completed" | "interrupted",
  text?: string
): RecoveredReplyOutcome {
  if (outcome !== "completed") return { outcome };
  const recovered = text ?? "";
  return {
    outcome,
    text: capText(
      recovered.startsWith(claim.partialText)
        ? recovered.slice(claim.partialText.length)
        : recovered
    )
  };
}

/**
 * The sink. Held until recovery releases it with an outcome. Each post goes
 * out at most once: the checkpoint's `posted` advances before it, because a
 * rejected post may still have landed (a timeout after the platform
 * accepted it), so a retry resumes with the next post. `connect` resolves
 * the messenger host first; failing to reach it fails the attempt without
 * spending a post.
 *
 * @internal
 */
export function recoveredReplySink(
  connect: () => Promise<
    (input: RecoveredReplyPost) => Promise<{ chunks: number }>
  >
): DeliverySink<RecoveredReplyClaim> {
  return {
    // A post that hangs past the attempt timeout keeps running while the
    // retry moves to the next post, so the timeout is long: a reply's posts
    // arrive out of order only if one post hangs for five minutes.
    attemptTimeoutMs: 5 * 60 * 1000,
    deliver: async (claim, attempt) => {
      const outcome =
        attempt.checkpoint.get<RecoveredReplyOutcome["outcome"]>("outcome");
      if (outcome === undefined) return "hold";
      const text = attempt.checkpoint.get<string>("text");
      const post = await connect();
      let next = attempt.checkpoint.get<number>("posted") ?? 0;
      let chunks: number | undefined;
      while (chunks === undefined || next < chunks) {
        attempt.checkpoint.set("posted", next + 1);
        ({ chunks } = await post({
          messengerId: claim.messengerId,
          threadId: claim.threadId,
          outcome,
          ...(text !== undefined && { text }),
          partialPosted: claim.partialText.trim().length > 0,
          chunk: next
        }));
        next += 1;
      }
    }
  };
}

/** Storage prefix of the replies the released version kept. */
const LEGACY_PREFIX = "cf_think_messenger_recovery:";

/** A reply as the released version kept it. */
type LegacyRecoveredReply = RecoveredReplyClaim & {
  outcome?: "completed" | "interrupted";
  text?: string;
  posted?: number;
};

/**
 * Move the replies the released version kept under
 * `cf_think_messenger_recovery:` into deliveries: `posted` and a settled
 * outcome go to the checkpoint; an unsettled one whose incident `isGone`
 * is settled `interrupted`, the rest wait for recovery as held deliveries.
 * One bad record does not hold back the rest, or the start.
 *
 * TEMPORARY: one-shot upgrade path. Remove in the next minor.
 *
 * @internal
 */
export async function migrateLegacyRecoveredReplies(
  storage: DurableObjectStorage,
  isGone: (incidentId: string) => Promise<boolean>,
  importReply: (
    id: string,
    claim: RecoveredReplyClaim,
    progress: Record<string, string | number>
  ) => Promise<unknown>
): Promise<void> {
  const legacy = await storage.list<LegacyRecoveredReply>({
    prefix: LEGACY_PREFIX
  });
  for (const [key, reply] of legacy) {
    try {
      const incidentId = key.slice(LEGACY_PREFIX.length);
      const outcome =
        reply.outcome ??
        ((await isGone(incidentId)) ? ("interrupted" as const) : undefined);
      await importReply(
        recoveredReplyId(incidentId),
        recoveredReplyClaim(reply),
        {
          ...(outcome !== undefined && { outcome }),
          ...(reply.text !== undefined && { text: capText(reply.text) }),
          ...(reply.posted !== undefined && { posted: reply.posted })
        }
      );
      await storage.delete(key);
    } catch (error) {
      console.error(`[Think] could not migrate recovered reply ${key}`, error);
    }
  }
}
