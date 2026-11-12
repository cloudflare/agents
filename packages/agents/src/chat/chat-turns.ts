/**
 * ChatTurns — the turn core shared by `@cloudflare/ai-chat` (`AIChatAgent`)
 * and `@cloudflare/think` (`Think`).
 *
 * A chat host runs one turn at a time while requests, cancels, clears, tool
 * results and recoveries arrive in any order. Both hosts used to keep the
 * state for that (turn queue, abort registry, submit concurrency, the
 * continuation slots and barrier, the pre-stream set, the tool-result apply
 * chain) as a dozen private fields each, with the rules that tie them together
 * written twice. This class owns that state and those rules once:
 *
 * - a turn runs under the queue generation it was admitted with, and a chat
 *   reset (clear) invalidates it ({@link turnResetGuard});
 * - tool results and approvals apply one at a time, and only one that settled
 *   its call schedules a continuation ({@link applyInteraction});
 * - a continuation runs only while the message it answers is still the latest
 *   ({@link takeContinuation});
 * - a cancel reaches a queued turn, a running turn, and a running recovery
 *   attempt ({@link cancel});
 * - a reset tears all of it down together ({@link reset});
 * - idle and stable mean no turn, no submit in flight, no tool result being
 *   applied and no continuation about to fire ({@link waitForIdle},
 *   {@link waitUntilStable}).
 *
 * What a turn does (call the model, stream and persist the reply) stays with
 * the host, behind {@link ChatTurnsHost}. See `design/rfc-chat-turn-core.md`.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { AbortRegistry } from "./abort-registry";
import {
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies
} from "./async-helpers";
import {
  AutoContinuationController,
  type ContinuationSpec,
  type ToolInteractionOutcome
} from "./auto-continuation-controller";
import {
  ContinuationState,
  continuationTargetIsLatest,
  type ContinuationConnection,
  type ContinuationPending
} from "./continuation-state";
import type { MessageConcurrency } from "./lifecycle";
import { PreStreamTurns } from "./pre-stream-turns";
import { runRpcRequest, type RpcChatRequest } from "./rpc-request";
import {
  SubmitConcurrencyController,
  type SubmitConcurrencyDecision
} from "./submit-concurrency";
import {
  hasIncompleteToolBatch,
  hasPendingToolInteraction
} from "./tool-state";
import { TurnQueue } from "./turn-queue";

/** The transcript shape the core reads: ids for targets, parts for batches. */
export type ChatTurnMessage = {
  id: string;
  role: string;
  parts: ReadonlyArray<unknown>;
};

/** What the turn core needs from the agent that hosts it. */
export interface ChatTurnsHost {
  /** The stored transcript, oldest first. */
  messages(): ReadonlyArray<ChatTurnMessage>;
  /**
   * `true` while an assistant reply is streaming: the parallel tool batch can
   * still grow, so a continuation must hold until the stream is finalized.
   */
  isReplyStreaming(): boolean;
  /** The reply being streamed now, before it is stored, or `null`. */
  streamingReply(): ChatTurnMessage | null;
  /**
   * Names of the tools a client is known to run: the schemas the client sent
   * with the request whose turn last started.
   */
  clientToolNames(): Set<string>;
  /** `true` while a resumable stream is active (clients can resume it). */
  hasActiveStream(): boolean;
  /** Mint the request id of a new continuation turn. */
  generateRequestId(): string;
  /** Hold the isolate alive for the duration of `fn`. */
  keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run the continuation turn for the pending continuation: the host's own
   * inference and reply pipeline, started through its turn admission.
   */
  fireContinuation(): void;
}

export interface ChatTurnsOptions {
  /** Wait for trailing-edge debounced overlapping submits, in milliseconds. */
  defaultDebounceMs: number;
}

/**
 * One chat request from a client, as {@link ChatTurns.runClientRequest} runs
 * it. The core owns the order of the steps; the host supplies what each step
 * does. `TPrepared` is whatever the host's `persist` hands to its `run`.
 */
