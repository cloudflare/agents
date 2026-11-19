/**
 * The auto-continuation turn, from the moment it fires to the moment it
 * settles. A client tool result or approval schedules a continuation
 * (`AutoContinuationController`). What happens next is the same in
 * `@cloudflare/ai-chat` and `@cloudflare/think`, and lives here:
 *
 * - {@link runContinuationTurn}: create the abort signal, enqueue the turn,
 *   claim the continuation when the turn starts, run it, and settle whatever
 *   happened. The same runner takes a continuation nothing scheduled on a
 *   connection (an approval that arrives over RPC with no client attached).
 * - What "run it" means is the host's one turn body, the same one a
 *   `saveMessages` or `continueLastTurn` turn runs. A failure before the
 *   stream starts is reported to clients here ({@link reportTurnFailure}).
 *   From the stream's start on, the reply pipeline reports its own.
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
 *   `STREAM_RESUME_NONE`;
 * - a continuation that fails before it streams sends one error frame.
 *
 * `ChatTurns` exposes each function as a method. Hosts call those.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { isDurableObjectResetError } from "../retries";
import type { AbortRegistry } from "./abort-registry";
import type { AutoContinuationController } from "./auto-continuation-controller";
import type { ClientToolSchema } from "./client-tools";
import {
  continuationTargetIsLatest,
  type ContinuationConnection,
  type ContinuationPending,
  type ContinuationState
} from "./continuation-state";
import {
  reportTurnFailure,
  type TurnFailureHost,
  type TurnFailureResult
} from "./turn-failure";
import { isTurnStopped } from "./turn-stop";

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
  /**
   * The continuation turns running now, by request id, and whether each
   * one's stream has started. {@link runContinuationBody} adds and removes
   * the entry. {@link continuationStreamStarted} only flips it, so a stream
   * of any other turn leaves nothing behind.
   */
  readonly streamed: Map<string, boolean>;
  /**
   * One entry per continuation turn between its fire and the start of its
   * turn. The chat is not idle while this holds anything: a host's
   * `enqueue` may await before the turn is on the queue, and the queue alone
   * would report idle in that window.
   */
  readonly firing: Set<object>;
  /**
   * A continuation was dropped: it will not run, and nothing failed. The
   * host reports it to the app (an observability event), so "the model never
   * answered my tool result" has something to look at.
   */
  dropped(event: ContinuationDropped): void;
}

/** A continuation that will not run, and why. */
export interface ContinuationDropped {
  /** The request id the continuation would have run under. */
  requestId: string;
  /**
   * - `answered`: the reply it would continue already went on to the
   *   model's answer.
   * - `moved_on`: a newer message follows the reply its tool result is in.
   * - `stopped`: it was stopped before it ran.
   */
  reason: "answered" | "moved_on" | "stopped";
}

/**
 * What a continuation turn runs with: its request id, the connection and
 * tools of the latest result that scheduled it, and the messages those
 * results are stored in. `connection` is `undefined` for a continuation no
 * connection scheduled.
 */
export interface ContinuationContext<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  requestId: string;
  connection: TConnection | undefined;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
  /** See {@link ContinuationPending.targetMessageIds}. */
  targetMessageIds: readonly string[];
}

/**
 * What a host supplies to run one continuation turn. The core owns the order
 * of the steps. The host owns what each step does.
 */
export interface ContinuationTurn<
  TConnection extends ContinuationConnection = ContinuationConnection,
  TMessage = unknown
> {
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive) onto the core's queue. It may await before it enqueues: the
   * core reports the chat busy from the fire until the turn starts
   * ({@link ContinuationTurnParts.firing}). Whatever the host has to store
   * before the transcript is read (`Think` drops the text written after a
   * pause that has since resolved) it does before it calls `turn`.
   */
  enqueue(requestId: string, turn: () => Promise<void>): Promise<unknown>;
  /**
   * Run the turn with `continuation: true`, for the connection and tools of
   * `continuation`: the host's turn body (recovery fiber, agent context,
   * model call, reply). `signal` aborts when the request is cancelled or the
   * chat is reset. The reply path must call
   * {@link continuationStreamStarted} when the stream starts, and from then
   * on tell clients about its own failures. A throw before that is reported
   * here.
   */
  run(
    continuation: ContinuationContext<TConnection>,
    signal: AbortSignal
  ): Promise<unknown>;
  /** How a failure before the stream is reported. */
  failure: TurnFailureHost<TMessage>;
  /**
   * The turn rejected, and it was not stopped: a stopped turn fails with
   * the stop's reason, which is not an error ({@link isTurnStopped}). Log it
   * when clients were not told.
   *
   * @param context.reported - Whether clients were told
   *   ({@link reportTurnFailure} ran).
   */
  onError(
    error: unknown,
    context: { errorPrefix: string | null; reported: boolean }
  ): void;
}

