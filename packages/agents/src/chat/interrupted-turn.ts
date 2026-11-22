/**
 * What an interrupted chat turn does next, decided once for `AIChatAgent` and
 * `Think` from what the turn's record and storage hold after a reset.
 *
 * Both hosts used to classify the turn and dispatch its recovery with their
 * own copies of these rules. They are pure here: the engine reads the
 * evidence, calls {@link interruptedTurnKind} before it opens the incident
 * and {@link planInterruptedTurn} after it stored what the turn streamed, and
 * schedules what the plan says.
 *
 * @internal Sibling-package support for AI Chat and Think.
 */

import type { ChatRecoveryOptions } from "./lifecycle";
import type { ChatFiberSnapshot } from "./recovery";
import type { ChatRecoveryKind } from "./recovery-incident";

/** The latest stored message, as recovery reads it. *
 * @internal
 */
export type RecoveryLeaf = { id: string; role: string } | null | undefined;

/** What the turn's record and storage say about it. *
 * @internal
 */
export type InterruptedTurnEvidence = {
  /** The snapshot the turn stored when it started, or `null`. */
  snapshot: ChatFiberSnapshot | null;
  /**
   * How the turn's stream ended, when the host tracks it: `completed` or
   * `error` means the stream ended before the isolate died.
   */
  streamStatus?: "streaming" | "completed" | "error";
};

/** What a recovered turn does next. *
 * @internal
 */
export type InterruptedTurnPlan =
  | {
      action: "retry";
      /** The question to answer again. */
      questionId: string;
      /** For a regeneration: the reply it was replacing, still the leaf. */
      regeneratedLeafId?: string;
    }
  | { action: "continue"; replyId: string }
  | {
      action: "skip";
      reason: "continue_disabled" | "stream_terminal" | "conversation_changed";
    };

function streamEnded(evidence: InterruptedTurnEvidence): boolean {
  return (
    evidence.streamStatus === "completed" || evidence.streamStatus === "error"
  );
}

/**
 * The question a turn that left no reply should answer again, or `null`.
 *
 * A new turn (not a continuation) answers its question again when that
 * question is still the latest message: nothing of its reply is stored. A
 * regeneration branches beside the reply it replaces, so that reply, not the
 * question, is still the leaf, and the question is the branch's parent.
 *
 * @param leaf - The latest stored message.
 *
 * @internal
 */
export function questionToRetry(
  snapshot: ChatFiberSnapshot | null,
  leaf: RecoveryLeaf
): { questionId: string; regeneratedLeafId?: string } | null {
  if (!snapshot || snapshot.continuation || !snapshot.latestUserMessageId) {
    return null;
  }
  if (!leaf) return null;
  if (snapshot.branchParentId !== undefined) {
    return leaf.id === snapshot.latestMessageId
      ? {
          questionId: snapshot.branchParentId,
          ...(snapshot.latestMessageId !== undefined && {
            regeneratedLeafId: snapshot.latestMessageId
          })
        }
      : null;
  }
  return leaf.role === "user" && leaf.id === snapshot.latestUserMessageId
    ? { questionId: snapshot.latestUserMessageId }
    : null;
}

/**
 * The kind the incident is opened with, before anything is stored: `retry`
 * when the turn left nothing of its reply, `continue` otherwise.
 *
 * @param partialHoldsContent - Whether what the turn streamed holds anything
 *   that would be stored. The host decides, by its own rules for what a
 *   stored reply drops.
 * @param leaf - The latest stored message.
 *
 * @internal
 */
export function interruptedTurnKind(
  evidence: InterruptedTurnEvidence,
  partialHoldsContent: boolean,
  leaf: RecoveryLeaf
): ChatRecoveryKind {
  return !partialHoldsContent &&
    !streamEnded(evidence) &&
    questionToRetry(evidence.snapshot, leaf) !== null
    ? "retry"
    : "continue";
}

/**
 * What the recovered turn does, decided after what it streamed was stored
 * (or dropped, when `onChatRecovery` asked for that).
 *
 * In order: a stream that ended before the reset has nothing to recover; an
 * app that declined to continue is obeyed; a question that is still the
 * latest message is answered again; a reply that is the latest message is
 * continued; anything else means the conversation moved on.
 *
 * @param leaf - The latest stored message, read after the store.
 *
 * @internal
 */
export function planInterruptedTurn(
  evidence: InterruptedTurnEvidence,
  options: ChatRecoveryOptions,
  leaf: RecoveryLeaf
): InterruptedTurnPlan {
  if (streamEnded(evidence)) {
    return { action: "skip", reason: "stream_terminal" };
  }
  if (options.continue === false) {
    return { action: "skip", reason: "continue_disabled" };
  }
  const retry = questionToRetry(evidence.snapshot, leaf);
  if (retry) return { action: "retry", ...retry };
  if (leaf?.role === "assistant") {
    return { action: "continue", replyId: leaf.id };
  }
  return { action: "skip", reason: "conversation_changed" };
}
