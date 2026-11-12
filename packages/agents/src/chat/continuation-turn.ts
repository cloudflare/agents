/**
 * The auto-continuation turn, from the moment it fires to the moment it
 * settles. A client tool result or approval schedules a continuation
 * (`AutoContinuationController`). What happens next is the same in
 * `@cloudflare/ai-chat` and `@cloudflare/think`, and lives here:
 *
 * - {@link runContinuationTurn}: create the abort signal, enqueue the turn,
 *   claim the continuation when the turn starts, run it, and settle whatever
 *   happened.
 * - {@link runUnscheduledContinuationTurn}: the same turn for a continuation
 *   nothing scheduled on a connection (an approval that arrives over RPC
 *   with no client attached).
 * - What "run it" means, for both: inside the host's recovery scope and the
 *   agent context of the continuation's connection, call the model, then
 *   stream the reply. A failure before the stream starts is reported to
 *   clients here ({@link reportContinuationFailure}). From the stream's
 *   start on, the reply pipeline reports its own.
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
 * - a continuation that fails before it streams sends one error frame;
 * - a continuation that was waiting when a stop landed on the running turn
 *   never runs ({@link dropWaitingContinuations}).
 *
 * `ChatTurns` exposes each function as a method. Hosts call those.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import {
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  type AgentContextStore
} from "../lifecycle/current-agent";
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
import { CHAT_MESSAGE_TYPES } from "./protocol";

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
   * Request ids of the continuation turns running now whose stream has
   * started. {@link continuationStreamStarted} adds to it.
   */
  readonly streamed: Set<string>;
}

/**
 * What a continuation turn runs with: its request id, and the connection
 * and tools of the latest result that scheduled it. `connection` is
 * `undefined` for a continuation no connection scheduled.
 */
export interface ContinuationContext<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  requestId: string;
  connection: TConnection | undefined;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
}

/** The error frame of a continuation that failed before it streamed. */
export interface ContinuationErrorFrame {
  type: typeof CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
  id: string;
  body: string;
  done: true;
  error: true;
  continuation: true;
}

/** The `onChatResponse` result of a continuation that failed. */
export interface ContinuationFailureResult<TMessage> {
  message: TMessage;
  requestId: string;
  continuation: true;
  status: "error";
  error: string;
}

/**
 * How a host tells its clients and its app that a continuation failed
 * before it streamed. {@link reportContinuationFailure} owns the order.
 */
export interface ContinuationFailureHost<TMessage> {
  /**
   * Observe the failure (the host's error hook and events) and return the
   * message clients see.
   */
  describe(error: unknown, requestId: string): string;
  /** Store the terminal record a reconnecting client replays. */
  recordTerminal(requestId: string, message: string): Promise<void>;
  /** Send `frame` to every client. */
  broadcast(frame: ContinuationErrorFrame): void;
  /**
   * Deliver `onChatResponse` for the assistant message the continuation
   * would have extended.
   */
  respond(result: ContinuationFailureResult<TMessage>): void | Promise<void>;
}

/**
 * What a host supplies to run one continuation turn. The core owns the order
 * of the steps. The host owns what each step does.
 */
export interface ContinuationTurn<
  TConnection extends ContinuationConnection = ContinuationConnection,
  TReply = unknown,
  TMessage = unknown
> {
  /** The agent hosting the turn, for `getCurrentAgent()` inside it. */
  agent: unknown;
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive). It must enqueue `turn` on the core's queue synchronously,
   * so the chat is not idle between the fire and the turn.
   */
  enqueue(requestId: string, turn: () => Promise<void>): Promise<unknown>;
  /**
   * Run `body` so that an eviction during it is recovered: the host's
   * recovery fiber for a continuation turn.
   */
  recover(requestId: string, body: () => Promise<void>): Promise<void>;
  /**
   * Call the model with `continuation: true`. Return nothing when there is
   * no reply to stream.
   */
  model(
    continuation: ContinuationContext<TConnection>,
    signal: AbortSignal
  ): Promise<TReply | null | undefined>;
  /**
   * Stream and store the reply. It must call
   * {@link continuationStreamStarted} when the stream starts, and from then
   * on tell clients about its own failures.
   */
  stream(
    continuation: ContinuationContext<TConnection>,
    reply: TReply,
    signal: AbortSignal
  ): Promise<unknown>;
  /** How a failure before the stream is reported. */
  failure: ContinuationFailureHost<TMessage>;
  /**
   * The turn rejected. Log it.
   *
   * @param context.reported - Whether clients were told
   *   ({@link reportContinuationFailure} ran).
   */
  onError(
    error: unknown,
    context: { errorPrefix: string | null; reported: boolean }
  ): void;
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
 * 4. Call the model and stream the reply ({@link runContinuationBody}).
 * 5. However the turn ended (ran, failed, or skipped), drop the abort signal
 *    and settle ({@link settleContinuationTurn}), inside the turn. A turn a
 *    chat reset dropped from the queue never started: it only drops its
 *    abort signal and releases the pending continuation if it still owns it.
 *
 * Never rejects: a failure goes to `turn.onError`.
 */