/**
 * Why a continuation has nothing to answer, or `null` when it has. The one
 * check for every continuation, whatever scheduled it:
 *
 * - `moved_on`: the conversation moved on since its result was stored (a
 *   newer question or reply, a regenerate, a clear), so none of the
 *   messages it answers is the latest;
 * - `answered`: the message it answers already went on to the model's
 *   answer ({@link transcriptEndsInAnswer}).
 *
 * The result itself is stored either way, and the next turn's model call
 * reads it.
 */
function nothingToAnswer(
  messages: ReturnType<ContinuationTurnParts["messages"]>,
  continuation: Pick<ContinuationPending, "targetMessageIds">
): "moved_on" | "answered" | null {
  if (!continuationTargetIsLatest(messages, continuation)) return "moved_on";
  if (transcriptEndsInAnswer(messages)) return "answered";
  return null;
}

/**
 * Claim the pending continuation at the start of its turn. `dropped` says
 * why there is nothing for this turn to continue:
 *
 * - `null`: no continuation is pending, or the pending one was fired for
 *   another turn (`requestId`). A turn that ran someone else's continuation
 *   would leave it marked as running after the turn ended, and every later
 *   result would wait behind it forever. Whoever removed this turn's own
 *   continuation reported that;
 * - a reason from {@link nothingToAnswer}.
 */
function tryClaimContinuation<TConnection extends ContinuationConnection>(
  parts: ContinuationTurnParts<TConnection>,
  requestId: string
):
  | { continuation: ContinuationPending<TConnection> }
  | { dropped: ContinuationDropped["reason"] | null } {
  const pending = parts.continuation.pending;
  if (!pending || pending.requestId !== requestId) return { dropped: null };
  const dropped = nothingToAnswer(parts.messages(), pending);
  if (dropped) return { dropped };
  pending.pastCoalesce = true;
  return { continuation: pending };
}

/**
 * Run a continuation turn, start to finish. There is one runner for both
 * kinds of continuation:
 *
 * - the pending continuation a tool result or approval scheduled (no
 *   `unscheduled` argument);
 * - a continuation nothing scheduled on a connection (`unscheduled`).
 *   `Think` uses it when an approval arrives over RPC with no client
 *   attached. No pending continuation stands for it, so there is nothing to
 *   claim and nothing to settle. It is checked against the transcript like
 *   any other ({@link nothingToAnswer}).
 *
 * The steps:
 *
 * 1. Create the abort signal now, so a cancel reaches the turn while it
 *    waits in the queue.
 * 2. Enqueue the turn.
 * 3. When the turn starts, claim the continuation
 *    ({@link tryClaimContinuation}). With nothing to claim, or when it was
 *    cancelled meanwhile, the model is never called, and the host is told
 *    the continuation was dropped.
 * 4. Run the host's turn body ({@link runContinuationBody}).
 * 5. However the turn ended (ran, failed, or skipped), drop the abort signal
 *    and settle ({@link settleContinuationTurn}), inside the turn. A turn a
 *    chat reset dropped from the queue never started: it only drops its
 *    abort signal and releases the pending continuation if it still owns it.
 * 6. Once the turn has left the queue, deliver `onChatResponse` for a
 *    failure that was reported.
 *
 * From the fire until the turn starts the chat is not idle
 * ({@link ContinuationTurnParts.firing}), whatever the host's `enqueue`
 * awaits first.
 *
 * Never rejects: a failure goes to `turn.onError`, unless the turn was
 * stopped ({@link isTurnStopped}).
 */
export async function runContinuationTurn<
  TConnection extends ContinuationConnection,
  TMessage
