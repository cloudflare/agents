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
 *   and has not gone on to its answer, and its turn runs and settles one way
 *   ({@link runContinuationTurn}, `continuation-turn.ts`);
 * - before a turn calls the model, every tool call nothing will answer in
 *   time is settled ({@link settleBeforeTurn});
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

import type { UIMessage } from "ai";
import { AbortRegistry } from "./abort-registry";
import {
  ChatAdmissions,
  type ChatAdmissionRecord,
  type ChatAdmissionsHost
} from "./admissions";
import {
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies
} from "./async-helpers";
import {
  AutoContinuationController,
  type ContinuationSource,
  type ToolInteractionOutcome
} from "./auto-continuation-controller";
import {
  continuationWaitsOnClient,
  replyToContinueIsEmpty,
  repairTranscriptBeforeTurn,
  type BeforeTurnRepairOptions,
  type BeforeTurnRepairResult
} from "./before-turn";
import {
  ContinuationState,
  type ContinuationConnection
} from "./continuation-state";
import {
  continuationStreamEnded,
  continuationStreamStarted,
  dropWaitingContinuations,
  replyFinalized,
  runContinuationTurn,
  type ContinuationContext,
  type ContinuationDropped,
  type ContinuationTurn,
  type ContinuationTurnParts
} from "./continuation-turn";
import type { MessageConcurrency } from "./lifecycle";
import { PreStreamTurns } from "./pre-stream-turns";
import {
  runServerTurn,
  type ServerChatTurn,
  type ServerTurnOutcome
} from "./server-turn";
import {
  persistRepairedTranscript,
  removeEmptyReplyToContinue,
  settleInterruptedReply,
  settleReplyBeforeRecovery,
  type RepairedTranscriptSink,
  type ReplyRemoval,
  type RepairInterruptedToolPartsOptions
} from "./repair-transcript";
import {
  SubmitConcurrencyController,
  type SubmitConcurrencyDecision
} from "./submit-concurrency";
import {
  hasIncompleteToolBatch,
  hasPendingToolInteraction
} from "./tool-state";
import {
  reportTurnFailure,
  type TurnFailure,
  type TurnFailureHost
} from "./turn-failure";
import { TurnQueue } from "./turn-queue";
import { ChatRecoverySupersededError, isTurnStopped } from "./turn-stop";

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
  /**
   * Every tool a client may answer, when the host can tell: the client's
   * own tools and the ones the server declares without an `execute`. A host
   * that cannot see its tools omits this, or returns `null`. See
   * {@link hasPendingToolInteraction}.
   */
  clientAnswerableToolNames?(): Set<string> | null;
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
  /**
   * A continuation was dropped: it will not run, and nothing failed. Emit
   * the host's observability event. Optional.
   */
  continuationDropped?(event: ContinuationDropped): void;
  /**
   * A stop landed: {@link ChatTurns.cancel} for `requestId`, or
   * {@link ChatTurns.stopAll} (`null`). Whatever the request id names beyond
   * a running turn is the host's to stop here, so every stop path does the
   * same: a recovery of the request that is scheduled and not yet running,
   * and an agent-tool run left open for that recovery. Not called for the
   * runtime's own abort ({@link ChatTurns.runtimeAbort}). Optional.
   */
  stopped?(requestId: string | null, reason: unknown): void | Promise<void>;
}

export interface ChatTurnsOptions {
  /** Wait for trailing-edge debounced overlapping submits, in milliseconds. */
  defaultDebounceMs: number;
  /**
   * Durable admission of client requests (`admissions.ts`). Without it a
   * request waiting in the queue is lost when the isolate resets.
   */
  admissions?: ChatTurnsAdmissionOptions;
}

/** What durable admission needs from the host. See `admissions.ts`. */
export interface ChatTurnsAdmissionOptions extends Omit<
  ChatAdmissionsHost,
  "replay" | "beginReplay"
> {
  /**
   * The request a record describes, to run again after a reset. It has no
   * connection: its frames go to every connection. Return `null` when it
   * cannot run any more; its record is then dropped.
   */
  replayRequest(record: ChatAdmissionRecord): ClientChatRequest<unknown> | null;
}

