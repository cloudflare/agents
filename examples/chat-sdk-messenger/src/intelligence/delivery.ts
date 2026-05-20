import type { Message, Thread } from "chat";

export const AI_REPLY_FIBER_NAME = "chat-sdk-messenger:ai-reply";
export const EMPTY_AI_RESPONSE =
  "I couldn't produce a text response. Please try again.";
export const INTERRUPTED_AI_RESPONSE =
  "Sorry, my reply was interrupted. Please send your message again if you'd like me to retry.";

export type AiReplyStage = "accepted" | "streaming" | "completed";

export type AiReplySnapshot = {
  type: typeof AI_REPLY_FIBER_NAME;
  stage: AiReplyStage;
  thread: unknown;
  message: unknown;
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
    message: candidate.message
  };
}

export function aiReplySnapshot(
  stage: AiReplyStage,
  thread: Thread,
  message: Message
): AiReplySnapshot {
  return {
    type: AI_REPLY_FIBER_NAME,
    stage,
    thread: thread.toJSON(),
    message: message.toJSON()
  };
}