>(
  parts: ContinuationTurnParts<TConnection>,
  turn: ContinuationTurn<TConnection, TMessage>,
  unscheduled?: {
    continuation: ContinuationContext<TConnection>;
    errorPrefix: string | null;
  }
): Promise<void> {
  const pending = unscheduled ? null : parts.continuation.pending;
  if (!unscheduled && !pending) return;
  const requestId = unscheduled
    ? unscheduled.continuation.requestId
    : pending!.requestId;
  const errorPrefix = unscheduled
    ? unscheduled.errorPrefix
    : pending!.errorPrefix;
  const signal = parts.aborts.getSignal(requestId);
  const firing = {};
  parts.firing.add(firing);

  let started = false;
  const outcome: ContinuationOutcome<TMessage> = { reported: false };

  /** What the turn continues, or `null` after telling the host why not. */
  const claim = (): ContinuationContext<TConnection> | null => {
    if (!signal || signal.aborted) {
      parts.dropped({ requestId, reason: "stopped" });
      return null;
    }
    if (unscheduled) {
      const dropped = nothingToAnswer(
        parts.messages(),
        unscheduled.continuation
      );
      if (!dropped) return unscheduled.continuation;
      parts.dropped({ requestId, reason: dropped });
      return null;
    }
    const claimed = tryClaimContinuation(parts, requestId);
    if ("continuation" in claimed) return claimed.continuation;
    if (claimed.dropped) parts.dropped({ requestId, reason: claimed.dropped });
    return null;
  };

  try {
    await turn.enqueue(requestId, async () => {
      started = true;
      // On the queue and running: the queue says the chat is busy now.
      parts.firing.delete(firing);
      try {
        const continuation = claim();
        if (!continuation || !signal) return;
        await runContinuationBody(parts, turn, continuation, signal, outcome);
      } finally {
        // Inside the turn, so the next turn in the queue sees settled slots.
        parts.aborts.remove(requestId);
        if (!unscheduled) settleContinuationTurn(parts, requestId);
      }
    });
  } catch (error) {
    // A stopped turn fails with the stop's reason. That is not an error.
    if (!isTurnStopped(signal)) {
      turn.onError(error, { errorPrefix, reported: outcome.reported });
    }
  } finally {
    parts.firing.delete(firing);
    if (!started) {
      parts.aborts.remove(requestId);
      if (!unscheduled) releaseOwnPending(parts, requestId);
    }
  }

  // The turn has left the queue: `onChatResponse` may start a turn itself.
  if (outcome.response) {
    try {
      await turn.failure.respond(outcome.response);
    } catch (error) {
      console.error("[chat] onChatResponse for a failed turn threw:", error);
    }
  }
}

/** What a continuation turn's failure report left for after the turn. */
interface ContinuationOutcome<TMessage> {
  /** Whether clients were told about the failure. */
  reported: boolean;
  /** The `onChatResponse` result to deliver once the turn left the queue. */
  response?: TurnFailureResult<TMessage>;
}

/**
 * Run the host's turn body for a continuation, and report a failure before
 * its stream started (a throw from the recovery fiber, the model call, or
 * the stream's setup) to clients, unless the turn was cancelled or the
 * Durable Object is resetting. After the stream started the reply pipeline
 * has told them already. The error is rethrown either way.
 */
async function runContinuationBody<
  TConnection extends ContinuationConnection,
  TMessage
>(
  parts: ContinuationTurnParts<TConnection>,
  turn: ContinuationTurn<TConnection, TMessage>,
  continuation: ContinuationContext<TConnection>,
  signal: AbortSignal,
  outcome: ContinuationOutcome<TMessage>
): Promise<void> {
  const { requestId } = continuation;
  parts.streamed.set(requestId, false);
  try {
    await turn.run(continuation, signal);
  } catch (error) {
    if (
      parts.streamed.get(requestId) !== true &&
      !signal.aborted &&
      !isDurableObjectResetError(error)
    ) {
      // The report runs app code (the host's error hook). When it fails, the
      // turn's own error is still the one that propagates.
      try {
        outcome.response = await reportTurnFailure(
          parts.messages(),
          turn.failure,
          { requestId, error, continuation: true, stage: "turn" }
        );
        outcome.reported = true;
      } catch (reportError) {
        console.error(
          "[chat] failed to report a continuation failure:",
          reportError
        );
      }
    }
    throw error;
  } finally {
    parts.streamed.delete(requestId);
  }
}

/**
 * Release the pending continuation `requestId` still owns: the connections
 * waiting on it get `STREAM_RESUME_NONE` and the slot is freed. Nothing
 * happens when the pending continuation is another's or none.
 *
 * A turn that never started uses only this. It does not settle: by the time
 * it runs, later turns may have started, and after a reset the deferred slot
 * belongs to the chat that came after it.
 */
function releaseOwnPending<TConnection extends ContinuationConnection>(
  parts: ContinuationTurnParts<TConnection>,
  requestId: string
): boolean {
  if (parts.continuation.pending?.requestId !== requestId) return false;
  releasePending(parts);
  return true;
}

/** Free the pending slot and tell its waiting connections there is no stream. */
function releasePending<TConnection extends ContinuationConnection>(
  parts: ContinuationTurnParts<TConnection>
): void {
  parts.continuation.sendResumeNone();
  parts.continuation.clearPending();
}