export interface ClientChatRequest<TPrepared> {
  requestId: string;
  /** `true` for a new message, `false` for a regenerate. */
  isSubmitMessage: boolean;
  /** The host's `messageConcurrency` setting. */
  concurrency: MessageConcurrency;
  /** Called with the concurrency decision, before any step that can wait. */
  onDecision?(decision: SubmitConcurrencyDecision): void;
  /**
   * An overlapping submit was dropped (`"drop"` concurrency): roll the
   * client back and send its terminal frame. Nothing was accepted.
   */
  onDropped(): void;
  /**
   * The request is accepted. Clear state a new turn supersedes, such as the
   * terminal record of an earlier failure.
   */
  onAccepted?(): void | Promise<void>;
  /**
   * Store the request's messages and show them to other clients. Runs before
   * the turn queue, so they are visible while the request waits. Return
   * `null` to skip the request.
   *
   * @param context.isCurrent - `false` once the chat was reset since the
   *   request arrived.
   */
  persist(context: {
    decision: SubmitConcurrencyDecision;
    generation: number;
    isCurrent: () => boolean;
  }): Promise<TPrepared | null>;
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive). It must enqueue `turn` on the core's queue under
   * `generation`, call `onQueued` once it has, and report whether the turn
   * ran or was skipped as stale.
   */
  enqueue(
    turn: () => Promise<void>,
    generation: number,
    onQueued: () => void
  ): Promise<"completed" | "stale">;
  /**
   * Host checks at the front of the queue, after the core's superseded and
   * debounce checks: merging queued messages, waiting for MCP connections.
   * Return `false` to skip the request.
   */
  beforeStart?(prepared: TPrepared): Promise<boolean>;
  /**
   * Run the turn: call the model and stream the reply. `signal` aborts when
   * the request is cancelled or the chat is reset.
   */
  run(prepared: TPrepared, signal: AbortSignal): Promise<void>;
  /**
   * The request was skipped without running: superseded, overtaken during
   * its debounce, reset while queued, or `persist` declined it. Send the
   * `skipped` terminal frame.
   */
  onSkipped(): void;
  /**
   * The request was cancelled before its turn started. Send the `aborted`
   * terminal frame. The model is never called.
   */
  onCancelledBeforeStart(): void;
  /**
   * A step threw. Report it to the client. When absent the error propagates
   * to the caller.
   *
   * @param stage - `"persist"` until the messages are stored, then `"turn"`.
   */
  onError?(error: unknown, stage: "persist" | "turn"): void | Promise<void>;
}

/** A running recovery attempt a client can stop by its original request id. */
export interface RecoveryAttemptHandle {
  /** Aborts when a client cancels the request the attempt recovers. */
  readonly signal: AbortSignal;
  /** Forget the attempt. Call when it settles, whatever its outcome. */
  end(): void;
}