/**
 * One chat request from a client, as {@link ChatTurns.runClientRequest} runs
 * it. The core owns the order of the steps; the host supplies what each step
 * does. `TPrepared` is whatever the host's `persist` hands to its `run`.
 */
export interface ClientChatRequest<TPrepared> {
  requestId: string;
  /**
   * What a replay after a reset needs: the ids of the user messages the
   * request stores, and the host's data to run it again (JSON). With it,
   * the request is recorded before its messages are stored, and the record
   * goes when its turn has a fiber or it ends. See `admissions.ts`.
   */
  admission?: { messageIds: string[]; payload: unknown };
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
   * The request was cancelled before its turn started, or its turn threw
   * after it was stopped and before it replied ({@link isTurnStopped}).
   * Send the `aborted` terminal frame.
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

  /**
   * The request id of the turn a stop has stopped: the running turn, or the
   * reply that had just ended. Request ids are unique, so a value left from
   * an earlier turn matches nothing.
   */
  #stoppedTurn: string | null = null;
  /** How many stops have dropped what was waiting. */
  #stops = 0;
  /**
   * The applies in the chain, each with the connection whose frame it is
   * (`null` for none). A tab's continuation stop drops only its own.
   */
  readonly #applying = new Set<{
    connectionId: string | null;
    stopped: boolean;
  }>();
  /**
   * The request whose reply stream started last. With no turn running, a
   * stop for it is a stop of the reply a waiting continuation continues.
   */
  #lastReply: string | null = null;
  /** Depth of {@link runtimeAbort} calls in progress. */
  #runtimeAborts = 0;
  /** The signals of the turns a stop landed on. */
  readonly #stoppedSignals = new WeakSet<AbortSignal>();

  /** What the continuation lifecycle (continuation-turn.ts) works on. */
  readonly #continuationParts: ContinuationTurnParts<TConnection>;

  /** Stop signals of running recovery attempts, by original request id. */
  readonly #recoveryAttempts = new Map<string, AbortController>();

  /** Durable admission records, when the host keeps them. */
  readonly admissions: ChatAdmissions | null;
  /** Concurrency decisions of replays not started yet, by request id. */
  readonly #restoredDecisions = new Map<string, SubmitConcurrencyDecision>();

  constructor(
    private readonly host: ChatTurnsHost,
    options: ChatTurnsOptions
  ) {
    const admissions = options.admissions;
    this.admissions = admissions
      ? new ChatAdmissions({
          store: admissions.store,
          recoveryPending: () => admissions.recoveryPending(),
          recoveryOwns: (requestId) => admissions.recoveryOwns(requestId),
          beginReplay: (records) => {
            for (const record of records) {
              this.#restoredDecisions.set(
                record.requestId,
                this.submits.restore(record.decision)
              );
            }
          },
          replay: (record, onQueued) => {
            const request = admissions.replayRequest(record);
            if (!request) {
              this.#restoredDecisions.delete(record.requestId);
              this.admissions?.end(record.requestId);
              onQueued();
              return Promise.resolve();
            }
            return this.#runClientRequest(request, { record, onQueued });
          }
        })
      : null;
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
    this.#continuationParts = {
      continuation: this.continuation,
      autoContinuation: this.autoContinuation,
      aborts: this.aborts,
      messages: () => host.messages(),
      clientToolNames: () => host.clientToolNames(),
      streamed: new Map(),
      firing: new Set(),
      unscheduled: new Set(),
      dropped: (event) => host.continuationDropped?.(event)
    };
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
  runClientRequest<TPrepared>(
    request: ClientChatRequest<TPrepared>
  ): Promise<void> {
    return this.#runClientRequest(request);
  }

  /**
   * {@link runClientRequest}, or the replay of a request a reset left
   * (`replay`): its decision is the stored one, its record exists, and
   * `onQueued` is told when it is queued or ended before that.
   */
  async #runClientRequest<TPrepared>(
    request: ClientChatRequest<TPrepared>,
    replay?: { record: ChatAdmissionRecord; onQueued: () => void }
  ): Promise<void> {
    const { requestId } = request;
    const generation = this.queue.generation;
    const admissions = request.admission ? this.admissions : null;
    const restored = replay && this.#restoredDecisions.get(requestId);
    if (replay) this.#restoredDecisions.delete(requestId);
    const decision = replay
      ? (restored ?? this.submits.restore(replay.record.decision))
      : this.decideSubmit(request.concurrency, request.isSubmitMessage);
    request.onDecision?.(decision);
    if (decision.action === "drop") {
      request.onDropped();
      return;
    }

    // The registry hands out a signal for every string id. Anything else
    // would give a turn no stop can reach.
    const signal = this.aborts.getSignal(requestId);
    if (!signal) {
      throw new TypeError("runClientRequest: requestId must be a string");
    }
    // A stop that landed on the record before the reset still stops it.
    if (replay?.record.stopped) this.aborts.cancel(requestId);
    this.preStream.begin(requestId);
    const releasePendingEnqueue = this.submits.beginEnqueue();
    let queued = false;
    const onQueued = () => {
      queued = true;
      releasePendingEnqueue();
      replay?.onQueued();
    };
    let stage: "persist" | "turn" = "persist";
    try {
      // The record comes before the messages: a reset between the two
      // leaves a record whose replay finds no message and ends `skipped`,
      // where the other order would leave a message nothing answers.
      if (admissions && !replay && request.admission) {
        admissions.admit({
          requestId,
          messageIds: request.admission.messageIds,
          decision: {
            strategy: decision.strategy,
            overlapping: decision.submitSequence !== null,
            debounceUntilMs: decision.debounceUntilMs
          },
          payload: request.admission.payload
        });
      }
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
      // Requests an earlier isolate left go first.
      if (admissions && !replay) await admissions.beforeEnqueue();

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
          if (signal.aborted) {
            request.onCancelledBeforeStart();
            return;
          }
          try {
            await request.run(prepared, signal);
          } catch (error) {
            // What a stopped turn throws because of the stop is not a
            // failure: the request ends `aborted`.
            if (!isTurnStopped(signal)) throw error;
            request.onCancelledBeforeStart();
          }
        },
        generation,
        onQueued
      );
      if (outcome === "stale") request.onSkipped();
    } catch (error) {
      if (!request.onError) throw error;
      await request.onError(error, stage);
    } finally {
      releasePendingEnqueue();
      if (!queued) replay?.onQueued();
      if (admissions) admissions.end(requestId);
      this.aborts.remove(requestId);
      this.settlePreStreamTurn(requestId);
    }
  }

  // ── Durable admission ──────────────────────────────────────────────

  /**
   * A turn has a fiber now: recovery owns it, and its admission record
   * goes. Call it where the host's fiber is durably accepted.
   */
  turnAccepted(requestId: string): void {
    this.admissions?.release(requestId);
  }

  /**
   * Queue again, in order, the requests an earlier isolate accepted and
   * never gave a turn with a fiber. Call it when the host starts and when a
   * recovery settles: nothing happens while an interrupted turn still waits
   * for recovery. See `admissions.ts`.
   */
  resumeAdmissions(): Promise<void> {
    return this.admissions?.resume() ?? Promise.resolve();
  }

  /**
   * The user messages of requests that have no turn with a fiber yet. A
   * recovery does not read them as the conversation moving on: they wait
   * behind the turn it recovers.
   */
  admittedMessageIds(): ReadonlySet<string> {
    return this.admissions?.messageIds() ?? new Set();
  }

  /**
   * Whether a request replayed after a reset has nothing left to answer:
   * one of its user messages is gone, or a user message no waiting request
   * stored follows them. That message was answered after the reset, by a
   * newer request or by a release without durable admission (a rollback),
   * and the conversation has moved on.
   */
  replayHasNothingToAnswer(
    messageIds: ReadonlyArray<string>,
    messages: ReadonlyArray<ChatTurnMessage>
  ): boolean {
    const ids = new Set(messageIds);
    const at = messages.map((m) => ids.has(m.id));
    if (at.filter(Boolean).length < ids.size) return true;
    const last = at.lastIndexOf(true);
    if (last < 0) return false;
    const queued = this.admittedMessageIds();
    return messages
      .slice(last + 1)
      .some((m) => m.role === "user" && !queued.has(m.id));
  }

  /**
   * Run one turn the server starts itself (`saveMessages`,
   * `continueLastTurn`, a retry), start to finish. The counterpart of
   * {@link runClientRequest}; see {@link runServerTurn} for the steps.
   */
  runServerTurn<TInput = undefined>(
    turn: ServerChatTurn<TInput>
  ): Promise<ServerTurnOutcome> {
    return runServerTurn(
      {
        queue: this.queue,
        aborts: this.aborts,
        linkExternal: (requestId, signal) =>
          this.linkExternal(requestId, signal)
      },
      turn
    );
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
   * @param enqueue - How the apply joins the queue. Defaults to
   *   {@link enqueueInteraction}. A host with an overridable enqueue hook
   *   passes it, so a subclass that wraps applies sees every one of them.
   * @param connectionId - The connection the frame came from, so a stop
   *   from that tab drops this result and no other tab's
   *   ({@link cancelWaitingContinuation}). Read from `spec` when left out.
   * @returns Whether the tool call was found.
   */
  applyInteraction(
    apply: () => Promise<ToolInteractionOutcome>,
    autoContinue: boolean,
    spec: () => ContinuationSource<TConnection>,
    enqueue: (run: () => Promise<boolean>) => Promise<boolean> = (run) =>
      this.enqueueInteraction(run),
    connectionId?: string | null
  ): Promise<boolean> {
    return this.#applyUnlessStopped(
      apply,
      autoContinue,
      (outcome) =>
        this.autoContinuation.afterInteraction(outcome, autoContinue, spec),
      enqueue,
      connectionId === undefined ? connectionOf(spec) : connectionId
    );
  }

  /**
   * {@link applyInteraction} for a result no connection is there to
   * continue: the host starts the continuation itself (`Think` queues its
   * connection-less one). The same rules hold: only an apply that settled
   * its call continues, and not when a stop landed while it applied.
   *
   * @param continueFor - Start the continuation that answers the message
   *   the result is stored in.
   * @param enqueue - As for {@link applyInteraction}.
   */
  applyInteractionThen(
    apply: () => Promise<ToolInteractionOutcome>,
    continueFor: (targetMessageId: string) => Promise<void>,
    enqueue: (run: () => Promise<boolean>) => Promise<boolean> = (run) =>
      this.enqueueInteraction(run)
  ): Promise<boolean> {
    return this.#applyUnlessStopped(
      apply,
      true,
      async (outcome) => {
        if (outcome.status === "changed") await continueFor(outcome.messageId);
      },
      enqueue,
      null
    );
  }

  /**
   * Run `apply` in the apply chain, then `decide` its continuation, unless
   * a stop landed since the frame arrived. A result whose frame arrived
   * before a stop was waiting when the stop landed, also when its apply had
   * not finished yet. It must not schedule a continuation once it does.
   */
  #applyUnlessStopped(
    apply: () => Promise<ToolInteractionOutcome>,
    autoContinue: boolean,
    decide: (outcome: ToolInteractionOutcome) => void | Promise<void>,
    enqueue: (run: () => Promise<boolean>) => Promise<boolean>,
    connectionId: string | null
  ): Promise<boolean> {
    const stops = this.#stops;
    const entry = { connectionId, stopped: false };
    this.#applying.add(entry);
    return enqueue(async () => {
      let outcome: ToolInteractionOutcome;
      try {
        outcome = await apply();
      } finally {
        this.#applying.delete(entry);
      }
      const stopLanded = stops !== this.#stops;
      if (stopLanded || entry.stopped) {
        if (autoContinue && outcome.status === "changed") {
          this.host.continuationDropped?.({
            requestId: null,
            reason: "stopped",
            ...(stopLanded &&
              this.#stoppedTurn !== null && {
                stoppedRequestId: this.#stoppedTurn
              })
          });
        }
      } else {
        await decide(outcome);
      }
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
   * Run the continuation turn for the pending continuation, from its abort
   * signal to its settle. The host supplies how to enqueue and what each
   * step does. See {@link runContinuationTurn}.
   */
  runContinuationTurn<TMessage>(
    turn: ContinuationTurn<TConnection, TMessage>
  ): Promise<void> {
    return runContinuationTurn(this.#continuationParts, turn);
  }

  /**
   * Run a continuation turn nothing scheduled on a connection, through the
   * same runner. See {@link runContinuationTurn}.
   */
  runUnscheduledContinuationTurn<TMessage>(
    turn: ContinuationTurn<TConnection, TMessage>,
    continuation: ContinuationContext<TConnection>,
    errorPrefix: string | null = null
  ): Promise<void> {
    return runContinuationTurn(this.#continuationParts, turn, {
      continuation,
      errorPrefix
    });
  }

  /**
   * Report a turn that failed before it streamed, a client request or a
   * continuation: the host's hook, the terminal record, then the error
   * frame. See {@link reportTurnFailure}.
   *
   * @returns For a continuation, the `onChatResponse` result to deliver
   *   after the turn left the queue. {@link runContinuationTurn} does that
   *   for the turns it runs.
   */
  reportTurnFailure<TMessage>(
    host: TurnFailureHost<TMessage>,
    failure: TurnFailure
  ) {
    return reportTurnFailure(this.host.messages(), host, failure);
  }

  /**
   * The resumable stream of the turn running `requestId` started. Every
   * connection that was waiting for it is told to resume it
   * (`notifyResuming` sends `STREAM_RESUMING`): those parked on the turn's
   * pre-stream window (#1784), and those waiting on the continuation the
   * turn runs ({@link continuationStreamStarted}). Call it for every stream.
   */
  streamStarted(
    requestId: string,
    notifyResuming: (connection: TConnection) => void
  ): void {
    this.#lastReply = requestId;
    this.preStream.flushOnStreamStart(notifyResuming);
    continuationStreamStarted(
      this.#continuationParts,
      requestId,
      notifyResuming
    );
  }

  /**
   * The resumable stream of the turn running `requestId` ended (finished,
   * completed or errored). See {@link continuationStreamEnded}.
   */
  streamEnded(requestId: string | null): void {
    continuationStreamEnded(this.#continuationParts, requestId);
  }

  /**
   * A streamed reply was finalized and the host cleared its stream-active
   * gate. See {@link replyFinalized}.
   */
  replyFinalized(): void {
    replyFinalized(this.#continuationParts);
  }

  // ── Before a turn ──────────────────────────────────────────────────

  /**
   * Whether the message a continuation turn would continue still waits on a
   * client. Ask it first, before the turn stores anything: when it is
   * `true` there is nothing to continue yet, the turn ends as skipped, and
   * the client's answer starts the continuation. See
   * {@link continuationWaitsOnClient}.
   */
  continuationWaitsOnClient(
    messages: ReadonlyArray<ChatTurnMessage> = this.host.messages()
  ): boolean {
    return continuationWaitsOnClient(messages, this.host.clientToolNames());
  }

  /**
   * Settle what `messages` must not go to the model with, before a turn
   * calls it, then store what changed and report it through `sink`. The one
   * before-turn step both hosts run. See {@link repairTranscriptBeforeTurn}
   * for the rule: a reply the conversation moved past keeps no unanswered
   * call, a continuation turn keeps, in the message it continues, what a
   * client is known to still answer, and no assistant message ends in
   * reasoning.
   *
   * @param messages - The history the turn's model request is built from.
   *   Its last message is the one a continuation turn continues.
   * @returns The repaired messages and what changed. When `keptToolCallIds`
   *   is not empty, the turn must not call the model.
   */
  async settleBeforeTurn(
    messages: UIMessage[],
    options: Omit<BeforeTurnRepairOptions, "clientToolNames">,
    sink: RepairedTranscriptSink
  ): Promise<BeforeTurnRepairResult> {
    const result = repairTranscriptBeforeTurn(messages, {
      ...options,
      clientToolNames: this.host.clientToolNames()
    });
    // Without the replies that hold nothing: the repair removed them.
    return {
      ...result,
      messages: await persistRepairedTranscript(messages, result, sink)
    };
  }

  /**
   * Whether the message a continuation turn would continue holds nothing
   * once its trailing reasoning is gone, so there is nothing to continue.
   * See {@link replyToContinueIsEmpty}.
   */
  replyToContinueIsEmpty(messages: ReadonlyArray<UIMessage>): boolean {
    return replyToContinueIsEmpty(messages);
  }

  /**
   * Remove the reply a continuation turn would continue when it holds
   * nothing once stripped. The host then answers the question again. See
   * {@link removeEmptyReplyToContinue}.
   */
  removeEmptyReplyToContinue(
    messages: ReadonlyArray<UIMessage>,
    sink: RepairedTranscriptSink
  ): Promise<boolean> {
    return removeEmptyReplyToContinue(messages, sink);
  }

  /**
   * Settle the tool calls a cut-off reply left unanswered, before it is
   * stored. A call the host's client is known to own is kept. See
   * {@link settleInterruptedReply}.
   */
  settleInterruptedReply<TMessage extends UIMessage>(
    message: TMessage,
    repairPart: RepairInterruptedToolPartsOptions["repairPart"]
  ): TMessage {
    return settleInterruptedReply(message, {
      repairPart,
      clientToolNames: this.host.clientToolNames()
    });
  }

  /**
   * Settle and store the reply a recovery attempt is about to continue. See
   * {@link settleReplyBeforeRecovery}.
   */
  settleBeforeRecovery(
    messages: ReadonlyArray<UIMessage>,
    continueReplyId: string,
    repairPart: RepairInterruptedToolPartsOptions["repairPart"],
    sink: RepairedTranscriptSink,
    removal?: ReplyRemoval
  ): Promise<"removed" | undefined> {
    return settleReplyBeforeRecovery(
      messages,
      continueReplyId,
      { repairPart, clientToolNames: this.host.clientToolNames() },
      sink,
      removal
    );
  }

  // ── Cancel and reset ───────────────────────────────────────────────

  /**
   * Stop a request: abort its turn (queued or running) and any recovery
   * attempt running for it. A client only learns a continuation's own request
   * id from its first frame, so until then it cancels a recovered turn by the
   * original id, which is the id recovery attempts are registered under.
   *
   * Stop means stop. When this call is what stops the turn running now (the
   * request itself, or the recovered reply of a recovery attempt registered
   * under it), every continuation that was waiting when the stop landed is
   * dropped, so the model does not start again by itself once the turn ends
   * ({@link dropWaitingContinuations}). That includes a tool result whose
   * frame arrived before the stop and whose apply had not finished. A tool
   * result that arrives after the stop is a new action and continues as
   * usual, so a second stop for a turn that was stopped already drops
   * nothing.
   *
   * With no turn running, the stop still lands when `requestId` is the
   * request whose reply just ended: a continuation of that reply that has
   * not started (in its coalesce window, or parked on an unanswered sibling)
   * is dropped the same way. A stop for any other ended request drops
   * nothing.
   *
   * The rule is about the turn, not about how it was stopped:
   * {@link stopAll} and a signal linked with {@link linkExternal} drop the
   * same way. An abort the runtime does for its own reasons (the stall
   * watchdog, which recovery follows) runs inside {@link runtimeAbort} and
   * drops nothing.
   */
  cancel(requestId: string, reason?: unknown): Promise<void> {
    // A request that waits as a record, here or after a reset, stays stopped.
    this.admissions?.stop(requestId);
    this.#noteStopped(this.aborts.getExistingSignal(requestId));
    this.#stop(() => {
      this.aborts.cancel(requestId, reason);
      this.#recoveryAttempts.get(requestId)?.abort(reason);
    }, requestId);
    return this.#afterStop(requestId, reason);
  }

  /**
   * Whether the turn that owns `signal` was stopped: {@link isTurnStopped},
   * or a stop that landed after the runtime had already aborted the signal
   * for a stall. The signal keeps the stall as its reason, so it alone
   * cannot say that a stop followed.
   */
  isStopped(signal: AbortSignal | undefined): boolean {
    return (
      isTurnStopped(signal) ||
      (signal !== undefined && this.#stoppedSignals.has(signal))
    );
  }

  #noteStopped(signal: AbortSignal | undefined): void {
    if (signal && this.#runtimeAborts === 0) this.#stoppedSignals.add(signal);
  }

  /**
   * Tell the host about a stop ({@link ChatTurnsHost.stopped}).
   *
   * @returns A promise that settles when the host's work is done. It never
   *   rejects: a stop that could not finish its bookkeeping still stopped
   *   the turn.
   */
  async #afterStop(requestId: string | null, reason: unknown): Promise<void> {
    if (this.#runtimeAborts > 0) return;
    try {
      await this.host.stopped?.(requestId, reason);
    } catch (error) {
      console.error("[chat] failed to finish a stop:", error);
    }
  }

  /**
   * Stop every request: abort every controller and empty the registry, and
   * abort every running recovery attempt. Every continuation waiting now
   * is dropped, whether a turn is running or not: one in its coalesce
   * window or parked on an unanswered sibling has no running turn, and
   * "stop everything" covers it all the same. A result that arrives after
   * this call continues as usual.
   */
  stopAll(reason?: unknown): Promise<void> {
    this.admissions?.stopAll();
    for (const signal of this.aborts.signals()) this.#noteStopped(signal);
    this.#stop(() => {
      this.aborts.destroyAll(reason);
      for (const attempt of this.#recoveryAttempts.values()) {
        attempt.abort(reason);
      }
    }, null);
    return this.#afterStop(null, reason);
  }

  /**
   * A tab pressed stop while it waited for a continuation to start. It has
   * no request id to cancel yet (the continuation's id reaches it with
   * `STREAM_RESUMING`), so it names itself:
   *
   * - the continuation it waits on has not started: it is dropped, with
   *   everything else that was waiting, and the tabs waiting on it get
   *   `STREAM_RESUME_NONE`;
   * - that continuation's turn is running, before or just after its stream
   *   started: the turn is stopped like one stopped with {@link cancel};
   * - its tool result is still being applied: the result schedules nothing.
   *
   * A tab that waits on nothing stops nothing.
   */
  cancelWaitingContinuation(connectionId: string, reason?: unknown): void {
    const { pending, activeRequestId, activeConnectionId } = this.continuation;
    if (pending && this.continuation.awaitingConnections.has(connectionId)) {
      if (pending.pastCoalesce) {
        void this.cancel(pending.requestId, reason);
        return;
      }
      // Fired and queued, or not fired yet: its turn finds nothing to claim.
      this.#dropWaiting(null);
      return;
    }
    if (activeRequestId !== null && activeConnectionId === connectionId) {
      void this.cancel(activeRequestId, reason);
      return;
    }
    // This tab's result, whose frame arrived before the stop and is still
    // applying. Another tab's apply is left alone.
    for (const entry of this.#applying) {
      if (entry.connectionId === connectionId) entry.stopped = true;
    }
  }

  /**
   * Link an external `AbortSignal` to the request `requestId`, the way
   * `AbortRegistry.linkExternal` does, with one difference: when the signal
   * fires it stops the request through {@link cancel}. A caller that stops a
   * turn through the `signal` it passed to `saveMessages`, `continueLastTurn`
   * or `chat()` gets the same "stop means stop" as one that calls
   * `abortRequest`.
   *
   * @returns A function that removes the link. Call it when the turn ends.
   */
  linkExternal(requestId: string, signal: AbortSignal | undefined): () => void {
    if (!signal) return () => {};
    // A recovery attempt whose reply another turn took over aborts its
    // turn's signal. That is the runtime's abort, not a user's stop.
    const stop = () => {
      if (signal.reason instanceof ChatRecoverySupersededError) {
        this.runtimeAbort(() => void this.cancel(requestId, signal.reason));
      } else {
        void this.cancel(requestId, signal.reason);
      }
    };
    if (signal.aborted) {
      // The controller has to exist for the stop to land on it.
      this.aborts.getSignal(requestId);
      stop();
      return () => {};
    }
    const listener = stop;
    signal.addEventListener("abort", listener, { once: true });
    return () => signal.removeEventListener("abort", listener);
  }

  /**
   * Run an abort that is the runtime's own and not a stop: `abort` may call
   * {@link cancel} (through the host's `abortRequest`, so a subclass that
   * observes aborts still sees it) and nothing waiting is dropped. The stall
   * watchdog uses it: recovery continues the turn it aborts.
   */
  runtimeAbort(abort: () => void): void {
    this.#runtimeAborts++;
    try {
      abort();
    } finally {
      this.#runtimeAborts--;
    }
  }

  /**
   * Run `abort`, and drop the waiting continuations when the stop lands on
   * them: it stops the turn running now, it names the reply that just
   * ended, or it stops every request.
   *
   * @param requestId - The request the stop names, or `null` for a stop of
   *   every request.
   */
  #stop(abort: () => void, requestId: string | null): void {
    const active = this.queue.activeRequestId;
    const activeSignal =
      active === null ? undefined : this.aborts.getExistingSignal(active);
    const wasAborted = activeSignal?.aborted ?? false;

    abort();

    if (this.#runtimeAborts > 0) return;
    if (requestId === null) {
      // Every request: whatever waits now is dropped, with or without a
      // running turn, also when an earlier stop stopped that turn already.
      this.#dropWaiting(active);
      return;
    }
    if (active === null) {
      // No turn is running. The stop lands only on the reply that just
      // ended, and only once.
      if (requestId !== this.#lastReply || this.#stoppedTurn === requestId) {
        return;
      }
      this.#dropWaiting(requestId);
      return;
    }
    // A stop for a turn that a stop already stopped stops nothing. What is
    // waiting by now arrived after the first stop. (A nested stop, through a
    // linked signal, may have just recorded it.)
    if (this.#stoppedTurn === active) return;
    // This call stopped the running turn when it names it, or when it is
    // what aborted it: a recovered reply runs under a fresh id with its
    // abort signal linked to the recovery attempt, which is registered
    // under the original id the client stops it by.
    const stoppedRunningTurn =
      active === requestId || (!wasAborted && activeSignal?.aborted === true);
    if (!stoppedRunningTurn) return;
    this.#dropWaiting(active);
  }

  /**
   * A stop landed: record it, so a result whose frame arrived before it
   * schedules nothing once its apply finishes, and drop what waits now.
   *
   * @param stoppedRequestId - The turn the stop stopped, or `null`.
   */
  #dropWaiting(stoppedRequestId: string | null): void {
    this.#stoppedTurn = stoppedRequestId;
    this.#stops++;
    dropWaitingContinuations(this.#continuationParts, stoppedRequestId);
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
    this.admissions?.clear();
    this.#restoredDecisions.clear();
    this.queue.reset();
    this.#lastReply = null;
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
      clientToolNames: this.host.clientToolNames(),
      clientAnswerableToolNames: this.host.clientAnswerableToolNames?.()
    });
  }

  /**
   * `true` while a continuation decision is still to come, or a
   * continuation has fired and its turn has not started: the host's enqueue
   * may await before the turn is on the queue, and the chat is not idle in
   * between.
   */
  hasPendingDecision(): boolean {
    return (
      this.autoContinuation.hasPendingDecision() ||
      this.#continuationParts.firing.size > 0
    );
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

/** The connection a continuation spec names, or `null` when it cannot say. */
function connectionOf<TConnection extends ContinuationConnection>(
  spec: () => ContinuationSource<TConnection>
): string | null {
  try {
    return spec().connection?.id ?? null;
  } catch {
    // A spec may throw when the result is not to continue.
    return null;
  }
}