export async function runContinuationTurn<
  TConnection extends ContinuationConnection,
  TReply,
  TMessage
>(
  parts: ContinuationTurnParts<TConnection>,
  turn: ContinuationTurn<TConnection, TReply, TMessage>
): Promise<void> {
  const pending = parts.continuation.pending;
  if (!pending) return;
  const { requestId, errorPrefix } = pending;
  const signal = parts.aborts.getSignal(requestId);

  let started = false;
  const outcome = { reported: false };

  try {
    await turn.enqueue(requestId, async () => {
      started = true;
      try {
        const continuation = claimContinuation(parts, requestId);
        if (!continuation || !signal || signal.aborted) return;
        await runContinuationBody(parts, turn, continuation, signal, outcome);
      } finally {
        // Inside the turn, so the next turn in the queue sees settled slots.
        parts.aborts.remove(requestId);
        settleContinuationTurn(parts, requestId);
      }
    });
  } catch (error) {
    turn.onError(error, { errorPrefix, reported: outcome.reported });
  } finally {
    if (!started) releaseUnstartedContinuationTurn(parts, requestId);
  }
}

/**
 * Run a continuation turn that no pending continuation stands for: nothing
 * was scheduled on a connection, so there is nothing to claim and nothing to
 * settle. `Think` uses it when an approval arrives over RPC with no client
 * attached. Otherwise it is the same turn: the abort signal exists before
 * the queue, a turn cancelled there never calls the model, and the model
 * call, the stream and the failure report are {@link runContinuationBody}.
 *
 * Never rejects: a failure goes to `turn.onError`.
 */
export async function runUnscheduledContinuationTurn<
  TConnection extends ContinuationConnection,
  TReply,
  TMessage
>(
  parts: ContinuationTurnParts<TConnection>,
  turn: ContinuationTurn<TConnection, TReply, TMessage>,
  continuation: ContinuationContext<TConnection>,
  errorPrefix: string | null = null
): Promise<void> {
  const { requestId } = continuation;
  const signal = parts.aborts.getSignal(requestId);
  const outcome = { reported: false };
  try {
    await turn.enqueue(requestId, async () => {
      if (!signal || signal.aborted) return;
      await runContinuationBody(parts, turn, continuation, signal, outcome);
    });
  } catch (error) {
    turn.onError(error, { errorPrefix, reported: outcome.reported });
  } finally {
    parts.aborts.remove(requestId);
  }
}

/**
 * What a continuation turn does once it has something to continue, in the
 * one order both hosts follow:
 *
 * 1. Enter the host's recovery scope, so an eviction from here on is
 *    recovered.
 * 2. Enter the agent context of the continuation's connection. It covers
 *    the model call and the stream, so `getCurrentAgent()` answers the same
 *    in a tool, a hook and the reply pipeline.
 * 3. Call the model. With no reply, stop.
 * 4. Stream the reply.
 *
 * A failure before the stream started (a throw from the recovery scope, the
 * model call, or the stream's setup) is reported to clients, unless the turn
 * was cancelled or the Durable Object is resetting. After the stream started
 * the reply pipeline has told them already. The error is rethrown either
 * way.
 */
async function runContinuationBody<
  TConnection extends ContinuationConnection,
  TReply,
  TMessage
>(
  parts: ContinuationTurnParts<TConnection>,
  turn: ContinuationTurn<TConnection, TReply, TMessage>,
  continuation: ContinuationContext<TConnection>,
  signal: AbortSignal,
  outcome: { reported: boolean }
): Promise<void> {
  const { requestId } = continuation;
  parts.streamed.delete(requestId);
  try {
    await turn.recover(requestId, () =>
      agentContext.run(
        {
          agent: turn.agent,
          connection:
            continuation.connection as AgentContextStore["connection"],
          request: undefined,
          email: undefined
        },
        async () => {
          const reply = await turn.model(continuation, signal);
          if (reply === null || reply === undefined) return;
          await turn.stream(continuation, reply, signal);
        }
      )
    );
  } catch (error) {
    if (
      !parts.streamed.has(requestId) &&
      !signal.aborted &&
      !isDurableObjectResetError(error)
    ) {
      await reportContinuationFailure(parts, turn.failure, requestId, error);
      outcome.reported = true;
    }
    throw error;
  } finally {
    parts.streamed.delete(requestId);
  }
}