export class ChatTurns<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  /** Serializes turns; its generation is the chat's reset epoch. */
  readonly queue = new TurnQueue();
  /** One abort controller per request id. */
  readonly aborts = new AbortRegistry();
  /** Overlapping-submit policy (`messageConcurrency`). */
  readonly submits: SubmitConcurrencyController;
  /** Pending, deferred and active auto-continuation slots. */
  readonly continuation = new ContinuationState<TConnection>();
  /** Accepted turns whose stream has not started, and connections parked on them. */
  readonly preStream = new PreStreamTurns<TConnection>();
  /** The coalesce timer and completeness barrier in front of a continuation. */
  readonly autoContinuation: AutoContinuationController<TConnection>;

  /**
   * The newest tool-result/approval apply in flight, or `null`. Because the
   * chain is serial, awaiting it waits for every apply before it.
   */
  pendingInteraction: Promise<boolean> | null = null;
  /**
   * Tail of the apply chain. Each apply is a read-modify-write of a whole
   * message, so parallel results must commit one at a time, in arrival order
   * (#1649).
   */
  interactionTail: Promise<void> = Promise.resolve();

  /** Stop signals of running recovery attempts, by original request id. */
  readonly #recoveryAttempts = new Map<string, AbortController>();

  constructor(
    private readonly host: ChatTurnsHost,
    options: ChatTurnsOptions
  ) {
    this.submits = new SubmitConcurrencyController({
      defaultDebounceMs: options.defaultDebounceMs
    });
    this.autoContinuation = new AutoContinuationController<TConnection>({
      continuation: this.continuation,
      generateRequestId: () => host.generateRequestId(),
      isStreamActive: () => host.isReplyStreaming(),
      hasPendingInteraction: () => this.pendingInteraction !== null,
      hasIncompleteToolBatch: () => hasIncompleteToolBatch(host.messages()),
      drainInteractionApplies: () => this.drainInteractions(),
      keepAliveWhile: (fn) => host.keepAliveWhile(fn),
      fire: () => host.fireContinuation()
    });
  }

  // ── Submits ────────────────────────────────────────────────────────

  /** Decide what an incoming client request does under `concurrency`. */
  decideSubmit(
    concurrency: MessageConcurrency,
    isSubmitMessage: boolean
  ): SubmitConcurrencyDecision {
    return this.submits.decide({
      concurrency,
      isSubmitMessage,
      queuedTurns: this.queue.queuedCount()
    });
  }

  /**
   * The checks a client request makes once its turn reaches the front of the
   * queue: it may have been superseded by a newer overlapping submit, and a
   * debounced one first waits out its quiet period, during which a reset or a
   * newer submit can still overtake it.
   *
   * @param decision - The request's {@link decideSubmit} result.
   * @param generation - The queue generation the request was admitted under.
   * @returns `false` when the request must be skipped without running.
   */
  async awaitSubmitTurn(
    decision: SubmitConcurrencyDecision,
    generation: number
  ): Promise<boolean> {
    if (this.submits.isSuperseded(decision.submitSequence)) return false;
    if (decision.debounceUntilMs === null) return true;
    await this.submits.waitForTimestamp(decision.debounceUntilMs);
    if (this.queue.generation !== generation) return false;
    return !this.submits.isSuperseded(decision.submitSequence);
  }

  /**
   * Run one chat request from a client, start to finish. This is the one
   * order both hosts follow:
   *
   * 1. Decide what the request does under the concurrency policy. A dropped
   *    request ends here.
   * 2. Accept it: mark it pre-stream (so a reconnecting client waits for its
   *    stream) and create its abort controller, so a cancel that arrives at
   *    any later point, including while it waits in the queue, is not lost
   *    (#2701).
   * 3. Store its messages, then queue the turn.
   * 4. At the front of the queue: skip it if a newer submit superseded it or
   *    the chat was reset, end it with `aborted` if it was cancelled
   *    meanwhile (the model is never called), otherwise run it.
   * 5. Whatever happened, drop the abort controller and settle the
   *    pre-stream turn.
   */
  async runClientRequest<TPrepared>(
    request: ClientChatRequest<TPrepared>
  ): Promise<void> {
    const { requestId } = request;
    const generation = this.queue.generation;
    const decision = this.decideSubmit(
      request.concurrency,
      request.isSubmitMessage
    );
    request.onDecision?.(decision);
    if (decision.action === "drop") {
      request.onDropped();
      return;
    }

    this.preStream.begin(requestId);
    const signal = this.aborts.getSignal(requestId);
    const releasePendingEnqueue = this.submits.beginEnqueue();
    let stage: "persist" | "turn" = "persist";
    try {
      // Inside the try, so a failure here is reported and settled like any
      // other step's.
      await request.onAccepted?.();
      const prepared = await request.persist({
        decision,
        generation,
        isCurrent: () => this.queue.generation === generation
      });
      if (prepared === null) {
        request.onSkipped();
        return;
      }
      stage = "turn";

      const outcome = await request.enqueue(
        async () => {
          if (!(await this.awaitSubmitTurn(decision, generation))) {
            request.onSkipped();
            return;
          }
          if (request.beforeStart && !(await request.beforeStart(prepared))) {
            request.onSkipped();
            return;
          }
          if (signal?.aborted) {
            request.onCancelledBeforeStart();
            return;
          }
          // The registry always has a controller here: only a reset removes
          // it, and a reset makes the turn stale before it reaches this point.
          await request.run(prepared, signal ?? new AbortController().signal);
        },
        generation,
        releasePendingEnqueue
      );
      if (outcome === "stale") request.onSkipped();
    } catch (error) {
      if (!request.onError) throw error;
      await request.onError(error, stage);
    } finally {
      releasePendingEnqueue();
      this.aborts.remove(requestId);
      this.settlePreStreamTurn(requestId);
    }
  }

  /**
   * Run one chat request a caller started over RPC and follows through a
   * callback. See {@link runRpcRequest} for the order of its steps.
   */
  runRpcRequest(request: RpcChatRequest): Promise<void> {
    return runRpcRequest(this, request);
  }

  /**
   * Mark an accepted turn (#1784) as settled. With `releaseParked` (the
   * default), once no accepted turn is in flight and no stream is active,
   * connections parked on the pre-stream window get `STREAM_RESUME_NONE`. A
   * skipped turn passes `releaseParked: false`: it was skipped because a newer
   * turn exists, and that turn flushes or releases the parked connections.
   */
  settlePreStreamTurn(
    requestId: string,
    options: { releaseParked?: boolean } = {}
  ): void {
    const idle = this.preStream.settle(requestId);
    if (
      (options.releaseParked ?? true) &&
      idle &&
      !this.host.hasActiveStream()
    ) {
      this.preStream.releaseAwaiting();
    }
  }

  // ── Turns ──────────────────────────────────────────────────────────

  /**
   * Capture the generation of the turn running now. The returned function
   * reports whether the chat was reset (cleared) since: a turn admitted
   * before a reset must not stream into the cleared chat or persist its reply
   * there, even though the reset emptied the abort registry and the turn's
   * controller is gone from it.
   *
   * Call it from inside a turn. Outside one it captures the current
   * generation.
   */
  turnResetGuard(): () => boolean {
    const generation = this.queue.activeGeneration ?? this.queue.generation;
    return () => this.queue.generation !== generation;
  }

  // ── Tool results and approvals ─────────────────────────────────────

  /**
   * Run `apply` after every apply already queued, whatever their outcome, so
   * one rejected apply cannot poison the rest of a batch.
   */
  enqueueInteraction(apply: () => Promise<boolean>): Promise<boolean> {
    const result = this.interactionTail.then(apply, apply);
    this.interactionTail = result.then(
      () => undefined,
      () => undefined
    );
    this.pendingInteraction = result;
    result
      .finally(() => {
        if (this.pendingInteraction === result) this.pendingInteraction = null;
      })
      .catch(() => {});
    return result;
  }

  /**
   * Apply a client tool result or approval, then decide its continuation:
   * with `autoContinue`, only an apply that settled its call schedules one,
   * targeted at that call's message; without it, a batch a sibling opted in
   * for is re-armed (#1650).
   *
   * @returns Whether the tool call was found.
   */
  applyInteraction(
    apply: () => Promise<ToolInteractionOutcome>,
    autoContinue: boolean,
    spec: () => ContinuationSpec<TConnection>
  ): Promise<boolean> {
    return this.enqueueInteraction(async () => {
      const outcome = await apply();
      this.autoContinuation.afterInteraction(outcome, autoContinue, spec);
      return outcome.status !== "missing";
    });
  }

  /**
   * Wait for every apply in flight, including those queued meanwhile, so a
   * completeness check sees every result that has already arrived. Bounded by
   * apply activity, never by a timer.
   */
  drainInteractions(): Promise<void> {
    return drainInteractionApplies(
      () => this.continuation.pending !== null,
      () => this.interactionTail
    );
  }

  // ── Continuations ──────────────────────────────────────────────────

  /**
   * Claim the pending continuation at the start of its turn. Returns `null`
   * when there is nothing to continue: no continuation is pending, or the
   * conversation moved on since its tool result (a newer question or reply, a
   * regenerate, a clear), so the message it answers is no longer the latest.
   * The caller then releases the continuation's state and runs no model call.
   */
  takeContinuation(): ContinuationPending<TConnection> | null {
    const pending = this.continuation.pending;
    if (!pending) return null;
    if (!continuationTargetIsLatest(this.host.messages(), pending)) return null;
    pending.pastCoalesce = true;
    return pending;
  }

  // ── Cancel and reset ───────────────────────────────────────────────

  /**
   * Cancel a request: abort its turn (queued or running) and any recovery
   * attempt running for it. A client only learns a continuation's own request
   * id from its first frame, so until then it cancels a recovered turn by the
   * original id, which is the id recovery attempts are registered under.
   */
  cancel(requestId: string, reason?: unknown): void {
    this.aborts.cancel(requestId, reason);
    this.#recoveryAttempts.get(requestId)?.abort(reason);
  }

  /**
   * Register a running recovery attempt for the request it recovers, so
   * {@link cancel} with that id stops it.
   */
  beginRecoveryAttempt(
    rootRequestId: string | undefined
  ): RecoveryAttemptHandle {
    const controller = new AbortController();
    if (rootRequestId) this.#recoveryAttempts.set(rootRequestId, controller);
    return {
      signal: controller.signal,
      end: () => {
        if (
          rootRequestId &&
          this.#recoveryAttempts.get(rootRequestId) === controller
        ) {
          this.#recoveryAttempts.delete(rootRequestId);
        }
      }
    };
  }

  /**
   * Tear down turn state for a chat reset (clear): invalidate queued turns,
   * abort every request, drop the apply chain and the continuation slots and
   * barrier, and release every waiting connection. Synchronous, so no event
   * interleaves with a half-reset chat. Stored messages and streams are the
   * host's to clear.
   */
  reset(): void {
    this.queue.reset();
    this.aborts.destroyAll();
    this.submits.reset();
    this.pendingInteraction = null;
    // New interactions must not serialize behind a stale, possibly hung,
    // apply from the turn being reset (#1649).
    this.interactionTail = Promise.resolve();
    this.autoContinuation.reset();
    this.continuation.sendResumeNone();
    this.continuation.clearAll();
    this.preStream.releaseAwaiting();
    this.preStream.reset();
  }

  // ── Idle and stable ────────────────────────────────────────────────

  /**
   * `true` while the chat waits on a client: a tool call a client still has
   * to answer, or an approval. See {@link hasPendingToolInteraction} for the
   * one definition.
   */
  hasPendingInteraction(): boolean {
    return hasPendingToolInteraction({
      messages: this.host.messages(),
      streaming: this.host.streamingReply(),
      clientToolNames: this.host.clientToolNames()
    });
  }

  /** `true` while a continuation decision is still to come. */
  hasPendingDecision(): boolean {
    return this.autoContinuation.hasPendingDecision();
  }

  /**
   * Resolve once no turn is queued or running, no submit is between its
   * concurrency decision and the queue, and no continuation is about to fire.
   */
  async waitForIdle(): Promise<void> {
    for (;;) {
      await this.submits.waitForIdle(() => this.queue.waitForIdle());
      if (!this.hasPendingDecision()) return;
      await sleep(AutoContinuationController.COALESCE_MS);
    }
  }

  /**
   * Resolve `true` once the chat is idle ({@link waitForIdle}) and nothing is
   * waiting on a client (`hasPendingInteraction`), or `false` when `timeout`
   * milliseconds pass first.
   *
   * @param options.hasPendingInteraction - Replaces
   *   {@link hasPendingInteraction} as the check for a client still having
   *   something to answer.
   */
  async waitUntilStable(
    options: {
      timeout?: number;
      hasPendingInteraction?: () => boolean;
    } = {}
  ): Promise<boolean> {
    const deadline =
      options.timeout != null ? Date.now() + options.timeout : null;
    const hasPendingInteraction =
      options.hasPendingInteraction ?? (() => this.hasPendingInteraction());

    for (;;) {
      if (
        (await awaitWithDeadline(
          this.submits.waitForIdle(() => this.queue.waitForIdle()),
          deadline
        )) === TIMED_OUT
      ) {
        return false;
      }

      if (!hasPendingInteraction()) {
        if (!this.hasPendingDecision()) return true;
        // A continuation is armed (#1650): wait for it to fire (the turn it
        // enqueues drains at the loop top) or to park.
        if (
          (await awaitWithDeadline(
            sleep(AutoContinuationController.COALESCE_MS),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
        continue;
      }

      const pending = this.pendingInteraction;
      if (pending) {
        let result: boolean | typeof TIMED_OUT;
        try {
          result = await awaitWithDeadline(pending, deadline);
        } catch {
          continue;
        }
        if (result === TIMED_OUT) return false;
      } else if (
        // No apply in flight: still waiting for the user to answer.
        (await awaitWithDeadline(sleep(100), deadline)) === TIMED_OUT
      ) {
        return false;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
