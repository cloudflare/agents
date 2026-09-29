import { Message, ThreadImpl } from "chat";
import type { Chat, SerializedThread, Thread } from "chat";

export const AI_REPLY_FIBER_NAME = "chat-sdk-messenger:ai-reply";
export const EMPTY_AI_RESPONSE =
  "I couldn't produce a text response. Please try again.";
export const INTERRUPTED_AI_RESPONSE =
  "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry.";

// Telegram has no native streaming, so Chat SDK would otherwise post "..."
// first and edit it, making "..." the notification preview.
export const FALLBACK_STREAMING_PLACEHOLDER_TEXT = null;

export type AiReplyStage = "accepted" | "streaming" | "completed";

export type AiReplySnapshot = {
  type: typeof AI_REPLY_FIBER_NAME;
  stage: AiReplyStage;
  thread: unknown;
  message: unknown;
  skipped?: unknown[];
};

export function aiReplyRecoveryMode(
  snapshot: AiReplySnapshot
): "answer" | "apologize" | null {
  if (snapshot.stage === "accepted") {
    return "answer";
  }
  if (snapshot.stage === "streaming") {
    return "apologize";
  }
  return null;
}

export function aiReplyFailureMode(
  hasStreamedText: boolean,
  completedModelTurn = false,
  expectedDeliveryCompletion = false
): "apologize" | "error" | null {
  if (expectedDeliveryCompletion) {
    return null;
  }

  if (completedModelTurn) {
    return "error";
  }

  return hasStreamedText ? "apologize" : "error";
}

export function parseAiReplySnapshot(
  snapshot: unknown
): AiReplySnapshot | null {
  if (snapshot === null || typeof snapshot !== "object") {
    return null;
  }

  const candidate = snapshot as Partial<AiReplySnapshot>;
  if (
    candidate.type !== AI_REPLY_FIBER_NAME ||
    (candidate.stage !== "accepted" &&
      candidate.stage !== "streaming" &&
      candidate.stage !== "completed") ||
    candidate.thread === undefined ||
    candidate.message === undefined
  ) {
    return null;
  }

  return {
    type: AI_REPLY_FIBER_NAME,
    stage: candidate.stage,
    thread: candidate.thread,
    message: candidate.message,
    ...(Array.isArray(candidate.skipped) && { skipped: candidate.skipped })
  };
}

export function aiReplySnapshot(
  stage: AiReplyStage,
  thread: Thread,
  message: Message,
  skipped: readonly Message[] = []
): AiReplySnapshot {
  return {
    type: AI_REPLY_FIBER_NAME,
    stage,
    thread: thread.toJSON(),
    message: message.toJSON(),
    ...(skipped.length > 0 && {
      skipped: skipped.map((entry) => entry.toJSON())
    })
  };
}

/**
 * `bot.reviver()` rebuilds threads with `ThreadImpl.fromJSON`, which drops the
 * bot's `fallbackStreamingPlaceholderText`, so a recovered reply would post
 * "..." first. Rebuild the thread from the same fields with that setting.
 *
 * The adapter is bound from `bot` rather than resolved lazily: a lazy thread
 * reads the module-global Chat singleton on first use, which another agent
 * instance in the same isolate can replace while recovery awaits.
 */
export function reviveReplyThread(bot: Chat, value: unknown): Thread {
  const json = JSON.parse(JSON.stringify(value)) as SerializedThread;
  const adapter = bot.getAdapter(json.adapterName);
  if (!adapter) {
    throw new Error(`Adapter "${json.adapterName}" is not registered`);
  }
  return new ThreadImpl({
    adapter,
    stateAdapter: bot.getState(),
    channelId: json.channelId,
    channelVisibility: json.channelVisibility,
    currentMessage: json.currentMessage
      ? Message.fromJSON(json.currentMessage)
      : undefined,
    fallbackStreamingPlaceholderText: FALLBACK_STREAMING_PLACEHOLDER_TEXT,
    id: json.id,
    isDM: json.isDM
  });
}
