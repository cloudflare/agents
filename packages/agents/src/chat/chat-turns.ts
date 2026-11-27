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
 * the host, behind {@link ChatTurnsHost}. See `design/chat-turn-core.md`.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import { tryN } from "../retries";
import { CHAT_REQUEST_CONTEXT_KEY, storableRequestContext } from "./chat-host";
export { CHAT_REQUEST_CONTEXT_KEY, storableRequestContext };
import type { UIMessage } from "ai";
import {
  ChatAdmissions,
  supersedes,
  type ChatAdmissionInput,
  type ChatAdmissionRecord,
  type HeldChatMessage
} from "./admissions";
import {
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies
} from "./async-helpers";
import {
  continuationWaitsOnClient,
  replyToContinueIsEmpty,
  repairTranscriptBeforeTurn,
  type BeforeTurnRepairOptions,
  type BeforeTurnRepairResult
} from "./before-turn";
import {
  CONTINUATION_COALESCE_MS,
  ContinuationSlots,
  addContinuationTarget,
  continuationTargetIsLatest,
  type ContinuationConnection,
  type ContinuationSource,
  type ContinuationSpec,
  type ToolInteractionOutcome
} from "./continuation-state";
import {
  continuationStreamEnded,
  continuationStreamStarted,
  dropPendingContinuation,
  dropWaitingContinuations,
  replyFinalized,
  runContinuationTurn,
  type ContinuationContext,
  type ContinuationDropped,
  type ContinuationTurn,
  type ContinuationTurnParts
} from "./continuation-turn";
import type {
  MessageConcurrency,
  NormalizedMessageConcurrency
} from "./lifecycle";
import { PreStreamTurns } from "./pre-stream-turns";
import type { LiveReply } from "./reply-pump";
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
  clientResolvableToolNames,
  hasIncompleteToolBatch,
  hasPendingToolInteraction
} from "./tool-state";
import type { ClientToolSchema } from "./client-tools";
import {
  reportTurnFailure,
  type TurnFailure,
  type TurnFailureHost
} from "./turn-failure";
import { TurnLane, type TurnReservation } from "./turn-lane";
import {
  CHAT_TURN_LANE,
  inLaneRecoveryAttempt,
  type ChatTurnTaskInput
} from "./turn-task";
import type { TaskJson, TaskRunOptions, Tasks } from "../tasks";
import type {
  ChatRecoveryAttemptInput,
  ChatRecoveryScheduleReason
} from "./recovery-engine";

/**
 * The stored form of a request context kept by an earlier release as two
 * JSON strings (`lastClientTools`, `lastBody`), or `null` when neither
 * holds anything. A malformed half is dropped.
 *
 * @internal
 */
export function requestContextFromLegacy(
  lastClientTools: string | undefined,
  lastBody: string | undefined
): string | null {
  const parse = (json: string | undefined): unknown => {
    try {
      return json ? JSON.parse(json) : undefined;
    } catch {
      return undefined;
    }
  };
  const clientTools = parse(lastClientTools);
  const body = parse(lastBody);
  const value: { clientTools?: unknown; body?: unknown } = {};
  if (Array.isArray(clientTools) && clientTools.length > 0) {
    value.clientTools = clientTools;
  }
  if (body && typeof body === "object") value.body = body;
  return Object.keys(value).length > 0 ? JSON.stringify(value) : null;
}
import { ChatStreamStalledError } from "./stall-watchdog";
import {
  ChatRecoverySupersededError,
  isTurnStopped,
  turnSignal,
  type TurnAborts
} from "./turn-stop";

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
   * Store the last request context: `{ clientTools, body }` as JSON, or
   * `null` once it is empty. The hosts keep it as the session's
   * `transcript:chat:request` value, so a clear drops it.
   */
  saveRequestContext(json: string | null): void;
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
   * Stop a request the host's way (its protected `abortRequest`), so a
   * subclass that observes aborts sees the stall watchdog's too. Optional:
   * without it {@link ChatTurns.stallAbort} cancels through the core.
   */
  abortRequest?(requestId: string, reason: unknown): void;
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
  /**
   * A waiting request's messages will not join the transcript (it ended
   * before its turn, or its record was dropped): send tabs the message list
   * again, so they stop drawing them as queued. Optional.
   */
  waitingChanged?(): void;
}

export interface ChatTurnsOptions {
  /** Wait for trailing-edge debounced overlapping submits, in milliseconds. */
  defaultDebounceMs: number;
  /**
   * Where each queued turn is a run: the host's Tasks, and its chat-turn
   * definition.
   */
  lane: {
    tasks(): Pick<
      Tasks,
      | "run"
      | "peek"
      | "peekList"
      | "inputOf"
      | "patchMetadata"
      | "settle"
      | "cancel"
    >;
    definition: string;
  };
  /**
   * Durable admission of client requests (`admissions.ts`). Without it a
   * request waiting in the queue is lost when the isolate resets.
   */
  admissions?: ChatTurnsAdmissionOptions;
}

/** What durable admission needs from the host. See `admissions.ts`. */
export interface ChatTurnsAdmissionOptions {
  /** Where continuations' records are kept. */
  storage(): Pick<DurableObjectStorage, "put" | "delete" | "list">;
  /** Whether a chat turn waits for recovery. */
  recoveryPending(): Promise<boolean>;
  /**
   * Take the records an earlier release left (`takeReleasedChatAdmissions`).
   * Called once, on the first {@link ChatTurns.resumeAdmissions}.
   */
  released(): { records: ChatAdmissionRecord[]; drop(): void };
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
   * The new user messages the request holds until its turn starts, and the
   * host's data to run it again after a reset (JSON). With it, the request
   * is recorded when it is accepted, the messages join the transcript at
   * the front of the queue ({@link join}), and the record goes when its
   * turn has a fiber or it ends. See `admissions.ts`.
   */
  admission?: { messages: HeldChatMessage[]; payload: unknown };
  /** `true` for a new message, `false` for a regenerate. */
  isSubmitMessage: boolean;
  /** The host's `messageConcurrency` setting. */
  concurrency: MessageConcurrency;
  /**
   * Called with the strategy the request arrived under while other turns
   * were queued (`null` when none were), before any step that can wait.
   */
  onDecision?(decision: {
    strategy: NormalizedMessageConcurrency | null;
  }): void;
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
   * Store what the request changes in the stored transcript, and show the
   * request to other clients. Runs before the turn queue. The messages
   * {@link admission} holds are not stored here: they join at
   * {@link join}, and tabs draw them as queued meanwhile. Return `null` to
   * skip the request.
   *
   * @param context.isCurrent - `false` once the chat was reset since the
   *   request arrived.
   */
  persist(context: {
    generation: number;
    isCurrent: () => boolean;
  }): Promise<TPrepared | null>;
  /**
   * Admit the turn through the host's own queue wrapper (tracing, hooks,
   * keep-alive). It must enqueue `turn` on the core's queue under
   * `generation`, and report whether the turn ran or was skipped as stale.
   */
  enqueue(
    turn: () => Promise<void>,
    generation: number
  ): Promise<"completed" | "stale">;
  /**
   * The request's turn is at the front of the queue: store the messages
   * {@link admission} holds, after everything stored so far, and tell tabs.
   * Called once the debounce wait is over, and before a stop is honored (a
   * stopped request's question is kept, unanswered). A request that
   * superseded others holds their messages too, ahead of its own: theirs
   * are never run, and their questions are kept. Not called after a clear.
   * `messages` leaves out those already stored (a reset after an earlier
   * join, or a request that ran before), so it can be empty. Return
   * `false` to skip the request.
   */
  join?(context: {
    prepared: TPrepared;
    messages: HeldChatMessage[];
    generation: number;
    isCurrent: () => boolean;
  }): Promise<boolean>;
  /**
   * Host checks at the front of the queue, after {@link join}: merging
   * queued messages, waiting for MCP connections.
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
  /**
   * Whether a client's answer fired a continuation that waits behind this
   * attempt, which holds the lane (a lane run's attempt). That turn
   * continues the reply; it cannot start before the attempt ends.
   */
  continuationWaiting(): boolean;
}

