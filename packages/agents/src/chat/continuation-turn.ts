/**
 * The auto-continuation turn, from the moment it fires to the moment it
 * settles. A client tool result or approval schedules a continuation
 * (`AutoContinuationController`). What happens next is the same in
 * `@cloudflare/ai-chat` and `@cloudflare/think`, and lives here:
 *
 * - {@link runContinuationTurn}: create the abort signal, enqueue the turn,
 *   claim the continuation when the turn starts, run the host's model call,
 *   and settle whatever happened.
 * - {@link continuationStreamStarted}: the turn's stream started, so its
 *   continuation is the active one and the connections waiting on it resume.
 * - {@link replyFinalized}: any reply finished, so a continuation its
 *   stream held can fire.
 * - {@link settleContinuationTurn}: the turn ended. Release what it still
 *   owns and start the follow-up a result deferred while it ran.
 *
 * The rules these keep, each with a broken variant in the `ChatTurns` TLA+
 * model (`.claude/skills/verify-chat`):
 *
 * - one continuation per tool result;
 * - a continuation never runs against a transcript that ends in an answer;
 * - a result that arrives while a continuation runs is never lost;
 * - a connection waiting on a continuation always gets `STREAM_RESUMING` or
 *   `STREAM_RESUME_NONE`.
 *
 * `ChatTurns` exposes each function as a method. Hosts call those.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { AbortRegistry } from "./abort-registry";
import type { AutoContinuationController } from "./auto-continuation-controller";
import {
  continuationTargetIsLatest,
  type ContinuationConnection,
  type ContinuationPending,
  type ContinuationState
} from "./continuation-state";

/** The parts of the turn core the continuation lifecycle works on. */
export interface ContinuationTurnParts<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  readonly continuation: ContinuationState<TConnection>;
  readonly autoContinuation: AutoContinuationController<TConnection>;
  readonly aborts: AbortRegistry;
  /** The stored transcript, oldest first. */
  messages(): ReadonlyArray<{
    id: string;
    role: string;
    parts: ReadonlyArray<unknown>;
  }>;
}

/**
 * What a host supplies to run one continuation turn. The core owns the order
 * of the steps. The host owns what a turn does.
 */
export interface ContinuationTurn<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive). It must enqueue `turn` on the core's queue synchronously,
   * so the chat is not idle between the fire and the turn.
   */
  enqueue(requestId: string, turn: () => Promise<void>): Promise<unknown>;
  /**
   * Run the model with `continuation: true` and stream the reply, for the
   * connection and tools of `continuation`. `signal` aborts when the request
   * is cancelled or the chat is reset. Call
   * {@link continuationStreamStarted} when the stream starts, and report a
   * failure before that to clients here.
   */
  run(
    continuation: ContinuationPending<TConnection>,
    signal: AbortSignal
  ): Promise<void>;
  /** The turn rejected. Log it. Clients were told by `run`. */
  onError(error: unknown, errorPrefix: string | null): void;
}

/**
 * Claim the pending continuation at the start of its turn. Returns `null`
 * when there is nothing for this turn to continue:
 *
 * - no continuation is pending, or the pending one was fired for another
 *   turn (`requestId`). A turn that ran someone else's continuation would
 *   leave it marked as running after the turn ended, and every later result
 *   would wait behind it forever;
 * - the conversation moved on since its tool result (a newer question or
 *   reply, a regenerate, a clear), so the message it answers is no longer
 *   the latest;
 * - the message it answers already went on to the model's answer
 *   ({@link transcriptEndsInAnswer}).
 */
export function claimContinuation<TConnection extends ContinuationConnection>(
  parts: ContinuationTurnParts<TConnection>,
  requestId?: string
): ContinuationPending<TConnection> | null {
  const pending = parts.continuation.pending;
  if (!pending) return null;
  if (requestId !== undefined && pending.requestId !== requestId) return null;
  // A continuation with no target (`null`) runs whatever the transcript: its
  // host rewrites the transcript when the turn runs (a resolved pause in
  // Think drops the text generated after it).
  if (pending.targetMessageIds != null) {
    const messages = parts.messages();
    if (!continuationTargetIsLatest(messages, pending)) return null;
    if (transcriptEndsInAnswer(messages)) return null;
  }
  pending.pastCoalesce = true;
  return pending;
}

/**
 * Run the continuation turn for the pending continuation, start to finish:
 *
 * 1. Create its abort signal now, so a cancel reaches it while it waits in
 *    the queue.
 * 2. Enqueue the turn.
 * 3. When the turn starts, claim the continuation ({@link claimContinuation}).
 *    With nothing to claim, or when it was cancelled meanwhile, the model is
 *    never called.
 * 4. Run the host's model call and stream.
 * 5. However the turn ended (ran, failed, skipped, or dropped from the queue
 *    by a chat reset), drop the abort signal and settle
 *    ({@link settleContinuationTurn}), exactly once.
 *
 * Never rejects: a failure goes to `turn.onError`.
 */