/**
 * Tell clients and the app that a continuation failed before it streamed,
 * the way a failed reply is reported:
 *
 * 1. the host's error hook and events, which give the message;
 * 2. the terminal record, before any frame, so a client that is not
 *    connected right now learns the outcome when it comes back;
 * 3. the error frame, before `onChatResponse`, so a slow hook does not hold
 *    it;
 * 4. `onChatResponse` with `status: "error"` for the assistant message the
 *    continuation would have extended.
 */
export async function reportContinuationFailure<
  TConnection extends ContinuationConnection,
  TMessage
>(
  parts: ContinuationTurnParts<TConnection>,
  host: ContinuationFailureHost<TMessage>,
  requestId: string,
  error: unknown
): Promise<void> {
  const message = host.describe(error, requestId);
  await host.recordTerminal(requestId, message).catch((recordError) => {
    console.error(
      "[chat] failed to record a continuation failure:",
      recordError
    );
  });
  host.broadcast({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
    id: requestId,
    body: message,
    done: true,
    error: true,
    continuation: true
  });
  const messages = parts.messages();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    await host.respond({
      message: messages[i] as TMessage,
      requestId,
      continuation: true,
      status: "error",
      error: message
    });
    return;
  }
}

/**
 * A continuation turn that never started: a chat reset dropped it from the
 * queue, or the host's `enqueue` failed. It removes its abort controller and
 * releases the pending continuation if it still owns it. It does not settle:
 * by the time this runs, later turns may have started, and after a reset the
 * deferred slot belongs to the chat that came after it.
 */
function releaseUnstartedContinuationTurn<
  TConnection extends ContinuationConnection
>(parts: ContinuationTurnParts<TConnection>, requestId: string): void {
  parts.aborts.remove(requestId);
  const { continuation } = parts;
  if (continuation.pending?.requestId !== requestId) return;
  continuation.sendResumeNone();
  continuation.clearPending();
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
  parts.streamed.add(requestId);
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
 * its turn starts ({@link claimContinuation}), not here.
 */
export function replyFinalized<TConnection extends ContinuationConnection>(
  parts: ContinuationTurnParts<TConnection>
): void {
  parts.autoContinuation.rearmForBatch();
}

/**
 * The turn that is running was stopped. Stop means stop: every continuation
 * that was waiting when the stop landed is dropped, so the model does not
 * start again by itself once the stopped turn ends.
 *
 * - A pending continuation that has not started: a tool result answered
 *   while the reply streamed scheduled it, and the stream gate held it. The
 *   connections waiting on it get `STREAM_RESUME_NONE`.
 * - The deferred result: it arrived while the stopped continuation ran.
 *
 * The results stay in the transcript, and the model reads them on the next
 * turn. This runs when the stop lands, not when the stopped turn ends: a
 * result that arrives after the stop is a new action, and it schedules a
 * continuation as usual even while the stopped turn is still winding down.
 *
 * A continuation whose own turn is the one running is left to that turn's
 * settle.
 */
export function dropWaitingContinuations<
  TConnection extends ContinuationConnection
>(parts: ContinuationTurnParts<TConnection>): void {
  const { continuation } = parts;
  const pending = continuation.pending;
  if (pending && !pending.pastCoalesce) {
    continuation.sendResumeNone();
    continuation.clearPending();
  }
  continuation.clearDeferred();
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
 *
 * A stop of the turn already dropped what was deferred when it landed
 * ({@link dropWaitingContinuations}). A result deferred after the stop is a
 * new action and runs as the next continuation like any other.
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
 * part. The
 * model wrote that step after every tool result it was given, so there is
 * nothing left for a continuation to answer. Running one would send the
 * provider a request that ends in assistant text, which current Anthropic
 * models reject as a prefill (#1618, #2171).
 *
 * A step is the run of parts after a `step-start` part, which is how the AI
 * SDK's `convertToModelMessages` splits an assistant message into model
 * messages. A last step that holds a tool part ends in that tool's result,
 * whatever text sits beside it, so it is not an answer. A message with no
 * `step-start` at all (a plain-text reply, a hand-built message) is one step.
 *
 * Reasoning is not an answer. A last step that holds only reasoning sends
 * an assistant message with no text, and every model tried (Claude Opus and
 * Sonnet, DeepSeek, Kimi, GLM, through `generateText` with a gateway model
 * string) accepts that request and answers from the tool result. Not tried:
 * a signed Anthropic thinking block on the provider's own API.
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
      (type === "text" && typeof part.text === "string" && part.text.length > 0)
    ) {
      hasContent = true;
    }
  }
  return hasContent;
}

/**
 * The targets of two continuations folded into one. `null` means "run
 * whatever the transcript" and wins. `undefined` is a continuation that
 * recorded no target, which is treated the same way when it is read.
 */
function mergeContinuationTargets(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined
): readonly string[] | null {
  if (a == null || b == null) return null;
  return [...a, ...b.filter((id) => !a.includes(id))];
}