/**
 * The stream of the turn running `requestId` started. When that turn owns
 * the pending continuation, it becomes the active one and every connection
 * waiting on it is told to resume the stream (`notifyResuming`, which sends
 * `STREAM_RESUMING`). From here on the reply pipeline reports the turn's
 * failures.
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
  if (parts.streamed.has(requestId)) parts.streamed.set(requestId, true);
  if (continuation.pending?.requestId !== requestId) return;
  continuation.activatePending();
  continuation.flushAwaitingConnections(notifyResuming);
}

/**
 * The stream of the turn running `requestId` ended. A continuation it made
 * active is no longer the active one.
 */
export function continuationStreamEnded<
  TConnection extends ContinuationConnection
>(parts: ContinuationTurnParts<TConnection>, requestId: string | null): void {
  const { continuation } = parts;
  if (requestId === null || continuation.activeRequestId !== requestId) return;
  continuation.activeRequestId = null;
  continuation.activeConnectionId = null;
}

/**
 * A streamed reply was finalized: its message, with every tool part, is
 * stored, and the host cleared its stream-active gate. Call it for every
 * reply, not only a continuation's. It re-runs the barrier for a
 * continuation the gate held (#1650): once the stream ends no further tool
 * result arrives to do it.
 *
 * Whether that continuation still has something to answer is decided when
 * its turn starts ({@link tryClaimContinuation}), not here.
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
 *   own. It also covers the deferred result, which arrived before it: it
 *   takes over the deferred result's targets, the deferred slot is emptied,
 *   and the model is asked once, not twice.
 * - Otherwise the deferred result becomes the next continuation, through
 *   the barrier. This holds for a turn that failed too: the result it
 *   deferred has not been read by any model call.
 */
export function settleContinuationTurn<
  TConnection extends ContinuationConnection
>(parts: ContinuationTurnParts<TConnection>, requestId: string): void {
  const { continuation } = parts;
  const pending = continuation.pending;
  if (releaseOwnPending(parts, requestId)) {
    // Its stream never started.
  } else if (pending && !pending.pastCoalesce) {
    const deferred = continuation.deferred;
    if (deferred) {
      // The newer one answers for the deferred result too, so it takes over
      // the messages that result targets. Without them, a deferred result
      // for the latest reply is lost when the newer continuation was
      // scheduled for an older one.
      pending.targetMessageIds = mergeContinuationTargets(
        pending.targetMessageIds,
        deferred.targetMessageIds
      );
      continuation.clearDeferred();
    }
  }
  parts.autoContinuation.activateDeferredAndReschedule();
}

/**
 * Whether the transcript ends in the model's answer: the latest message is
 * an assistant message whose last step has text (or a file) and no tool
 * call whose result is sent after it. The model wrote that step after every
 * tool result it was given, so there is nothing left for a continuation to
 * answer. Running one would send the provider a request that ends in
 * assistant text, which current Anthropic models reject as a prefill
 * (#1618, #2171).
 *
 * A step is the run of parts after a `step-start` part, which is how the AI
 * SDK's `convertToModelMessages` splits an assistant message into model
 * messages. A last step that holds a tool part ends in that tool's result,
 * whatever text sits beside it, so it is not an answer. A message with no
 * `step-start` at all (a plain-text reply, a hand-built message) is one step.
 *
 * A provider-executed tool (Anthropic web search, code execution) is the
 * exception: its call and its result both stay inside the assistant
 * message, so text after it still ends the request. Such a part is skipped.
 *
 * Reasoning is not an answer. A last step that holds only reasoning is
 * removed from the request before a turn (the core's reasoning-only step
 * rule in the before-turn repair), because Anthropic rejects an assistant
 * message whose final block is a signed thinking block. What the request
 * then ends in is the step before it, which is what this looks at: reasoning
 * is skipped here the same way.
 *
 * This assumes the host turns the transcript into model messages with
 * `convertToModelMessages`. An app that builds them another way can end a
 * request in assistant text where this returns `false`.
 */
export function transcriptEndsInAnswer(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>
): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  let hasContent = false;
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const part = last.parts[i] as {
      type?: unknown;
      text?: unknown;
      providerExecuted?: unknown;
    };
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "step-start") {
      // An empty step sends nothing to the model: look at the one before.
      if (hasContent) return true;
      continue;
    }
    if (type.startsWith("tool-") || type === "dynamic-tool") {
      if (part.providerExecuted === true) continue;
      return false;
    }
    if (
      type === "file" ||
      (type === "text" && typeof part.text === "string" && part.text.length > 0)
    ) {
      hasContent = true;
    }
  }
  return hasContent;
}

/** The targets of two continuations folded into one. */
function mergeContinuationTargets(
  a: readonly string[],
  b: readonly string[]
): readonly string[] {
  return [...a, ...b.filter((id) => !a.includes(id))];
}