export class ChatTurns<
  TConnection extends ContinuationConnection = ContinuationConnection
> {
  /** Serializes turns; its generation is the chat's reset epoch. */
  readonly queue: TurnLane;
  /** One abort controller per request id. */
  readonly aborts: TurnAborts = new Map();
  /** Pending, running and active auto-continuation slots. */
  readonly continuation = new ContinuationSlots<TConnection>();
  /** Accepted turns whose stream has not started, and connections parked on them. */
  /**
   * Accepted-but-not-yet-streamed turns and the connections parked waiting for
   * one (#1784). See `ResumeHandshake.preStream`.
   *
   * HIBERNATION INVARIANT: in-memory only, NOT persisted. Safe because the
   * pre-stream window cannot overlap hibernation — a turn between `begin()` and
   * stream start is held by an unresolved `onMessage` handler promise or, for a
   * request replayed after a reset, by `keepAliveWhile`; either keeps the DO
   * alive, so eviction only happens once a durable stream exists (resumed via
   * `ReplyStreams`) or the turn finished. Breaks if a pre-stream wait is ever
   * moved onto a durable alarm that releases the DO; if so, persist this state.
   */
  readonly preStream = new PreStreamTurns<TConnection>();
  /**
   * @internal The coalesce timer in front of a continuation (#1650): each
   * tool result or approval re-arms it, and when it fires the barrier
   * ({@link fireContinuationWhenStable}) runs.
   */
  coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * @internal Whether the barrier is draining the applies in flight. Only
   * one drain runs; a result that re-arms the timer meanwhile is absorbed
   * by it, and the drain re-checks when it ends.
   */
  barrierActive = false;

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

  /**
   * The reply `pumpReply` builds, while it streams and while it is stored.
   * A tool result or approval that arrives then is applied to it in place,
   * and the resume handshake reads whether its terminal frame waits.
   */
  liveReply: LiveReply | null = null;
  /** Depth of {@link runtimeAbort} calls in progress. */
  /** The reasons of the runtime's own aborts running now ({@link runtimeAbort}). */
  readonly #runtimeReasons: unknown[] = [];
  /** The signals of the turns a stop landed on. */
  readonly #stoppedSignals = new WeakSet<AbortSignal>();

  /** What the continuation lifecycle (continuation-turn.ts) works on. */
  readonly #continuationParts: ContinuationTurnParts<TConnection>;

  /** Stop signals of running recovery attempts, by original request id. */
  readonly #recoveryAttempts = new Map<string, AbortController>();

  /** Durable admission records, when the host keeps them. */
  readonly admissions: ChatAdmissions | null;
  /** The debounce wait of a `{ strategy: "debounce" }` without one. */
  readonly #defaultDebounceMs: number;
  /** Where queued turns are runs. */
  readonly #lane: ChatTurnsOptions["lane"];
  /** Lane runs this isolate keeps parked until their reply ends. */
  readonly #parked = new Set<string>();
  /** The host's request for a record, to replay it inside its run. */
  readonly #replayRequest:
    | ((record: ChatAdmissionRecord) => ClientChatRequest<unknown> | null)
    | null;
  /** The records an earlier release left, until they are carried over. */
  #released: ChatTurnsAdmissionOptions["released"] | null;
  /** Whether a chat turn waits for recovery, for continuations' records. */
  readonly #recoveryPending: (() => Promise<boolean>) | null;

  /**
   * The client tools and body of the last client request. A server-started
   * turn (`saveMessages`, a schedule) and a tool-answer continuation run
   * with them. Kept in memory because hooks read them synchronously, and
   * stored through {@link ChatTurnsHost.saveRequestContext}.
   */
  lastClientTools: ClientToolSchema[] | undefined;
  /** See {@link lastClientTools}. */
  lastBody: Record<string, unknown> | undefined;
  /** Bumped by every set and clear, so a tool result applied meanwhile does not replace newer tools. */
  #requestGeneration = 0;

  /**
   * Load the stored request context (`json` from the session value), at
   * start. Malformed JSON is treated as none.
   */
  restoreRequestContext(json: string | null): void {
    let value: { clientTools?: unknown; body?: unknown } = {};
    try {
      value = json ? (JSON.parse(json) as typeof value) : {};
    } catch {
      // A malformed value is no context.
    }
    this.lastClientTools = Array.isArray(value.clientTools)
      ? (value.clientTools as ClientToolSchema[])
      : undefined;
    this.lastBody =
      value.body && typeof value.body === "object"
        ? (value.body as Record<string, unknown>)
        : undefined;
  }

  /**
   * Take a client request's tools and body as the last request context. No
   * tools clears the stored tools; an empty body clears the body.
   */
  setRequestContext(request: {
    clientTools?: ClientToolSchema[] | null;
    body?: Record<string, unknown> | null;
  }): {
    clientTools: ClientToolSchema[] | undefined;
    body: Record<string, unknown> | undefined;
  } {
    const { clientTools, body } = request;
    this.#requestGeneration++;
    this.lastClientTools =
      Array.isArray(clientTools) && clientTools.length > 0
        ? clientTools
        : undefined;
    this.lastBody = body && Object.keys(body).length > 0 ? body : undefined;
    this.storeRequestContext();
    return { clientTools: this.lastClientTools, body: this.lastBody };
  }

  /** Forget the last request context (a chat clear). */
  clearRequestContext(): void {
    this.#requestGeneration++;
    this.lastClientTools = undefined;
    this.lastBody = undefined;
    this.storeRequestContext();
  }

  /**
   * Wrap a tool result's apply so that, when it changed a message, the
   * tools it carried replace the stored ones, unless a request set or
   * cleared the context while it ran.
   */
  applyingToolResult(
    clientTools: unknown,
    apply: () => Promise<ToolInteractionOutcome>
  ): () => Promise<ToolInteractionOutcome> {
    const generation = this.#requestGeneration;
    return async () => {
      const outcome = await apply();
      if (
        outcome.status === "changed" &&
        this.#requestGeneration === generation &&
        Array.isArray(clientTools) &&
        clientTools.length > 0
      ) {
        this.lastClientTools = clientTools as ClientToolSchema[];
        this.storeRequestContext();
      }
      return outcome;
    };
  }

  /** Names of the tools the client of the last request runs. */
  clientToolNames(): Set<string> {
    return clientResolvableToolNames(this.lastClientTools);
  }

  /**
   * Store the current request context. One past `ROW_VALUE_BYTES` is kept in
   * memory only, with a warning, and the stored one is deleted: after a
   * restart, server-started turns run without a context rather than with an
   * older one. Every call writes: a Sessions clear deletes the stored value
   * without telling this object, so "unchanged" cannot be trusted.
   */
  storeRequestContext(): void {
    this.host.saveRequestContext(
      storableRequestContext(
        this.lastClientTools || this.lastBody
          ? JSON.stringify({
              ...(this.lastClientTools && {
                clientTools: this.lastClientTools
              }),
              ...(this.lastBody && { body: this.lastBody })
            })
          : null
      )
    );
  }

  /**
   * Run a recovery attempt no turn's run kept in a chat-turn run of its
   * own, from the alarm, where `trackAlarmWork` keeps the continuation's
   * model turn inside the memory-limit breaker. The run's input carries
   * the attempt, so one too large for a step's journal still runs.
   *
   * A first schedule (`initial`) joins an open run for the same incident,
   * callback and schedule number, so a retried start of one schedule makes
   * one run. A later schedule of the same incident carries a newer number
   * and gets its own run: the older run is stale by then and returns
   * without a turn. Chained and timed-out attempts are unkeyed: each is
   * started while the run before it still exists, and is a new attempt.
   *
   * @param dedupeKey - The run's id: every retry of one failed start reuses
   *   it and joins the run an earlier try already created (the `redefer` of
   *   `dispatchChatRecoveryToHandoff`).
   */
  async startAttemptRun(
    attempt: ChatRecoveryAttemptInput,
    reason: ChatRecoveryScheduleReason,
    dedupeKey?: string
  ): Promise<void> {
    const { callback, data } = attempt;
    const text = (value: unknown) =>
      typeof value === "string" ? value : undefined;
    const incidentId = text(data.incidentId);
    const recoveredRequestId = text(data.recoveredRequestId);
    // The schedule's number is part of the key. A second schedule of the
    // same incident has a newer number, which makes the run it would join
    // stale (`recoveryDelivery`), so it must get its own run.
    const delivery =
      typeof data.delivery === "number" ? data.delivery : undefined;
    const input: ChatTurnTaskInput = {
      requestId:
        recoveredRequestId ?? text(data.originalRequestId) ?? incidentId ?? "",
      continuation: false,
      nonce: dedupeKey ?? crypto.randomUUID(),
      // SAFETY: the attempt is the recovery engine's JSON payload.
      attempt: attempt as unknown as TaskJson
    };
    await this.#lane.tasks().run(this.#lane.definition, input, {
      retain: false,
      ...(dedupeKey !== undefined && { runId: dedupeKey }),
      ...(reason === "initial" &&
        incidentId && {
          idempotencyKey: `chat-recovery:${callback}:${incidentId}${
            delivery === undefined ? "" : `:${delivery}`
          }`
        }),
      // No `requestId`: the run is not a turn of that request.
      metadata: {
        callback,
        ...(incidentId && { incidentId }),
        ...(recoveredRequestId && { recoveredRequestId })
      },
      start: "alarm"
    });
  }

  constructor(
    private readonly host: ChatTurnsHost,
    options: ChatTurnsOptions
  ) {
    const { lane } = options;
    this.#lane = lane;
    this.#defaultDebounceMs = options.defaultDebounceMs;
    this.queue = new TurnLane((requestId, entry, extra, policy) => {
      const nonce = crypto.randomUUID();
      const input: ChatTurnTaskInput = {
        requestId,
        continuation: false,
        nonce,
        lane: true,
        ...extra
      };
      return lane.tasks().run(lane.definition, input, {
        runId: `chat_${nonce}`,
        retain: false,
        metadata: { requestId },
        lane: CHAT_TURN_LANE,
        local: entry,
        ...(policy && { policy })
      });
    });
    const admissions = options.admissions;
    this.admissions = admissions
      ? new ChatAdmissions({
          tasks: lane.tasks,
          definition: lane.definition,
          storage: admissions.storage
        })
      : null;
    this.#replayRequest = admissions
      ? (record) => admissions.replayRequest(record)
      : null;
    this.#recoveryPending = admissions
      ? () => admissions.recoveryPending()
      : null;
    this.#released = admissions ? () => admissions.released() : null;
    this.#continuationParts = {
      continuation: this.continuation,
      rearmForBatch: () => this.rearmContinuation(),
      aborts: this.aborts,
      messages: () => host.messages(),
      clientToolNames: () => this.clientToolNames(),
      streamed: new Map(),
      firing: new Set(),
      unscheduled: new Set(),
      dropped: (event) => host.continuationDropped?.(event),
      // A continuation that ends without a turn leaves no record behind.
      released: (requestId) => {
        this.admissions?.end(requestId);
        this.#continuationQueued(requestId);
      },
      queued: (requestId) => this.#continuationQueued(requestId)
    };
  }

  // ── Submits ────────────────────────────────────────────────────────

  /**
   * The strategy a client request arrives under: its `messageConcurrency`
   * when it is a new message and other turns are queued or running, `null`
   * otherwise.
   */
  #strategy(
    concurrency: MessageConcurrency,
    isSubmitMessage: boolean
  ): NormalizedMessageConcurrency | null {
    // A request an earlier isolate left waiting (in its quiet period, say)
    // is queued too, though this isolate has not replayed it yet.
    if (
      !isSubmitMessage ||
      (this.queue.queuedCount() === 0 && !this.admissions?.waiting())
    ) {
      return null;
    }
    if (typeof concurrency === "string") return concurrency;
    const { debounceMs } = concurrency;
    return {
      strategy: "debounce",
      debounceMs:
        typeof debounceMs === "number" &&
        Number.isFinite(debounceMs) &&
        debounceMs >= 0
          ? debounceMs
          : this.#defaultDebounceMs
    };
  }

  /**
   * Run one chat request from a client, start to finish. This is the one
   * order both hosts follow:
   *
   * 1. Accept it: mark it pre-stream (so a reconnecting client waits for its
   *    stream) and create its abort controller, so a cancel that arrives at
   *    any later point, including while it waits in the queue, is not lost
   *    (#2701).
   * 2. Take its run on the chat lane, which holds the new messages it
   *    holds, under its concurrency strategy: under `drop` at a busy lane
   *    nothing is stored and the request ends here; under `latest`, `merge`
   *    and debounce its run skips the waiting runs that arrived so too, and
   *    holds their messages ahead of its own; a debounced run starts once
   *    its quiet period is over.
   * 3. Store what it changes in the stored transcript, then queue the turn.
   * 4. At the front of the queue: skip it if the chat was reset. Otherwise
   *    its held messages join the transcript, after everything stored so
   *    far. Then end it with `aborted` if it was cancelled meanwhile (the
   *    model is never called), otherwise run it.
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
   * (`replay`): it runs inside its run, which holds its record.
   */
  async #runClientRequest<TPrepared>(
    request: ClientChatRequest<TPrepared>,
    replay?: { record: ChatAdmissionRecord }
  ): Promise<void> {
    const { requestId } = request;
    if (!request.join && (request.admission?.messages.length ?? 0) > 0) {
      throw new TypeError("runClientRequest: held messages need a join step");
    }
    const generation = this.queue.generation;
    const admissions = request.admission ? this.admissions : null;
    const strategy = replay
      ? replay.record.strategy
      : this.#strategy(request.concurrency, request.isSubmitMessage);
    request.onDecision?.({ strategy });

    // Anything but a string would give a turn no stop can reach.
    if (typeof requestId !== "string") {
      throw new TypeError("runClientRequest: requestId must be a string");
    }
    const signal = turnSignal(this.aborts, requestId);
    // A stop that landed on the record before the reset still stops it.
    if (replay?.record.stopped) this.aborts.get(requestId)?.abort();
    this.preStream.begin(requestId);
    let reservation: TurnReservation | undefined;
    let stage: "persist" | "turn" = "persist";
    // The messages the request holds until its turn starts: with those of
    // the waiting requests it supersedes first.
    const held: HeldChatMessage[] = replay
      ? replay.record.messages
      : [
          ...(supersedes(strategy) && admissions
            ? admissions.supersedableMessages()
            : []),
          ...(request.admission?.messages ?? [])
        ];
    let joined = held.length === 0;
    try {
      // The run holds the request's new messages: a reset at any point
      // before its turn has a fiber leaves them there, and only there, so
      // the replay stores them once and nothing else can.
      if (!replay) {
        const admission: ChatAdmissionInput | undefined = request.admission && {
          order: admissionOrder(),
          messages: held,
          afterUserId: this.#latestUserId(),
          ...(strategy && { strategy }),
          payload: request.admission.payload
        };
        // Taken before any wait: a request accepted next is after it.
        reservation = this.queue.reserve(
          requestId,
          admission ? { admission } : {},
          arrivalPolicy(strategy)
        );
        admissions?.hold(requestId, null, held, supersedes(strategy));
        const receipt = await reservation.accepted;
        if (receipt.dropped) {
          joined = true;
          // Its messages are not coming: tabs are sent the list without them.
          admissions?.end(requestId);
          request.onDropped();
          return;
        }
        // The runs it superseded never run. Those an earlier isolate left
        // have no request here to say so: they end `skipped` here, so a tab
        // that resumes by their request id learns it.
        for (const record of admissions?.endRuns(receipt.superseded ?? []) ??
          []) {
          this.#replayRequest?.(record)?.onSkipped();
        }
        admissions?.hold(requestId, receipt.runId, held, supersedes(strategy));
      }
      // Inside the try, so a failure here is reported and settled like any
      // other step's.
      await request.onAccepted?.();
      const prepared = await request.persist({
        generation,
        isCurrent: () => this.queue.generation === generation
      });
      if (prepared === null) {
        request.onSkipped();
        return;
      }
      stage = "turn";
      const outcome = await request.enqueue(async () => {
        if (this.queue.generation !== generation) {
          request.onSkipped();
          return;
        }
        // A replay whose conversation moved on without it (a rollback
        // answered something newer) does not run. Its question is still
        // stored, after what is there: a user's message is never dropped.
        const movedOn =
          !joined && replay !== undefined && this.#replayMovedOn(replay.record);
        if (!joined) {
          const stored = new Set(this.host.messages().map((m) => m.id));
          const fresh = held.filter((message) => !stored.has(message.id));
          if (
            !(await request.join?.({
              prepared,
              messages: fresh,
              generation,
              isCurrent: () => this.queue.generation === generation
            }))
          ) {
            request.onSkipped();
            return;
          }
          joined = true;
        }
        if (movedOn) {
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
      }, generation);
      if (outcome === "stale") request.onSkipped();
    } catch (error) {
      if (!request.onError) throw error;
      await request.onError(error, stage);
    } finally {
      reservation?.release();
      if (replay) this.queue.releaseInline(requestId);
      this.admissions?.end(requestId);
      // Tabs drew its messages as queued. They are not coming.
      if (!joined && this.queue.generation === generation) {
        this.host.waitingChanged?.();
      }
      this.aborts.delete(requestId);
      this.settlePreStreamTurn(requestId);
    }
  }

  // ── Durable admission ──────────────────────────────────────────────

  /**
   * A turn has a fiber now: recovery owns it, and its admission record
   * goes. Call it where the host's fiber is durably accepted.
   */
  turnAccepted(requestId: string): void {
    this.admissions?.end(requestId);
  }

  /**
   * Run the client request a record describes, inside the lane run that
   * holds the record (its isolate died before the turn started). The host's
   * chat-turn definition calls it.
   */
  async replayInRun(runId: string, record: ChatAdmissionRecord): Promise<void> {
    const marks = this.#lane.tasks().peek(runId)?.metadata?.chat as
      | { stopped?: unknown; cleared?: unknown }
      | undefined;
    // A clear discards a waiting request, messages and all.
    if (marks?.cleared === true) return;
    const stopped =
      marks?.stopped === true ||
      (this.admissions?.takeStop(record.requestId) ?? false);
    const request = this.#replayRequest?.({ ...record, stopped });
    if (!request) return;
    this.admissions?.hold(record.requestId, runId, record.messages);
    // The request runs inside this run, which holds the lane until its turn
    // ends; what the host does after the turn (its response hooks, which may
    // queue a turn of their own) runs after the lane moved on.
    let laneDone!: () => void;
    const done = new Promise<void>((resolve) => {
      laneDone = resolve;
    });
    this.queue.reserveInline(record.requestId, laneDone);
    void this.#runClientRequest(request, {
      record: { ...record, stopped }
    })
      .catch((error: unknown) =>
        console.error("[chat] a replayed request failed:", error)
      )
      .finally(laneDone);
    await done;
  }

  /**
   * Carry the admission records an earlier release left
   * (`takeReleasedChatAdmissions`) onto this release's: a client request's
   * becomes a run on the chat lane, in their order, which runs it again by
   * itself; a continuation's becomes its record key. A request a later one
   * superseded (`latest`, `merge`, debounce) gets no run: the later one
   * holds its messages ahead of its own, as a live arrival does.
   */
  async #carryReleasedAdmissions(
    records: ReadonlyArray<ChatAdmissionRecord>
  ): Promise<void> {
    const admissions = this.admissions;
    if (!admissions) return;
    const superseded = new Set<ChatAdmissionRecord>();
    const messagesOf = new Map<ChatAdmissionRecord, HeldChatMessage[]>();
    let previous: ChatAdmissionRecord | undefined;
    for (const record of records) {
      if (continuationRecord(record) || !supersedes(record.strategy)) continue;
      if (previous) {
        superseded.add(previous);
        messagesOf.set(record, [
          ...(messagesOf.get(previous) ?? previous.messages),
          ...record.messages
        ]);
      }
      previous = record;
    }
    for (const record of records) {
      if (superseded.has(record)) continue;
      const continuation = continuationRecord(record);
      if (continuation) {
        if (!record.stopped) {
          await admissions.admitContinuation(
            record.requestId,
            continuation.targetMessageIds,
            true
          );
        }
        continue;
      }
      // Named by the request, so a carry a reset cut short and runs again
      // finds the run it already made.
      const nonce = `released-${record.requestId}`;
      const admission: ChatAdmissionInput = {
        order: record.seq,
        messages: messagesOf.get(record) ?? record.messages,
        afterUserId: record.afterUserId,
        ...(record.strategy && { strategy: record.strategy }),
        payload: record.payload
      };
      const input: ChatTurnTaskInput = {
        requestId: record.requestId,
        continuation: false,
        nonce,
        lane: true,
        admission
      };
      await this.#lane.tasks().run(this.#lane.definition, input, {
        runId: `chat_${nonce}`,
        retain: false,
        metadata: {
          requestId: record.requestId,
          ...(record.stopped && { chat: { stopped: true } })
        },
        lane: CHAT_TURN_LANE
      });
    }
  }

  /**
   * Schedule again the continuations an earlier isolate kept a record of.
   * Call it when the host starts and when a recovery settles: nothing
   * happens while an interrupted turn still waits for recovery. A client
   * request's record is its lane run, which runs again by itself.
   */
  async resumeAdmissions(): Promise<void> {
    await this.#endOrphanedParks();
    const admissions = this.admissions;
    if (!admissions) return;
    if (this.#released) {
      const released = this.#released();
      this.#released = null;
      if (released.records.length > 0) {
        await this.#carryReleasedAdmissions(released.records);
      }
      // Only once their replacements are written.
      released.drop();
    }
    const kept = await admissions.continuations();
    if (kept.length === 0) return;
    // Scheduled again only once no interrupted turn waits for recovery: a
    // later call (a recovery settling) asks again.
    if (await this.#recoveryPending?.()) {
      admissions.forgetRead(kept.map((c) => c.requestId));
      return;
    }
    await this.host.keepAliveWhile(async () => {
      for (const { requestId, targetMessageIds } of kept) {
        await new Promise<void>((queued) =>
          this.#resumeContinuation(requestId, targetMessageIds, queued)
        );
      }
    });
  }

  /**
   * Keep the parked lane run `runId` at the lane's head until `reply` (its
   * recovered reply) ends, then complete it.
   */
  parkUntil(runId: string, reply: Promise<void>): void {
    this.#parked.add(runId);
    const tasks = this.#lane.tasks();
    // A parked run has no wake: a settle that throws is tried again.
    const settle = () =>
      tryN(5, async () => {
        // The attempt that parks it may not have ended yet.
        while (!(await tasks.settle(runId, null))) {
          if (tasks.peek(runId)?.status !== "running") return;
          await new Promise((wait) => setTimeout(wait, 10));
        }
      });
    void reply
      .then(settle)
      .catch((error) => console.error("[chat] parked run not ended:", error))
      .finally(() => this.#parked.delete(runId));
  }

  /** Recovered replies that keep the parks an earlier isolate left. */
  readonly #heldBy = new Set<Promise<void>>();
  #parksCheck: ReturnType<typeof setTimeout> | null = null;

  /** The parked lane runs an earlier isolate left. */
  #orphanedParks(): Array<{ runId: string }> {
    const tasks = this.#lane.tasks();
    try {
      return tasks
        .peekList({
          definition: this.#lane.definition,
          lane: CHAT_TURN_LANE,
          status: ["pending"],
          parked: true,
          results: false
        })
        .filter((run) => !this.#parked.has(run.runId));
    } catch {
      // Tasks has not started.
      return [];
    }
  }

  /**
   * Whether a lane run an earlier isolate left parked holds the lane. Its
   * recovered reply was cut off with that isolate, and the turn's own run
   * recovers it: until it has, nothing queued behind may start.
   */
  laneHeldForRecovery(): boolean {
    return this.#orphanedParks().length > 0;
  }

  /** Keep the parks an earlier isolate left until `reply` ends as well. */
  holdParksUntil(reply: Promise<void>): void {
    this.#heldBy.add(reply);
    void reply
      .catch(() => {})
      .finally(() => {
        this.#heldBy.delete(reply);
        void this.#endOrphanedParks();
      });
  }

  /**
   * End the parks an earlier isolate left, once no turn run of theirs is
   * open and no reply holds them: a recovered reply cut off with that
   * isolate is recovered by its own run first, holding the lane.
   */
  async #endOrphanedParks(): Promise<void> {
    const parked = this.#orphanedParks();
    if (parked.length === 0) return;
    const tasks = this.#lane.tasks();
    const open = (lane?: string) =>
      tasks.peekList({
        definition: this.#lane.definition,
        status: ["pending", "running"],
        results: false,
        limit: Number.MAX_SAFE_INTEGER,
        ...(lane !== undefined && { lane })
      }).length;
    // A turn run off the lane: a recovered reply's, recovering.
    const recovering = this.#heldBy.size > 0 || open() > open(CHAT_TURN_LANE);
    if (recovering) {
      // Asked again until they are done.
      if (this.#parksCheck === null) {
        this.#parksCheck = setTimeout(() => {
          this.#parksCheck = null;
          void this.#endOrphanedParks();
        }, 100);
      }
      return;
    }
    for (const run of parked) await tasks.settle(run.runId, null);
  }

  /**
   * What a tab is sent as the message list: `messages` (the stored
   * transcript), then the messages waiting requests hold, in admission
   * order, named in `queuedMessageIds`. A tab draws those after the
   * transcript and after a reply that is streaming. Without waiting
   * requests it is `messages` alone.
   */
  clientView<TMessage extends { id: string }>(
    messages: ReadonlyArray<TMessage>
  ): { messages: TMessage[]; queuedMessageIds?: string[] } {
    const waiting =
      this.admissions?.waitingMessages(new Set(messages.map((m) => m.id))) ??
      [];
    if (waiting.length === 0) return { messages: [...messages] };
    this.#queuedViews++;
    return {
      messages: [...messages, ...(waiting as unknown as TMessage[])],
      queuedMessageIds: waiting.map((message) => message.id)
    };
  }

  /**
   * {@link clientView} for a tab that has just connected while a reply
   * streams: without the reply. The tab gets the reply from the stream it
   * resumes, and a copy in its list would be continued by that replay, so
   * the reply would be drawn with its first chunks twice.
   */
  connectView<TMessage extends { id: string }>(
    messages: ReadonlyArray<TMessage>
  ): { messages: TMessage[]; queuedMessageIds?: string[] } {
    const streaming = this.host.streamingReply()?.id;
    const view = this.clientView(messages);
    if (streaming === undefined) return view;
    return {
      ...view,
      messages: view.messages.filter((message) => message.id !== streaming)
    };
  }

  /**
   * The ids of the messages waiting requests hold that have not joined the
   * transcript. A client's copy of the transcript can include them (a tab
   * draws them): they are not new messages of the request it sends.
   */
  queuedMessageIds(): Set<string> {
    const stored = new Set(this.host.messages().map((m) => m.id));
    return new Set(
      (this.admissions?.waitingMessages(stored) ?? []).map((m) => m.id)
    );
  }

  #queuedViews = 0;

  /**
   * How many message lists {@link clientView} has built that named queued
   * messages. A host compares it across a request's wait: when it moved,
   * the tab that sent the request may have been shown its message as
   * queued, and must be told when it joins.
   */
  get queuedViews(): number {
    return this.#queuedViews;
  }

  /** The latest user message a tab shows: stored, or held by a request. */
  #latestUserId(): string | null {
    const messages = this.host.messages();
    const stored = new Set(messages.map((m) => m.id));
    const waiting = this.admissions?.waitingMessages(stored) ?? [];
    for (const list of [waiting, messages]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "user") return list[i].id;
      }
    }
    return null;
  }

  /**
   * Whether a request replayed after a reset has nothing left to answer: a
   * user message follows the one the request was accepted after, and no
   * waiting request holds it. That message was answered after the reset by
   * a release without durable admission (a rollback), and the conversation
   * has moved on. When the message it was accepted after is gone, it runs.
   */
  #replayMovedOn(record: ChatAdmissionRecord): boolean {
    if (record.afterUserId === null) return false;
    const messages = this.host.messages();
    const at = messages.findIndex((m) => m.id === record.afterUserId);
    if (at < 0) return false;
    const own = new Set(record.messageIds);
    const held = new Set(
      (this.admissions?.waitingMessages(new Set()) ?? []).map((m) => m.id)
    );
    return messages
      .slice(at + 1)
      .some((m) => m.role === "user" && !own.has(m.id) && !held.has(m.id));
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
      (outcome) => {
        if (!autoContinue) {
          this.rearmContinuation();
          return;
        }
        if (outcome.status !== "changed") return;
        this.#scheduleContinuation({
          ...spec(),
          targetMessageId: outcome.messageId
        });
        this.#admitContinuation();
      },
      enqueue,
      connectionId === undefined ? connectionOf(spec) : connectionId
    );
  }

  /**
   * The continuation a client's answer scheduled is kept as an admission
   * record until its turn has a fiber, like a client request: it waits in
   * memory (the coalesce timer, a sibling's answer) and a reset there would
   * lose it, leaving the answered call that nothing continues (P1). After a
   * reset the record schedules it again ({@link #resumeContinuation}).
   */
  #admitContinuation(): void {
    const pending = this.continuation.pending;
    if (!this.admissions || !pending) return;
    void this.admissions
      .admitContinuation(pending.requestId, [...pending.targetMessageIds])
      .catch((error: unknown) =>
        console.error("[chat] a continuation record was not kept:", error)
      );
  }

  /**
   * Schedule again the continuation an earlier isolate kept a record of,
   * under its request id (so its turn's fiber releases the record), while
   * one of the messages it answers is still the latest. No tab waits on it.
   */
  #resumeContinuation(
    requestId: string,
    targetMessageIds: string[],
    onQueued: () => void
  ): void {
    const target = { targetMessageIds };
    if (
      this.continuation.pending ||
      this.continuation.running ||
      !continuationTargetIsLatest(this.host.messages(), target)
    ) {
      this.admissions?.end(requestId);
      onQueued();
      return;
    }
    this.continuation.pending = {
      // SAFETY: only `id` and `send` are used, and nothing is sent to it.
      connection: DETACHED_CONNECTION as unknown as TConnection,
      connectionId: null,
      requestId,
      errorPrefix: null,
      prerequisite: null,
      targetMessageIds
    };
    // Queued at once, in replay order: a request that woke the agent must
    // not run, and store its question, before the answer's continuation.
    // The replay waits until its turn is on the queue (a host may await
    // before it enqueues), or until it will not run now.
    this.#replayWaiting.set(requestId, onQueued);
    this.fireContinuationWhenStable();
    // Not fired now (a tool batch still waits on a sibling, say): nothing
    // will queue it before a request may.
    if (
      ![...this.#continuationParts.firing].some(
        (firing) => firing.requestId === requestId
      )
    ) {
      this.#continuationQueued(requestId);
    }
  }

  /** Replays waiting for a restored continuation's turn to be queued. */
  readonly #replayWaiting = new Map<string, () => void>();

  #continuationQueued(requestId: string): void {
    const waiting = this.#replayWaiting.get(requestId);
    if (!waiting) return;
    this.#replayWaiting.delete(requestId);
    waiting();
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

  // ── The continuation barrier ───────────────────────────────────────

  /**
   * Schedule a continuation for a result that settled its call and opted in
   * with `autoContinue` (#1650). Results that arrive close together share
   * one continuation through the coalesce timer, and it fires through the
   * barrier ({@link fireContinuationWhenStable}). One that arrives while a
   * continuation runs is the next continuation: its turn waits behind the
   * running one in the lane.
   */
  #scheduleContinuation(spec: ContinuationSpec<TConnection>): void {
    const c = this.continuation;
    if (c.pending) {
      c.pending.connection = spec.connection;
      c.pending.connectionId = spec.connection.id;
      c.pending.errorPrefix = spec.errorPrefix;
      // A later result for an older reply must not drop a newer one's target.
      c.pending.targetMessageIds = addContinuationTarget(
        c.pending.targetMessageIds,
        spec.targetMessageId
      );
    } else {
      c.pending = {
        connection: spec.connection,
        connectionId: spec.connection.id,
        requestId: this.host.generateRequestId(),
        errorPrefix: spec.errorPrefix,
        prerequisite: null,
        targetMessageIds: [spec.targetMessageId]
      };
    }
    c.awaitPending();
    this.armCoalesce();
  }

  /**
   * @internal Re-run the barrier for a pending continuation that has not
   * fired: a result without `autoContinue` may complete a batch a sibling
   * opted in for, and a finalized reply lifts the stream gate (#1650).
   * Never creates a continuation.
   */
  rearmContinuation(): void {
    if (!this.continuation.pending) return;
    this.armCoalesce();
  }

  /** @internal (Re)arm the coalesce timer. */
  armCoalesce(): void {
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      if (this.continuation.pending) this.fireContinuationWhenStable();
    }, CONTINUATION_COALESCE_MS);
  }

  /** @internal Cancel the coalesce timer, if armed. */
  cancelCoalesce(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }

  /**
   * @internal Fire the pending continuation, but only once the model's
   * parallel tool batch is answered (#1649) and no reply streams (#1650).
   * With the batch incomplete it drains the applies in flight and checks
   * again; still incomplete, it returns without firing and without holding
   * the isolate, leaving the continuation pending for the next sibling's
   * result to re-arm. A sibling that never arrives never continues: a later
   * turn repairs the transcript.
   */
  fireContinuationWhenStable(): void {
    const pending = this.continuation.pending;
    if (!pending || this.barrierActive) return;
    // A continuation runs and has not streamed: the model may still add
    // tool calls to the reply this one answers. Its stream's finalize, or
    // its settle without a stream, re-arms.
    if (this.continuation.running) return;
    // While the reply streams the batch can still grow. The finalize
    // re-arms ({@link replyFinalized}).
    if (this.host.isReplyStreaming()) return;
    if (
      this.pendingInteraction === null &&
      !hasIncompleteToolBatch(this.host.messages())
    ) {
      this.cancelCoalesce();
      this.host.fireContinuation();
      return;
    }
    this.barrierActive = true;
    // Kept alive only for the applies that already arrived.
    this.host
      .keepAliveWhile(() => this.drainInteractions())
      .catch(() => {})
      .finally(() => {
        // No await from here to the decision, so a re-armed timer cannot
        // interleave and fire twice.
        this.barrierActive = false;
        if (!this.continuation.pending) return;
        // A continuation claimed its turn during the drain: hold for it.
        if (this.continuation.running) return;
        if (this.host.isReplyStreaming()) return;
        if (hasIncompleteToolBatch(this.host.messages())) return;
        this.cancelCoalesce();
        this.host.fireContinuation();
      });
  }

  /**
   * @internal Whether the barrier will fire by itself: its timer is armed
   * or its drain runs.
   */
  continuationArmed(): boolean {
    return this.coalesceTimer !== null || this.barrierActive;
  }

  /** @internal Tear down the timer and the drain flag. */
  resetContinuationBarrier(): void {
    this.cancelCoalesce();
    this.barrierActive = false;
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

  /**
   * The stall watchdog fired on `requestId`'s reply: abort its turn as the
   * runtime, not as a stop. Recovery continues the turn, so nothing waiting
   * on it is dropped. The isolate is held until the stop's bookkeeping ends.
   */
  stallAbort(requestId: string): void {
    // Cancelled now, inside the runtime's abort: a cancel the hold ran
    // later would read as a user's stop.
    const reason = new ChatStreamStalledError(
      "chat stream stalled: inactivity watchdog fired"
    );
    this.runtimeAbort(() => {
      if (this.host.abortRequest) {
        this.host.abortRequest(requestId, reason);
        return;
      }
      const settled = this.cancel(requestId, reason);
      void this.host.keepAliveWhile(() => settled);
    }, reason);
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
    return continuationWaitsOnClient(messages, this.clientToolNames());
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
      clientToolNames: this.clientToolNames()
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
    repairPart: RepairInterruptedToolPartsOptions["repairPart"],
    /**
     * The client tools of the turn whose reply this is, when they are not
     * the stored ones (a turn that runs with pinned tools: a recovered
     * turn, an agent-tool run). Defaults to the host's.
     */
    clientToolNames: ReadonlySet<string> = this.clientToolNames()
  ): TMessage {
    return settleInterruptedReply(message, { repairPart, clientToolNames });
  }

  /**
   * Settle and store the reply a recovery attempt is about to continue. See
   * {@link settleReplyBeforeRecovery}.
   */
  async settleBeforeRecovery(
    messages: () => ReadonlyArray<UIMessage>,
    continueReplyId: string,
    repairPart: RepairInterruptedToolPartsOptions["repairPart"],
    sink: RepairedTranscriptSink,
    removal?: ReplyRemoval
  ): Promise<"removed" | undefined> {
    // On the apply chain, with the transcript read there: the settle writes
    // the whole reply, and a client's tool result applied between its read
    // and its write would be written over (or the dead call put back).
    let settled: "removed" | undefined;
    await this.enqueueInteraction(async () => {
      settled = await settleReplyBeforeRecovery(
        messages(),
        continueReplyId,
        { repairPart, clientToolNames: this.clientToolNames() },
        sink,
        removal
      );
      return true;
    });
    return settled;
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
    // Inside the runtime's abort, a cancel with another reason (a user's
    // stop that a subclass's `abortRequest` issues) is still a stop.
    const runtime = this.#isRuntimeReason(reason);
    // The continuation waiting under this id has no turn until it fires:
    // the stop drops it.
    if (!runtime) dropPendingContinuation(this.#continuationParts, requestId);
    this.#noteStopped(this.aborts.get(requestId)?.signal, runtime);
    this.#stop(
      () => {
        this.aborts.get(requestId)?.abort(reason);
        this.#recoveryAttempts.get(requestId)?.abort(reason);
      },
      requestId,
      runtime
    );
    if (runtime) return this.#afterStop(requestId, reason, runtime);
    // Started first, so the run has ended by the time the stop's terminal
    // frame goes out; the host still hears of the stop at once.
    const ended = this.#endKeptBackoffs(requestId);
    const stopped = this.#afterStop(requestId, reason, runtime);
    return Promise.all([ended, stopped]).then(() => {});
  }

  /**
   * The lane runs of this isolate that wait out a kept attempt's backoff,
   * by run id, with their request. Set as the wait starts, which is before
   * Tasks records the run as sleeping, and removed when the run wakes (its
   * replay says the wait is over) or a stop ends it.
   */
  readonly #backingOff = new Map<string, string>();

  /**
   * The requests a user's stop named in this isolate, newest last. A stop
   * can land after a cut-off turn's result and before its run starts the
   * backoff: the run finds it here as it starts to wait. Bounded: an id
   * matters only until its turn's run has ended.
   */
  readonly #stoppedRequests = new Set<string>();

  /** See `ChatTurnTaskHooks.backingOff`. */
  backingOff(runId: string, requestId: string, waiting: boolean): void {
    if (!waiting) {
      this.#backingOff.delete(runId);
      return;
    }
    if (!this.#stoppedRequests.has(requestId)) {
      this.#backingOff.set(runId, requestId);
      return;
    }
    // The stop came first: the run ends as it starts to wait.
    void this.#lane
      .tasks()
      .cancel(runId, "chat recovery stopped")
      .catch((error) =>
        console.error("[chat] failed to end a stopped recovery's run:", error)
      );
  }

  /**
   * End the lane runs that wait out the backoff of the recovery attempt
   * they kept for `requestId`: the stop has settled its incident, and what
   * is queued behind must not wait for its wake. A clear leaves them: their
   * attempt wakes, finds the conversation changed and settles its incident.
   */
  async #endKeptBackoffs(requestId: string): Promise<void> {
    this.#stoppedRequests.delete(requestId);
    this.#stoppedRequests.add(requestId);
    if (this.#stoppedRequests.size > 64) {
      const [oldest] = this.#stoppedRequests;
      this.#stoppedRequests.delete(oldest);
    }
    try {
      const tasks = this.#lane.tasks();
      const waiting = tasks
        .peekList({
          definition: this.#lane.definition,
          lane: CHAT_TURN_LANE,
          status: ["pending"],
          parked: false,
          results: false
        })
        .filter(
          (run) =>
            run.metadata?.requestId === requestId &&
            // A lane run sleeps only in its kept attempt's backoff.
            run.waitReason === "sleep"
        );
      // A run that has started its backoff and is not recorded as sleeping
      // yet (it is suspending) is known from `backingOff`.
      const runIds = new Set(waiting.map((run) => run.runId));
      for (const [runId, id] of this.#backingOff) {
        if (id === requestId) runIds.add(runId);
      }
      for (const runId of runIds) {
        this.#backingOff.delete(runId);
        await tasks.cancel(runId, "chat recovery stopped");
      }
    } catch (error) {
      console.error("[chat] failed to end a stopped recovery's run:", error);
    }
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

  #noteStopped(signal: AbortSignal | undefined, runtime: boolean): void {
    if (signal && !runtime) this.#stoppedSignals.add(signal);
  }

  /**
   * Tell the host about a stop ({@link ChatTurnsHost.stopped}).
   *
   * @returns A promise that settles when the host's work is done. It never
   *   rejects: a stop that could not finish its bookkeeping still stopped
   *   the turn.
   */
  async #afterStop(
    requestId: string | null,
    reason: unknown,
    runtime: boolean
  ): Promise<void> {
    if (runtime) return;
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
    const runtime = this.#isRuntimeReason(reason);
    for (const { signal } of this.aborts.values()) {
      this.#noteStopped(signal, runtime);
    }
    this.#stop(
      () => {
        this.#abortAll(reason);
        for (const attempt of this.#recoveryAttempts.values()) {
          attempt.abort(reason);
        }
      },
      null,
      runtime
    );
    return this.#afterStop(null, reason, runtime);
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
    const { pending, running, activeRequestId, activeConnectionId } =
      this.continuation;
    // The reply this tab was just told to resume: its stop is for that
    // reply, also when the tab already waits on the next continuation.
    if (activeRequestId !== null && activeConnectionId === connectionId) {
      void this.cancel(activeRequestId, reason);
      return;
    }
    const waits = this.continuation.awaitingConnections.has(connectionId);
    if (running && waits) {
      void this.cancel(running.requestId, reason);
      return;
    }
    if (pending && waits) {
      // Fired and queued, or not fired yet: its turn finds nothing to claim.
      this.#dropWaiting(null);
      return;
    }
    // This tab's result, whose frame arrived before the stop and is still
    // applying. Another tab's apply is left alone.
    for (const entry of this.#applying) {
      if (entry.connectionId === connectionId) entry.stopped = true;
    }
  }

  /**
   * Link an external `AbortSignal` to the request `requestId`: when the
   * signal fires it stops the request through {@link cancel}. A caller that stops a
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
        this.runtimeAbort(
          () => void this.cancel(requestId, signal.reason),
          signal.reason
        );
      } else {
        void this.cancel(requestId, signal.reason);
      }
    };
    if (signal.aborted) {
      // The controller has to exist for the stop to land on it.
      turnSignal(this.aborts, requestId);
      stop();
      return () => {};
    }
    const listener = stop;
    signal.addEventListener("abort", listener, { once: true });
    return () => signal.removeEventListener("abort", listener);
  }

  /** Abort every request's controller, and forget them. */
  #abortAll(reason?: unknown): void {
    for (const controller of this.aborts.values()) controller.abort(reason);
    this.aborts.clear();
  }

  /**
   * Whether `reason` is that of a runtime abort running now: the same
   * object, or one of its class (an `abortRequest` override may pass on a
   * copy of the watchdog's error).
   */
  #isRuntimeReason(reason: unknown): boolean {
    return this.#runtimeReasons.some(
      (own) =>
        own === reason ||
        (own instanceof Error &&
          reason instanceof Error &&
          reason.constructor === own.constructor)
    );
  }

  /**
   * Run an abort that is the runtime's own and not a stop: `abort` may call
   * {@link cancel} (through the host's `abortRequest`, so a subclass that
   * observes aborts still sees it) and nothing waiting is dropped. The stall
   * watchdog uses it: recovery continues the turn it aborts.
   *
   * @param reason - The runtime's reason. Only a cancel with this reason is
   *   the runtime's: one with another reason that `abort` leads to (a
   *   subclass's `abortRequest` that stops the request for its user) is a
   *   stop.
   */
  runtimeAbort(abort: () => void, reason?: unknown): void {
    this.#runtimeReasons.push(reason);
    try {
      abort();
    } finally {
      this.#runtimeReasons.pop();
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
  #stop(abort: () => void, requestId: string | null, runtime: boolean): void {
    const active = this.queue.activeRequestId;
    const activeSignal =
      active === null ? undefined : this.aborts.get(active)?.signal;
    const wasAborted = activeSignal?.aborted ?? false;

    abort();

    if (runtime) return;
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
    // A dropped continuation's record goes with it (`released`): a reset
    // must not run what a stop dropped.
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
    const inLane = inLaneRecoveryAttempt();
    return {
      signal: controller.signal,
      continuationWaiting: () => inLane && this.#continuationFired(),
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

  /** Whether a continuation fired and its turn has not started. */
  #continuationFired(): boolean {
    return this.#continuationParts.firing.size > 0;
  }

  /**
   * Tear down turn state for a chat reset (clear): invalidate queued turns,
   * abort every request, drop the apply chain and the continuation slots and
   * barrier, and release every waiting connection. Synchronous, so no event
   * interleaves with a half-reset chat. Stored messages and streams are the
   * host's to clear.
   */
  reset(): void {
    // A late tool result must not land on the reply of a cleared chat.
    this.liveReply = null;
    this.admissions?.clear();
    this.queue.reset();
    this.#lastReply = null;
    this.#abortAll();
    this.pendingInteraction = null;
    // New interactions must not serialize behind a stale, possibly hung,
    // apply from the turn being reset (#1649).
    this.interactionTail = Promise.resolve();
    this.resetContinuationBarrier();
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
      clientToolNames: this.clientToolNames(),
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
    if (this.pendingInteraction !== null) return true;
    const pending = this.continuation.pending;
    return (
      (pending !== null && this.continuationArmed()) ||
      this.#continuationParts.firing.size > 0
    );
  }

  /**
   * Resolve once no turn is queued, running or taking its place, and no
   * continuation is about to fire.
   */
  async waitForIdle(): Promise<void> {
    for (;;) {
      await this.queue.waitForIdle();
      if (!this.hasPendingDecision()) return;
      await sleep(CONTINUATION_COALESCE_MS);
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

    // A lane run's recovery attempt holds the lane: a continuation a
    // client's answer fires waits behind it, so the queue is never idle
    // before the attempt ends. That continuation settles the chat instead.
    const inLane = inLaneRecoveryAttempt();
    for (;;) {
      // Turns queued behind a lane run's recovery attempt cannot run before
      // it ends, so it does not wait for them; its own run in place.
      if (
        !inLane &&
        (await awaitWithDeadline(this.queue.waitForIdle(), deadline)) ===
          TIMED_OUT
      ) {
        return false;
      }
      if (inLane && this.#continuationFired()) return true;

      if (!hasPendingInteraction()) {
        if (!this.hasPendingDecision()) return true;
        // A continuation is armed (#1650): wait for it to fire (the turn it
        // enqueues drains at the loop top) or to park.
        if (
          (await awaitWithDeadline(
            sleep(CONTINUATION_COALESCE_MS),
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

let lastAdmissionOrder = 0;
/** An admission order: increasing in this isolate, and after earlier ones. */
function admissionOrder(): number {
  lastAdmissionOrder = Math.max(lastAdmissionOrder + 1, Date.now() * 1000);
  return lastAdmissionOrder;
}

/** The trigger of a continuation's admission record (P1). */
const CONTINUATION_TRIGGER = "continuation";

/** A continuation's admission record's payload, or `undefined`. */
function continuationRecord(
  record: ChatAdmissionRecord
): { targetMessageIds: string[] } | undefined {
  const payload = record.payload as
    | { trigger?: unknown; targetMessageIds?: unknown }
    | undefined;
  if (
    payload?.trigger !== CONTINUATION_TRIGGER ||
    !Array.isArray(payload.targetMessageIds)
  ) {
    return undefined;
  }
  return {
    targetMessageIds: payload.targetMessageIds.filter(
      (id): id is string => typeof id === "string"
    )
  };
}

/**
 * The connection a continuation resumed after a reset answers to: no tab
 * waits on it, so what it would tell one goes nowhere.
 */
const DETACHED_CONNECTION = { id: "", send: () => {} };

/**
 * The arrival policy of a client request's lane run under the strategy it
 * arrived with (`latest` for `merge` too: the host merges the messages).
 */
function arrivalPolicy(
  strategy: NormalizedMessageConcurrency | null
): TaskRunOptions["policy"] {
  if (strategy === null || strategy === "queue") return undefined;
  if (strategy === "drop") return "drop";
  // A debounce with no quiet period still supersedes what waits.
  if (strategy === "latest" || strategy === "merge" || !strategy.debounceMs) {
    return "latest";
  }
  return { debounceMs: strategy.debounceMs };
}