export async function runContinuationTurn<
  TConnection extends ContinuationConnection
>(
  parts: ContinuationTurnParts<TConnection>,
  turn: ContinuationTurn<TConnection>
): Promise<void> {
  const pending = parts.continuation.pending;
  if (!pending) return;
  const { requestId, errorPrefix } = pending;
  const signal = parts.aborts.getSignal(requestId);

  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    parts.aborts.remove(requestId);
    settleContinuationTurn(parts, requestId);
  };

  try {
    await turn.enqueue(requestId, async () => {
      try {
        const continuation = claimContinuation(parts, requestId);
        if (!continuation || !signal || signal.aborted) return;
        await turn.run(continuation, signal);
      } finally {
        // Inside the turn, so the next turn in the queue sees settled slots.
        settle();
      }
    });
  } catch (error) {
    turn.onError(error, errorPrefix);
  } finally {
    // A turn dropped from the queue by a chat reset never ran the above.
    settle();
  }
}

/**
 * The stream of the turn running `requestId` started. When that turn owns
 * the pending continuation, it becomes the active one and every connection
 * waiting on it is told to resume the stream (`notifyResuming`, which sends
 * `STREAM_RESUMING`).
 *
 * A result deferred while the turn ran stays deferred until the turn
 * settles: only then is it known whether the reply answered it.
 */
export function continuationStreamStarted<
  TConnection extends ContinuationConnection
>(
  parts: ContinuationTurnParts<TConnection>,
  requestId: string,
  notifyResuming: (connection: TConnection) => void
): void {
  const { continuation } = parts;
  if (continuation.pending?.requestId !== requestId) return;
  continuation.activatePending();
  continuation.flushAwaitingConnections(notifyResuming);
}

/**
 * A streamed reply was finalized: its message, with every tool part, is
 * stored, and the host cleared its stream-active gate. Call it for every
 * reply, not only a continuation's. It re-runs the barrier for a
 * continuation the gate held (#1650): once the stream ends no further tool
 * result arrives to do it.
 *
 * Whether that continuation still has something to answer is decided when
 * its turn starts ({@link claimContinuation}), not here.
 */
export function replyFinalized<TConnection extends ContinuationConnection>(
  parts: ContinuationTurnParts<TConnection>
): void {
  parts.autoContinuation.rearmForBatch();
}

/**
 * Settle the continuation slots when the continuation turn `requestId`
 * ends, however it ended. A turn touches only what it owns:
 *
 * - It still owns the pending continuation when its stream never started
 *   (it failed, was cancelled, produced nothing, or had nothing to claim,
 *   which includes a reply that already went on to its answer).
 *   The connections waiting on it get `STREAM_RESUME_NONE`.
 * - A pending continuation it does not own is left alone (#2443): a result
 *   that landed while this turn streamed created it, and it fires on its
 *   own. It also covers the deferred result, which arrived before it, so
 *   the deferred one is dropped and the model is asked once, not twice.
 * - Otherwise the deferred result becomes the next continuation, through
 *   the barrier. This holds for a turn that failed too: the result it
 *   deferred has not been read by any model call.
 */
export function settleContinuationTurn<
  TConnection extends ContinuationConnection
>(parts: ContinuationTurnParts<TConnection>, requestId: string): void {
  const { continuation } = parts;
  const pending = continuation.pending;
  if (pending?.requestId === requestId) {
    continuation.sendResumeNone();
    continuation.clearPending();
  } else if (pending && !pending.pastCoalesce) {
    continuation.clearDeferred();
  }
  parts.autoContinuation.activateDeferredAndReschedule();
}

/**
 * Whether the transcript ends in the model's answer: the latest message is
 * an assistant message whose last step has content and no tool part. The
 * model wrote that step after every tool result it was given, so there is
 * nothing left for a continuation to answer. Running one would send the
 * provider a request that ends in assistant text, which current Anthropic
 * models reject as a prefill (#1618, #2171).
 *
 * A step is the run of parts after a `step-start` part, which is how the AI
 * SDK splits an assistant message into model messages. A last step that
 * holds a tool part ends in that tool's result, whatever text sits beside
 * it, so it is not an answer.
 */
export function transcriptEndsInAnswer(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>
): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  let hasContent = false;
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i] as { type?: unknown; text?: unknown };
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "step-start") {
      // An empty step sends nothing to the model: look at the one before.
      if (hasContent) return true;
      continue;
    }
    if (type.startsWith("tool-") || type === "dynamic-tool") return false;
    if (
      type === "file" ||
      ((type === "text" || type === "reasoning") &&
        typeof part.text === "string" &&
        part.text.length > 0)
    ) {
      hasContent = true;
    }
  }
  return hasContent;
}
