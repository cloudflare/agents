import { AsyncLocalStorage } from "node:async_hooks";
import type {
  UIMessage,
  GenerateTextOnFinishCallback,
  TextUIPart,
  ToolSet,
  UIMessageChunk
} from "ai";
import {
  Agent,
  isPlatformTransientError,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
  __DO_NOT_USE_WILL_BREAK__withInvocationScope as withInvocationScope,
  type AgentToolEventDelivery,
  type AgentToolLifecycleResult,
  type AgentToolMilestone,
  type AgentToolProgress,
  type AgentToolRunInfo,
  type AgentToolRunInspection,
  type AgentToolStoredChunk,
  type AgentContext,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type WSMessage
} from "agents";

import { MessageType, type OutgoingMessage } from "./types";
import { autoTransformMessages } from "./ai-chat-v5-migration";
import {
  keepStoredReplies,
  reconcileMessages,
  reconcileOrphanPartial,
  ChatRequestContext,
  interruptedToolPartAsError,
  type RepairedTranscriptSink,
  streamChunksFinished,
  persistReconstructedOrphan,
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  type OrphanPersistStore
} from "agents/chat";
import {
  applyChunkToParts,
  applyLateToolInput,
  lateToolInputForwardChunks,
  aiSdkRecoveryCodec,
  ResumeHandshake,
  isReplayChunk,
  parseProtocolMessage,
  sendIfOpen,
  ChatTurns,
  AgentToolRuns,
  createAgentToolRunStore,
  createChatAdmissionStore,
  chatRecoveryNames,
  type ChatAdmissionRecord,
  type ClientChatRequest,
  ChatTurnFibers,
  pinnedOr,
  prepareTurnMessages,
  toSaveMessagesResult,
  type TurnFailureHost,
  type ToolInteractionOutcome,
  toolApprovalUpdate,
  type TurnResult,
  type MessagePart,
  type StreamChunkData,
  type ServerChatTurn,
  type SubmitConcurrencyDecision,
  type ChatFiberSnapshot,
  type ChatTurnOutcome
} from "agents/chat";
import { ResumableStream, createChatStreams } from "agents/chat";
import type { Streams } from "agents/streams";
import { Sessions, type Session, type SessionMessage } from "agents/sessions";
import {
  CHAT_RECOVERY_TASK_NAME,
  chatRecoveryProgressReader,
  chatRecoveryStorageAdapter,
  createChatRecoveryTaskDefinition,
  createChatTurnTaskDefinition,
  enqueueChatRecoveryTask,
  type ChatRecoveryTaskReason,
  type StreamInterruptionOutcome
} from "agents/chat";
import {
  chunkMustBeStoredNow,
  replyIsEmpty,
  settleInterruptedPart,
  stripTrailingReasoning,
  type ClientToolSchema,
  type PinnedTurnContext,
  type RecoveryLeafCheck,
  type ReplyRemoval
} from "agents/chat";
import {
  resolveChatRecoveryConfig,
  ChatRecoveryEngine,
  runChatRecoveryExhaustion,
  ChatStreamStalledError,
  isTurnStopped,
  iterateWithStallWatchdog,
  CHAT_RECOVERY_PROGRESS_KEY,
  recordChatTerminal,
  clearChatTerminal,
  pendingChatTerminal,
  originMessageIds,
  withOriginMessageIds,
  buildChatRecoveringFrame,
  setChatRecovering,
  AgentToolStreamProgressThrottle,
  isDurableObjectResetError,
  type ChatRecoveryAdapter,
  type ChatFiberWakeHooks,
  type ResolvedRecoveryStream,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryAttemptScope,
  type ChatRecoveryIncident,
  type ChatRecoveryKind
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";
import { nanoid } from "nanoid";

// Re-export lifecycle types from the shared chat toolkit so existing
// consumers (`import type { ChatResponseResult } from "@cloudflare/ai-chat"`)
// continue to work.
export type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult,
  SkippedTurnReason
} from "agents/chat";

type AgentSpanAttributes = Readonly<
  Record<string, string | number | boolean | undefined>
>;

type UpdateAgentSpan = (attributes: AgentSpanAttributes) => void;

type AgentSpanHost = {
  _withAgentSpan<T>(
    operation: string,
    storagePhase: string,
    attributes: AgentSpanAttributes,
    run: (update: UpdateAgentSpan) => T | Promise<T>
  ): T | Promise<T>;
};

function withAgentSpan<T>(
  host: object,
  operation: string,
  storagePhase: string,
  attributes: AgentSpanAttributes,
  run: (update: UpdateAgentSpan) => Promise<T>
): Promise<T>;
function withAgentSpan<T>(
  host: object,
  operation: string,
  storagePhase: string,
  attributes: AgentSpanAttributes,
  run: (update: UpdateAgentSpan) => T
): T;
function withAgentSpan<T>(
  host: object,
  operation: string,
  storagePhase: string,
  attributes: AgentSpanAttributes,
  run: (update: UpdateAgentSpan) => T | Promise<T>
): T | Promise<T> {
  return (host as AgentSpanHost)._withAgentSpan(
    operation,
    storagePhase,
    attributes,
    run
  );
}

type ChatRecoveryRetryData = {
  targetUserId?: string;
  originalRequestId?: string;
  originMessageIds?: string[];
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
};

type ChatRecoveryContinueData = {
  targetAssistantId?: string;
  originalRequestId?: string;
  originMessageIds?: string[];
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
};

/**
 * `AIChatAgent`'s `classifyRecoveredTurn` detail (the {@link ChatFiberWakeHooks}
 * generic). `shouldRetryPreStream` is the only classification bit the dispatch
 * decision needs that it cannot cheaply recompute post-persist; the lost-partial
 * branch is re-derived in `_dispatchRecoveredChatTurn` from the (now-updated) leaf.
 */
type AIChatRecoveryClassification = { shouldRetryPreStream: boolean };

// `ChatRecoveryIncident` / `ChatRecoveryKind` / `CHAT_RECOVERY_INCIDENT_KEY_PREFIX`
// are the canonical shared symbols from `agents/chat` (imported above); the
// persisted incident shape and key prefix are owned by the engine package so
// both consumers round-trip the same record across the deploy that ships them.

// The monotonic forward-progress marker the recovery budget keys off is
// derived from the stream log (`ResumableStream.progressMarker`): durably
// flushed segments, folded into a retired total as their rows are deleted.
// Nothing is written per chunk. The pre-derivation KV counter
// (`CHAT_RECOVERY_PROGRESS_KEY`) is read once per isolate and seeded into the
// marker, so it is never read lower than an in-flight incident recorded.
// Recovery budget defaults (maxAttempts, maxRecoveryWork, stableTimeoutMs,
// terminalMessage, noProgressTimeoutMs, alarm debounce) now live in the shared
// incident engine (agents/chat) and are applied by `resolveChatRecoveryConfig`
// / `evaluateChatRecoveryIncident`. See design/rfc-chat-recovery-foundation.md.
// Auto-continuation barrier (#1649/#1650): when the model emits parallel tool
// calls, the client answers each one independently and sends a tool result with
// `autoContinue` per result. A fast tool's result must NOT trigger inference
// while a slower sibling is still `input-available` — that feeds the provider
// an incomplete tool-result set. The barrier is event-driven (converged onto
// `@cloudflare/think`'s model): we only fire the continuation once the leaf
// step's batch is fully answered, re-arming on each applied result and on stream
// finalize, with NO orphan timeout — an incomplete batch simply never
// auto-continues until it completes (a later user turn / chat recovery repairs
// the transcript). See design/rfc-chat-recovery-foundation.md.
// (Stable-state retry delay `CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS` now lives
// in agents/chat; the reschedule that consumes it is owned by the shared engine.
// The recovering-flag key/TTL and the terminal-record key now live in agents/chat
// too — the durable recovery UX is driven via the shared `setChatRecovering` /
// `buildChatRecoveringFrame` / `recordChatTerminal` helpers — and the incident
// sweep via the shared `sweepStaleChatRecoveryIncidents` helper.)
// (N9 throttle now lives in the shared engine as `AgentToolStreamProgressThrottle`
// / `AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS`; the stream-cleanup delay and
// The `sendIfOpen` / `isWebSocketClosedSendError` WS send
// guard is shared via agents/chat.)

/**
 * What framework code can pass to the turn behind `saveMessages` on top of
 * the public options. `saveMessages` hands its options object through as it
 * got it, so these reach the turn through a subclass's override too.
 */
type ProgrammaticTurnOptions = SaveMessagesOptions & {
  shouldApplyMessages?: () => boolean | Promise<boolean>;
  body?: Record<string, unknown> | null;
  clientTools?: ClientToolSchema[] | null;
};

type StreamResultStatus = {
  status: Exclude<SaveMessagesResult["status"], "skipped">;
  error?: string;
  /** `"interrupted"` for a reply cut off and handed to recovery. */
  reason?: SaveMessagesResult["reason"];
};

export type ChatMessage = UIMessage;

/**
 * Provider-executed tool fields that contain opaque replay tokens and must be
 * persisted exactly as returned by the provider.
 */
const PROVIDER_TOOL_OPAQUE_STRING_KEY_PREFIX = "encrypted";

/**
 * Max string length preserved in `input`/`output` of provider-executed tool
 * parts (e.g. Anthropic code_execution / text_editor). Strings exceeding this
 * limit are truncated with a marker so persisted messages stay small.
 */
const PROVIDER_TOOL_MAX_STRING_LENGTH = 500;

/**
 * Whether a response-reader error is a platform transient that bounded chat
 * recovery can retry. A deploy or storage reset is excluded: the isolate is
 * going away, and the restart's own recovery owns the turn.
 */
function isRecoverableStreamReadError(error: unknown): boolean {
  return isPlatformTransientError(error) && !isDurableObjectResetError(error);
}

/** A live stream interruption (stall or transient error) to route to recovery. */
type StreamInterruptionRoute = {
  requestId: string;
  streamId: string;
  partialParts: MessagePart[];
  targetAssistantId?: string;
  continuation: boolean;
  /** Delay the recovery with exponential backoff (transient errors). */
  backoff?: boolean;
  /** The error that interrupted the stream. */
  error: unknown;
  /** Skip persisting the partial (`onChatRecovery` returned `persist: false`). */
  discardPartial: () => Promise<void>;
};

/**
 * Validates that a parsed message has the minimum required structure.
 * Returns false for messages that would cause runtime errors downstream
 * (e.g. in convertToModelMessages or the UI layer).
 *
 * Checks:
 * - `id` is a non-empty string
 * - `role` is one of the valid roles
 * - `parts` is an array (may be empty — the AI SDK enforces nonempty
 *   on incoming messages, but we are lenient on persisted data)
 */
function isValidMessageStructure(msg: unknown): msg is UIMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;

  if (typeof m.id !== "string" || m.id.length === 0) return false;

  if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
    return false;
  }

  if (!Array.isArray(m.parts)) return false;

  return true;
}

/**
 * Schema for a client-defined tool sent from the browser.
 * These tools are executed on the client, not the server.
 *
 * **For most apps**, define tools on the server with `tool()` from `"ai"` —
 * you get schema-derived type safety, server-side execution, and simpler code.
 * Use `onToolCall` in `useAgentChat` for tools that need client-side execution.
 *
 * **For SDKs and platforms** where the tool surface is determined dynamically
 * by the embedding application at runtime, client tool schemas let the
 * client register tools the server does not know about at deploy time.
 *
 * Note: Uses `parameters` (JSONSchema7) rather than AI SDK's `inputSchema`
 * because this is the wire format. Runtime validation schemas cannot be
 * serialized.
 */
export type { ClientToolSchema } from "agents/chat";

type ChatRequestTrigger = "submit-message" | "regenerate-message";
/**
 * Options passed to the onChatMessage handler.
 */
export type OnChatMessageOptions = {
  /**
   * Unique ID for this chat message exchange.
   *
   * For initial user messages this is the client-generated ID from the
   * `CF_AGENT_USE_CHAT_REQUEST` WebSocket frame. For tool continuations
   * (auto-continue after client tool results or approvals) this is a
   * server-generated ID.
   */
  requestId: string;
  /** AbortSignal for cancelling the request */
  abortSignal?: AbortSignal;
  /**
   * Tool schemas sent from the client for dynamic tool registration.
   * These represent tools that will be executed on the client side.
   * Use `createToolsFromClientSchemas()` to convert these to AI SDK tool format.
   *
   * **For most apps**, you do not need this — define tools on the server with
   * `tool()` from `"ai"` and use `onToolCall` for client-side execution.
   *
   * **For SDKs and platforms** where tools are defined dynamically by the
   * client at runtime and the server does not know the tool surface ahead
   * of time, this field carries the client-provided tool schemas.
   */
  clientTools?: ClientToolSchema[];
  /**
   * Custom body data sent from the client via `prepareSendMessagesRequest`
   * or the AI SDK's `body` option in `sendMessage`.
   *
   * Contains all fields from the request body except `messages` and `clientTools`,
   * which are handled separately.
   *
   * During tool continuations (auto-continue after client tool results), this
   * contains the body from the most recent chat request. The value is persisted
   * to SQLite so it survives Durable Object hibernation. It is cleared when the
   * chat is cleared via `CF_AGENT_CHAT_CLEAR`.
   */
  body?: Record<string, unknown>;
  /**
   * Whether this turn is a continuation of a previous assistant message
   * (auto-continue after tool result, `continueLastTurn`, or recovery).
   *
   * Use this to adjust system prompts, select different models, skip
   * expensive context assembly, or log differently for continuations.
   */
  continuation?: boolean;
};

export { createToolsFromClientSchemas } from "agents/chat";

const decoder = new TextDecoder();

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
/** Bounds for one window of the legacy lift: rows and their summed bytes. */
const LEGACY_LIFT_WINDOW_ROWS = 25;
const LEGACY_LIFT_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * What `AIChatAgent` stores with a client request's admission record, to run
 * it again after an isolate reset. See `ChatTurns.resumeAdmissions`.
 */
type StoredClientChatRequest = {
  trigger: ChatRequestTrigger;
  clientTools: ClientToolSchema[] | undefined;
  body: Record<string, unknown>;
  originMessageIds: string[] | undefined;
  /** A regenerate: the messages the client sent. */
  keepIds?: string[];
  /** A regenerate: the stored user messages it did not send. */
  storedUserIds?: string[];
};

export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends object = object
> extends Agent<Env, State, Props> {
  /** The engine keeps the root request id of the recovery work now running. */
  private get _activeChatRecoveryRootRequestId(): string | undefined {
    return this._chatRecoveryEngine().activeRootRequestId;
  }
  /**
   * Set around the persist of a client request's incoming messages. Holds
   * the request's `isCurrent` check, which `persistMessages` reads right
   * before it writes: `false` once the chat was reset since the request was
   * accepted. An async scope, so an app's `persistMessages` override need
   * not pass anything along, and no other persist is affected.
   */
  private _incomingPersistScope = new AsyncLocalStorage<{
    isCurrent: () => boolean;
  }>();

  /**
   * The originating user message ids of the active recovery chain (#2280),
   * carried in the recovery payload because the successor turn runs under a
   * fresh request id. Scoped to the recovery callback's async context, so a
   * concurrent client request never inherits them.
   */
  private _chatRecoveryOriginIdsScope = new AsyncLocalStorage<
    string[] | undefined
  >();

  private get _activeChatRecoveryOriginIds(): string[] | undefined {
    return this._chatRecoveryOriginIdsScope.getStore();
  }

  /**
   * The turn core shared with `@cloudflare/think`: the turn queue, abort
   * registry, submit concurrency, continuation slots and barrier, pre-stream
   * set and tool-result apply chain, with the rules that tie them together.
   * The fields below that alias its parts are the same objects.
   */
  private readonly _turns = new ChatTurns<Connection>(
    {
      messages: () => this.messages,
      isReplyStreaming: () => this._streamingTurnActive,
      streamingReply: () => this._replyInFlight(),
      clientToolNames: () => this._requestContext.clientToolNames(),
      hasActiveStream: () => this._resumableStream.hasActiveStream(),
      generateRequestId: () => nanoid(),
      keepAliveWhile: (fn) => this.keepAliveWhile(fn),
      // Fired from a timer that may have been armed inside a recovered turn.
      // The continuation is its own turn, not the recovery attempt's.
      fireContinuation: () =>
        this._chatRecoveryEngine().outsideAttempt(() =>
          this._fireAutoContinuation()
        ),
      lastTurnReplyId: () => this._lastTurnReplyId,
      continuationDropped: (event) =>
        this._emit("chat:continuation:dropped", { ...event }),
      stopped: (requestId, reason) => this._afterStop(requestId, reason)
    },
    {
      defaultDebounceMs: AIChatAgent.MESSAGE_DEBOUNCE_MS,
      // A request waiting in the queue survives an isolate reset.
      admissions: {
        store: createChatAdmissionStore(() => this.ctx.storage.sql),
        recoveryPending: () => this._chatRecoveryNames(),
        recoveryOwns: (requestId) => this._chatRecoveryNames(requestId),
        replayRequest: (record) => this._replayClientChatRequest(record)
      }
    }
  );

  /**
   * Whether a chat turn waits for recovery, or, with `requestId`, whether a
   * turn of that request had a fiber recovery knows about.
   */
  private _chatRecoveryNames(requestId?: string): Promise<boolean> {
    return chatRecoveryNames({
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      turnName: (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME,
      liveRequestIds: new Set(this._chatTurnFibers.liveTurns.keys()),
      requestId
    });
  }

  /**
   * Registry of per-request AbortControllers.
   * Used to propagate cancellation signals for any external calls made by the agent.
   */
  private readonly _abortRegistry = this._turns.aborts;

  /** Durable chat history for this Agent. */
  readonly sessions = new Sessions();

  /**
   * Byte budget for wake-time transcript hydration into {@link messages}.
   *
   * `onStart` hydrates through `session.getRecentHistory(budget, …)`. The
   * budget counts each stored row plus the continuation rows it was split
   * across, so it bounds isolate memory: an oversized transcript hydrates
   * as a bounded recent window
   * instead of exhausting the isolate. Durable storage is never truncated by
   * this — `sessions.session().getHistory()` still reads the full path, and
   * the streamed `get-messages` route still serves every message.
   *
   * Set to `Number.POSITIVE_INFINITY` (or any non-positive value) to disable
   * windowing and always hydrate the whole transcript.
   *
   * @default 32 * 1024 * 1024
   */
  hydrationByteBudget: number = 32 * 1024 * 1024;

  /** The default linear conversation handle. */
  readonly #session: Session = this.sessions.session();

  /**
   * The Streams capability backing `_resumableStream`: chat's in-flight
   * output lives in the shared durable chunk log, readable by any
   * `streams.read()` consumer on this Durable Object.
   */
  readonly streams: Streams = createChatStreams();

  /**
   * Resumable stream manager -- handles chunk buffering, persistence, and replay.
   * @internal Protected for testing purposes.
   */
  protected _resumableStream!: ResumableStream;

  /**
   * The message currently being streamed. Used to apply tool results
   * before the message is persisted.
   * @internal
   */
  private _streamingMessage: UIMessage | null = null;

  /**
   * The finished reply while it is being stored: between leaving
   * {@link _streamingMessage} and `persistMessages` having written it. An
   * app's `persistMessages` override can await in that window, and a tool
   * result that arrives then must still find the reply. `dirty` is set when
   * one was applied, so the reply is stored again with it.
   */
  private _replyBeingStored: { message: UIMessage; dirty: boolean } | null =
    null;

  /**
   * The reply that is not in the stored transcript yet, or not in its final
   * form: streaming, or finished and being stored. A tool result or approval
   * is applied to it in place.
   */
  private _replyInFlight(): UIMessage | null {
    return this._streamingMessage ?? this._replyBeingStored?.message ?? null;
  }

  /**
   * Queued by `_reply` so the hook can fire after the turn lock releases.
   * Uses an array to avoid losing results when multiple turns complete
   * during a single `onChatResponse` call.
   * @internal
   */
  private _pendingChatResponseResults: ChatResponseResult[] = [];

  /**
   * Re-entrancy guard: true while `onChatResponse` is executing.
   * Prevents recursive hook calls when the hook triggers `saveMessages`.
   * @internal
   */
  private _insideResponseHook = false;

  /**
   * Resolves when the current pending client-tool interaction (tool result or
   * approval) has been written to state. Set when an apply promise is created,
   * cleared when it settles. Used by waitUntilStable to avoid polling.
   */
  private get _pendingInteractionPromise(): Promise<boolean> | null {
    return this._turns.pendingInteraction;
  }
  private set _pendingInteractionPromise(value: Promise<boolean> | null) {
    this._turns.pendingInteraction = value;
  }

  /**
   * Serialization tail for client-tool result/approval applies (#1649). Each
   * apply is a read-modify-write of the full message; running siblings from a
   * parallel tool batch concurrently lets last-write-wins clobber the others
   * back to `input-available`. Chaining every apply off this tail makes them
   * commit atomically in arrival order.
   */
  private get _interactionApplyTail(): Promise<void> {
    return this._turns.interactionTail;
  }
  private set _interactionApplyTail(value: Promise<void>) {
    this._turns.interactionTail = value;
  }

  /**
   * Tracks the ID of a streaming message that was persisted early due to
   * a tool entering approval-requested state. When set, stream completion
   * updates the existing persisted message instead of appending a new one.
   * @internal
   */
  private _approvalPersistedMessageId: string | null = null;

  /**
   * Serial queue for chat turns. Handles promise-chain serialization,
   * generation-based invalidation on clear, and active-request tracking.
   */
  private readonly _turnQueue = this._turns.queue;

  /**
   * Durable chat recovery configuration. Every chat turn runs in `runFiber`,
   * enabling `onChatRecovery` and `this.stash()` during streaming. Assign an
   * object to tune recovery budgets and terminal behavior.
   *
   * Assign this as a class field or in the constructor — NOT in `onStart()`.
   * On every wake the SDK evaluates recovery budgets (and may seal an
   * interrupted turn, firing `onExhausted`) before `onStart()` runs, so a config
   * set in `onStart()` is applied too late and the built-in defaults are used
   * for the recovery that matters. See {@link ChatRecoveryConfig}.
   */
  chatRecovery: ChatRecoveryConfig = true;

  /**
   * Inactivity watchdog for the live model/transport stream, in milliseconds.
   * If more than this many ms elapse between stream chunks, the turn is aborted
   * and routed into bounded recovery (the same continuation machinery as a
   * deploy or eviction interruption, #1626) rather than parking forever on a
   * hung provider.
   *
   * Default `0` disables the watchdog (opt-in), matching `@cloudflare/think`.
   * A value such as `60_000` (60s) is a reasonable starting point; tune it
   * above your slowest legitimate inter-chunk gap (slow reasoning models, long
   * tool calls) to avoid aborting healthy turns. Because the watchdog measures
   * the gap between chunks — not total turn duration — a steadily streaming
   * turn never trips it regardless of overall length.
   *
   * Assign as a class field or in the constructor, like {@link chatRecovery}.
   */
  chatStreamStallTimeoutMs = 0;

  /** First queued overlap message index for merge strategy, keyed by epoch. */
  private _mergeQueuedUserStartIndexByEpoch = new Map<number, number>();

  /** Shared admission policy state for overlapping submit-message requests. */
  private readonly _submitConcurrency = this._turns.submits;

  /**
   * Set of connection IDs that are pending stream resume.
   * These connections have received CF_AGENT_STREAM_RESUMING but haven't sent ACK yet.
   * They should be excluded from live stream broadcasts until they ACK.
   * @internal
   */
  private _pendingResumeConnections: Set<string> = new Set();

  /** Lazily-built shared resume-handshake driver (Tier-2). */
  private _resumeHandshakeInstance: ResumeHandshake | null = null;

  /**
   * Continuation lifecycle state: pending, deferred, active, and
   * connections awaiting a continuation stream to start.
   */
  private readonly _continuation = this._turns.continuation;

  /**
   * Accepted-but-not-yet-streamed turns and the connections parked waiting for
   * one (#1784). Lets a client that reconnects/re-mounts during a turn's
   * pre-stream window (queue, MCP wait, model latency) keep waiting instead of
   * giving up — see the {@link ResumeHandshake} `preStream` seam.
   *
   * HIBERNATION INVARIANT: this is in-memory only and is NOT persisted. It is
   * safe precisely because the pre-stream window cannot overlap hibernation: a
   * turn between `begin()` and `_startStream()` is an unresolved `onMessage`
   * handler promise (queue/debounce/MCP/model awaits) that pins the DO in
   * memory, so the DO is only evicted once the turn either recorded a durable
   * stream (resumed via `ResumableStream` on wake) or finished. This breaks if a
   * pre-stream wait is ever moved onto a durable alarm that releases the DO; if
   * that changes, this state must become durable.
   */
  private readonly _preStream = this._turns.preStream;
  /**
   * Everything this agent does when a parent runs it as a tool: the run
   * table, the run's life, what the parent reads, and progress. Shared with
   * `@cloudflare/think`; this class supplies only what differs.
   */
  private readonly _agentToolRuns = new AgentToolRuns({
    store: createAgentToolRunStore(() => this.ctx.storage.sql, {
      runs: "cf_ai_chat_agent_tool_runs",
      milestones: "cf_ai_chat_agent_tool_milestones",
      requestIndex: "idx_ai_chat_agent_tool_request_id"
    }),
    streams: () => this._resumableStream,
    storage: () => this.ctx.storage,
    responseType: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
    resetError: "Agent tool run was skipped because the chat was cleared.",
    keepAliveWhile: (fn) => this.keepAliveWhile(fn),
    generateRequestId: () => nanoid(),
    activeRequestId: () => this._activeRequestId,
    broadcastChunk: (requestId, body) =>
      this._broadcastChatMessage({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        body,
        done: false
      }),
    collectResult: (runId, input) => {
      const messagesAfterStart = this._getAgentToolMessagesAfterStart(runId);
      const output = this.getAgentToolOutput(
        { runId, input },
        messagesAfterStart
      );
      return {
        output,
        summary: this.getAgentToolSummary(
          { runId, input },
          output,
          messagesAfterStart
        )
      };
    },
    messages: () => this.messages,
    // The same as a client's stop for the request (#1630).
    cancelRequest: (requestId, reason) =>
      this._holdForStop(this._turns.cancel(requestId, reason))
  });

  /**
   * The stored request context (the shared `ChatRequestContext`): the client
   * tools and custom body of the most recent chat request, which tool
   * continuations and `continueLastTurn` pass to `onChatMessage`. It owns
   * when they change and writes them to SQLite so they survive hibernation.
   */
  private readonly _requestContext = new ChatRequestContext({
    get: (key) =>
      this.sql<{ value: string }>`
        select value from cf_ai_chat_request_context where key = ${key}
      `[0]?.value,
    set: (key, json) => {
      this.sql`
        insert or replace into cf_ai_chat_request_context (key, value)
        values (${key}, ${json})
      `;
    },
    delete: (key) => {
      this.sql`delete from cf_ai_chat_request_context where key = ${key}`;
    }
  });

  /**
   * Client tool schemas from the most recent chat request.
   * @internal
   */
  protected get _lastClientTools(): ClientToolSchema[] | undefined {
    return this._requestContext.clientTools;
  }
  protected set _lastClientTools(clientTools: ClientToolSchema[] | undefined) {
    this._requestContext.clientTools = clientTools;
  }

  /**
   * Custom body data from the most recent chat request.
   * @internal
   */
  protected get _lastBody(): Record<string, unknown> | undefined {
    return this._requestContext.body;
  }
  protected set _lastBody(body: Record<string, unknown> | undefined) {
    this._requestContext.body = body;
  }

  /**
   * Shared auto-continuation barrier (#1649 / #1650): owns the coalesce timer
   * and the double-fire guard. Parameterized by this agent's stream-active
   * signal, apply-drain, and continuation-turn pipeline (`_fireAutoContinuation`).
   */
  private readonly _autoContinuation = this._turns.autoContinuation;

  /**
   * Stream-active gate for the auto-continuation barrier (#1650). True while an
   * assistant turn is streaming in `_reply`: the parallel tool batch can still
   * grow with tool calls the model hasn't emitted yet, so no completeness check
   * is meaningful until the stream finalizes. `_onStreamingTurnFinalized`
   * clears it and re-runs the barrier once the batch is fully materialized.
   */
  private _streamingTurnActive = false;

  /** Default wait for trailing-edge debounced overlapping submits. */
  private static MESSAGE_DEBOUNCE_MS = 750;

  /**
   * Maximum number of messages to keep in SQLite storage.
   * When the conversation exceeds this limit, oldest messages are deleted
   * after each persist. Set to `undefined` (default) for no limit.
   *
   * This controls storage only — it does not affect what's sent to the LLM.
   * Use `pruneMessages()` from the AI SDK in your `onChatMessage` to control
   * LLM context separately.
   *
   * @example
   * ```typescript
   * class MyAgent extends AIChatAgent<Env> {
   *   maxPersistedMessages = 100; // Keep last 100 messages in storage
   * }
   * ```
   */
  maxPersistedMessages: number | undefined = undefined;

  /**
   * Controls how overlapping user submit requests behave while another chat
   * turn is already active or queued.
   *
   * - `"queue"` (default) — queue every submit and process them in order.
   * - `"latest"` — keep only the latest overlapping submit; superseded submits
   *   still persist their user messages, but do not start their own model turn.
   * - `"merge"` — queue overlapping submits, then collapse their trailing user
   *   messages into one combined user turn before the latest queued turn runs.
   * - `"drop"` — ignore overlapping submits entirely.
   * - `{ strategy: "debounce" }` — trailing-edge latest with a quiet window.
   *
   * This setting only applies to `sendMessage()` / `trigger: "submit-message"`
   * requests. Regenerations, tool continuations, approvals, clears, and
   * programmatic `saveMessages()` calls keep their existing serialized
   * behavior.
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * When enabled, waits for all MCP server connections to be ready before
   * calling `onChatMessage`. This prevents the race condition where
   * `getAITools()` returns an incomplete set because connections are still
   * restoring after Durable Object hibernation.
   *
   * - `false` (default) — non-blocking; `onChatMessage` runs immediately.
   * - `true` — waits indefinitely for all connections to settle.
   * - `{ timeout: number }` — waits up to `timeout` milliseconds.
   *
   * For lower-level control, call `this.mcp.waitForConnections()` directly
   * inside your `onChatMessage` instead.
   *
   * @example
   * ```typescript
   * class MyAgent extends AIChatAgent<Env> {
   *   waitForMcpConnections = true;
   * }
   * ```
   *
   * @example
   * ```typescript
   * class MyAgent extends AIChatAgent<Env> {
   *   waitForMcpConnections = { timeout: 10_000 };
   * }
   * ```
   */
  waitForMcpConnections: boolean | { timeout: number } = { timeout: 10_000 };

  /**
   * Live chat-turn closures keyed by run nonce. A closure exists only in the
   * isolate that accepted the turn; recovery after interruption never re-runs
   * it — the definition's `recover` callback hands the interruption to the
   * shared ChatRecoveryEngine instead.
   */
  private get _liveChatTurnClosures() {
    return this._chatTurnFibers.liveClosures;
  }

  /** Runs each chat turn as a durable fiber. Shared with `Think`. */
  private readonly _chatTurnFibers = new ChatTurnFibers({
    fiberName: (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME,
    snapshotKey: "__cfAIChatFiberSnapshot",
    generateId: () => nanoid(),
    turnSignal: (requestId) => this._abortRegistry.getExistingSignal(requestId),
    isFacet: () => this.parentPath.length > 0,
    runLegacyFiber: (name, fn, options) =>
      this._runFiberWithStashWrapper(name, fn, options),
    runTask: ({ requestId, continuation, nonce }) =>
      this.tasks.__DO_NOT_USE_WILL_BREAK__runAttached(
        (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME,
        { requestId, continuation, nonce },
        { runId: `chat_${nonce}`, retain: false, metadata: { requestId } }
      ),
    captureContext: () => {
      const ambient = agentContext.getStore();
      return (fn) => (ambient ? agentContext.run(ambient, fn) : fn());
    },
    turnBody: (continuation, body, requestId) =>
      this._chatRecoveryEngine().turnBody(continuation, body, requestId),
    turnAccepted: (requestId) => this._turns.turnAccepted(requestId)
  });

  /**
   * Register the shared chat-turn Task definition (see
   * `agents/chat` `createChatTurnTaskDefinition` for the turn logic): the
   * host wires its protected internals through the hooks.
   */
  private _registerChatTurnTaskDefinition(): void {
    const chatFiberName = (this.constructor as typeof AIChatAgent)
      .CHAT_FIBER_NAME;
    this.tasks.register(
      chatFiberName,
      createChatTurnTaskDefinition({
        definitionName: chatFiberName,
        storage: this.ctx.storage,
        getRunCreatedAt: async (runId) =>
          (await this.tasks.get(runId))?.createdAt ?? null,
        getLiveClosure: (nonce) => this._liveChatTurnClosures.get(nonce),
        keepAliveWhile: (fn) => this.keepAliveWhile(fn),
        withStash: (context, fn) => this._withFiberStash(context, fn),
        handleRecovery: (ctx) => this._handleInternalFiberRecovery(ctx)
      })
    );
  }

  /** Register the shared Tasks transport for recovery continuations. */
  private _registerChatRecoveryTaskDefinition(): void {
    // SAFETY: the recovery engine is the sole producer of each callback's
    // payload and the Task persists it verbatim, so the callback name selects
    // the matching host input type.
    this.tasks.register(
      CHAT_RECOVERY_TASK_NAME,
      createChatRecoveryTaskDefinition({
        _chatRecoveryContinue: (data) =>
          this._chatRecoveryContinue(data as ChatRecoveryContinueData),
        _chatRecoveryRetry: (data) =>
          this._chatRecoveryRetry(data as ChatRecoveryRetryData)
      })
    );
  }

  /** Enqueue one recovery attempt on the shared Tasks transport. */
  private _enqueueChatRecovery(
    callback: ChatRecoveryScheduleCallback,
    data: Record<string, unknown>,
    reason: ChatRecoveryTaskReason,
    delaySeconds: number,
    dedupeKey?: string
  ): Promise<void> {
    return enqueueChatRecoveryTask(
      this.tasks,
      { callback, data, delaySeconds },
      reason,
      dedupeKey
    );
  }

  /**
   * Start time and latest `stash()` data of each chat turn running in this
   * isolate, keyed by request id. A live stream failure is recovered while the
   * turn is still running, so `onChatRecovery` reads these instead of a fiber
   * snapshot.
   */
  private get _liveChatRecoveryTurns() {
    return this._chatTurnFibers.liveTurns;
  }

  /**
   * @param context - The tools and body the turn runs with, for its
   *   recovery snapshot. Left out by a turn that runs with the stored ones.
   */
  private _runChatRecoveryFiber<T>(
    requestId: string,
    continuation: boolean,
    fn: (takeReply: () => Promise<void>) => Promise<T>,
    context?: {
      clientTools: ClientToolSchema[] | undefined;
      body: Record<string, unknown> | undefined;
    }
  ): Promise<T> {
    return this._chatTurnFibers.run(
      {
        requestId,
        continuation,
        snapshot: createChatFiberSnapshot({
          kind: "ai-chat-turn",
          requestId,
          recoveryRootRequestId:
            this._activeChatRecoveryRootRequestId ?? requestId,
          continuation,
          messages: this.messages,
          lastBody: context ? context.body : this._lastBody,
          lastClientTools: context
            ? context.clientTools
            : this._lastClientTools,
          originMessageIds: this._originMessageIdsFor(requestId)
        })
      },
      fn
    );
  }

  /**
   * Array of chat messages for the current conversation.
   *
   * Public and mutable for backwards compatibility. Framework code
   * generally writes through `saveMessages` / `persistMessages`, but
   * existing subclasses may still assign `this.messages = [...]` or
   * mutate the array directly.
   */
  messages: UIMessage[] = [];

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    // A chunk of a terminal-only agent-tool run is forwarded to the run's
    // tailers, not broadcast.
    if (this._agentToolRuns.intercept(msg)) return;
    super.broadcast(msg, without);
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.sessions);
    this.lifecycle.use(this.streams);
    this._registerChatTurnTaskDefinition();
    this._registerChatRecoveryTaskDefinition();
    withAgentSpan(
      this,
      "chat_initialization",
      "initialization",
      { "cloudflare.agents.component": "ai_chat" },
      (update) => {
        withAgentSpan(
          this,
          "initialize_chat_storage",
          "initialization",
          { "cloudflare.agents.component": "ai_chat" },
          () => {
            // Session storage is Sessions' business and is initialized by its
            // capability `onStart`; the constructor never reads or writes the
            // transcript. Legacy lift and hydration happen in `onStart`.

            // Key-value table for request context that must survive hibernation
            // (e.g., custom body fields, client tools from the last chat request).
            this.sql`create table if not exists cf_ai_chat_request_context (
              key text primary key,
              value text not null
            )`;

            // Created here, as always, so the run table exists on every
            // agent whether or not it ever runs as a tool.
            this._agentToolRuns.store.ensure();
          }
        );

        // Restore request context from SQLite (survives hibernation)
        withAgentSpan(
          this,
          "restore_chat_request_context",
          "initialization",
          { "cloudflare.agents.component": "ai_chat" },
          () => {
            this._requestContext.restore();
            this._restoreLastTurnReplyId();
          }
        );

        // Initialize resumable stream manager (creates its own tables + restores state)
        withAgentSpan(
          this,
          "initialize_resumable_stream",
          "initialization",
          { "cloudflare.agents.component": "ai_chat" },
          () => {
            this._resumableStream = new ResumableStream(
              this.streams,
              this.sql.bind(this),
              {
                // Rollback insurance: a build still on the KV counter reads
                // a marker no lower than one recorded under the derived
                // marker. One put per stream retired, none per chunk.
                onProgress: (durable) => {
                  void this.ctx.storage
                    .put(CHAT_RECOVERY_PROGRESS_KEY, durable)
                    .catch(() => {});
                }
              }
            );
          }
        );

        update({
          "cloudflare.agents.chat.active_stream.restored":
            this._resumableStream.hasActiveStream()
        });
      }
    );

    // `this.messages` mirrors durable storage through the Sessions change
    // feed rather than being hand-patched at each write site.
    this.#subscribeToSessionChanges();

    const _onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      await withAgentSpan(
        this,
        "load_chat_messages",
        "startup",
        { "cloudflare.agents.component": "ai_chat" },
        async (update) => {
          await this._migrateLegacyMessages();
          await this._hydrateMessages();
          update({
            "cloudflare.agents.chat.messages.loaded": this.messages.length
          });
        }
      );
      // Requests an earlier isolate accepted and never started run again,
      // once no interrupted turn waits for recovery.
      this._resumeAdmissions();
      return _onStart(props);
    };

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      if (this._cf_requestTargetsSubAgent(ctx.request)) {
        return _onConnect(connection, ctx);
      }

      // Notify client about active streams that can be resumed
      if (this._resumableStream.hasActiveStream()) {
        this._notifyStreamResuming(connection);
      } else if (this._preStream.park(connection)) {
        // A turn is accepted but its stream hasn't started yet (#1784): park
        // this connection and tell it to keep waiting. `park` sent the
        // keep-waiting frame; the turn flushes it into STREAM_RESUMING on
        // _startStream or releases it with STREAM_RESUME_NONE on settle.
      } else {
        // No active stream to resume: if a recovery is in progress (between
        // attempts — the interrupted stream ended and the continuation hasn't
        // started yet), replay the live "recovering…" status so a client that
        // connects mid-recovery reads the turn as working rather than frozen
        // (#1620). This converges `AIChatAgent` onto `@cloudflare/think`'s
        // behavior. Unlike the terminal outcome (which must go through the
        // resume handshake to reach the client's stream reader), the recovering
        // frame is a plain status the client reflects directly into state.
        const recoveringFrame = await this._buildRecoveringConnectFrame();
        if (recoveringFrame) {
          sendIfOpen(connection, JSON.stringify(recoveringFrame));
        }
      }
      // Call consumer's onConnect
      return _onConnect(connection, ctx);
    };

    // Wrap onClose to clean up pending resume connections
    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      // Clean up pending resume state for this connection
      this._pendingResumeConnections.delete(connection.id);
      this._continuation.releaseConnection(connection.id);
      this._preStream.release(connection.id);
      // Call consumer's onClose
      return _onClose(connection, code, reason, wasClean);
    };

    // Wrap onMessage
    const _onMessage = this.onMessage.bind(this);
    const handleMessage = async (
      connection: Connection,
      message: WSMessage
    ) => {
      if (this._cf_connectionTargetsSubAgent(connection)) {
        return _onMessage(connection, message);
      }

      // Handle AIChatAgent's internal messages first. Classification is shared
      // with `@cloudflare/think` via `parseProtocolMessage`; the handler bodies
      // below stay AIChatAgent-specific (e.g. the `messages` event persists the
      // client snapshot, where Think no-ops it).
      if (typeof message === "string") {
        const event = parseProtocolMessage(message);
        if (!event) {
          // Not JSON, or not a recognized chat protocol message — forward to
          // the consumer's onMessage.
          return _onMessage(connection, message);
        }

        // Handle chat request
        if (event.type === "chat-request" && event.init.method === "POST") {
          const { body } = event.init;
          if (!body) {
            console.warn(
              "[AIChatAgent] Received chat request with empty body, ignoring"
            );
            return;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(body as string);
          } catch (_parseError) {
            console.warn(
              "[AIChatAgent] Received chat request with invalid JSON body, ignoring"
            );
            return;
          }

          const {
            messages,
            clientTools,
            trigger: _trigger,
            ...customBody
          } = parsed as {
            messages: UIMessage[];
            clientTools?: ClientToolSchema[];
            trigger?: string;
            [key: string]: unknown;
          };
          const chatMessageId = event.id;
          const transformedMessages = autoTransformMessages(messages);
          const requestTrigger: ChatRequestTrigger =
            _trigger === "regenerate-message"
              ? "regenerate-message"
              : "submit-message";
          const requestOriginIds = originMessageIds(messages);
          if (requestOriginIds) {
            this._requestOriginMessageIds.set(chatMessageId, requestOriginIds);
          }
          try {
            await this._turns.runClientRequest(
              this._clientChatRequest({
                requestId: chatMessageId,
                trigger: requestTrigger,
                messages: transformedMessages,
                newMessageIds: this._newUserMessageIds(transformedMessages),
                clientTools,
                body: customBody,
                connection,
                // What was stored when a regenerate arrived: its turn may
                // delete these, but never a question another tab sent after
                // it.
                regenerate:
                  requestTrigger === "regenerate-message"
                    ? this._regenerateAdmission(transformedMessages)
                    : null,
                originMessageIds: requestOriginIds
              })
            );
          } finally {
            this._requestOriginMessageIds.delete(chatMessageId);
          }
          return;
        }

        // Handle clear chat
        if (event.type === "clear") {
          this.resetTurnState();
          await this.#session.clearMessages();
          // Drop any pending terminal record (#1645) so a stale exhaustion
          // can't replay onto a freshly-cleared (empty) conversation when a
          // client reconnects and runs the resume probe.
          await this._clearChatTerminal();
          this._resumableStream.clearAll();
          this._pendingResumeConnections.clear();
          this._preStream.releaseAwaiting();
          this._preStream.reset();
          this._requestContext.clear();
          // `clearMessages()` above emptied `this.messages` through the
          // change feed.
          this._broadcastChatMessage(
            { type: MessageType.CF_AGENT_CHAT_CLEAR },
            [connection.id]
          );
          this._emit("message:clear");
          return;
        }

        // Handle message replacement
        if (event.type === "messages") {
          const transformedMessages = autoTransformMessages(event.messages);
          await this.persistMessages(transformedMessages, [connection.id]);
          return;
        }

        // Handle request cancellation
        if (event.type === "cancel") {
          // Aborts the request's turn, queued or running, and a recovery
          // attempt running for it.
          await this._turns.cancel(event.id);
          this._emit("message:cancel", { requestId: event.id });
          return;
        }

        // A stop from a tab that waits for a tool continuation to start. It
        // has no request id for it yet, so it names itself.
        if (event.type === "cancel-continuation") {
          this._turns.cancelWaitingContinuation(connection.id);
          return;
        }

        // Handle client-initiated stream resume request.
        // The client sends this after its message handler is registered,
        // avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
        // in onConnect arrives before the client's handler is ready.
        if (event.type === "stream-resume-request") {
          await this._resumeHandshake().handleResumeRequest(
            connection,
            event.probeId
          );
          return;
        }

        // Handle stream resume acknowledgment
        if (event.type === "stream-resume-ack") {
          await this._resumeHandshake().handleResumeAck(connection, event.id);
          return;
        }

        // Handle client-side tool result
        if (event.type === "tool-result") {
          const {
            toolCallId,
            toolName,
            output,
            state,
            errorText,
            autoContinue,
            clientTools
          } = event;

          const overrideState =
            state === "output-error" ? "output-error" : undefined;

          this._emit("tool:result", { toolCallId, toolName });

          // Only a result that settled its call continues, targeted at that
          // call's message. Without autoContinue it re-arms a batch a sibling
          // opted in for (#1650).
          this._turns.applyInteraction(
            // A result that settled its call and lists client tools replaces
            // the stored ones, so its continuation runs with the latest
            // schemas. A duplicate or a result for a call that is gone
            // changes nothing.
            this._requestContext.applyingToolResult(clientTools, () =>
              this._settleToolResult(
                toolCallId,
                toolName,
                output,
                overrideState,
                errorText
              )
            ),
            autoContinue === true,
            () => ({
              connection,
              errorPrefix: "[AIChatAgent] Tool continuation failed:"
            }),
            (run) => this._enqueueInteractionApply(run)
          );
          return;
        }

        // Handle client-side tool approval response
        if (event.type === "tool-approval") {
          const { toolCallId, approved, autoContinue } = event;
          this._emit("tool:approval", { toolCallId, approved });
          this._turns.applyInteraction(
            () => this._settleToolApproval(toolCallId, approved),
            autoContinue === true,
            () => ({
              connection,
              errorPrefix: "[AIChatAgent] Tool approval continuation failed:"
            }),
            (run) => this._enqueueInteractionApply(run)
          );
          return;
        }
      }

      // Forward unhandled messages to consumer's onMessage
      return _onMessage(connection, message);
    };
    this.onMessage = (connection: Connection, message: WSMessage) => {
      const event =
        typeof message === "string" ? parseProtocolMessage(message) : null;
      if (event?.type === "chat-request") {
        return withAgentSpan(
          this,
          "chat_interaction",
          "interaction",
          {
            "cloudflare.agents.component": "ai_chat",
            "cloudflare.agents.turn.request_id": event.id
          },
          () => handleMessage(connection, message)
        );
      }
      return handleMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      return this._tryCatchChat(async () => {
        const url = new URL(request.url);
        if (url.pathname.split("/").pop() === "get-messages") {
          return new Response(this.#streamMessagesAsJson(), {
            headers: { "content-type": "application/json" }
          });
        }
        return _onRequest(request);
      });
    };
  }

  /**
   * The shared resume-handshake driver (Tier-2). Lazily built; the
   * `ResumableStream` / `ContinuationState` / pending set are stable after the
   * constructor, so a single instance threads them for the agent's lifetime.
   */
  private _resumeHandshake(): ResumeHandshake {
    return (this._resumeHandshakeInstance ??= new ResumeHandshake({
      responseMessageType: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      resumableStream: this._resumableStream,
      continuation: this._continuation,
      preStream: this._preStream,
      pendingResumeConnections: this._pendingResumeConnections,
      pendingChatTerminal: () => this._pendingChatTerminal(),
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      isConnectionPresent: (connectionId) =>
        this._isConnectionPresent(connectionId),
      holdsTerminalFrames: (requestId) =>
        this._heldTerminalFrames.has(requestId)
    }));
  }

  /**
   * Notify a connection about an active stream that can be resumed — delegates
   * to the shared {@link ResumeHandshake}. Kept as a thin method because it is
   * also called proactively from onConnect and the broadcast loop. See the
   * driver for the #1733 double-send contract.
   * @param connection - The WebSocket connection to notify
   */
  private _notifyStreamResuming(connection: Connection) {
    this._resumeHandshake().notifyStreamResuming(connection);
  }

  // ── Delegate methods for backward compatibility with tests ─────────
  // These protected methods delegate to _resumableStream so existing
  // test workers that call them directly continue to work.

  /** @internal Delegate to _resumableStream */
  protected get _activeStreamId(): string | null {
    return this._resumableStream?.activeStreamId ?? null;
  }

  /** @internal Delegate to _resumableStream */
  protected get _activeRequestId(): string | null {
    return this._resumableStream?.activeRequestId ?? null;
  }

  /** @internal Delegate to _resumableStream */
  protected _startStream(
    requestId: string,
    options: { messageId?: string; continuation?: boolean } = {}
  ): string {
    const originIds =
      this._requestOriginMessageIds.get(requestId) ??
      this._activeChatRecoveryOriginIds;
    const streamId = this._resumableStream.start(requestId, {
      ...options,
      ...(originIds && { originMessageIds: originIds })
    });
    // Connections parked on this turn's pre-stream window (#1784) or on the
    // continuation it runs go into the normal STREAM_RESUMING path now that
    // a stream exists.
    this._turns.streamStarted(requestId, (c) => this._notifyStreamResuming(c));
    // Arm on START as well as finish so cleanup still has a belt-and-suspenders
    // wake if fiber recovery cannot finalize a stream. The last-activity sweep
    // threshold keeps an actively streaming run from being reclaimed before it
    // goes quiet (#1706).
    return streamId;
  }

  /** @internal Delegate to _resumableStream */
  protected _completeStream(streamId: string, outcome?: ChatTurnOutcome) {
    const completedRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.complete(streamId, outcome);
    this._afterStreamFinished(completedRequestId);
  }

  /**
   * @internal The producer finished; leave the row for the cutover that
   * persists the message (`persistMessages` via `#pendingCutover`). `_reply`'s
   * finally settles it if no persist follows.
   */
  protected _finishStream(streamId: string, outcome?: ChatTurnOutcome) {
    const finishedRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.finish(streamId, outcome);
    this._afterStreamFinished(finishedRequestId);
  }

  private _afterStreamFinished(requestId: string | null) {
    this._pendingResumeConnections.clear();
    this._turns.streamEnded(requestId);
  }

  /**
   * @deprecated Streams are reclaimed at cutover and on the next stream
   * start; no alarm is armed any more. Kept so a cleanup alarm persisted
   * by an earlier version still resolves to a callback when it fires.
   * @internal
   */
  async _cleanupStreamBuffers(): Promise<void> {
    this._resumableStream.reclaim();
  }

  /**
   * @internal Delegate to _resumableStream.
   *
   * A settled tool result (`tool-output-available` / `-error` / `-denied`)
   * is flushed to SQLite immediately rather than waiting for the packed
   * segment to fill: it captures a completed, often non-idempotent side
   * effect (or a user's denial), and an isolate eviction before the next
   * batch flush would lose it — recovery would re-anchor without it and
   * re-run the tool. The flush is also what the recovery progress marker is
   * derived from (`_chatRecoveryProgressMarker`), so a settled result counts
   * as forward progress the moment it lands, as it did under the old
   * per-chunk counter. Streaming deltas keep the buffer's own packing.
   *
   * A tool call (`tool-input-available`) is flushed too, before the tool
   * runs: see the shared `chunkMustBeStoredNow`.
   */
  protected async _storeStreamChunk(
    streamId: string,
    body: string
  ): Promise<number | undefined> {
    const seq = this._resumableStream.storeChunk(streamId, body);
    let type: string | undefined;
    try {
      type = (JSON.parse(body) as { type?: string }).type;
    } catch {
      // non-JSON chunk body — packed with the rest
    }
    if (chunkMustBeStoredNow(type)) {
      this._resumableStream.flushBuffer();
    }
    return seq;
  }

  /** @internal Delegate to _resumableStream */
  protected _flushChunkBuffer() {
    this._resumableStream.flushBuffer();
  }

  /** @internal Delegate to _resumableStream */
  protected _restoreActiveStream() {
    this._resumableStream.restore();
  }

  /** @internal Delegate to _resumableStream */
  protected _markStreamError(streamId: string) {
    const erroredRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.markError(streamId);
    this._afterStreamFinished(erroredRequestId);
  }

  /**
   * Reconstruct and persist a partial assistant message from an orphaned
   * stream's stored chunks. Called when the DO wakes from hibernation and
   * discovers an active stream with no live LLM reader.
   *
   * Built from the three orphan-persist seams the chat-recovery RFC factored
   * out — all three are ai-chat's substrate-specific realizations of a shape
   * `Think` shares:
   *   - (a) reconstruct via the shared `StreamAccumulator` (the same primitive
   *     `Think` and the client reducer use), replacing a hand-rolled chunk
   *     switch; it owns the `start` / `finish` / `message-metadata` handling;
   *   - (b) {@link _resolveOrphanTargetId} — the id to persist under (#1691);
   *   - (c)+(d) upsert-by-id through the shared `OrphanPersistStore` shape
   *     (`getMessage` → `updateMessage` / `appendMessage`).
   *     When a row already owns the id, the shared `reconcileOrphanPartial`
   *     merge preserves an in-place tool result rather than letting a replayed
   *     chunk re-advance it (ai-chat has an early tool-approval persist; hosts
   *     without one append straight through).
   * @internal
   */
  protected async _persistOrphanedStream(streamId: string): Promise<void> {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (!chunks.length) return;

    // The accumulate loop and the `getMessage → update(merge) XOR append` upsert
    // are the shared `persistReconstructedOrphan` core. ai-chat supplies the two
    // host-specific hooks:
    //   - prepare: resolve the persist-target id (#1691) — the one per-package
    //     step (a flat array can't express the tree a Session uses). A provider
    //     `start.messageId` is adopted by the accumulator (the live path adopts
    //     it for new turns too); continuations have it stripped before storage
    //     (#1229), so the unconditional adopt matches the live path.
    //   - merge: a row may already own this id (an early persist during tool
    //     approval, or a continuation resuming the last assistant message) —
    //     reconcile onto it via the shared `reconcileOrphanPartial` so an
    //     in-place tool result isn't re-advanced by a replayed chunk.
    // The store routes each write through `persistMessages` (exactly one write →
    // one `persistMessages` → one broadcast), so no explicit broadcast here.
    // NOTE: progress is bumped at production/flush time in `_storeStreamChunk`
    // (#1637), NOT here — persisting on recovery or a client reconnect must not
    // be miscounted as new forward progress.
    // A stream with no `finish` chunk was cut off: settle the tool calls it
    // left unanswered, so the stored reply never shows a server tool as
    // running after its `execute()` died. A stream that finished and only
    // missed its persist keeps its unanswered calls: those wait for a client.
    const settle = streamChunksFinished(chunks)
      ? (message: UIMessage) => message
      : (message: UIMessage) => this._settleInterruptedReply(message);
    const fallbackId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await persistReconstructedOrphan(chunks, {
      store: this._orphanStore(),
      fallbackId,
      prepare: (message) => {
        message.id = this._resolveOrphanTargetId(
          streamId,
          message.id,
          fallbackId
        );
        const settled = settle(message);
        // Nothing left to store (cut off while the model was reasoning).
        return replyIsEmpty(settled) ? null : settled;
      },
      merge: (existing, incoming) =>
        settle(reconcileOrphanPartial(existing, incoming))
    });
  }

  /**
   * Settle the tool calls a cut-off reply left unanswered (the shared
   * `settleInterruptedReply`): a call no client is known to own becomes an
   * errored result through {@link repairInterruptedToolPart}.
   */
  private _settleInterruptedReply(message: UIMessage): UIMessage {
    return this._turns.settleInterruptedReply(message, (part) =>
      this.repairInterruptedToolPart(part)
    );
  }

  /**
   * How a repaired transcript is stored and reported: one write and one
   * broadcast through `persistMessages`, which also refreshes
   * `this.messages`, then the `chat:transcript:repaired` event.
   */
  private _repairedTranscriptSink(): RepairedTranscriptSink {
    return {
      persist: async (_changed, repaired) => {
        await this.persistMessages(repaired);
      },
      // `CF_AGENT_CHAT_MESSAGES` carries the whole list, so every tab
      // drops what is no longer in it.
      remove: async (ids) => {
        await this._deleteMessagesByIds(ids);
        this._broadcastChatMessage({
          messages: this._messagesForClientSync(),
          type: MessageType.CF_AGENT_CHAT_MESSAGES
        });
      },
      emitRepaired: (event) => this._emit("chat:transcript:repaired", event)
    };
  }

  /**
   * Settle and store the reply a recovery attempt is about to continue,
   * before the attempt waits for the chat to be stable. That reply was cut
   * off by definition. One this version stored is settled already; one an
   * older version stored may hold a server tool call nothing will answer,
   * and the attempt would otherwise wait on it as if a client could.
   *
   * Earlier replies are left alone. The conversation has moved past them, so
   * nothing waits on them, and the turn that follows settles what they left
   * unanswered.
   */
  private _settleBeforeRecovery(
    continueReplyId: string,
    removal?: ReplyRemoval
  ): Promise<"removed" | undefined> {
    return this._turns.settleBeforeRecovery(
      this.messages,
      continueReplyId,
      (part) => this.repairInterruptedToolPart(part),
      this._repairedTranscriptSink(),
      removal
    );
  }

  /**
   * Resolve the id an orphaned partial should persist under — orphan-persist
   * step **(b)**, and the one legitimately per-package piece of the path: a
   * flat `UIMessage[]` can't express the parent/child a Session tree uses to
   * resolve this structurally, so ai-chat reads it from stream metadata.
   *
   * When the reconstructed message already adopted a provider `start.messageId`
   * (kept as-is — the live path adopts it for new turns too) `reconstructedId`
   * differs from `fallbackId` and is returned unchanged. Otherwise resolve to:
   *   - the id allocated when the stream started, recorded in stream metadata
   *     (#1691) — the SAME id the live path persists under (it only adopts a
   *     provider id, never invents one). A new turn stored its own fresh id, so
   *     it becomes its own message; a continuation stored the cloned
   *     last-assistant id, so it merges. This is what stops a new turn after a
   *     later user message from being folded into the previous assistant
   *     message (the #1691 corruption); or
   *   - (legacy rows written before the metadata column existed) the last
   *     assistant message, matching pre-#1691 behavior.
   * @internal
   */
  protected _resolveOrphanTargetId(
    streamId: string,
    reconstructedId: string,
    fallbackId: string
  ): string {
    if (reconstructedId !== fallbackId) return reconstructedId;
    const storedId = this._resumableStream.getStreamMessageId(streamId);
    if (storedId != null) return storedId;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") return this.messages[i].id;
    }
    return reconstructedId;
  }

  /**
   * The orphan-persist store adapter. Orphan-persist steps **(c)/(d)** route
   * through the shared `OrphanPersistStore` seam, backed by ai-chat's
   * `this.messages`
   * array + the existing `persistMessages` whole-array write path, so
   * reconcile/sanitize/row-size/broadcast all stay intact. Each mutating call
   * is exactly one `persistMessages` invocation; `parentId` is unused (a flat
   * array has no tree to attach to).
   * @internal
   */
  protected _orphanStore(): OrphanPersistStore {
    return {
      getMessage: (id) => this.messages.find((m) => m.id === id) ?? null,
      // A recovered partial is a turn's reply, stored late.
      appendMessage: async (message) => {
        await this.persistMessages([...this.messages, message]);
        this._recordTurnReply(message.id);
      },
      updateMessage: async (message) => {
        await this.persistMessages(
          this.messages.map((m) => (m.id === message.id ? message : m))
        );
        this._recordTurnReply(message.id);
      }
    };
  }

  /**
   * Repair a single interrupted tool call — a tool part with no settled result,
   * left behind when a stream was cut off mid-flight (e.g. a SERVER tool whose
   * `execute()` died with an evicted isolate, leaving an `input-available`
   * orphan that nothing will ever resolve). Returns the replacement part that
   * takes its place in the transcript; `input` has already been normalized to a
   * valid object.
   *
   * The default flips it to an errored tool result so the record survives (no
   * "disappearing" tool call) and `convertToModelMessages` still gets a
   * tool-result for it, avoiding `AI_MissingToolResultsError` on the next
   * provider call. This mirrors `@cloudflare/think` so ai-chat RECOVERS an
   * interrupted server tool (repairs, then continues) instead of waiting on a
   * dead orphan until its budget is spent.
   *
   * Override to customize the repaired shape for client-resolved tools — e.g.
   * convert an interrupted question tool (no server `execute`, normally answered
   * by the user's next message) into a plain text part so the model sees it as
   * ordinary conversation rather than a tool error. A returned tool part MUST
   * carry a settled result (`output-available` / `output-error` /
   * `output-denied` or an `output` / `result` field); returning a non-tool part
   * (e.g. text) is fine.
   */
  protected repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    return interruptedToolPartAsError(part, {
      clientToolNames: this._requestContext.clientToolNames()
    });
  }

  /**
   * Transcript repair, run before EVERY inference chokepoint (live submit, tool
   * auto-continuation, `continueLastTurn`, `saveMessages`/retry, and the chat
   * recovery callbacks). An interrupted server-tool orphan is flipped to a
   * settled (errored) result — via the shared `agents/chat`
   * `ChatTurns.settleBeforeTurn`, the SAME logic `@cloudflare/think`
   * runs before its own inference (`_assembleModelMessages`) — so the app's next
   * `convertToModelMessages(this.messages)` doesn't 400 with
   * `AI_MissingToolResultsError`. Because the app owns the inference call, the
   * framework can't repair "inside" it the way Think does; it repairs
   * `this.messages` at each point right before handing control to
   * `onChatMessage` instead. This reaches the cases the recovery-only repair
   * missed, including a mixed client+server orphan whose client replay drives
   * an auto-continuation.
   *
   * Scope (the shared `repairTranscriptBeforeTurn` rule, one for both hosts):
   * in a reply the conversation has moved past, every unanswered call is
   * settled, whoever owns it, because the provider rejects a request that holds
   * a call with no result. A turn that starts a new reply treats the last
   * message the same way. A continuation turn keeps, in the message it
   * continues, what a client is known to still answer: an `input-available`
   * call for a tool the client sent a schema for, and an `approval-requested`
   * call. The rule is per part, so a dead server orphan at the leaf is repaired
   * whatever sits earlier in history.
   *
   * Repair only ever reshapes ASSISTANT tool parts; it never touches user
   * messages, so per-channel policy carried on the user message's
   * `metadata.channel` (re-resolved on wake) is structurally untouched. It is a
   * no-op (no write, no broadcast) when nothing needs repair — the common case
   * for a healthy transcript. When anything changes, the corrected transcript is
   * persisted and broadcast through the normal `persistMessages` write path (one
   * write, one broadcast), which also refreshes `this.messages`.
   *
   * @throws When a continuation turn kept a call a client still has to
   *   answer: the turn has nothing to continue yet and must not call
   *   `onChatMessage`.
   * @internal
   */
  private async _repairInterruptedToolsBeforeTurn(options: {
    continuation: boolean;
  }): Promise<void> {
    const repaired = await this._turns.settleBeforeTurn(
      this.messages,
      {
        continuation: options.continuation,
        repairPart: (part) => this.repairInterruptedToolPart(part)
      },
      this._repairedTranscriptSink()
    );
    // The rule holds where the request is built: this runs right before
    // every `onChatMessage`. A continuation turn whose repair kept a call a
    // client still has to answer has nothing to continue. Its entry points
    // end such a turn first (`ChatTurns.continuationWaitsOnClient`). One
    // that did not must not reach the model: the request would hold a call
    // with no result.
    if (repaired.keptToolCallIds.length > 0) {
      throw new Error(
        `[AIChatAgent] A continuation turn cannot call the model while its reply waits on a client for tool call(s) ${repaired.keptToolCallIds.join(", ")}.`
      );
    }
  }

  /**
   * The id of the last reply a turn stored. `continuationTargetIsLatest`
   * reads it to tell a later turn's reply from a message appended without a
   * turn. Stored, because a reply can wait on a client for longer than the
   * isolate lives.
   */
  private _lastTurnReplyId: string | null = null;

  private _recordTurnReply(messageId: string): void {
    if (this._lastTurnReplyId === messageId) return;
    this._lastTurnReplyId = messageId;
    this.sql`
      insert or replace into cf_ai_chat_request_context (key, value)
      values ('lastTurnReplyId', ${JSON.stringify(messageId)})
    `;
  }

  /** Load {@link _lastTurnReplyId} from SQLite. A corrupted row reads as none. */
  private _restoreLastTurnReplyId(): void {
    const rows = this.sql<{ value: string }>`
      select value from cf_ai_chat_request_context where key = 'lastTurnReplyId'
    `;
    try {
      if (rows[0]) this._lastTurnReplyId = JSON.parse(rows[0].value);
    } catch {
      // Corrupted row: the next stored reply overwrites it.
    }
  }

  /**
   * Write the request context to SQLite (the shared `ChatRequestContext`).
   * @internal
   */
  private _persistRequestContext() {
    this._requestContext.persist();
  }

  /**
   * User message ids a WebSocket chat request originated from (#2280), keyed
   * by request id while the request is handled. After that (or after a
   * restart) the request's stream metadata is the fallback.
   */
  private _requestOriginMessageIds = new Map<string, string[]>();

  private _originMessageIdsFor(requestId: string): string[] | undefined {
    return (
      this._requestOriginMessageIds.get(requestId) ??
      this._resumableStream.getOriginMessageIds(requestId) ??
      this._activeChatRecoveryOriginIds
    );
  }

  private _withOriginMessageIds(message: OutgoingMessage): OutgoingMessage {
    if (
      message.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
      !(message.done || message.error)
    ) {
      return message;
    }
    return withOriginMessageIds(message, this._originMessageIdsFor(message.id));
  }

  private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
    message = this._withOriginMessageIds(message);
    if (
      message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
      (message.done || message.error)
    ) {
      const held = this._heldTerminalFrames.get(message.id);
      if (held) {
        held.push({ message, exclude });
        return;
      }
    }
    // Combine explicit exclusions with connections pending stream resume.
    // Pending connections should not receive live stream chunks until they ACK,
    // at which point they'll receive the full replay via _sendStreamChunks.
    const allExclusions = [
      ...(exclude || []),
      ...this._pendingResumeConnections
    ];
    this.broadcast(JSON.stringify(message), allExclusions);
  }

  /**
   * `useAgentChat` flips to ready on the terminal `done` frame, and a message
   * the user sends after that is replaced by any transcript broadcast that
   * arrives later. So while `_reply` owns a request, its terminal frames (the
   * `done` frame, and an in-band `error` frame, which clients also treat as
   * terminal) are held here in order and sent only after the assistant message
   * is persisted and broadcast.
   */
  private _heldTerminalFrames = new Map<
    string,
    Array<{ message: OutgoingMessage; exclude?: string[] }>
  >();

  private _releaseTerminalFrames(id: string, errorText?: string): void {
    const held = this._heldTerminalFrames.get(id);
    this._heldTerminalFrames.delete(id);
    if (!held) return;
    const failed =
      errorText !== undefined &&
      !held.some(
        ({ message }) =>
          message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          message.error
      );
    for (const { message, exclude } of held) {
      this._broadcastChatMessage(
        failed && message.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE
          ? {
              ...message,
              body: errorText,
              error: true,
              ...(message.done && { outcome: "error" as const })
            }
          : message,
        exclude
      );
    }
  }

  /**
   * Broadcasts a text event for non-SSE responses.
   * This ensures plain text responses follow the AI SDK v5 stream protocol.
   *
   * @param streamId - The stream identifier for chunk storage
   * @param event - The text event payload (text-start, text-delta with delta, or text-end)
   * @param continuation - Whether this is a continuation of a previous stream
   */
  private async _broadcastTextEvent(
    streamId: string,
    event:
      | { type: "text-start"; id: string }
      | { type: "text-delta"; id: string; delta: string }
      | { type: "text-end"; id: string },
    continuation: boolean
  ) {
    const body = JSON.stringify(event);
    const seq = await this._storeStreamChunk(streamId, body);
    this._broadcastChatMessage({
      body,
      done: false,
      id: event.id,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      ...(seq !== undefined && { seq }),
      ...(continuation && { continuation: true })
    });
  }

  /**
   * Lift ai-chat's legacy flat table into the default Sessions chain.
   *
   * Runs in `onStart` (before hydration), not in the constructor: the lift is
   * an async import through Sessions, and the constructor does no session
   * storage work at all.
   *
   * Order is read first as ids alone, then message bodies are fetched in
   * windows bounded by row count and bytes, so a large transcript never sits
   * in the isolate at once. Once every readable row has a copy the legacy
   * table is DROPPED rather than renamed: keeping it would leave the object
   * holding its history twice.
   */
  private async _migrateLegacyMessages(): Promise<void> {
    const present =
      this.ctx.storage.sql
        .exec(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'`
        )
        .toArray().length > 0;
    if (!present) return;

    // Ids and sizes only: the ordering pass must not carry message bodies.
    const order = this.sql<{
      id: string;
      bytes: number;
      created_at: string | number | null;
    }>`
      SELECT id, LENGTH(CAST(message AS BLOB)) AS bytes, created_at
      FROM cf_ai_chat_agent_messages
      ORDER BY created_at ASC, rowid ASC
    `;

    let parentId: string | null = null;
    let imported = 0;
    let skipped = 0;
    let index = 0;
    while (index < order.length) {
      const window: typeof order = [];
      let bytes = 0;
      while (
        index < order.length &&
        window.length < LEGACY_LIFT_WINDOW_ROWS &&
        (window.length === 0 ||
          bytes + order[index].bytes <= LEGACY_LIFT_WINDOW_BYTES)
      ) {
        bytes += order[index].bytes;
        window.push(order[index]);
        index++;
      }
      const ids = JSON.stringify(window.map((row) => row.id));
      const bodies = new Map(
        this.sql<{ id: string; message: string }>`
          SELECT id, message FROM cf_ai_chat_agent_messages
          WHERE id IN (SELECT value FROM json_each(${ids}))
        `.map((row) => [row.id, row.message] as const)
      );

      for (const row of window) {
        const body = bodies.get(row.id);
        if (body === undefined) {
          skipped++;
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(body);
          const message = autoTransformMessages([parsed])[0];
          if (!message || !isValidMessageStructure(message)) {
            console.warn(
              `[AIChatAgent] Skipping invalid legacy message ${row.id}: ` +
                "missing or malformed id, role, or parts"
            );
            skipped++;
            continue;
          }
          const parsedTime =
            typeof row.created_at === "number"
              ? row.created_at
              : Date.parse(String(row.created_at ?? ""));
          await this.#session.importMessage(message, {
            parentId,
            createdAt: Number.isFinite(parsedTime) ? parsedTime : imported
          });
          parentId = message.id;
          imported++;
        } catch (error) {
          console.error(`Failed to migrate message ${row.id}:`, error);
          skipped++;
        }
      }
    }

    // Drop the source ONLY when every row actually landed. A skipped row is
    // one that could not be parsed or imported, and dropping the table then
    // would delete it permanently — accounting for a row is not the same as
    // migrating it. The lift is idempotent (`importMessage` ignores ids it
    // already has), so leaving the table means a later start retries the rows
    // that failed rather than losing them.
    if (skipped === 0 && imported === order.length) {
      this.ctx.storage.sql.exec("DROP TABLE cf_ai_chat_agent_messages");
      return;
    }
    console.error(
      `[AIChatAgent] Legacy lift imported ${imported} of ${order.length} rows ` +
        `(${skipped} skipped); leaving cf_ai_chat_agent_messages in place so ` +
        "they remain recoverable."
    );
  }

  /**
   * Hydrate `this.messages` once per wake, bounded by
   * {@link hydrationByteBudget}. This is the only transcript read on the
   * startup path; every later change arrives through the Sessions change
   * feed.
   */
  private async _hydrateMessages(): Promise<void> {
    const budget = this.hydrationByteBudget;
    const stored =
      Number.isFinite(budget) && budget > 0
        ? (await this.#session.getRecentHistory(budget)).messages
        : await this.#session.getHistory();

    const messages: UIMessage[] = [];
    for (const message of stored as unknown[]) {
      if (!isValidMessageStructure(message)) {
        console.warn(
          `[AIChatAgent] Skipping invalid message ${(message as { id?: unknown } | null)?.id}: ` +
            "missing or malformed id, role, or parts"
        );
        continue;
      }
      messages.push(message);
    }
    // Automatic migration following https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages
    this.messages = autoTransformMessages(messages);
  }

  /**
   * Mirror `this.messages` from the Sessions change feed. Every durable write
   * dispatches here synchronously, so write sites never hand-patch the
   * cache.
   */
  #subscribeToSessionChanges(): void {
    this.#session.mirror<UIMessage>({
      get: () => this.messages,
      set: (messages) => {
        this.messages = messages;
      },
      transform: (message) => this.#messageForCache(message)
    });
  }

  /**
   * Turn a stored row into its in-memory form. A stored row is exactly what
   * the write returned, so this never costs a re-read.
   */
  #messageForCache(message: SessionMessage): UIMessage {
    const stored = message as UIMessage;
    return autoTransformMessages([stored])[0] ?? stored;
  }

  /**
   * Serialize the whole transcript as a JSON array of messages without ever
   * holding it in one string: `historyBatches()` yields bounded batches and
   * each batch is encoded straight into the response body.
   */
  #streamMessagesAsJson(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const batches = this.#session.historyBatches();
    let opened = false;
    let first = true;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!opened) {
          opened = true;
          controller.enqueue(encoder.encode("["));
          return;
        }
        const next = await batches.next();
        if (next.done) {
          controller.enqueue(encoder.encode("]"));
          controller.close();
          return;
        }
        let chunk = "";
        for (const message of autoTransformMessages(
          next.value as UIMessage[]
        )) {
          chunk += `${first ? "" : ","}${JSON.stringify(message)}`;
          first = false;
        }
        if (chunk.length > 0) controller.enqueue(encoder.encode(chunk));
      },
      cancel: async () => {
        await batches.return?.(undefined);
      }
    });
  }

  /**
   * @param signal - The signal of the turn `fn` runs, if it runs one. What
   *   a stopped turn throws is not an error: `onError` is not called for it.
   */
  private async _tryCatchChat<T>(
    fn: () => T | Promise<T>,
    signal?: AbortSignal
  ) {
    try {
      return await fn();
    } catch (e) {
      if (isTurnStopped(signal)) throw e;
      // `onError` observes the error and may replace it by throwing. If it
      // returns, the original error continues to the caller.
      await this.onError(e);
      throw e;
    }
  }

  private isChatTurnActive(): boolean {
    return this._turnQueue.isActive;
  }

  /**
   * Wait until the agent is fully idle — both the turn queue is drained
   * AND no submits are in flight between the concurrency decision and
   * `_runExclusiveChatTurn` (mid-`persistMessages` etc.).
   *
   * Just awaiting `_turnQueue.waitForIdle()` would miss submits whose
   * handlers have bumped `_latestOverlappingSubmitSequence` and
   * incremented `_pendingEnqueueCount` but haven't yet reached
   * `_runExclusiveChatTurn` — those would race with anything calling
   * `waitForIdle()` (tests, `waitUntilStable`, recovery code).
   */
  private async waitForIdle(): Promise<void> {
    return this._turns.waitForIdle();
  }

  /** Remember where a merge strategy's queued user messages start. */
  private _noteMergeStart(decision: SubmitConcurrencyDecision): void {
    if (
      decision.strategy === "merge" &&
      !this._mergeQueuedUserStartIndexByEpoch.has(this._turnQueue.generation)
    ) {
      this._mergeQueuedUserStartIndexByEpoch.set(
        this._turnQueue.generation,
        this.messages.length
      );
    }
  }

  private async _mergeQueuedUserMessages(
    epoch = this._turnQueue.generation
  ): Promise<void> {
    const mergedMessages = this._getMergedQueuedUserMessages(epoch);
    if (!mergedMessages) {
      return;
    }

    await this.persistMessages(mergedMessages, [], {
      _deleteStaleRows: true
    });
  }

  private _getMergedQueuedUserMessages(epoch: number): UIMessage[] | null {
    const queuedUserStart = this._mergeQueuedUserStartIndexByEpoch.get(epoch);
    if (queuedUserStart === undefined) {
      return null;
    }

    let queuedUserEnd = queuedUserStart;
    while (this.messages[queuedUserEnd]?.role === "user") {
      queuedUserEnd++;
    }

    if (
      queuedUserEnd === queuedUserStart &&
      queuedUserStart < this.messages.length
    ) {
      console.warn(
        `[AIChatAgent] merge: expected user messages at index ${queuedUserStart} ` +
          `but found role="${this.messages[queuedUserStart]?.role}"; skipping merge`
      );
    }

    const queuedUserMessages = this.messages.slice(
      queuedUserStart,
      queuedUserEnd
    );
    if (queuedUserMessages.length < 2) {
      return null;
    }

    return [
      ...this.messages.slice(0, queuedUserStart),
      AIChatAgent._mergeUserMessages(queuedUserMessages),
      ...this.messages.slice(queuedUserEnd)
    ];
  }

  private static _mergeUserMessages(messages: UIMessage[]): UIMessage {
    const [firstMessage, ...remainingMessages] = messages;
    if (!firstMessage) {
      throw new Error("cannot merge an empty message list");
    }

    let mergedParts = AIChatAgent._cloneMessageParts(firstMessage.parts);
    for (const message of remainingMessages) {
      AIChatAgent._appendMergedText(mergedParts, "\n\n");
      mergedParts = AIChatAgent._mergeMessageParts(mergedParts, message.parts);
    }

    const lastMessage = messages[messages.length - 1] ?? firstMessage;
    return {
      ...lastMessage,
      parts: mergedParts
    };
  }

  private static _mergeMessageParts(
    currentParts: UIMessage["parts"],
    nextParts: UIMessage["parts"]
  ): UIMessage["parts"] {
    const mergedParts = AIChatAgent._cloneMessageParts(currentParts);

    for (const part of nextParts) {
      if (part.type === "text") {
        AIChatAgent._appendMergedText(mergedParts, part.text);
        continue;
      }

      mergedParts.push(part);
    }

    return mergedParts;
  }

  private static _cloneMessageParts(
    parts: UIMessage["parts"]
  ): UIMessage["parts"] {
    return [...parts];
  }

  private static _appendMergedText(
    parts: UIMessage["parts"],
    text: string
  ): void {
    if (text.length === 0) {
      return;
    }

    const lastPart = parts[parts.length - 1];
    if (lastPart?.type === "text") {
      parts[parts.length - 1] = {
        ...lastPart,
        text: lastPart.text + text
      };
      return;
    }

    const textPart: TextUIPart = {
      type: "text",
      text
    };
    parts.push(textPart);
  }

  private _setRequestContext(
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>
  ) {
    this._requestContext.set({ clientTools, body });
  }

  private _messagesForClientSync(): readonly UIMessage[] {
    const inFlight = this._replyInFlight();
    if (!inFlight || inFlight.parts.length === 0) {
      return this.messages;
    }

    const existingIdx = this.messages.findIndex(
      (message) => message.id === inFlight.id
    );

    if (existingIdx >= 0) {
      return this.messages.map((message, idx) =>
        idx === existingIdx ? inFlight : message
      );
    }

    return [...this.messages, inFlight];
  }

  private _sendDirectMessage(
    connection: Connection,
    message: OutgoingMessage
  ): void {
    try {
      connection.send(JSON.stringify(message));
    } catch {
      // Connection closed before the server could reply.
    }
  }

  /**
   * One client chat request, as the turn core runs it: decide, accept
   * (pre-stream mark and abort controller, so a cancel while it waits in the
   * queue is not lost, #2701), record it for a replay after a reset,
   * persist, queue, the queued checks, then the turn. It always settles the
   * pre-stream turn (#1784) and drops the abort controller, whatever a step
   * does.
   *
   * A replay after an isolate reset (`messages: null`) has no connection:
   * its messages are stored already, and its frames go to every connection.
   */
  /** User messages in `messages` that are not stored yet. */
  private _newUserMessageIds(messages: UIMessage[]): string[] {
    const stored = new Set(this.messages.map((message) => message.id));
    return messages
      .filter((message) => message.role === "user" && !stored.has(message.id))
      .map((message) => message.id);
  }

  /**
   * What a regenerate needs to know about when it arrived: the messages it
   * keeps, and the stored user messages it did not send. A question another
   * tab sends later is in neither, and makes the regenerate skip.
   */
  private _regenerateAdmission(messages: UIMessage[]): {
    keepIds: string[];
    storedUserIds: Set<string>;
  } {
    const keepIds = messages.map((message) => message.id);
    const keep = new Set(keepIds);
    return {
      keepIds,
      storedUserIds: new Set(
        this.messages
          .filter((message) => message.role === "user" && !keep.has(message.id))
          .map((message) => message.id)
      )
    };
  }

  /**
   * A request an earlier isolate accepted and never gave a turn with a
   * fiber, to run again (`ChatTurns.resumeAdmissions`).
   */
  /**
   * Run the requests an earlier isolate left. Never rejects: what fails is
   * logged, and the next start or recovery tries again.
   */
  private _resumeAdmissions(): void {
    void this.keepAliveWhile(() => this._turns.resumeAdmissions()).catch(
      (error) =>
        console.error("[AIChatAgent] failed to replay requests:", error)
    );
  }

  /**
   * The last message a recovery checks: the latest one that no request
   * queued behind the recovered turn stored. Those requests run after it,
   * so their questions have not moved the conversation on.
   */
  private _recoveryLeaf(): UIMessage | undefined {
    const queued = this._turns.admittedMessageIds();
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (!queued.has(this.messages[i].id)) return this.messages[i];
    }
    return undefined;
  }

  private _replayClientChatRequest(
    record: ChatAdmissionRecord
  ): ClientChatRequest<true> | null {
    const stored = record.payload as StoredClientChatRequest | undefined;
    if (!stored || typeof stored !== "object") return null;
    const requestId = record.requestId;
    if (stored.originMessageIds) {
      this._requestOriginMessageIds.set(requestId, stored.originMessageIds);
    }
    const forget = () => this._requestOriginMessageIds.delete(requestId);
    const request = this._clientChatRequest({
      requestId,
      trigger: stored.trigger,
      messages: null,
      newMessageIds: record.messageIds,
      clientTools: stored.clientTools,
      body: stored.body ?? {},
      connection: null,
      regenerate:
        stored.trigger === "regenerate-message"
          ? {
              keepIds: stored.keepIds ?? [],
              storedUserIds: new Set(stored.storedUserIds ?? [])
            }
          : null,
      originMessageIds: stored.originMessageIds
    });
    const { persist, enqueue } = request;
    return {
      ...request,
      persist: async (context) => {
        const prepared = await persist(context);
        if (prepared === null) forget();
        return prepared;
      },
      enqueue: async (turn, generation, onQueued) => {
        try {
          return await enqueue(turn, generation, onQueued);
        } finally {
          forget();
        }
      }
    };
  }

  private _clientChatRequest(input: {
    requestId: string;
    trigger: ChatRequestTrigger;
    /** What the client sent, or `null` for a replay. */
    messages: UIMessage[] | null;
    /** The user messages this request stores. */
    newMessageIds: string[];
    clientTools: ClientToolSchema[] | undefined;
    body: Record<string, unknown>;
    connection: Connection | null;
    /**
     * A regenerate: the messages the client sent, and the user messages
     * stored when it arrived that it did not send.
     */
    regenerate: { keepIds: string[]; storedUserIds: Set<string> } | null;
    originMessageIds: string[] | undefined;
  }): ClientChatRequest<true> {
    const {
      requestId: chatMessageId,
      trigger: requestTrigger,
      messages: transformedMessages,
      newMessageIds,
      clientTools,
      body: customBody,
      connection,
      regenerate
    } = input;
    let concurrencyDecision!: SubmitConcurrencyDecision;
    let epoch!: number;
    return {
      requestId: chatMessageId,
      admission: {
        messageIds: newMessageIds,
        payload: {
          trigger: requestTrigger,
          clientTools,
          body: customBody,
          originMessageIds: input.originMessageIds,
          ...(regenerate && {
            keepIds: regenerate.keepIds,
            storedUserIds: [...regenerate.storedUserIds]
          })
        } satisfies StoredClientChatRequest
      },
      isSubmitMessage: requestTrigger === "submit-message",
      concurrency: this.messageConcurrency,
      onDecision: (decision) => {
        concurrencyDecision = decision;
        this._noteMergeStart(decision);
      },
      onDropped: () => {
        if (connection) this._rollbackDroppedSubmit(connection);
        this._completeSkippedRequest(connection, chatMessageId);
      },
      // A genuinely-new turn supersedes any pending terminal record
      // (#1645) so a stale exhaustion can't replay on a later
      // reconnect once the user has moved on.
      onAccepted: () =>
        withAgentSpan(
          this,
          "clear_previous_chat_state",
          "interaction",
          {
            "cloudflare.agents.component": "ai_chat",
            "cloudflare.agents.turn.request_id": chatMessageId,
            "cloudflare.agents.turn.trigger": requestTrigger
          },
          () => this._clearChatTerminal()
        ),
      // Persist and broadcast user messages before entering the turn
      // queue so other tabs see the new message immediately and so
      // overlapping submits under latest/merge/debounce can inspect
      // the full message list when their turn starts.
      persist: async ({ decision, generation, isCurrent }) => {
        epoch = generation;
        // A replay after a reset: its messages were stored before the reset.
        // One that is gone (a clear, or a reset before it was written) has
        // nothing to answer.
        if (!transformedMessages) {
          return this._turns.replayHasNothingToAnswer(
            newMessageIds,
            this.messages
          )
            ? null
            : true;
        }
        await withAgentSpan(
          this,
          "persist_incoming_messages",
          "interaction",
          {
            "cloudflare.agents.component": "ai_chat",
            "cloudflare.agents.turn.request_id": chatMessageId,
            "cloudflare.agents.turn.trigger": requestTrigger
          },
          async () => {
            this._broadcastChatMessage(
              {
                messages: transformedMessages,
                type: MessageType.CF_AGENT_CHAT_MESSAGES
              },
              connection ? [connection.id] : []
            );

            // A regenerate deletes the replies it replaces once its
            // turn starts (below), so a reply still streaming or
            // queued now is deleted too instead of surviving next to
            // the regenerated one.
            // Inside the scope, the write is skipped once the chat
            // was cleared: `persistMessages` can await before it
            // writes (an app's override, auto-compaction), and a
            // clear from another tab can land in that wait.
            await this._incomingPersistScope.run({ isCurrent }, () =>
              this.persistMessages(
                transformedMessages,
                connection ? [connection.id] : [],
                {
                  _deleteStaleRows: requestTrigger !== "regenerate-message"
                }
              )
            );

            if (isCurrent() && decision.strategy === "merge") {
              await this._mergeQueuedUserMessages(generation);
            }
          }
        );
        // Cleared meanwhile: nothing was stored, so there is no turn.
        return isCurrent() ? true : null;
      },
      enqueue: async (turn, generation, onQueued) => {
        let stale = false;
        const done = this._runExclusiveChatTurn(chatMessageId, turn, {
          epoch: generation,
          onStale: () => {
            stale = true;
          }
        });
        onQueued();
        await done;
        return stale ? "stale" : "completed";
      },
      beforeStart: async () => {
        // Re-merge inside the lock: more overlapping submits may have
        // persisted additional user messages while this turn was queued.
        if (concurrencyDecision.strategy === "merge") {
          await withAgentSpan(
            this,
            "merge_queued_messages",
            "turn",
            {
              "cloudflare.agents.component": "ai_chat",
              "cloudflare.agents.turn.request_id": chatMessageId,
              "cloudflare.agents.turn.trigger": requestTrigger,
              "cloudflare.agents.turn.admission": "queue",
              "cloudflare.agents.turn.generation": epoch
            },
            () => this._mergeQueuedUserMessages(epoch)
          );

          if (this._turnQueue.generation !== epoch) {
            return false;
          }

          if (
            this._submitConcurrency.isSuperseded(
              concurrencyDecision.submitSequence
            )
          ) {
            return false;
          }
        }

        await withAgentSpan(
          this,
          "prepare_chat_context",
          "turn",
          {
            "cloudflare.agents.component": "ai_chat",
            "cloudflare.agents.turn.request_id": chatMessageId,
            "cloudflare.agents.turn.trigger": requestTrigger,
            "cloudflare.agents.turn.admission": "queue",
            "cloudflare.agents.turn.generation": epoch
          },
          async () => {
            // Optionally wait for in-flight MCP connections to settle (e.g. after hibernation restore)
            // so that getAITools() returns the full set of tools in onChatMessage
            if (this.waitForMcpConnections) {
              const timeout =
                typeof this.waitForMcpConnections === "object"
                  ? this.waitForMcpConnections.timeout
                  : undefined;
              await this.mcp.waitForConnections(
                timeout != null ? { timeout } : undefined
              );
            }
          }
        );
        return true;
      },
      onSkipped: () => this._completeSkippedRequest(connection, chatMessageId),
      // The request was cancelled before its turn started. There is
      // no assistant message, so onChatResponse doesn't fire, and the
      // stored request context is left alone: tool continuations and
      // continueLastTurn read it and this request never ran. Like a
      // skipped request it never streamed, so only the tab that sent
      // it was ever shown it.
      onCancelledBeforeStart: () =>
        this._endUnstartedRequest(connection, chatMessageId, "aborted"),
      run: async (_prepared, signal) => {
        // Regenerate: drop every reply after the messages the client
        // sent, including one that landed while this request waited
        // in the queue (another tab's turn was still streaming). A
        // question another tab sent meanwhile has moved the chat on:
        // skip the regenerate rather than delete that question.
        if (regenerate) {
          const keep = new Set(regenerate.keepIds);
          const stale = this.messages.filter(
            (message) => !keep.has(message.id)
          );
          if (
            stale.some(
              (message) =>
                message.role === "user" &&
                !regenerate.storedUserIds.has(message.id)
            )
          ) {
            this._completeSkippedRequest(connection, chatMessageId);
            return;
          }
          if (stale.length > 0) {
            await this.persistMessages(
              transformedMessages ??
                this.messages.filter((message) => keep.has(message.id)),
              [],
              { _deleteStaleRows: true }
            );
          }
        }

        // The request's tools and body become the stored request
        // context now that its turn runs. A request that sends no
        // tools clears the stored ones. Decided first, stored after:
        // a regenerate skipped above never ran, and leaves the
        // context that continuations and `continueLastTurn` read.
        const { clientTools: requestClientTools, body: requestBody } =
          this._requestContext.set({ clientTools, body: customBody });

        this._emit("message:request");

        return this._tryCatchChat(async () => {
          // Wrap in agentContext.run() to propagate connection context to onChatMessage
          // This ensures getCurrentAgent() returns the connection inside tool execute functions
          return agentContext.run(
            {
              agent: this,
              connection: connection ?? undefined,
              request: undefined,
              email: undefined
            },
            async () => {
              const chatTurnBody = async () => {
                let replying = false;
                try {
                  await withAgentSpan(
                    this,
                    "repair_interrupted_tools",
                    "turn",
                    {
                      "cloudflare.agents.component": "ai_chat",
                      "cloudflare.agents.turn.request_id": chatMessageId,
                      "cloudflare.agents.turn.trigger": requestTrigger,
                      "cloudflare.agents.turn.admission": "queue",
                      "cloudflare.agents.turn.generation": epoch
                    },
                    () =>
                      this._repairInterruptedToolsBeforeTurn({
                        continuation: false
                      })
                  );
                  const response = await this.onChatMessage(
                    async (_finishResult) => {
                      // User-provided hook. Cleanup is now handled by _reply,
                      // so this is optional for the user to pass to streamText.
                    },
                    {
                      requestId: chatMessageId,
                      abortSignal: signal,
                      clientTools: requestClientTools,
                      body: requestBody,
                      continuation: false
                    }
                  );

                  if (response) {
                    await withAgentSpan(
                      this,
                      "persist_chat_result",
                      "turn",
                      {
                        "cloudflare.agents.component": "ai_chat",
                        "cloudflare.agents.turn.request_id": chatMessageId,
                        "cloudflare.agents.turn.trigger": requestTrigger,
                        "cloudflare.agents.turn.admission": "queue",
                        "cloudflare.agents.turn.generation": epoch
                      },
                      () =>
                        this._reply(
                          chatMessageId,
                          response,
                          connection ? [connection.id] : [],
                          {
                            chatMessageId,
                            abortSignal: signal,
                            onStreamStart: () => {
                              replying = true;
                            }
                          }
                        )
                    );
                  } else {
                    console.warn(
                      `[AIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`
                    );
                    this._broadcastChatMessage({
                      body: "No response was generated by the agent.",
                      done: true,
                      id: chatMessageId,
                      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                      outcome: "completed"
                    });
                  }
                } catch (error) {
                  // onChatMessage (or _reply before its stream was
                  // set up) threw: no frame reached the client yet,
                  // so report the failure the way a stream error is
                  // reported instead of leaving the request open.
                  if (
                    !replying &&
                    !signal?.aborted &&
                    !isDurableObjectResetError(error)
                  ) {
                    await this._reportTurnFailure(chatMessageId, error);
                  }
                  throw error;
                } finally {
                  this._abortRegistry.remove(chatMessageId);
                  // Settle the pre-stream turn on the normal path (#1784):
                  // a no-op release when the turn streamed (already flushed
                  // into STREAM_RESUMING on _startStream) or a release on
                  // the no-response path. A throw BEFORE chatTurnBody runs
                  // is caught by the outer finally instead.
                  this._settlePreStreamTurn(chatMessageId);
                }
              };

              await this._runChatRecoveryFiber(
                chatMessageId,
                false,
                chatTurnBody
              );
            }
          );
        }, signal);
      }
    };
  }

  /**
   * Send the terminal frame of a request that ended before its turn started
   * (skipped or cancelled in the queue) to the connection that sent it. No
   * other connection was shown the request.
   */
  private _endUnstartedRequest(
    connection: Connection | null,
    requestId: string,
    outcome: "skipped" | "aborted"
  ): void {
    const frame = this._withOriginMessageIds({
      body: "",
      done: true,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      outcome
    });
    // A request replayed after a reset has no connection: the tab that sent
    // it may be any of them now.
    if (connection) this._sendDirectMessage(connection, frame);
    else this._broadcastChatMessage(frame);
  }

  private _completeSkippedRequest(
    connection: Connection | null,
    requestId: string
  ) {
    this._endUnstartedRequest(connection, requestId, "skipped");
    // A skipped turn settles out of the pre-stream set, but must NOT release
    // parked connections (#1784): a skip happens because a NEWER turn was
    // admitted (latest/merge supersede) or the queue generation advanced. The
    // earliest "successor exists" signal (`SubmitConcurrencyController.decide`)
    // fires before the successor's `_preStream.begin()`, so releasing here would
    // race a `begin()` that hasn't run yet and cut a parked client loose right
    // before the successor streams. Leave it parked: the successor flushes it on
    // `_startStream`, or the final surviving turn's settle releases it. (Chat
    // clear releases parked connections explicitly via `resetTurnState`.)
    this._settlePreStreamTurn(requestId, { releaseParked: false });
  }

  /** Whether a connection with this id is still attached. */
  private _isConnectionPresent(connectionId: string): boolean {
    return this.getConnection(connectionId) !== undefined;
  }

  /**
   * Mark an accepted turn (#1784) as settled. When `releaseParked` (the default)
   * and no accepted turn remains in flight and no stream is active, release every
   * parked connection with STREAM_RESUME_NONE so a client that reconnected during
   * the pre-stream window stops waiting. A no-op when the parked set was already
   * flushed on stream start. Skip paths pass `releaseParked: false` so a parked
   * client survives onto the successor turn (see `_completeSkippedRequest`).
   */
  private _settlePreStreamTurn(
    requestId: string,
    options: { releaseParked?: boolean } = {}
  ): void {
    this._turns.settlePreStreamTurn(requestId, options);
  }

  private _rollbackDroppedSubmit(connection: Connection) {
    this._sendDirectMessage(connection, {
      messages: this._messagesForClientSync(),
      type: MessageType.CF_AGENT_CHAT_MESSAGES
    });
  }

  /**
   * `true` when the chat is waiting on a client: a tool call a client still
   * has to answer, or an approval it still has to give.
   *
   * Every unanswered call in the stored transcript counts, whatever its tool.
   * A reply is stored unanswered only when its stream finished on that call,
   * which is what a client tool does; a reply that was cut off has its dead
   * calls settled before it is stored. In the reply streaming now, only a
   * tool the client sent a schema for counts, because a server tool sits at
   * `input-available` while it runs.
   */
  protected hasPendingInteraction(): boolean {
    return this._turns.hasPendingInteraction();
  }

  /**
   * Waits until the conversation is fully stable — no active stream, no
   * pending client-tool interactions, and no queued continuation turns.
   *
   * Returns `true` when stable. Returns `false` if `timeout` expires before
   * a pending interaction resolves. Safe to call at any time; if there is
   * nothing pending it returns immediately.
   *
   * `pendingInteraction` replaces the check for a client still having
   * something to answer. It defaults to {@link hasPendingInteraction}.
   * Recovery passes {@link hasPendingClientInteraction}, which is the same
   * check unless a subclass overrides it.
   */
  protected async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }): Promise<boolean> {
    return this._turns.waitUntilStable({
      timeout: options?.timeout,
      hasPendingInteraction:
        options?.pendingInteraction ?? (() => this.hasPendingInteraction())
    });
  }

  /**
   * Aborts the active turn and invalidates queued continuations. Call this
   * when intercepting `CF_AGENT_CHAT_CLEAR` before the SDK sees the message —
   * the built-in handler calls it automatically.
   */
  protected resetTurnState(): void {
    this._mergeQueuedUserStartIndexByEpoch.delete(this._turnQueue.generation);
    // Queue generation, abort controllers, submit concurrency, the tool-result
    // apply chain, the continuation slots and barrier, and parked connections.
    this._turns.reset();
    this._streamingTurnActive = false;
    this._pendingChatResponseResults.length = 0;
  }

  /**
   * Abort a single in-flight chat turn by request id.
   *
   * Equivalent to the cancel path that fires when a client sends a
   * `chat-request-cancel` WebSocket message — the inference loop's
   * signal aborts and the turn's `ChatResponseResult` reports
   * `status: "aborted"`. No-op if no controller exists for `requestId`.
   *
   * Most callers don't have the request id and want
   * {@link abortAllRequests} instead. Prefer
   * {@link SaveMessagesOptions.signal} when driving a turn
   * programmatically — it threads the abort intent in from the start
   * without requiring the caller to know the id.
   */
  protected abortRequest(requestId: string, reason?: unknown): void {
    this._holdForStop(this._turns.cancel(requestId, reason));
  }

  /**
   * Hold the isolate while a stop finishes its bookkeeping. The stop itself
   * already happened, synchronously, when `settled` was created.
   */
  private _holdForStop(settled: Promise<void>): void {
    void this.keepAliveWhile(() => settled);
  }

  /**
   * What every stop does beyond aborting a running turn, whichever way the
   * stop came in (a client's cancel, {@link abortRequest},
   * {@link abortAllRequests}, a caller's `signal`):
   *
   * - an agent-tool run whose turn the stop names is cancelled, so a run
   *   left open for chat recovery is settled and its parent stops waiting;
   * - a recovery of the request that is waiting out its backoff, with
   *   nothing in flight to abort, is cancelled, so its callback bails when
   *   it fires.
   *
   * @param requestId - The stopped request, or `null` for every request.
   */
  private async _afterStop(
    requestId: string | null,
    reason: unknown
  ): Promise<void> {
    this._agentToolRuns.stopped(requestId, reason);
    if (requestId !== null) {
      await this._chatRecoveryEngine().tryCancelScheduledRecovery(requestId);
    }
  }

  /**
   * Abort every in-flight chat turn on this agent.
   *
   * Aborts all controllers in the registry and clears it. Used by
   * subclasses that drive single-purpose turns (e.g. an RPC-driven
   * sub-agent helper that runs one turn at a time) and want a coarse
   * "cancel whatever is running" handle without tracking request ids.
   *
   * A turn still waiting in the queue is aborted too: it ends `aborted`
   * when it reaches the front, stores nothing and does not call the model.
   *
   * Every auto-continuation that waits to run is dropped too, whether a
   * turn is running or not. A tool result that arrives afterwards continues
   * as usual.
   *
   * Does NOT invalidate queued turns or submit concurrency state — use
   * {@link resetTurnState} for the full teardown that runs on `chat-clear`.
   */
  protected abortAllRequests(reason?: unknown): void {
    this._holdForStop(this._turns.stopAll(reason));
  }

  /**
   * What chat recovery asks before it waits, parks or gives up: is a client
   * still to answer something? The same check as
   * {@link hasPendingInteraction} by default. The two used to differ: this
   * one ignored a server tool call that died with its isolate. Such a call is
   * now settled when its cut-off reply is stored, so neither sees one.
   *
   * Override it to change what recovery waits for without changing what
   * {@link waitUntilStable} waits for elsewhere.
   */
  protected hasPendingClientInteraction(): boolean {
    return this.hasPendingInteraction();
  }

  /**
   * Run a chat turn exclusively so `_reply()` never overlaps with another
   * streaming turn.
   */
  private async _runExclusiveChatTurn<T>(
    requestId: string,
    fn: () => Promise<T>,
    options?: { epoch?: number; onStale?: () => void }
  ): Promise<T> {
    const generation = options?.epoch;
    let result: TurnResult<T>;
    try {
      result = await this._turnQueue.enqueue(
        requestId,
        () =>
          // A turn owns its own traced boundary, never that of whatever
          // admitted it: an auto-continuation fires from a coalescing timer
          // long after the handler that armed it returned, and a turn started
          // without being awaited outlives its caller. Either way the caller's
          // boundary would close every span in a turn that is still running.
          withInvocationScope(
            () =>
              withAgentSpan(
                this,
                "chat_turn",
                "turn",
                {
                  "cloudflare.agents.component": "ai_chat",
                  "cloudflare.agents.turn.request_id": requestId,
                  "cloudflare.agents.turn.admission": "queue",
                  "cloudflare.agents.turn.generation": generation
                },
                fn
              ),
            { detached: true }
          ),
        { generation }
      );
    } finally {
      // Clean merge map when all turns for a generation complete
      const gen = generation ?? this._turnQueue.generation;
      if (this._turnQueue.queuedCount(gen) === 0) {
        this._mergeQueuedUserStartIndexByEpoch.delete(gen);
      }

      await this._drainChatResponseResults();
    }

    if (result!.status === "stale") {
      options?.onStale?.();
      return undefined as T;
    }
    return result!.value;
  }

  /**
   * Called when a streaming assistant turn finalizes (its message, with ALL tool
   * parts, is now persisted). Clears the stream-active gate and re-runs the
   * barrier for a continuation the gate held (#1650). Essential for an all-fast
   * parallel batch whose every result landed mid-stream: once the stream ends
   * there is no further tool-result event to re-arm, so without this the held
   * continuation would never fire. A slow batch is re-checked here and simply
   * keeps holding (event-driven) until its remaining siblings answer.
   */
  private _onStreamingTurnFinalized(): void {
    this._streamingTurnActive = false;
    // Whether the held continuation still has something to answer (#1618,
    // #2171) is decided when its turn starts.
    this._turns.replyFinalized();
  }

  /** Results whose terminal record was written before they were queued. */
  private readonly _terminalRecordedResults = new WeakSet<ChatResponseResult>();

  /**
   * Deliver every queued `onChatResponse` result, one at a time. The one
   * guarded place the hook is called from: a hook that starts a turn of its
   * own (`saveMessages`) queues that turn's result, and this loop delivers
   * it after the hook returns, never inside it.
   */
  private async _drainChatResponseResults(): Promise<void> {
    if (
      this._pendingChatResponseResults.length === 0 ||
      this._insideResponseHook
    ) {
      return;
    }
    this._insideResponseHook = true;
    try {
      await this.keepAliveWhile(async () => {
        while (this._pendingChatResponseResults.length > 0) {
          const chatResult = this._pendingChatResponseResults.shift()!;
          // A later turn that ends in a non-error outcome supersedes any
          // pending terminal record (#1645) — both a successful turn and an
          // aborted one (the conversation has moved on either way; only a
          // fresh error should leave a terminal to replay). The
          // client-request handler already clears on a new submit; this
          // covers turns driven purely server-side (`saveMessages`,
          // auto-continuation) with no client request in between, so a
          // stale exhaustion can't replay on a later reconnect. Mirrors
          // Think's `_recordTerminalChatStatus`, which clears on any
          // non-error/non-interrupted status.
          if (
            chatResult.status === "completed" ||
            chatResult.status === "aborted"
          ) {
            // Not the record of this turn's own give-up.
            await this._clearChatTerminal(chatResult.requestId);
          } else if (chatResult.status === "error") {
            // A terminal (non-recovered) error — e.g. a provider 500 surfaced
            // as a stream `error` part — has no durable trace otherwise, so a
            // client disconnected at this moment never learns the turn failed
            // and stays frozen on reconnect (#1645). Record it so it replays
            // over the resume handshake (shared
            // `ResumeHandshake._replayTerminalOnResume`). Mirrors
            // Think's `_fireResponseHook`, which records on `error` too.
            // Recoverable failures (deploy/eviction/stall) don't arrive here
            // as `error` — they reach the drain loop as `aborted`, or not at
            // all (the isolate is gone), and exhaustion records its own
            // terminal — so this can't pre-empt recovery.
            // A turn that failed before its stream recorded it already.
            if (!this._terminalRecordedResults.delete(chatResult)) {
              await this._recordChatTerminal(
                chatResult.requestId,
                chatResult.error ?? "The assistant encountered an error."
              );
            }
          }
          try {
            // The hook is the app's, and may start a turn of its own.
            // Neither belongs to a recovery attempt whose turn this was.
            await this._chatRecoveryEngine().outsideAttempt(() =>
              this.onChatResponse(chatResult)
            );
          } catch (hookError) {
            console.error("[AIChatAgent] onChatResponse threw:", hookError);
          }
        }
      });
    } finally {
      this._insideResponseHook = false;
    }
  }

  /**
   * Run the continuation turn for the pending continuation. The turn core
   * owns it (`ChatTurns.runContinuationTurn`): the abort signal, the claim
   * when the turn starts, the failure report and the settle. This supplies
   * the queue wrapper, the turn body (`_runServerTurnReply`, the same one
   * `saveMessages` and `continueLastTurn` run), and how a failure reaches
   * clients and `onChatResponse`.
   */
  private _fireAutoContinuation() {
    const epoch = this._turnQueue.generation;
    void this._turns.runContinuationTurn({
      // _runExclusiveChatTurn must be called synchronously so the chat turn
      // queue is set up immediately, otherwise waitForIdle() can resolve
      // before the continuation starts. keepAlive() is called inside the
      // turn to prevent hibernation while streaming, without deferring the
      // queue registration.
      enqueue: (requestId, turn) =>
        this._runExclusiveChatTurn(
          requestId,
          async () => {
            const dispose = await this.keepAlive();
            try {
              await turn();
            } finally {
              dispose();
            }
          },
          { epoch }
        ),
      // The one turn body every server-started turn runs, for the
      // continuation's connection. Its tools and body are the stored ones,
      // read now that the turn starts.
      run: (continuation, abortSignal) =>
        this._runServerTurnReply(continuation.requestId, abortSignal, {
          clientTools: this._lastClientTools,
          body: this._lastBody,
          continuation: true,
          connection: continuation.connection,
          // The reply that asked for the tool is extended while it is the
          // last message. When a message was appended after it, the answer
          // is a new reply after that message, which is left as it is.
          extendsReply:
            continuation.targetMessageIds == null ||
            continuation.targetMessageIds.includes(
              this.messages.at(-1)?.id ?? ""
            )
        }),
      failure: this._turnFailureHost(),
      onError: (error, { errorPrefix, reported }) => {
        // A failure clients were told about is not logged a second time.
        if (reported) return;
        console.error(
          errorPrefix ?? "[AIChatAgent] Auto-continuation failed:",
          error
        );
      }
    });
  }

  /**
   * How a turn that failed before it streamed reaches clients and the app.
   * The turn core owns the order (`reportTurnFailure`): the event, the
   * durable terminal record, then the error frame, for a client request and
   * a continuation alike.
   */
  private _turnFailureHost(): TurnFailureHost<ChatMessage> {
    return {
      describe: ({ error }) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this._emit("message:error", { error: errorMessage });
        return errorMessage;
      },
      recordTerminal: (requestId, errorMessage) =>
        this._recordChatTerminal(requestId, errorMessage),
      broadcast: (frame) =>
        this._broadcastChatMessage({
          ...frame,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
        }),
      // Called once the turn has left the queue, so the hook may start a
      // turn of its own. It goes through the same guarded queue as every
      // other result. The terminal record is written already.
      respond: (result) => {
        this._terminalRecordedResults.add(result);
        this._pendingChatResponseResults.push(result);
        return this._drainChatResponseResults();
      }
    };
  }

  /**
   * Report a chat request whose turn failed before it streamed: a durable
   * terminal record, so a client that reconnects learns the outcome too,
   * then an error frame for the request.
   */
  private async _reportTurnFailure(
    requestId: string,
    error: unknown
  ): Promise<void> {
    await this._turns.reportTurnFailure(this._turnFailureHost(), {
      requestId,
      error,
      continuation: false,
      stage: "turn"
    });
  }

  /**
   * Admit a server-started turn through the queue wrapper every chat turn
   * uses, for {@link ChatTurns.runServerTurn}.
   */
  private async _enqueueServerTurn(
    requestId: string,
    turn: () => Promise<unknown>,
    epoch: number
  ): Promise<"completed" | "stale"> {
    let stale = false;
    await this._runExclusiveChatTurn(requestId, turn, {
      epoch,
      onStale: () => {
        stale = true;
      }
    });
    return stale ? "stale" : "completed";
  }

  /**
   * Run one server-started turn through {@link ChatTurns.runServerTurn}.
   * `saveMessages`, `continueLastTurn`, the recovery retry, an agent-tool run
   * and the reaction to a detached notification all come through here; they
   * differ only in what they store first, the context they pin, and whether
   * the reply continues the last assistant message.
   */
  private async _runServerTurn(
    requestId: string,
    turn: {
      signal?: AbortSignal;
      continuation: boolean;
      /**
       * The body and client tools this turn runs with. A caller that leaves
       * one out gets the stored one, read when the turn starts. `null` pins
       * "none".
       */
      body?: Record<string, unknown> | null;
      clientTools?: ClientToolSchema[] | null;
      /**
       * Write this turn's tools and body to the stored request context, so
       * later turns run with them too. Only for a body the app itself gave
       * `continueLastTurn`. A pinned context is otherwise this turn's only.
       */
      storeContext?: boolean;
      /** The caller already holds the queue slot: run without waiting. */
      inline?: boolean;
      prepare?: ServerChatTurn<UIMessage[]>["prepare"];
      persist?: ServerChatTurn<UIMessage[]>["persist"];
    }
  ): Promise<SaveMessagesResult> {
    // A turn chat recovery re-runs for an agent-tool run gets that run's
    // row, so the parent keeps receiving the run's frames. Any other turn
    // binds nothing.
    this._agentToolRuns.rebind(
      requestId,
      this._activeChatRecoveryRootRequestId
    );
    const outcome = await this._turns.runServerTurn<UIMessage[]>({
      requestId,
      signal: turn.signal,
      enqueue: turn.inline
        ? async (run) => {
            await run();
            return "completed";
          }
        : (run, epoch) => this._enqueueServerTurn(requestId, run, epoch),
      prepare: turn.prepare,
      persist: turn.persist,
      run: (signal) =>
        this._runServerTurnBody(requestId, signal, {
          body: turn.body,
          clientTools: turn.clientTools,
          storeContext: turn.storeContext ?? false,
          continuation: turn.continuation
        }),
      onAborted: () => this._clearChatTerminal()
    });
    return toSaveMessagesResult(requestId, outcome);
  }

  /**
   * The model call and reply of a server-started turn: what
   * {@link ChatTurns.runServerTurn} runs once the turn is at the front of the
   * queue and has not been stopped.
   *
   * A caller can pin the tools and body with the turn. What it leaves out is
   * the stored one, read here, when the turn starts, so a turn that waited in
   * the queue runs with the context of the request that ran before it, like a
   * continuation does. A pinned context is never written to the stored one:
   * it goes to `onChatMessage` and into the turn's recovery snapshot, and
   * the chat's stored context is left for the turns after it.
   *
   * @returns The reply's outcome, or nothing when `onChatMessage` returned no
   *   response.
   */
  private async _runServerTurnBody(
    requestId: string,
    abortSignal: AbortSignal,
    turn: {
      body: Record<string, unknown> | null | undefined;
      clientTools: ClientToolSchema[] | null | undefined;
      storeContext: boolean;
      continuation: boolean;
    }
  ): Promise<StreamResultStatus | undefined> {
    const { continuation } = turn;
    const clientTools = pinnedOr(turn.clientTools, () => this._lastClientTools);
    const body = pinnedOr(turn.body, () => this._lastBody);
    if (turn.storeContext) this._setRequestContext(clientTools, body);
    return this._runServerTurnReply(requestId, abortSignal, {
      clientTools,
      body,
      continuation
    });
  }

  private async _runServerTurnReply(
    requestId: string,
    abortSignal: AbortSignal,
    turn: {
      clientTools: ClientToolSchema[] | undefined;
      body: Record<string, unknown> | undefined;
      continuation: boolean;
      /** The connection whose tool result started the turn, if one did. */
      connection?: Connection;
      /**
       * For a continuation: whether its reply extends the last assistant
       * message. `false` when a message was appended after the reply it
       * answers, so the answer is stored as a new reply. Defaults to
       * `continuation`.
       */
      extendsReply?: boolean;
    }
  ): Promise<StreamResultStatus | undefined> {
    const { clientTools, body, continuation } = turn;
    let outcome: StreamResultStatus | undefined;

    await this._tryCatchChat(async () => {
      return agentContext.run(
        {
          agent: this,
          connection: turn.connection,
          request: undefined,
          email: undefined
        },
        () =>
          this._runChatRecoveryFiber(
            requestId,
            continuation,
            async (takeReply) => {
              await this._repairInterruptedToolsBeforeTurn({ continuation });
              const response = await this.onChatMessage(() => {}, {
                requestId,
                abortSignal,
                clientTools,
                body,
                continuation
              });

              if (response) {
                // The model returned a reply: this turn continues it now.
                await takeReply();
                outcome = await this._reply(requestId, response, [], {
                  continuation: turn.extendsReply ?? continuation,
                  chatMessageId: requestId,
                  abortSignal
                });
              }
            },
            { clientTools, body }
          )
      );
    }, abortSignal);

    return outcome;
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @param options Options including abort signal and client-defined tools
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    throw new Error(
      "received a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /**
   * Called after a chat turn completes and the assistant message has been
   * persisted. The turn lock is released before this hook runs, so it is
   * safe to call `saveMessages` from inside.
   *
   * Fires for all turn completion paths: WebSocket chat requests,
   * `saveMessages`, and auto-continuation.
   *
   * Responses triggered from inside `onChatResponse` (e.g. via `saveMessages`)
   * do not fire `onChatResponse` recursively.
   *
   * The default implementation is a no-op.
   *
   * @param result - Information about the completed turn
   *
   * @example
   * ```ts
   * class MyAgent extends AIChatAgent<Env> {
   *   protected async onChatResponse(result: ChatResponseResult) {
   *     if (result.status === "completed") {
   *       this.broadcast(JSON.stringify({ streaming: false }));
   *     }
   *   }
   * }
   * ```
   */
  protected onChatResponse(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _result: ChatResponseResult
  ): void | Promise<void> {}

  /**
   * Override this method to apply custom transformations to messages before
   * they are persisted to storage. This hook runs **after** the built-in
   * sanitization (OpenAI metadata stripping, Anthropic provider-executed tool
   * payload truncation, empty reasoning part filtering).
   *
   * The default implementation returns the message unchanged.
   *
   * @param message - The pre-sanitized message about to be persisted
   * @returns The transformed message to persist
   *
   * @example
   * ```ts
   * class MyAgent extends AIChatAgent<Env> {
   *   protected sanitizeMessageForPersistence(
   *     message: UIMessage
   *   ): UIMessage {
   *     return {
   *       ...message,
   *       parts: message.parts.map(part => {
   *         if ("output" in part && typeof part.output === "string"
   *             && part.output.length > 1000) {
   *           return { ...part, output: "[redacted]" };
   *         }
   *         return part;
   *       })
   *     };
   *   }
   * }
   * ```
   */
  protected sanitizeMessageForPersistence(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    message: UIMessage
  ): UIMessage {
    return message;
  }

  /**
   * Convert an agent-tool input payload into the synthetic user message that
   * starts a headless `AIChatAgent` turn.
   */
  protected formatAgentToolInput(
    input: unknown,
    request: { runId: string }
  ): UIMessage {
    let text: string;
    try {
      text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    } catch {
      text = String(input);
    }

    return {
      id: `agent-tool-${request.runId}-input`,
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  override async reportProgress<T = unknown>(
    progress: AgentToolProgress<T>,
    options?: { persist?: boolean }
  ): Promise<void> {
    const result = this._agentToolRuns.reportProgress(progress, options);
    if (result === "inactive") {
      console.warn(
        "[ai-chat] reportProgress() was called outside of an active agent-tool run; ignoring. Call it from within an onChatMessage turn that is running as a sub-agent."
      );
    }
  }

  /**
   * Override to return structured agent-tool output instead of the default
   * final assistant text.
   */
  protected getAgentToolOutput(
    _request: { runId: string; input: unknown },
    messagesAfterStart: readonly UIMessage[]
  ): unknown {
    return AIChatAgent._extractLatestAssistantText(messagesAfterStart);
  }

  /**
   * Override to customize the concise summary stored on the parent run.
   */
  protected getAgentToolSummary(
    _request: { runId: string; input: unknown },
    output: unknown,
    messagesAfterStart: readonly UIMessage[]
  ): string {
    if (typeof output === "string") return output;
    if (output === undefined) {
      return AIChatAgent._extractLatestAssistantText(messagesAfterStart) ?? "";
    }
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  /** True while running inside this agent's own serialized detached-delivery
   * turn slot (set by {@link _runDetachedDelivery}); lets a `react` notify run
   * its reply inline rather than enqueuing (which would deadlock) or interleaving
   * with a foreign turn. */
  private _inSerializedDetachedDeliverySlot = false;

  /** Notification ids (`detached-finish:*` / `detached-ms:*`) currently being
   * injected, to dedupe a concurrent warm-tail + backbone delivery of the same
   * milestone within one isolate before the persisted message exists. */
  private _inFlightDetachedNotifications = new Set<string>();

  /**
   * Serialize detached terminal delivery against the chat turn queue. A
   * fast-path push or backbone tick can land mid-turn, and an `onFinish` that
   * mutates chat state (`saveMessages`, `setState`, a follow-up
   * `runAgentTool`) running concurrently with an active LLM turn is a data
   * race. Those paths never run synchronously inside a turn body (they fire
   * from `waitUntil` / a scheduled alarm), so enqueuing on the turn queue runs
   * the delivery strictly between turns without risk of self-deadlock.
   *
   * An explicit `cancelAgentTool` (`serialize` unset) may be invoked from
   * inside the very turn that triggers it, where enqueuing WOULD self-deadlock,
   * so it runs inline in the caller's (or a fresh) `agentContext`.
   */
  protected override async _runDetachedDelivery(
    invoke: () => Promise<void>,
    options?: { serialize?: boolean }
  ): Promise<void> {
    const inContext = () =>
      agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        invoke
      );
    if (!options?.serialize) {
      if (agentContext.getStore()?.agent === this) {
        await invoke();
        return;
      }
      await inContext();
      return;
    }
    await this.keepAliveWhile(() =>
      this._turnQueue.enqueue(
        `detached-delivery:${crypto.randomUUID()}`,
        // Mark the slot so `_injectDetachedNotification` knows it owns the active
        // turn and can run a `react` reply INLINE (vs a foreign active turn,
        // where inline would interleave and enqueue-await would deadlock).
        async () => {
          this._inSerializedDetachedDeliverySlot = true;
          try {
            await inContext();
          } finally {
            this._inSerializedDetachedDeliverySlot = false;
          }
        }
      )
    );
  }

  /**
   * Inject a synthetic chat message for a detached-run notification, idempotent
   * on its deterministic `id` (a re-delivery from the warm tail + cold backbone
   * collapses to one — `persistMessages` is skipped when the id already exists).
   * When `react` is set the model then takes a turn over the new message.
   *
   * `@cloudflare/ai-chat` has no durable-submission layer (unlike Think's
   * `submitMessages`), so the turn cannot be enqueued-and-awaited from inside the
   * serialized delivery slot — `TurnQueue` has no re-entrancy bypass, so that
   * would self-deadlock. Instead: when we are already inside a turn slot (the
   * `serialize: true` finish delivery runs as its own enqueued turn) we run the
   * programmatic turn INLINE, reusing that slot — so the whole notify completes
   * before the ledger marks the slot delivered (eviction-safe). When we are not
   * inside a slot (a milestone fired from the `waitUntil` fast path or the
   * reconcile alarm) we enqueue a fresh turn normally.
   */
  private async _injectDetachedNotification(
    id: string,
    role: "user" | "assistant",
    text: string,
    metadata: Record<string, unknown>,
    options: { react: boolean }
  ): Promise<void> {
    // `messages.some` covers re-delivery against persisted history (survives
    // eviction); the in-flight set closes the check-then-persist race when the
    // warm tail and cold backbone deliver the SAME milestone concurrently in one
    // isolate (milestones have no ledger claim, unlike finish).
    if (
      this._inFlightDetachedNotifications.has(id) ||
      this.messages.some((message) => message.id === id)
    ) {
      return;
    }
    this._inFlightDetachedNotifications.add(id);
    try {
      await this.persistMessages([
        ...this.messages,
        { id, role, parts: [{ type: "text", text }], metadata } as UIMessage
      ]);
      if (!options.react) return;
      if (this._inSerializedDetachedDeliverySlot) {
        // We own the active turn slot (a `serialize: true` finish delivery), so
        // run inline + awaited, reusing the slot's request id (keeps the
        // `activeRequestId === turn requestId` invariant `saveMessages` relies
        // on). The ledger marks the slot delivered only after the reaction
        // completes, making the react turn eviction-safe too.
        await this._runServerTurn(this._turnQueue.activeRequestId ?? nanoid(), {
          continuation: false,
          inline: true
        });
      } else if (this._turnQueue.isActive) {
        // Inside a FOREIGN turn (e.g. `cancelAgentTool` called mid-turn).
        // Enqueue-and-await would deadlock; inline would interleave with that
        // turn. Fire-and-forget a turn that runs once the slot frees — the
        // message is already persisted, so the reaction is best-effort.
        void this.keepAliveWhile(() =>
          this._runServerTurn(nanoid(), { continuation: false })
        );
      } else {
        await this._runServerTurn(nanoid(), { continuation: false });
      }
    } finally {
      this._inFlightDetachedNotifications.delete(id);
    }
  }

  /**
   * Format the message injected by `detached: { notify }` when a background run
   * finishes. Override to customize the prose, or return an empty string to
   * suppress the notification for a given outcome.
   */
  protected formatDetachedCompletion(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): string {
    const label = `Background task "${run.agentType}" (run ${run.runId})`;
    switch (result.status) {
      case "completed":
        return result.summary
          ? `${label} finished:\n\n${result.summary}`
          : `${label} finished successfully.`;
      case "error":
        return `${label} failed${result.error ? `: ${result.error}` : "."}`;
      case "aborted":
        return `${label} was cancelled.`;
      case "interrupted":
        return result.reason === "budget-exceeded"
          ? `${label} ran out of time before completing and was stopped.`
          : `${label} was interrupted before completing${result.error ? `: ${result.error}` : "."}`;
      default:
        return `${label} ended (${result.status}).`;
    }
  }

  /**
   * Targeted completion hook for `detached: { notify }`. Auto-wired by
   * `runAgentTool` (resolved by name so the base `Agent` stays decoupled from the
   * chat layer). Injects the formatted completion as a user turn so the model
   * reacts to the background result. Idempotent per run + status (deterministic
   * message id), so an exactly-once finish — or a soft give-up followed by a real
   * completion — never injects a duplicate, while a give-up and a later real
   * completion surface as two distinct messages.
   */
  async _cfDetachedNotifyFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    const text = this.formatDetachedCompletion(run, result);
    if (!text) return;
    await this._injectDetachedNotification(
      `detached-finish:${run.runId}:${result.status}`,
      "user",
      text,
      {
        source: run.notifySource ?? "detached-agent-tool",
        runId: run.runId,
        agentType: run.agentType,
        status: result.status
      },
      { react: true }
    );
  }

  /**
   * Format the message injected when a `detached: { onMilestones }` milestone is
   * reached. Override to customize the prose (or return an empty string to
   * suppress a given milestone).
   */
  protected formatDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone
  ): string {
    const label = `Background task "${run.agentType}" (run ${run.runId})`;
    const detail =
      milestone.data !== undefined
        ? `\n\n${JSON.stringify(milestone.data, null, 2)}`
        : "";
    return `${label} reached milestone "${milestone.name}".${detail}`;
  }

  /**
   * Targeted milestone hook for `detached: { onMilestones }`. Idempotent per run
   * + milestone NAME (deterministic message id), so the warm tail and the cold
   * backbone reconcile converge to at most one message.
   *
   * - `"narrate"` (default): a synthetic **assistant** message injected directly
   *   — no model turn.
   * - `"react"`: a **user** message followed by a model turn so the agent
   *   responds to the milestone.
   */
  protected override async _deliverDetachedMilestone(
    run: AgentToolRunInfo,
    milestone: AgentToolMilestone,
    mode: "react" | "narrate"
  ): Promise<void> {
    const text = this.formatDetachedMilestone(run, milestone);
    if (!text) return;
    await this._injectDetachedNotification(
      `detached-ms:${run.runId}:${milestone.name}`,
      mode === "narrate" ? "assistant" : "user",
      text,
      {
        source: run.notifySource ?? "detached-agent-tool",
        runId: run.runId,
        agentType: run.agentType,
        milestone: milestone.name
      },
      { react: mode === "react" }
    );
  }

  /**
   * Start this agent as an agent-tool run for a parent.
   *
   * @param options.signal - Aborting it cancels the run, the same as
   *   {@link cancelAgentToolRun}. An `AbortSignal` does not cross a Durable
   *   Object RPC call, so it works for a caller in the same isolate. A
   *   parent that reaches this agent over RPC cancels with
   *   `cancelAgentToolRun(runId, reason)`.
   */
  async startAgentToolRun(
    input: unknown,
    options: {
      runId: string;
      signal?: AbortSignal;
      eventDelivery?: AgentToolEventDelivery;
    }
  ): Promise<AgentToolRunInspection> {
    return this._agentToolRuns.start(
      options.runId,
      {
        input,
        terminalOnly: options.eventDelivery === "terminal",
        signal: options.signal
      },
      ({ requestId, signal, shouldStart }) =>
        this._runProgrammaticMessagesTurn(
          requestId,
          (messages) => [
            ...messages,
            this.formatAgentToolInput(input, { runId: options.runId })
          ],
          {
            signal,
            shouldApplyMessages: shouldStart,
            // The run's input goes with its turn: it is the stored request
            // context while the turn runs, and not while it waits.
            body: { agentToolInput: input },
            clientTools: null
          }
        )
    );
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    this._agentToolRuns.cancel(runId, reason);
  }

  async inspectAgentToolRun(
    runId: string,
    options?: { reconcile?: boolean }
  ): Promise<AgentToolRunInspection | null> {
    return this._agentToolRuns.inspect(runId, options);
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    return this._agentToolRuns.chunks(runId, options);
  }

  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    // The stream carries newline-delimited JSON; the RPC boundary types it
    // as the chunks it encodes.
    return this._agentToolRuns.tail(runId, options, {
      chunks: (id, chunkOptions) => this.getAgentToolChunks(id, chunkOptions),
      inspect: (id) => this.inspectAgentToolRun(id)
    }) as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  private _getAgentToolMessagesAfterStart(runId: string): UIMessage[] {
    return this._agentToolRuns.messagesSinceStart(runId, this.messages);
  }

  private static _extractLatestAssistantText(
    messages: readonly UIMessage[]
  ): string | undefined {
    const message = [...messages]
      .reverse()
      .find((candidate) => candidate.role === "assistant");
    if (!message) return undefined;

    const text = message.parts
      .filter((part): part is TextUIPart => part.type === "text")
      .map((part) => part.text)
      .join("");
    return text.length > 0 ? text : undefined;
  }

  /**
   * Persist messages and trigger `onChatMessage()` for a new response.
   *
   * Waits for any active chat turn to finish before starting, so scheduled
   * or programmatic messages never overlap an in-flight stream.
   *
   * Pass a function to derive the next message list from the latest
   * persisted `this.messages` when the turn actually starts. This avoids
   * stale baselines when multiple `saveMessages()` calls queue up behind
   * active work:
   *
   * ```ts
   * await this.saveMessages((messages) => [...messages, syntheticMessage]);
   * ```
   *
   * Pass `options.signal` to cancel the turn from outside without knowing
   * the internally-generated request id. The signal is linked to the
   * registry's controller for this turn — when it aborts, the inference
   * loop's signal aborts and the result reports `status: "aborted"`.
   * A signal already aborted, or one that aborts while the turn waits in the
   * queue, stops the turn before it starts: nothing is stored, `onChatMessage`
   * and `onChatResponse` are not called, and the result reports
   * `status: "aborted"`.
   *
   * Returns `{ requestId, status, error? }` where `status` is `"completed"`
   * when the turn ran, `"error"` when the stream reported an error,
   * `"skipped"` when the chat was cleared, or `"aborted"` when an external
   * signal cancelled it mid-stream.
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((
          currentMessages: readonly UIMessage[]
        ) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    return this._runProgrammaticMessagesTurn(nanoid(), messages, options);
  }

  /**
   * The turn behind {@link saveMessages}, with the options framework callers
   * need on top of the public ones.
   *
   * @param options.shouldApplyMessages - Asked when the turn reaches the
   *   front of the queue, before and after the messages are worked out.
   *   `false` ends the turn `aborted` with nothing stored and no model call.
   * @param options.body - The body this turn runs with, in place of the
   *   stored one, which is left as it is.
   * @param options.clientTools - The same for the client tools. `null` runs
   *   the turn with none.
   */
  private async _runProgrammaticMessagesTurn(
    requestId: string,
    messages:
      | UIMessage[]
      | ((
          currentMessages: readonly UIMessage[]
        ) => UIMessage[] | Promise<UIMessage[]>),
    options?: ProgrammaticTurnOptions
  ): Promise<SaveMessagesResult> {
    return this._runServerTurn(requestId, {
      signal: options?.signal,
      continuation: false,
      body: options?.body,
      clientTools: options?.clientTools,
      prepare: ({ isCurrent }) =>
        prepareTurnMessages<UIMessage>({
          messages,
          current: () => this.messages,
          shouldApply: options?.shouldApplyMessages,
          isCurrent
        }),
      persist: (resolvedMessages) => this.persistMessages(resolvedMessages)
    });
  }

  /**
   * Trigger a continuation of the last assistant message without inserting
   * a new user message. The LLM sees the full conversation (including the
   * partial assistant response) and generates a continuation that appends
   * to the same message.
   *
   * This uses `continuation: true` in `_reply`, which clones the last
   * assistant message and appends new parts to it — the same mechanism
   * used by tool auto-continuation.
   *
   * Returns early if there is no assistant message to continue from.
   *
   * Pass `options.signal` to cancel the continuation from outside —
   * matches the {@link saveMessages} contract.
   */
  protected async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const pinned: ProgrammaticTurnOptions | undefined = options;
    if (!this._findLastAssistantMessage()) {
      return {
        requestId: "",
        status: "skipped",
        reason: "nothing-to-continue"
      };
    }

    const requestId = nanoid();
    let emptyReplyRemoved = false;
    const result = await this._runServerTurn(requestId, {
      signal: options?.signal,
      body: body ?? pinned?.body,
      clientTools: pinned?.clientTools,
      // A body the app passes becomes the chat's stored body, as it always
      // has. A context framework code pins is this turn's only.
      storeContext: body !== undefined,
      continuation: true,
      // Decided first, at the front of the queue, before the turn stores
      // anything: while the reply still waits on a client there is nothing
      // to continue, and a skipped call leaves the chat as it found it. The
      // client's answer starts the continuation.
      // A reply that holds nothing once its trailing reasoning is gone has
      // nothing to continue either. It is removed, and the question it
      // answered is answered again below, as recovery does for a lost reply.
      prepare: async () => {
        if (this._turns.continuationWaitsOnClient()) {
          return { declined: "skipped", reason: "awaiting-client" };
        }
        emptyReplyRemoved = await this._turns.removeEmptyReplyToContinue(
          this.messages,
          this._repairedTranscriptSink()
        );
        return emptyReplyRemoved
          ? { declined: "skipped", reason: "nothing-to-continue" }
          : { input: [] };
      }
    });
    if (!emptyReplyRemoved) return result;
    const retried = await this._retryLastUserTurn(
      { ...pinned, body: body ?? pinned?.body },
      body !== undefined
    );
    return retried.status === "skipped" && retried.reason === undefined
      ? { ...retried, reason: "nothing-to-continue" }
      : retried;
  }

  private async _retryLastUserTurn(
    options?: ProgrammaticTurnOptions,
    /** Store `options.body` as the chat's body: the app passed it. */
    storeContext = false
  ): Promise<SaveMessagesResult> {
    const lastMessage =
      this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
    if (!lastMessage || lastMessage.role !== "user") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = nanoid();
    return this._runServerTurn(requestId, {
      signal: options?.signal,
      body: options?.body,
      clientTools: options?.clientTools,
      storeContext,
      continuation: false
    });
  }

  // ── Chat recovery via fibers ──────────────────────────────────────

  /**
   * Context passed to `onChatRecovery` when an interrupted chat stream
   * is detected after DO restart.
   */
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /**
   * Intercept internal chat fibers before they reach the user's
   * `onFiberRecovered` hook. Maps to `onChatRecovery`.
   * @internal
   */
  private _resolveChatRecoveryConfig(): ResolvedChatRecoveryConfig {
    // Delegates to the shared incident engine (agents/chat) so AIChatAgent and
    // Think resolve recovery config identically. See
    // design/rfc-chat-recovery-foundation.md.
    return resolveChatRecoveryConfig(this.chatRecovery);
  }

  /**
   * Monotonic forward-progress signal for recovery budget resets.
   *
   * This used to count assistant messages in `this.messages`, but that is
   * recomputed from the live, mutable transcript. Compaction collapses older
   * assistant messages into a summary, lowering the count — so a turn that had
   * genuinely advanced could read as "no progress" between attempts and exhaust
   * its budget prematurely (#1628). It then became a KV counter bumped per
   * credited chunk. It is now derived from the stream log the chunks were
   * already flushed to (`ResumableStream.progressMarker`): the log only grows
   * when new content lands durably, a reconnect replay or a recovery
   * re-persist reads it without appending (#1637), and compaction rewrites
   * the transcript, not the log. Nothing is written per chunk.
   *
   * The pre-derivation KV counter is folded in once per isolate, so a marker
   * an in-flight incident already recorded is never read lower after the
   * upgrade.
   */
  private readonly _chatRecoveryProgressMarker = chatRecoveryProgressReader(
    this.ctx.storage,
    () => this._resumableStream
  );

  /** Per-isolate N9 throttle gate (shared `agents/chat` helper); reset per
   *  isolate so the first forwarded chunk after a restart always credits. */
  private _agentToolStreamProgress = new AgentToolStreamProgressThrottle();

  /**
   * N9: forwarding a sub-agent's chunks IS forward progress for this parent
   * turn, so credit the parent's recovery progress marker — otherwise a parent
   * whose turn merely `await`s a child banks no progress of its own and its
   * no-progress window exhausts while the child is healthily streaming. The
   * child's output goes to clients, not to this object's stream log, so the
   * derived marker cannot see it; this is the one explicit credit left. Only
   * invoked after a child actually produced output (see
   * `_forwardAgentToolStream`), so a silent child still lets the parent exhaust.
   * Throttled (and reset per isolate) so we never write storage per token.
   */
  protected override async _onAgentToolStreamProgress(): Promise<void> {
    if (this._agentToolStreamProgress.shouldCredit(Date.now())) {
      this._resumableStream.creditProgress();
    }
  }

  /**
   * Lazily-built shared recovery engine. The adapter arrows capture `this`, so a
   * single cached instance is correct across calls (and across future engine
   * methods). `AIChatAgent` has no interaction state to rehydrate, so it omits
   * the optional `ensureInteractionStateLoaded` hook.
   */
  private _chatRecoveryEngineInstance?: ChatRecoveryEngine;
  private _chatRecoveryEngine(): ChatRecoveryEngine {
    return (this._chatRecoveryEngineInstance ??= new ChatRecoveryEngine({
      resolveConfig: () => this._resolveChatRecoveryConfig(),
      ...chatRecoveryStorageAdapter(this.ctx.storage),
      turns: {
        label: "[AIChatAgent]",
        beginRecoveryAttempt: (rootRequestId) =>
          this._turns.beginRecoveryAttempt(rootRequestId),
        // Recovery asks the overridable client-interaction check.
        waitUntilStable: (timeout) =>
          this.waitUntilStable({
            timeout,
            pendingInteraction: () => this.hasPendingClientInteraction()
          }),
        recordTerminalError: (requestId, errorText) =>
          this._recordChatTerminal(requestId, errorText),
        reconcileAgentToolChildRuns: () => this._agentToolRuns.reconcileOwn(),
        trackAlarmWork: (turn) => this.lifecycle.trackAlarmWork(turn),
        attemptScope: new AsyncLocalStorage<ChatRecoveryAttemptScope>(),
        latestMessage: () => this.messages.at(-1),
        originMessageIdsScope: this._chatRecoveryOriginIdsScope,
        // SAFETY: the recovery engine is the sole producer of each
        // callback's payload and the Task persists it verbatim, so the
        // callback name selects the matching host input type.
        attempts: {
          _chatRecoveryContinue: (data, onTurnStarted) =>
            this._chatRecoveryContinueDetached(
              data as ChatRecoveryContinueData | undefined,
              onTurnStarted
            ),
          _chatRecoveryRetry: (data, onTurnStarted) =>
            this._chatRecoveryRetryDetached(
              data as ChatRecoveryRetryData | undefined,
              onTurnStarted
            )
        }
      },
      readProgress: () => this._chatRecoveryProgressMarker(),
      // A turn parked on a pending CLIENT interaction is waiting on the human,
      // not stuck, so the engine keeps it budget-free.
      isAwaitingClientInteraction: () => this.hasPendingClientInteraction(),
      turnRecovered: (requestIds) => {
        for (const requestId of requestIds) {
          this._turns.turnAccepted(requestId);
        }
      },
      recoverySettled: () => this._resumeAdmissions(),
      emitRecoveryEvent: (event) =>
        this._emit(event.type, {
          incidentId: event.incidentId,
          requestId: event.requestId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          recoveryKind: event.recoveryKind,
          ...(event.reason ? { reason: event.reason } : {})
        }),
      scheduleRecovery: (callback, data, reason, delaySeconds, dedupeKey) =>
        this._enqueueChatRecovery(
          callback,
          data,
          reason,
          delaySeconds,
          dedupeKey
        ),
      setRecovering: (active, requestId) =>
        this._setChatRecovering(active, requestId),
      onShouldKeepRecoveringError: (error) =>
        console.error(
          "[AIChatAgent] chatRecovery shouldKeepRecovering hook threw",
          error
        ),
      exhaustChatRecovery: (
        incident,
        config,
        partial,
        streamId,
        createdAt,
        originMessageIds
      ) =>
        this._exhaustChatRecovery(
          incident,
          config,
          partial,
          streamId,
          createdAt,
          originMessageIds
        ),
      resolveRecoveryStream: (requestId) =>
        this._resolveAIChatRecoveryStream(requestId),
      getPartialStreamText: (streamId) => this._getPartialStreamText(streamId),
      onGiveUpBookkeepingError: (phase, error) =>
        console.error(
          phase === "read"
            ? "[AIChatAgent] failed to read recovery incident during give-up; synthesizing"
            : "[AIChatAgent] failed to persist sealed recovery incident during give-up",
          error
        )
    } satisfies ChatRecoveryAdapter));
  }

  private async _exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    // `parts` is the engine's vocabulary-agnostic `unknown[]`; ai-chat owns the
    // AI SDK `UIMessage` vocabulary, so it re-asserts `MessagePart[]` at the
    // user-facing exhausted-context edge below.
    partial: { text: string; parts: unknown[] },
    streamId: string,
    createdAt: number,
    originMessageIds?: string[]
  ): Promise<void> {
    // Build + notification (event + onExhausted-swallow) and the
    // notify-before-terminalize invariant live in the engine helper; the
    // terminal/broadcast ordering inside `terminalize` is broadcast-first,
    // converged onto `Think`'s ordering (see the note below).
    // See design/rfc-chat-recovery-foundation.md.
    await runChatRecoveryExhaustion(
      {
        incident,
        config,
        partialText: partial.text,
        partialParts: partial.parts as MessagePart[],
        streamId,
        createdAt
      },
      {
        emit: (event) => this._emit("chat:recovery:exhausted", event),
        onExhausted: config.onExhausted,
        onError: (error) =>
          console.error(
            "[AIChatAgent] chatRecovery onExhausted hook threw",
            error
          ),
        terminalize: async (ctx) => {
          // Deliver the user-visible terminal banner BEFORE the durable terminal
          // write. The write can reject in the deploy/storage window a give-up
          // runs in (#1730); ordering the broadcast first keeps the banner
          // resilient to that, the throw then propagates, and the whole give-up
          // re-runs on a healthy isolate — which persists the record
          // (idempotently) and re-delivers the banner (the documented
          // at-least-once edge). Persisting first gains no durability (the
          // re-run persists either way) while dropping the live banner on the
          // failing pass — so ai-chat matches `Think`'s broadcast-first.
          const messageIds =
            this._originMessageIdsFor(ctx.requestId) ?? originMessageIds;
          this._broadcastChatMessage({
            body: ctx.terminalMessage,
            done: true,
            error: true,
            id: ctx.requestId,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            ...(messageIds ? { messageIds } : {})
          });
          // The durable terminal record (#1645) is replayed to a client that
          // (re)connects after the turn ended (shared
          // `ResumeHandshake._replayTerminalOnResume`).
          await this._recordChatTerminal(
            ctx.requestId,
            ctx.terminalMessage,
            messageIds
          );
          // Exhaustion resolves recovery — clear the "recovering…" status (#1620).
          await this._setChatRecovering(false);
        }
      }
    );
    // The exhausted record is retained for inspection and reclaimed later by
    // the TTL sweep; only successful (completed) incidents are deleted eagerly.
  }

  /**
   * Persist a durable record of the last terminal turn so a client that
   * (re)connects after the turn ended still learns its outcome (#1645). Kept
   * until a later turn supersedes it (`_clearChatTerminal`); a single record is
   * sufficient because only the most recent terminal is relevant.
   */
  private async _recordChatTerminal(
    requestId: string,
    body: string,
    messageIds = this._originMessageIdsFor(requestId)
  ): Promise<void> {
    await recordChatTerminal(this.ctx.storage, requestId, body, messageIds);
  }

  /** Clear the durable terminal record once a later turn supersedes it (#1645). */
  private async _clearChatTerminal(endedRequestId?: string): Promise<void> {
    await clearChatTerminal(this.ctx.storage, endedRequestId);
  }

  private async _pendingChatTerminal(): Promise<{
    requestId: string;
    body: string;
    messageIds?: string[];
  } | null> {
    return pendingChatTerminal(this.ctx.storage);
  }

  /**
   * Build the on-connect "recovering…" replay frame (#1620), or `null` when no
   * (non-stale) recovery is in progress. A client that connects between recovery
   * attempts (no active stream) reads the turn as working rather than frozen.
   * A record older than the flag TTL is treated as abandoned (its terminal-clear
   * never ran) and skipped, so a dead recovery can't show "recovering…" forever.
   * Mirrors `@cloudflare/think`'s `_buildIdleConnectMessages` recovering replay.
   */
  private async _buildRecoveringConnectFrame(): Promise<Record<
    string,
    unknown
  > | null> {
    return buildChatRecoveringFrame(
      this.ctx.storage,
      MessageType.CF_AGENT_CHAT_RECOVERING,
      Date.now()
    );
  }

  /**
   * Set or clear the live "recovering…" status (#1620). Persists a durable
   * record (so set/clear stay consistent across the isolates a recovery spans)
   * and broadcasts a `CF_AGENT_CHAT_RECOVERING` frame on a genuine transition.
   * The status is also replayed on connect (`_buildRecoveringConnectFrame`) so a
   * client connecting mid-recovery isn't left looking frozen; the terminal
   * outcome is surfaced separately over the resume handshake (#1645).
   */
  private async _setChatRecovering(
    active: boolean,
    requestId?: string
  ): Promise<void> {
    await setChatRecovering(active, requestId, {
      storage: this.ctx.storage,
      messageType: MessageType.CF_AGENT_CHAT_RECOVERING,
      broadcast: (frame) =>
        this._broadcastChatMessage(frame as OutgoingMessage),
      now: Date.now()
    });
  }

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    // The wake-recovery lifecycle (non-chat dispatch → chat gate → unwrap →
    // stream/partial → classify → begin-incident → exhausted-branch →
    // onChatRecovery → persist → complete → dispatch → catch→failed) lives in the
    // shared ChatRecoveryEngine; this binds the divergent organs as wake hooks,
    // symmetric with `Think`. `AIChatAgent` tracks no terminal stream status
    // (`streamStatus: undefined`, so every terminal-stream branch is dead) and
    // has no submission layer, so its dispatch is a leaf-only retry/continue/skip.
    // See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().handleChatFiberRecovery(ctx, {
      chatFiberPrefix: () =>
        (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME + ":",
      unwrapRecoverySnapshot: (fiber) => {
        const { snapshot, user } = unwrapChatFiberSnapshot<"ai-chat-turn">(
          "__cfAIChatFiberSnapshot",
          fiber.snapshot,
          "ai-chat-turn"
        );
        return { snapshot, recoveryData: user };
      },
      classifyRecoveredTurn: (input) => this._classifyRecoveredChatTurn(input),
      invokeOnChatRecovery: (input) =>
        this.onChatRecovery({
          incidentId: input.incident.incidentId,
          recoveryRootRequestId: input.recoveryRootRequestId,
          attempt: input.incident.attempt,
          maxAttempts: input.incident.maxAttempts,
          recoveryKind: input.recoveryKind,
          streamId: input.streamId,
          requestId: input.requestId,
          partialText: input.partial.text,
          // The engine seam is vocabulary-agnostic (`unknown[]`); ai-chat owns
          // the AI SDK parts vocabulary, so re-assert it for the user context.
          partialParts: input.partial.parts as MessagePart[],
          recoveryData: input.recoveryData,
          messages: [...this.messages],
          lastBody: input.snapshot?.lastBody ?? this._lastBody,
          lastClientTools:
            input.snapshot?.lastClientTools ?? this._lastClientTools,
          createdAt: input.createdAt
        }),
      // Only persist while the stream is still active. The ACK handler (client
      // reconnect → replayChunks) may have already persisted + completed the
      // orphaned stream before fiber recovery runs; persisting again on the same
      // chunks would double the assistant message's parts. (The engine ANDs this
      // with the shared never-drop-settled-work clause.)
      shouldPersistOrphanedPartial: (input) => input.streamStillActive,
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      completeRecoveredStream: (streamId) => {
        this._resumableStream.complete(streamId);
      },
      dispatchRecoveredTurn: (input) => this._dispatchRecoveredChatTurn(input)
    } satisfies ChatFiberWakeHooks<AIChatRecoveryClassification>);
  }

  /**
   * Resolve the orphaned stream for a recovered chat turn — drives BOTH the wake
   * path (full result) and the give-up terminalization (which reads only
   * `.streamId`). Prefers the newest durable stream row keyed by the recovery-
   * root request id; falls back to the live active stream; `streamId` is `""`
   * when neither survives. `AIChatAgent` does not model terminal stream status,
   * so `streamStatus` is left `undefined` (keeping the engine's terminal-stream
   * branches dead here) — see the "substrate capabilities are optional" decision
   * in the RFC.
   */
  private _resolveAIChatRecoveryStream(
    requestId: string
  ): ResolvedRecoveryStream {
    let streamId = "";
    if (requestId) {
      streamId =
        this._resumableStream.latestStreamInfoForRequest(requestId)?.id ?? "";
    }
    if (!streamId && this._resumableStream.hasActiveStream()) {
      streamId = this._resumableStream.activeStreamId ?? "";
    }
    const streamStillActive = Boolean(
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId
    );
    return { streamId, streamStillActive };
  }

  /**
   * Classify a recovered turn as `retry` or `continue`. The `shouldRetryPreStream`
   * detail is threaded to the dispatch decision; `emptyPartialNewTurn` only
   * influences the reported kind (an empty partial persists nothing, so a new turn
   * is re-run fresh rather than merged into the previous assistant — #1691). The
   * `persist: false` discard case stays "continue" here and only surfaces as
   * "retry" on the `chat:recovery:scheduled` event, decided in dispatch.
   */
  private _classifyRecoveredChatTurn(input: ClassifyRecoveredTurnInput): {
    recoveryKind: ChatRecoveryKind;
    detail: AIChatRecoveryClassification;
  } {
    const shouldRetryPreStream = this._shouldRetryRecoveredPreStreamTurn(
      input.snapshot,
      input.streamId,
      input.partial
    );
    const preStreamLeaf = this._recoveryLeaf();
    const emptyPartialNewTurn =
      !!input.streamId &&
      input.snapshot?.continuation === false &&
      !!input.snapshot.latestUserMessageId &&
      input.partial.text === "" &&
      input.partial.parts.length === 0 &&
      preStreamLeaf?.role === "user" &&
      preStreamLeaf.id === input.snapshot.latestUserMessageId;
    const recoveryKind: ChatRecoveryKind =
      shouldRetryPreStream || emptyPartialNewTurn ? "retry" : "continue";
    return { recoveryKind, detail: { shouldRetryPreStream } };
  }

  /**
   * The retry/continue/skip decision for a recovered chat turn, run after the
   * partial is persisted and the stream completed. A NEW turn that left no
   * persisted assistant partial (the leaf is still the user message) is re-run
   * fresh instead of continued (which would clone + merge into the previous
   * assistant turn — #1691); this lost-partial check is re-derived here from the
   * now-updated leaf rather than carried from classify.
   */
  private async _dispatchRecoveredChatTurn(
    input: DispatchRecoveredTurnInput<AIChatRecoveryClassification>
  ): Promise<void> {
    const { incident, options, snapshot, recoveryRootRequestId } = input;
    const originIds =
      this._originMessageIdsFor(input.requestId) ?? snapshot?.originMessageIds;
    const leaf = this._recoveryLeaf();
    const lostPartialUserId =
      snapshot?.continuation === false &&
      snapshot.latestUserMessageId &&
      leaf?.role === "user" &&
      leaf.id === snapshot.latestUserMessageId
        ? snapshot.latestUserMessageId
        : undefined;

    if (options.continue === false) {
      await this._chatRecoveryEngine().updateIncident(
        incident.incidentId,
        "skipped",
        "continue_disabled"
      );
      return;
    }
    // A turn that died before it streamed, or whose partial is gone, leaves
    // the question as the latest message: answer it again. Continuing would
    // merge into the previous reply (#1691).
    const retryUserId = input.detail.shouldRetryPreStream
      ? snapshot?.latestUserMessageId
      : lostPartialUserId;
    await this._chatRecoveryEngine().scheduleRecoveredTurn({
      incident,
      recoveryKind:
        !input.detail.shouldRetryPreStream && lostPartialUserId !== undefined
          ? "retry"
          : input.recoveryKind,
      recoveryRootRequestId,
      retryUserId,
      targetAssistantId: retryUserId
        ? undefined
        : this._findLastAssistantMessage()?.id,
      requestContext: snapshot,
      originMessageIds: originIds
    });
  }

  /**
   * Called when an interrupted chat stream is detected after restart.
   * Return options to control recovery:
   *
   * - `{}` (default): persist partial response + schedule continuation
   * - `{ continue: false }`: persist but don't continue
   * - `{ persist: false, continue: false }`: handle everything yourself
   *
   * `ctx.recoveryData` contains any data checkpointed via `this.stash()`
   * during the turn (e.g., OpenAI `responseId`). If recovery happens before
   * any stream chunks exist and the latest message is still the unanswered
   * user message from the interrupted turn, the framework retries that turn
   * automatically unless continuation is disabled.
   */
  protected async onChatRecovery(
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return {};
  }

  async _chatRecoveryContinue(data?: ChatRecoveryContinueData): Promise<void> {
    await this._chatRecoveryEngine().runRecoveryCallback(
      "_chatRecoveryContinue",
      data
    );
  }

  protected async _chatRecoveryContinueDetached(
    data?: ChatRecoveryContinueData,
    onTurnStarted?: () => void
  ): Promise<void> {
    const targetId = data?.targetAssistantId;
    await this._chatRecoveryEngine().runRecoveredTurn({
      callback: "_chatRecoveryContinue",
      data,
      // The turn of an agent-tool run its parent cancelled is not recovered.
      admit: () =>
        this._agentToolRuns.admitRecoveredTurn(
          data,
          (incidentId, status, reason) =>
            this._chatRecoveryEngine().updateIncident(
              incidentId,
              status,
              reason
            )
        ),
      settleCutOffReply: async (removal) =>
        targetId
          ? this._settleBeforeRecovery(targetId, {
              ...removal,
              originMessageIds: data?.originMessageIds
            })
          : undefined,
      // The reply is not in the transcript (it held nothing and was removed,
      // by this attempt or an earlier run of it): answer the question again.
      retryLostReply: this._recoveryRetrySteps(undefined, onTurnStarted),
      // The leaf is the last message, not the last assistant message: a newer
      // question that got no reply (stopped, or failed) also moved it, and
      // continuing would answer that question inside the old reply.
      checkLeaf: async () =>
        targetId && this._recoveryLeaf()?.id !== targetId
          ? { moved: true, reason: "conversation_changed" }
          : { moved: false },
      // `continueLastTurn` repairs interrupted server-tool orphans before it
      // re-enters inference (`_repairInterruptedToolsBeforeTurn`), so the
      // next `convertToModelMessages` doesn't 400 with
      // `AI_MissingToolResultsError`.
      runTurn: (signal, context) => {
        onTurnStarted?.();
        // The pinned context rides on the options object, through a
        // subclass's `continueLastTurn` override too.
        const options: ProgrammaticTurnOptions = { ...context, signal };
        return this.continueLastTurn(undefined, options);
      }
    });
  }

  /**
   * Route a live stream interruption (the {@link chatStreamStallTimeoutMs}
   * watchdog fired, or the provider failed with a transient error) into the
   * bounded recovery a deploy or eviction interruption uses (#1626). The
   * shared engine owns the sequence. This supplies what is `AIChatAgent`'s:
   * the live message is already the stored partial, so keeping it is a no-op
   * and dropping it deletes it.
   *
   * On `"declined"` and `"failed"` the caller delivers its ordinary terminal
   * error.
   */
  private _routeStreamInterruption(
    input: StreamInterruptionRoute
  ): Promise<StreamInterruptionOutcome> {
    const liveTurn = this._liveChatRecoveryTurns.get(input.requestId);
    // The turn's own tools and body. A pinned turn never wrote them to the
    // stored context.
    const turnContext = this._chatTurnFibers.requestContext(
      input.requestId
    ) ?? {
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools
    };
    const latestUserMessageId =
      [...this.messages].reverse().find((m) => m.role === "user")?.id ?? null;
    return this._chatRecoveryEngine().routeStreamInterruption({
      requestId: input.requestId,
      streamId: input.streamId,
      partialParts: input.partialParts,
      backoff: input.backoff,
      error: input.error,
      latestUserMessageId,
      originMessageIds: this._originMessageIdsFor(input.requestId),
      // A new turn (not a continuation) whose question is still the latest
      // message has nothing stored to continue.
      retryTargetUserId: async () => {
        const leaf = this.messages.at(-1);
        return !input.continuation && leaf?.role === "user" ? leaf.id : null;
      },
      onChatRecovery: (context) =>
        this.onChatRecovery({
          incidentId: context.incidentId,
          recoveryRootRequestId: context.recoveryRootRequestId,
          attempt: context.attempt,
          maxAttempts: context.maxAttempts,
          recoveryKind: context.recoveryKind,
          streamId: context.streamId,
          requestId: context.requestId,
          partialText: context.partialText,
          partialParts: context.partialParts,
          recoveryData: liveTurn?.recoveryData ?? null,
          messages: [...this.messages],
          ...turnContext,
          createdAt: liveTurn?.createdAt ?? context.firstSeenAt
        }),
      resolvePartial: async (keep) => {
        if (keep) return input.targetAssistantId;
        await input.discardPartial();
        // A continuation's message was there before this turn and stays.
        return input.continuation ? input.targetAssistantId : undefined;
      },
      requestContext: () => turnContext
    });
  }

  /**
   * Terminalize a recovery turn that has run out of stable-state-timeout retry
   * budget — or whose incident record has vanished — by routing through the
   * SAME `_exhaustChatRecovery` path as deploy-recovery exhaustion. It fires
   * `onExhausted`, emits `chat:recovery:exhausted`, and delivers the configured
   * `terminalMessage`.
   *
   * This replaces the older give-up that only set the incident to `failed`,
   * which bypassed `_exhaustChatRecovery` entirely — so an app relying on
   * `onExhausted` for the terminal banner regressed to an eternal spinner when
   * recovery gave up under extreme churn. Shared by `_chatRecoveryRetry` and
   * `_chatRecoveryContinue`; mirrors the same helper in `@cloudflare/think`.
   *
   * Exactly-once terminalization here rests SOLELY on the
   * `stored?.status === "exhausted"` re-entry guard below — unlike
   * `@cloudflare/think`, `@cloudflare/ai-chat` has no durable-submission layer
   * to short-circuit a duplicate alarm earlier. The incident read/write are
   * best-effort because they back only that guard, not the terminal UX: a
   * failed read synthesizes the incident and a failed seal write costs at most
   * a re-delivered banner on a duplicate alarm.
   *
   * Two residual at-least-once edges, both deliberately accepted as "deliver a
   * second banner" ≫ "silently drop the turn":
   *  • No `incidentId` at all in the payload (only reachable via a direct/test
   *    invocation — every production recovery enqueue carries one): the
   *    synthesized incident can't be persisted (no key), so the guard can't
   *    arm.
   *  • The record is swept AGAIN between two alarms (the guard re-persists on
   *    the first, so this needs a second independent sweep) — vanishingly
   *    unlikely.
   */
  /**
   * Host memory-limit policy hook (#1825), dispatched structurally by
   * Lifecycle's circuit breaker — protected because it is framework
   * machinery, not part of the public chat API. Tasks applies the breaker to
   * root recovery runs; the routed dynamic-agent fallback applies it to
   * `recoveryLoop` schedule rows (see `RecoveryLoopScheduleOptions`). At the
   * strike budget this hook seals active incidents via
   * `ChatRecoveryEngine.sealMemoryLimitedRecovery`.
   */
  protected async onAlarmMemoryLimit(context: { readonly sealed: boolean }) {
    if (!context.sealed) return;
    await this._chatRecoveryEngine().sealMemoryLimitedRecovery();
  }

  private _shouldRetryRecoveredPreStreamTurn(
    snapshot: ChatFiberSnapshot | null,
    streamId: string,
    partial: { text: string; parts: unknown[] }
  ): snapshot is ChatFiberSnapshot & {
    latestUserMessageId: string;
  } {
    if (
      !snapshot ||
      snapshot.continuation ||
      !snapshot.latestUserMessageId ||
      streamId ||
      partial.text ||
      partial.parts.length > 0
    ) {
      return false;
    }

    const lastMessage = this._recoveryLeaf();
    return (
      lastMessage?.role === "user" &&
      lastMessage.id === snapshot.latestUserMessageId
    );
  }

  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    await this._chatRecoveryEngine().runRecoveryCallback(
      "_chatRecoveryRetry",
      data
    );
  }

  protected async _chatRecoveryRetryDetached(
    data?: ChatRecoveryRetryData,
    onTurnStarted?: () => void
  ): Promise<void> {
    await this._chatRecoveryEngine().runRecoveredTurn({
      callback: "_chatRecoveryRetry",
      data,
      // The turn of an agent-tool run its parent cancelled is not recovered.
      admit: () =>
        this._agentToolRuns.admitRecoveredTurn(
          data,
          (incidentId, status, reason) =>
            this._chatRecoveryEngine().updateIncident(
              incidentId,
              status,
              reason
            )
        ),
      ...this._recoveryRetrySteps(data?.targetUserId, onTurnStarted)
    });
  }

  /**
   * The leaf check and the turn of a recovery that answers the latest
   * question again: a retry attempt, and a continue attempt whose reply held
   * nothing and was removed.
   */
  private _recoveryRetrySteps(
    targetUserId: string | undefined,
    onTurnStarted?: () => void
  ): {
    checkLeaf(): Promise<RecoveryLeafCheck>;
    runTurn(
      signal: AbortSignal,
      context: PinnedTurnContext<ClientToolSchema>
    ): Promise<SaveMessagesResult>;
  } {
    return {
      checkLeaf: async () => {
        const lastMessage = this._recoveryLeaf();
        if (!lastMessage || lastMessage.role !== "user") {
          return { moved: true, reason: "no_unanswered_user_message" };
        }
        if (targetUserId && lastMessage.id !== targetUserId) {
          return { moved: true, reason: "conversation_changed" };
        }
        return { moved: false };
      },
      // `_retryLastUserTurn` repairs any interrupted tool orphan before it
      // re-enters inference, like `continueLastTurn`.
      runTurn: (signal, context) => {
        onTurnStarted?.();
        return this._retryLastUserTurn({ ...context, signal });
      }
    };
  }

  /**
   * Extract partial text and parts from stored stream chunks.
   */
  private _getPartialStreamText(streamId: string): {
    text: string;
    parts: MessagePart[];
    hasSettledToolResults: boolean;
  } {
    return aiSdkRecoveryCodec.toRecoveryPartial(
      this._resumableStream.getStreamChunks(streamId).map((chunk) => chunk.body)
    );
  }

  /**
   * The turn whose finished stream is waiting for its message write: the
   * cutover rides on the instance, not on an argument, so a subclass that
   * overrides {@link persistMessages} and calls `super` with only the
   * messages still lands the message, the stream's settlement and the
   * deletion of its rows in one transaction. Consumed by the first persist
   * that carries the turn's message; cleared when the turn ends.
   */
  #pendingCutover: {
    streamId: string;
    messageId: string;
    discard: boolean;
  } | null = null;

  async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    /** @internal */
    options?: { _deleteStaleRows?: boolean }
  ) {
    const incoming = this._incomingPersistScope.getStore();
    // A client request's messages, admitted before the chat was cleared:
    // writing them now would put the cleared history back.
    if (incoming?.isCurrent() === false) return;
    // Snapshot the pre-write transcript: `this.messages` is mirrored from the
    // change feed and therefore mutates as the loop below writes.
    const priorMessages = [...this.messages];
    const priorById = new Map(priorMessages.map((m) => [m.id, m]));
    const reconciled = reconcileMessages(messages, priorMessages, (msg) =>
      this._sanitizeMessageForPersistence(msg)
    );
    // A client's copy of a reply can be behind the stored one (the tab that
    // pressed stop has one chunk fewer). It never shortens the stored reply.
    const mergedMessages = incoming
      ? keepStoredReplies(reconciled, priorMessages)
      : reconciled;

    const toWrite: UIMessage[] = [];
    for (const message of mergedMessages) {
      const resolved = this._sanitizeMessageForPersistence(message);
      // The live array mirrors storage, so a message serializing to what it
      // already holds is already stored. Comparing here is a string compare;
      // letting Sessions discover it would cost a row read and, for media, a
      // decode and hash of every payload on every turn.
      const prior = priorById.get(resolved.id);
      if (prior && JSON.stringify(prior) === JSON.stringify(resolved)) continue;
      toWrite.push(resolved);
    }
    // The cutover: a persist that carries the finished turn's message
    // lands every changed message in the same transaction that settles the
    // stream and drops its rows. A persist of other messages (an override
    // writing its own first) takes the plain path and leaves the cutover
    // pending. The change feed (and auto-compaction) run once the
    // transaction has committed.
    const cutover = this.#pendingCutover;
    if (
      cutover &&
      mergedMessages.some((message) => message.id === cutover.messageId)
    ) {
      this.#pendingCutover = null;
      const sync = this.#session.__DO_NOT_USE_WILL_BREAK__sync();
      const afters: Array<() => Promise<void>> = [];
      try {
        this._resumableStream.cutover(
          cutover.streamId,
          () => {
            for (const message of toWrite)
              afters.push(sync.upsert(message).after);
          },
          { discard: cutover.discard }
        );
      } catch (error) {
        // The settle transaction rolled back: no row landed, but the
        // session's in-memory caches already counted the writes.
        sync.abandon();
        throw error;
      }
      for (const after of afters) await after();
    } else {
      for (const message of toWrite) await this.#session.upsertMessage(message);
    }

    // Regeneration can submit a strict subset of the server transcript. Keep
    // the old subset guard, but delete through Sessions so descendants splice
    // to their grandparent instead of breaking the active path.
    if (options?._deleteStaleRows) {
      const serverIds = new Set(priorMessages.map((message) => message.id));
      const isSubsetOfServer = mergedMessages.every((message) =>
        serverIds.has(message.id)
      );
      if (isSubsetOfServer) {
        const keepIds = new Set(mergedMessages.map((message) => message.id));
        await this._deleteMessagesByIds(
          this.messages
            .map((message) => message.id)
            .filter((id) => !keepIds.has(id))
        );
      }
    }

    // Retention counts STORED rows, not the hydrated window: a transcript
    // larger than the hydration budget holds rows this.messages never saw.
    if (this.maxPersistedMessages != null) {
      const stored = await this.#session.getHistoryRowStats();
      const excess = stored.length - this.maxPersistedMessages;
      if (excess > 0) {
        await this._deleteMessagesByIds(
          stored.slice(0, excess).map((row) => row.id)
        );
      }
    }

    this._broadcastChatMessage(
      {
        messages: mergedMessages,
        type: MessageType.CF_AGENT_CHAT_MESSAGES
      },
      excludeBroadcastIds
    );
  }

  /**
   * Finds an existing assistant message that contains a tool part with the given toolCallId.
   * Used to detect when a tool result should update an existing message rather than
   * creating a new one.
   *
   * @param toolCallId - The tool call ID to search for
   * @returns The existing message if found, undefined otherwise
   */
  private _findMessageByToolCallId(toolCallId: string): UIMessage | undefined {
    for (const msg of this.messages) {
      if (msg.role !== "assistant") continue;

      for (const part of msg.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          return msg;
        }
      }
    }
    return undefined;
  }

  private _findLastAssistantMessage(): UIMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        return this.messages[i];
      }
    }

    return undefined;
  }

  private _createStreamingAssistantMessage(continuation: boolean): UIMessage {
    if (continuation) {
      const lastAssistant = this._findLastAssistantMessage();
      if (lastAssistant) {
        // A text or reasoning part the interruption left streaming is closed
        // (the shared `settleInterruptedPart`). The continuation opens parts
        // of its own after it, so its reasoning and text follow in the order
        // the model wrote them.
        const clone = structuredClone(lastAssistant);
        return { ...clone, parts: clone.parts.map(settleInterruptedPart) };
      }
    }

    return {
      id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      role: "assistant",
      parts: []
    };
  }

  /**
   * Applies the ai-chat-specific normalization Sessions does not do.
   *
   * Sessions already strips OpenAI ephemeral fields (itemId,
   * reasoningEncryptedContent) and drops truly empty reasoning parts on every
   * write, so those steps are not repeated here.
   *
   * Pipeline:
   *
   * 1. **Truncate provider-executed tool payloads**: Server-side tool
   *    executions (e.g. Anthropic code_execution, text_editor) can produce
   *    200KB+ payloads in `input` and `output`. These are truncated since the
   *    model has already consumed the results.
   *
   * 2. **User hook**: Calls the overridable `sanitizeMessageForPersistence()`
   *    method, allowing subclasses to apply custom transformations.
   *
   * @param message - The message to sanitize
   * @returns A new message with ai-chat's normalization applied
   */
  private _sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    // ai-chat-specific: truncate large payloads in provider-executed tool parts
    const parts = message.parts.map((part) =>
      AIChatAgent._truncateProviderExecutedToolPayloads(part)
    ) as UIMessage["parts"];

    // Run user-overridable hook last
    return this.sanitizeMessageForPersistence({
      ...message,
      parts
    });
  }

  /**
   * Truncates large string values in `input` and `output` of tool parts that
   * were executed server-side by the provider (e.g. Anthropic code_execution,
   * text_editor). These payloads can be 200KB+ and are dead weight once the
   * model has consumed the result.
   *
   * Anthropic web tools are excluded because their outputs are replayed on
   * subsequent turns. Within other tool payloads, opaque encrypted fields are
   * always preserved verbatim.
   */
  private static _truncateProviderExecutedToolPayloads<
    T extends UIMessage["parts"][number]
  >(part: T): T {
    const record = part as Record<string, unknown>;
    if (!record.providerExecuted) return part;
    if (AIChatAgent._shouldPreserveProviderToolPayload(record)) return part;

    const result = { ...record };

    if (result.input !== undefined) {
      result.input = AIChatAgent._truncateLargeStrings(result.input);
    }
    if (result.output !== undefined) {
      result.output = AIChatAgent._truncateLargeStrings(result.output);
    }

    return result as T;
  }

  /**
   * Recursively walks a value and truncates any string exceeding
   * `PROVIDER_TOOL_MAX_STRING_LENGTH`, appending a size marker.
   *
   * The total output (content + marker) is kept within the threshold so
   * re-running this function on already-truncated data is a no-op. Strings
   * under opaque encrypted keys are preserved verbatim.
   */
  private static _truncateLargeStrings(
    value: unknown,
    preserveOpaqueStrings = false
  ): unknown {
    if (typeof value === "string") {
      if (preserveOpaqueStrings) return value;
      if (value.length > PROVIDER_TOOL_MAX_STRING_LENGTH) {
        const marker = `… [truncated, original length: ${value.length}]`;
        const contentLength = Math.max(
          0,
          PROVIDER_TOOL_MAX_STRING_LENGTH - marker.length
        );
        return value.slice(0, contentLength) + marker;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) =>
        AIChatAgent._truncateLargeStrings(v, preserveOpaqueStrings)
      );
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = AIChatAgent._truncateLargeStrings(
          v,
          preserveOpaqueStrings || AIChatAgent._isOpaqueReplayFieldKey(k)
        );
      }
      return result;
    }
    return value;
  }

  private static _shouldPreserveProviderToolPayload(
    part: Record<string, unknown>
  ): boolean {
    const toolName = AIChatAgent._getToolNameFromPart(part);
    return toolName === "web_search" || toolName === "web_fetch";
  }

  private static _getToolNameFromPart(
    part: Record<string, unknown>
  ): string | undefined {
    if (typeof part.toolName === "string") {
      return part.toolName;
    }

    if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      return part.type.slice("tool-".length);
    }

    return undefined;
  }

  private static _isOpaqueReplayFieldKey(key: string): boolean {
    return key.startsWith(PROVIDER_TOOL_OPAQUE_STRING_KEY_PREFIX);
  }

  /**
   * Delete message rows through Sessions. The change feed removes them from
   * `this.messages`.
   */
  private async _deleteMessagesByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#session.deleteMessages(ids);
  }

  /**
   * Shared helper for finding a tool part by toolCallId and applying an update.
   * Handles both streaming (in-memory) and persisted (SQLite) messages.
   *
   * Checks _streamingMessage first (tool results/approvals can arrive while
   * the AI is still streaming), then retries persisted messages with backoff
   * in case streaming completes between attempts.
   *
   * `applyUpdate` may return its argument by reference (or `{ ...part }`
   * with no semantic changes) to signal an idempotent no-op — this is
   * detected via `_isToolPartUnchanged` and short-circuits the SQLite
   * write and `MESSAGE_UPDATED` broadcast.
   *
   * @param toolCallId - The tool call ID to find
   * @param callerName - Name for log messages (e.g. "_settleToolResult")
   * @param matchStates - Which tool part states to match
   * @param applyUpdate - Mutation to apply to the matched part (streaming: in-place, persisted: spread)
   * @returns true if the update was applied (or matched as an idempotent
   *   no-op), false if no matching part was found
   */
  private async _findAndUpdateToolPart(
    toolCallId: string,
    callerName: string,
    matchStates: string[],
    applyUpdate: (part: Record<string, unknown>) => Record<string, unknown>
  ): Promise<boolean> {
    return (
      (
        await this._updateToolPart(
          toolCallId,
          callerName,
          matchStates,
          applyUpdate
        )
      ).status !== "missing"
    );
  }

  /**
   * {@link _findAndUpdateToolPart}, reporting whether the update changed the
   * part, was an idempotent no-op, or found no part to update.
   */
  private async _updateToolPart(
    toolCallId: string,
    callerName: string,
    matchStates: string[],
    applyUpdate: (part: Record<string, unknown>) => Record<string, unknown>
  ): Promise<ToolInteractionOutcome> {
    // Find the message containing this tool call: the reply in flight first
    // (streaming, or finished and being stored), then the stored transcript.
    // One look, no retry: applies run one at a time, so waiting here for a
    // call that does not exist would stall every result queued behind it.
    // The reply in flight covers every moment a reply exists and is not yet
    // stored, so there is nothing to wait for.
    let message: UIMessage | undefined;

    const inFlight = this._replyInFlight();
    if (inFlight) {
      for (const part of inFlight.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          message = inFlight;
          break;
        }
      }
    }

    message ??= this._findMessageByToolCallId(toolCallId);

    if (!message) {
      console.warn(
        `[AIChatAgent] ${callerName}: Could not find message with toolCallId ${toolCallId}`
      );
      return { status: "missing" };
    }

    const isStreamingMessage = message === inFlight;
    // `wasFound` tracks whether any matching part was processed (real
    // change OR idempotent no-op). `hasRealChange` tracks whether any
    // apply actually mutated state. Tracking both separately matters
    // when a (legacy) message somehow contains duplicate tool parts for
    // the same toolCallId — we must still persist if any of them
    // produced a real change, even if another was an idempotent no-op.
    let wasFound = false;
    let hasRealChange = false;

    if (isStreamingMessage) {
      // Update in place -- the message will be persisted when streaming completes
      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          matchStates.includes(part.state as string)
        ) {
          wasFound = true;
          const applied = applyUpdate(part as Record<string, unknown>);
          if (
            !AIChatAgent._isToolPartUnchanged(
              part as Record<string, unknown>,
              applied
            )
          ) {
            Object.assign(part, applied);
            hasRealChange = true;
            // A reply that is being stored may already have been written
            // without this change: `_reply` stores it again.
            if (this._replyBeingStored?.message === message) {
              this._replyBeingStored.dirty = true;
            }
          }
          break;
        }
      }
    } else {
      // For persisted messages, create updated parts immutably
      const updatedParts = message.parts.map((part) => {
        if (
          "toolCallId" in part &&
          part.toolCallId === toolCallId &&
          "state" in part &&
          matchStates.includes(part.state as string)
        ) {
          wasFound = true;
          const applied = applyUpdate(part as Record<string, unknown>);
          if (
            AIChatAgent._isToolPartUnchanged(
              part as Record<string, unknown>,
              applied
            )
          ) {
            return part;
          }
          hasRealChange = true;
          return applied;
        }
        return part;
      }) as UIMessage["parts"];

      if (hasRealChange) {
        const updatedMessage: UIMessage = this._sanitizeMessageForPersistence({
          ...message,
          parts: updatedParts
        });
        // The change feed patches `this.messages`. A `null` result means the
        // row is not in storage (nothing to mirror), so patch the live view
        // directly to keep the in-memory transcript consistent.
        const stored = await this.#session.updateMessage(updatedMessage);
        if (!stored) {
          const index = this.messages.findIndex(
            (candidate) => candidate.id === updatedMessage.id
          );
          if (index !== -1) {
            this.messages[index] = autoTransformMessages([updatedMessage])[0];
          }
        }
      }
    }

    if (!wasFound) {
      console.warn(
        `[AIChatAgent] ${callerName}: Tool part with toolCallId ${toolCallId} not in expected state (expected: ${matchStates.join("|")})`
      );
      return { status: "missing" };
    }

    // Idempotent no-op: caller asked us to apply something we'd already
    // applied (e.g. a duplicate cf_agent_tool_result, or a cross-tab
    // re-delivery). Skip the broadcast — clients are already in the
    // correct state and a redundant MESSAGE_UPDATED would just churn UI.
    if (!hasRealChange) {
      return { status: "unchanged" };
    }

    // Broadcast the update to all clients.
    // For persisted messages, re-fetch the latest state from this.messages.
    // For streaming messages, broadcast the in-memory snapshot so clients
    // get immediate confirmation that the tool result/approval was applied.
    if (isStreamingMessage) {
      this._broadcastChatMessage({
        type: MessageType.CF_AGENT_MESSAGE_UPDATED,
        message
      });
    } else {
      const broadcastMessage = this._findMessageByToolCallId(toolCallId);
      if (broadcastMessage) {
        this._broadcastChatMessage({
          type: MessageType.CF_AGENT_MESSAGE_UPDATED,
          message: broadcastMessage
        });
      }
    }

    return { status: "changed", messageId: message.id };
  }

  /**
   * Returns true if `applied` is the same reference as `original`, or if
   * the two have identical state-relevant fields. Used by
   * `_findAndUpdateToolPart` to detect idempotent re-applies and skip
   * SQLite writes plus `MESSAGE_UPDATED` broadcasts.
   */
  private static _isToolPartUnchanged(
    original: Record<string, unknown>,
    applied: Record<string, unknown>
  ): boolean {
    if (applied === original) return true;
    if (applied.state !== original.state) return false;
    // For terminal output states, the only fields the apply functions
    // touch are output / errorText / preliminary. Compare via JSON so
    // structurally equal outputs (the common idempotent case) compare
    // equal regardless of reference identity.
    if (
      applied.state === "output-available" ||
      applied.state === "output-error"
    ) {
      return (
        JSON.stringify(applied.output) === JSON.stringify(original.output) &&
        applied.errorText === original.errorText &&
        applied.preliminary === original.preliminary
      );
    }
    if (applied.state === "output-denied") {
      return true;
    }
    if (
      applied.state === "approval-responded" ||
      applied.state === "approval-requested"
    ) {
      return (
        JSON.stringify(applied.approval) === JSON.stringify(original.approval)
      );
    }
    return false;
  }

  /**
   * Serialize a client-tool result/approval apply behind any in-flight apply
   * (#1649, defensive). Each apply is a read-modify-write of the message and
   * parallel tool results arrive as independent WebSocket messages. Today
   * `_findAndUpdateToolPart` performs that read-modify-write synchronously (no
   * await between reading `this.messages` and the SQLite write), so concurrent
   * applies can't actually interleave — unlike Think, ai-chat does not exhibit
   * the #1649 clobber. This queue is a guard so the invariant survives if the
   * apply ever gains an await between read and write (e.g. async storage): each
   * apply commits atomically in arrival order.
   *
   * `_pendingInteractionPromise` is set to the newest link so the barrier's
   * single-slot wake-up observes the latest apply; because the chain is serial,
   * awaiting it transitively waits for every predecessor.
   *
   * @internal
   */
  protected _enqueueInteractionApply(
    apply: () => Promise<boolean>
  ): Promise<boolean> {
    return this._turns.enqueueInteraction(apply);
  }

  /**
   * Applies a tool result to an existing assistant message.
   * This is used when the client sends CF_AGENT_TOOL_RESULT for client-side tools.
   * The server is the source of truth, so we update the message here and broadcast
   * the update to all clients.
   *
   * `output-available` and `output-error` are accepted as valid starting
   * states for *idempotent* re-application — duplicate WS frames, second
   * tabs re-running the same tool, and provider-replay round-trips all
   * become silent no-ops rather than a warn + skipped update. The first
   * applied terminal result wins; subsequent results carrying *different*
   * data are also dropped (preserving the existing "first write wins"
   * contract — see `client-tool-duplicate-message.test.ts`). See issue
   * #1404.
   *
   * @param toolCallId - The tool call ID this result is for
   * @param _toolName - The name of the tool (unused, kept for API compat)
   * @param output - The output from the tool execution
   * @param overrideState - Optional state override ("output-error" to signal denial/failure)
   * @param errorText - Error message when overrideState is "output-error"
   * @returns What the apply did to the part: changed it, left it as it was
   *   (an idempotent re-apply), or found no part.
   */
  private async _settleToolResult(
    toolCallId: string,
    _toolName: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<ToolInteractionOutcome> {
    return this._updateToolPart(
      toolCallId,
      "_settleToolResult",
      [
        "input-available",
        "approval-requested",
        "approval-responded",
        // Idempotent re-apply: if the part is already terminal, the apply
        // function below returns the part by reference. _findAndUpdateToolPart
        // detects that and skips the persist + broadcast (and the warn).
        "output-available",
        "output-error",
        "output-denied"
      ],
      (part) => {
        // Once a tool part has reached a terminal state, the first applied
        // result wins. Don't overwrite with conflicting data, and don't
        // emit a redundant MESSAGE_UPDATED for a matching re-apply.
        if (
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied"
        ) {
          return part;
        }
        if (overrideState === "output-error") {
          return {
            ...part,
            state: "output-error",
            errorText: errorText ?? "Tool execution denied by user"
          };
        }
        return {
          ...part,
          state: "output-available",
          output,
          preliminary: false
        };
      }
    );
  }

  private async _streamSSEReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: UIMessage,
    streamCompleted: { value: boolean },
    continuation = false,
    abortSignal?: AbortSignal
  ): Promise<StreamResultStatus> {
    streamCompleted.value = false;

    // Cancel the reader when the abort signal fires (e.g. client pressed stop).
    // This ensures we stop broadcasting chunks even if the underlying stream
    // hasn't been connected to the abort signal (e.g. user forgot to pass it
    // to streamText).
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    // Route reads through the shared inactivity watchdog when a stall timeout is
    // configured. The watchdog aborts a stream that parks between chunks (a hung
    // provider/transport) by cancelling the reader and throwing
    // `ChatStreamStalledError`, which the read-loop catch propagates so `_reply`
    // can route the stall into bounded recovery (#1626). A `0` timeout (the
    // default) keeps the raw `reader.read()` path untouched.
    const stallTimeoutMs = this.chatStreamStallTimeoutMs;
    let pull: () => Promise<ReadableStreamReadResult<Uint8Array>>;
    if (stallTimeoutMs > 0) {
      const byteSource: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              const { done, value } = await reader.read();
              return done || value === undefined
                ? { done: true, value: undefined }
                : { done: false, value };
            },
            async return(): Promise<IteratorResult<Uint8Array>> {
              await reader.cancel().catch(() => {});
              return { done: true, value: undefined };
            }
          };
        }
      };
      const guarded = iterateWithStallWatchdog(
        byteSource,
        stallTimeoutMs,
        () => {
          // Unblock the abandoned `reader.read()` so the pipeline unwinds; the
          // thrown `ChatStreamStalledError` carries the recovery decision.
          reader.cancel().catch(() => {});
        }
      )[Symbol.asyncIterator]();
      pull = async () => {
        const next = await guarded.next();
        return next.done
          ? { done: true, value: undefined }
          : { done: false, value: next.value };
      };
    } else {
      pull = () => reader.read();
    }

    while (true) {
      if (abortSignal?.aborted) break;
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await pull();
      } catch (readError) {
        if (abortSignal?.aborted) break;
        throw readError;
      }
      const { done, value } = readResult;
      if (done) {
        // reader.cancel() resolves read() with { done: true } — check abort
        if (abortSignal?.aborted) break;
        this._finishStream(streamId);
        streamCompleted.value = true;
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return { status: "completed" };
      }

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const data: UIMessageChunk = JSON.parse(line.slice(6));

            // Drop replay chunks before applying or broadcasting them.
            //
            // Some providers (notably the OpenAI Responses API) re-emit
            // prior tool calls as a fresh `tool-input-start` →
            // `tool-input-delta` → `tool-input-available` sequence
            // carrying the *same* `toolCallId` during continuation
            // streams. AI SDK v6's `updateToolPart` finds an existing
            // part by toolCallId and mutates it in place, which
            // visibly regresses an `output-available` part back to
            // `input-streaming`/`input-available` on the client
            // (issue #1404).
            //
            // `applyChunkToParts` handles the server-side cloned
            // streaming message safely (it's idempotent for these
            // chunk types), but we must also stop these chunks from
            // reaching the client-side AI SDK, where the in-place
            // mutation would corrupt a resolved tool part.
            //
            // `tool-output-available` is not filtered: its in-place
            // update sets state and output to the values the part
            // already has when the replay matches, so it's
            // semantically a no-op on the client too.
            if (isReplayChunk(message.parts, data as StreamChunkData)) {
              // A `tool-input-available` that lands after its approval
              // request still carries the canonical input the approved
              // call executes with. Refresh the approval snapshot persisted
              // without it, and forward it followed by the approval request
              // again so clients show the input on the approval card.
              if (
                applyLateToolInput(message.parts, data as StreamChunkData) &&
                this._approvalPersistedMessageId !== null &&
                this._streamingMessage
              ) {
                await this.#session.upsertMessage(
                  this._sanitizeMessageForPersistence({
                    ...this._streamingMessage,
                    parts: [...this._streamingMessage.parts]
                  })
                );
              }
              for (const forwarded of lateToolInputForwardChunks(
                message.parts,
                data as StreamChunkData
              )) {
                const chunkBody = JSON.stringify(forwarded);
                const seq = await this._storeStreamChunk(streamId, chunkBody);
                this._broadcastChatMessage({
                  body: chunkBody,
                  done: false,
                  id,
                  type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                  ...(seq !== undefined && { seq }),
                  ...(continuation && { continuation: true })
                });
              }
              continue;
            }

            // Delegate message building to the shared parser.
            // It handles: text, reasoning, file, source, tool lifecycle,
            // step boundaries — all the part types needed for UIMessage.
            const handled = applyChunkToParts(message.parts, data);

            // When a tool enters approval-requested state, the stream is
            // paused waiting for user approval. Persist the streaming message
            // immediately so the approval UI survives page refresh. Without
            // this, a refresh would reload from SQLite where the tool part
            // is still in input-available state, showing "Running..." instead
            // of the Approve/Reject buttons.
            if (
              data.type === "tool-approval-request" &&
              this._streamingMessage
            ) {
              // Persist directly to SQLite without broadcasting.
              // The client already has this data from the SSE stream —
              // broadcasting would cause the approval UI to render twice.
              // We only need the SQL write so the state survives page refresh.
              const snapshot: UIMessage = {
                ...this._streamingMessage,
                parts: [...this._streamingMessage.parts]
              };
              const sanitized = this._sanitizeMessageForPersistence(snapshot);
              const stored = await this.#session.upsertMessage(sanitized);
              // Track that we persisted early so stream completion can update
              // in place rather than appending a duplicate.
              this._approvalPersistedMessageId = stored.message.id;
            }

            // Cross-message tool output fallback:
            // When a tool with needsApproval is approved, the continuation
            // stream emits tool-output-available/tool-output-error for a
            // tool call that lives in a *previous* assistant message.
            // applyChunkToParts only searches the current message's parts,
            // so the update is silently skipped. Fall back to searching
            // this.messages and update the persisted message directly.
            // Note: checked independently of `handled` — applyChunkToParts
            // returns true for recognized chunk types even when it cannot
            // find the target part, so `handled` is not a reliable signal.
            //
            // `output-available` and `output-error` are accepted as
            // starting states for idempotent re-application. Some
            // providers (notably the OpenAI Responses API) replay the
            // entire prior tool round-trip during continuations — the
            // replay's tool-output-available carries the same output the
            // part already has, so the apply functions below short-circuit
            // to a no-op via reference equality (issue #1404).
            if (
              (data.type === "tool-output-available" ||
                data.type === "tool-output-error") &&
              data.toolCallId
            ) {
              const foundInCurrentMessage = message.parts.some(
                (p) => "toolCallId" in p && p.toolCallId === data.toolCallId
              );
              if (!foundInCurrentMessage) {
                if (data.type === "tool-output-available") {
                  this._findAndUpdateToolPart(
                    data.toolCallId,
                    "_streamSSEReply",
                    [
                      "input-available",
                      "input-streaming",
                      "approval-responded",
                      "approval-requested",
                      "output-available",
                      "output-error",
                      "output-denied"
                    ],
                    (part) => {
                      // First-write-wins: a chunk arriving for a tool
                      // that's already terminal is a provider replay.
                      // Never overwrite a resolved tool's output.
                      if (
                        part.state === "output-available" ||
                        part.state === "output-error" ||
                        part.state === "output-denied"
                      ) {
                        return part;
                      }
                      return {
                        ...part,
                        state: "output-available",
                        output: data.output,
                        ...(data.preliminary !== undefined && {
                          preliminary: data.preliminary
                        })
                      };
                    }
                  );
                } else {
                  this._findAndUpdateToolPart(
                    data.toolCallId,
                    "_streamSSEReply",
                    [
                      "input-available",
                      "input-streaming",
                      "approval-responded",
                      "approval-requested",
                      "output-available",
                      "output-error",
                      "output-denied"
                    ],
                    (part) => {
                      if (
                        part.state === "output-available" ||
                        part.state === "output-error" ||
                        part.state === "output-denied"
                      ) {
                        return part;
                      }
                      return {
                        ...part,
                        state: "output-error",
                        errorText: data.errorText
                      };
                    }
                  );
                }
              }
            }

            // Handle server-specific chunk types not covered by the shared parser
            if (!handled) {
              switch (data.type) {
                case "start": {
                  if (data.messageId != null && !continuation) {
                    message.id = data.messageId;
                  }
                  if (data.messageMetadata != null) {
                    message.metadata = message.metadata
                      ? { ...message.metadata, ...data.messageMetadata }
                      : data.messageMetadata;
                  }
                  break;
                }
                case "finish":
                case "message-metadata": {
                  if (data.messageMetadata != null) {
                    message.metadata = message.metadata
                      ? { ...message.metadata, ...data.messageMetadata }
                      : data.messageMetadata;
                  }
                  break;
                }
                case "finish-step": {
                  // No-op for message building (shared parser handles step-start)
                  break;
                }
                case "error": {
                  const error =
                    data.errorText ?? JSON.stringify({ type: data.type });
                  this._broadcastChatMessage({
                    error: true,
                    body: error,
                    done: false,
                    id,
                    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                    ...(continuation && { continuation: true })
                  });
                  this._markStreamError(streamId);
                  this._emit("message:error", { error });
                  await reader.cancel().catch(() => {});
                  streamCompleted.value = true;
                  this._broadcastChatMessage({
                    body: "",
                    done: true,
                    id,
                    type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                    outcome: "error",
                    ...(continuation && { continuation: true })
                  });
                  return { status: "error", error };
                }
              }
            }

            // Rewrite chunks before storing and broadcasting:
            // 1. Strip messageId from continuation start chunks so clients
            //    reuse the existing assistant message (#1229).
            // 2. Stamp the allocated assistant id onto a new turn's start chunk
            //    so the client builds the live message under the SAME id the
            //    server persists under (see below).
            // 3. Convert the internal "finish" event's finishReason into the
            //    UIMessageStreamPart messageMetadata format (#677).
            let eventToSend: unknown = data;
            if (data.type === "start") {
              if (continuation && "messageId" in data) {
                const { messageId: _, ...rest } = data as {
                  messageId: unknown;
                  [key: string]: unknown;
                };
                eventToSend = rest;
              } else if (!continuation) {
                // Most providers (e.g. Workers AI) emit no `start.messageId`,
                // so the client's AI SDK would build the streaming assistant
                // under its own generated id while the server persists under
                // `message.id`. The two then can't be reconciled by id, and the
                // originating tab briefly renders the turn twice — the live copy
                // plus the `CF_AGENT_CHAT_MESSAGES` broadcast — before
                // collapsing. Stamping the allocated id here makes the common
                // case behave like the provider-id case the client already
                // relies on (react.tsx records `start.messageId` to map the
                // local stream to the persisted message).
                const startData = data as {
                  messageId?: unknown;
                  [key: string]: unknown;
                };
                if (startData.messageId == null) {
                  eventToSend = { ...startData, messageId: message.id };
                }
              }
            }
            if (data.type === "finish" && "finishReason" in data) {
              const { finishReason: chunkFinishReason, ...rest } = data as {
                finishReason: string;
                [key: string]: unknown;
              };
              eventToSend = {
                ...rest,
                type: "finish",
                messageMetadata: { finishReason: chunkFinishReason }
              };
            }

            // Store chunk for replay and broadcast to clients
            const chunkBody = JSON.stringify(eventToSend);
            const seq = await this._storeStreamChunk(streamId, chunkBody);
            this._broadcastChatMessage({
              body: chunkBody,
              done: false,
              id,
              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
              ...(seq !== undefined && { seq }),
              ...(continuation && { continuation: true })
            });
          } catch (_error) {
            // Skip malformed JSON lines silently
          }
        }
      }
    }

    // If we exited due to abort, send a done signal so clients know the stream ended
    if (!streamCompleted.value) {
      this._finishStream(streamId, "aborted");
      streamCompleted.value = true;
      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        outcome: "aborted",
        ...(continuation && { continuation: true })
      });
      return { status: "aborted" };
    }

    return { status: "completed" };
  }

  // Handle plain text responses (e.g., from generateText)
  private async _sendPlaintextReply(
    id: string,
    streamId: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    message: UIMessage,
    streamCompleted: { value: boolean },
    continuation = false,
    abortSignal?: AbortSignal
  ): Promise<StreamResultStatus> {
    // A continuation opens a text part of its own. A part the interruption
    // left streaming was closed when the message was cloned.
    await this._broadcastTextEvent(
      streamId,
      { type: "text-start", id },
      continuation
    );

    // Use a single text part and accumulate into it, so the persisted message
    // has one text part regardless of how many network chunks the response spans.
    const textPart: TextUIPart = { type: "text", text: "", state: "streaming" };
    message.parts.push(textPart);

    // Cancel the reader when the abort signal fires
    if (abortSignal && !abortSignal.aborted) {
      abortSignal.addEventListener(
        "abort",
        () => {
          reader.cancel().catch(() => {});
        },
        { once: true }
      );
    }

    while (true) {
      if (abortSignal?.aborted) break;
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (readError) {
        if (abortSignal?.aborted) break;
        throw readError;
      }
      const { done, value } = readResult;
      if (done) {
        // reader.cancel() resolves read() with { done: true } — check abort
        if (abortSignal?.aborted) break;
        textPart.state = "done";

        await this._broadcastTextEvent(
          streamId,
          { type: "text-end", id },
          continuation
        );

        // Mark the stream as completed
        this._finishStream(streamId);
        streamCompleted.value = true;
        // Send final completion signal
        this._broadcastChatMessage({
          body: "",
          done: true,
          id,
          type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
          ...(continuation && { continuation: true })
        });
        return { status: "completed" };
      }

      const chunk = decoder.decode(value);

      // Accumulate into the single text part to preserve exact formatting
      if (chunk.length > 0) {
        textPart.text += chunk;
        await this._broadcastTextEvent(
          streamId,
          { type: "text-delta", id, delta: chunk },
          continuation
        );
      }
    }

    // If we exited due to abort, send a done signal so clients know the stream ended
    if (!streamCompleted.value) {
      textPart.state = "done";
      await this._broadcastTextEvent(
        streamId,
        { type: "text-end", id },
        continuation
      );
      this._finishStream(streamId, "aborted");
      streamCompleted.value = true;
      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        outcome: "aborted",
        ...(continuation && { continuation: true })
      });
      return { status: "aborted" };
    }

    return { status: "completed" };
  }

  /**
   * Applies a tool approval response from the client, updating the persisted message.
   * This is called when the client sends CF_AGENT_TOOL_APPROVAL for tools with needsApproval.
   *
   * - approved=true transitions to approval-responded
   * - approved=false transitions to output-denied so convertToModelMessages
   *   emits a tool_result for providers (e.g. Anthropic) that require it.
   *
   * @param toolCallId - The tool call ID this approval is for
   * @param approved - Whether the tool execution was approved
   * @returns What the apply did to the part.
   */
  private async _settleToolApproval(
    toolCallId: string,
    approved: boolean
  ): Promise<ToolInteractionOutcome> {
    // Use the shared `agents/chat` builder so the approval merge — including
    // the fallback that synthesizes `approval.id` from `toolCallId` when an
    // older / hand-seeded transcript lacks one — stays identical to Think.
    // convertToModelMessages needs `approval.id` to produce a valid
    // tool-approval-request content part with `approvalId`.
    const update = toolApprovalUpdate(toolCallId, approved);
    return this._updateToolPart(
      toolCallId,
      "_settleToolApproval",
      update.matchStates,
      update.apply
    );
  }

  private async _reply(
    id: string,
    response: Response,
    excludeBroadcastIds: string[] = [],
    options: {
      continuation?: boolean;
      chatMessageId?: string;
      /**
       * Called once the stream is set up. From then on `_reply` reports its
       * own failures to clients; a throw before it is the caller's to report.
       */
      onStreamStart?: () => void;
      /**
       * The turn's own abort signal: it cancels the reader loop when the
       * turn is stopped. Every turn hands it over. Looking it up in the
       * registry would find none once `abortAllRequests()` emptied it while
       * the turn waited on `onChatMessage`. This is a safety net — users
       * should also pass abortSignal to streamText for proper cancellation.
       */
      abortSignal?: AbortSignal;
    } = {}
  ): Promise<StreamResultStatus> {
    const {
      continuation = false,
      chatMessageId,
      onStreamStart,
      abortSignal
    } = options;
    // A chat clear (resetTurnState) bumps the queue generation and empties
    // the abort registry. A turn admitted before it must neither stream into
    // the cleared chat nor persist its reply there, even when its controller
    // is gone from the registry.
    const resetSinceTurnStarted = this._turns.turnResetGuard();

    // Keep the DO alive during streaming to prevent idle eviction
    return this.keepAliveWhile(() =>
      this._tryCatchChat(async () => {
        if (resetSinceTurnStarted()) {
          response.body?.cancel().catch(() => {});
          this._broadcastChatMessage({
            body: "",
            done: true,
            id,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            outcome: "aborted",
            ...(continuation && { continuation: true })
          });
          return { status: "aborted" };
        }
        if (!response.body) {
          // Send empty response if no body. A continuation turn that gets
          // here never streamed, and settles as such.
          this._broadcastChatMessage({
            body: "",
            done: true,
            id,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            ...(continuation && { continuation: true })
          });
          return { status: "completed" };
        }

        // Take the reader before the stream starts: an unreadable body must
        // fail while nothing has been sent, not leave a started stream behind.
        const reader = response.body.getReader();
        let message: UIMessage;
        let streamId: string;
        try {
          // Parsing state adapted from:
          // https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts#L295
          message = this._createStreamingAssistantMessage(continuation);

          // Start tracking this stream for resumability. The allocated message id
          // is persisted in stream metadata so orphan recovery (#1691) can
          // re-associate reconstructed chunks with the right assistant message —
          // even when the provider stream carries no `start.messageId`. For a
          // continuation this is the cloned last-assistant id, so recovery merges
          // into it; for a new turn it is a fresh id, so recovery keeps it
          // distinct.
          // The continuation flag is persisted in stream metadata so replayed
          // frames carry `continuation: true` exactly like the live broadcast
          // frames below (#1733) — a reconnecting client needs it to append to
          // the existing assistant message instead of rebuilding it from
          // scratch and dropping the pre-continuation parts.
          streamId = this._startStream(id, {
            messageId: message.id,
            continuation
          });
        } catch (error) {
          // The streaming `finally` that releases the reader is not entered yet.
          reader.cancel(error).catch(() => {});
          throw error;
        }

        // Track the streaming message so tool results can be applied before persistence
        this._streamingMessage = message;

        // Determine response format based on content-type
        const contentType = response.headers.get("content-type") || "";
        const isSSE = contentType.includes("text/event-stream"); // AI SDK v5 SSE format
        const streamCompleted = { value: false };
        let streamResult: StreamResultStatus = { status: "completed" };
        // Capture before try so it's available after finally.
        // _approvalPersistedMessageId is set inside _streamSSEReply when a
        // tool enters approval-requested state and the message is persisted early.
        let earlyPersistedId: string | null = null;
        // Set when a stall watchdog abort was routed into bounded recovery
        // (#1626): the orphan partial was already persisted and a continuation
        // (or terminal exhaustion) now owns the turn, so the post-stream
        // persistence + the success `message:response` emit below are skipped.
        let stallRouted = false;
        // Set when `onChatRecovery` returned `persist: false` for the routed
        // interruption: the partial is dropped instead of persisted.
        let discardPartial = false;

        // Stream-active gate for the auto-continuation barrier (#1650): while
        // this assistant turn is streaming the parallel tool batch can still
        // grow, so no completeness check is meaningful. The gate clears only in
        // the outer `finally` below — AFTER the streamed message (with all its
        // tool parts) is persisted to `this.messages` — so the re-armed barrier
        // check sees the fully-materialized batch.
        this._streamingTurnActive = true;
        this._heldTerminalFrames.set(id, []);
        let persisted = false;
        onStreamStart?.();
        try {
          try {
            if (isSSE) {
              // AI SDK v5 SSE format
              streamResult = await this._streamSSEReply(
                id,
                streamId,
                reader,
                message,
                streamCompleted,
                continuation,
                abortSignal
              );
            } else {
              streamResult = await this._sendPlaintextReply(
                id,
                streamId,
                reader,
                message,
                streamCompleted,
                continuation,
                abortSignal
              );
            }
          } catch (error) {
            // A stall watchdog abort (#1626) or a platform transient such as a
            // dropped connection (#1964) is a recoverable interruption, not a
            // terminal error. Persist the settled partial (so the continuation
            // re-anchors without re-running completed tool calls, and the user
            // keeps generated content), then route into bounded recovery.
            if (
              !streamCompleted.value &&
              (error instanceof ChatStreamStalledError ||
                (!abortSignal?.aborted && isRecoverableStreamReadError(error)))
            ) {
              // The partial generated so far lives on the in-memory `message`; the
              // unconditional post-stream persistence block below writes it under
              // `message.id` (the same path a normal turn uses), so the scheduled
              // continuation re-anchors onto it via `targetAssistantId`. (Unlike a
              // cold deploy recovery, there is no need to reconstruct from stored
              // chunks here — the live `message` is authoritative.)
              // A reply that holds nothing once its trailing reasoning is
              // gone is not stored, so recovery retries the question.
              const targetAssistantId = replyIsEmpty(
                stripTrailingReasoning(message)
              )
                ? undefined
                : message.id;
              const outcome = await this._routeStreamInterruption({
                requestId: id,
                streamId,
                partialParts: message.parts,
                targetAssistantId,
                continuation,
                backoff: !(error instanceof ChatStreamStalledError),
                error,
                discardPartial: async () => {
                  discardPartial = true;
                  // An approval request already persisted this turn's
                  // message; drop it too. A continuation's early persist
                  // overwrote the message it continues, which stays.
                  const earlyId = this._approvalPersistedMessageId;
                  if (!earlyId || continuation) return;
                  this._approvalPersistedMessageId = null;
                  await this._deleteMessagesByIds([earlyId]);
                  this._broadcastChatMessage({
                    messages: this._messagesForClientSync(),
                    type: MessageType.CF_AGENT_CHAT_MESSAGES
                  });
                }
              });
              if (outcome === "scheduled") {
                // Recovering: close the stream cleanly (no terminal error frame);
                // the scheduled continuation drives the turn to completion. Report
                // `aborted` so this attempt does not terminalize the turn.
                this._completeStream(streamId, "recovering");
                this._broadcastChatMessage({
                  body: "",
                  done: true,
                  id,
                  type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                  outcome: "recovering",
                  ...(continuation && { continuation: true })
                });
                streamResult = { status: "aborted", reason: "interrupted" };
                streamCompleted.value = true;
                stallRouted = true;
              } else if (outcome === "exhausted") {
                // `routeStreamInterruption` already delivered terminal UX
                // (terminalMessage + done/error frame + onExhausted), identical to
                // deploy-recovery exhaustion. Finalize the resumable stream and
                // report `aborted` so the generic terminal path is not re-run.
                this._markStreamError(streamId);
                streamResult = { status: "aborted", reason: "interrupted" };
                streamCompleted.value = true;
                stallRouted = true;
              }
            }
            if (!stallRouted) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              streamResult = { status: "error", error: errorMessage };
              // Mark stream as error if not already completed
              if (!streamCompleted.value) {
                this._markStreamError(streamId);
                // Notify clients of the error
                this._broadcastChatMessage({
                  body: errorMessage,
                  done: true,
                  error: true,
                  id,
                  type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                  ...(continuation && { continuation: true })
                });
                this._emit("message:error", { error: errorMessage });
                streamCompleted.value = true;
              }
            }
          } finally {
            reader.releaseLock();

            // Always clear the streaming message reference, even on error.
            this._streamingMessage = null;
            // Capture and clear early-persist tracking. The persistence block
            // after the finally uses the local to update in place.
            earlyPersistedId = this._approvalPersistedMessageId;
            this._approvalPersistedMessageId = null;

            // Framework-level cleanup: always remove abort controller.
            // Only emit observability on success (not on error path).
            if (chatMessageId) {
              this._abortRegistry.remove(chatMessageId);
              if (
                streamCompleted.value &&
                streamResult.status !== "error" &&
                !stallRouted
              ) {
                this._emit("message:response");
              }
            }
          }

          // The cutover: when this turn's stream is awaiting settlement, the
          // persist that carries this turn's message settles it and drops
          // its rows in one transaction (see `#pendingCutover`). Agent-tool
          // child turns keep their rows (the parent tails the stored chunks
          // after completion); the next start() reclaims them.
          this.#pendingCutover =
            this._resumableStream.pendingCutoverId === streamId
              ? {
                  streamId,
                  messageId: earlyPersistedId ?? message.id,
                  discard: !this._agentToolRuns.runsByRequestId.get(id)
                }
              : null;
          // The stream was cut off (stopped, stalled, errored): settle the
          // tool calls it left unanswered before the reply is stored.
          // A reply the chat was cleared under before it could be stored did
          // not complete. One that was stored first did, whatever came after.
          const resetBeforeStore = resetSinceTurnStarted();
          if (resetBeforeStore && streamResult.status === "completed") {
            streamResult = { status: "aborted" };
          }
          const partsBeforeSettle = message.parts.length;
          if (streamResult.status !== "completed") {
            message = this._settleInterruptedReply(message);
          }
          // The reply left `_streamingMessage` above and is not stored yet.
          // Keep it findable until it is, with no await in between.
          const storing = { message, dirty: false };
          this._replyBeingStored = storing;
          // A reply that holds nothing (cut off while the model was still
          // reasoning) is not stored: a client would draw an empty bubble.
          if (!replyIsEmpty(message) && !discardPartial && !resetBeforeStore) {
            if (earlyPersistedId) {
              // Message already exists in this.messages from the early persist.
              // Update it in place with the final streaming state.
              const persistedMessage: UIMessage = {
                ...message,
                id: earlyPersistedId
              };
              const existingIdx = this.messages.findIndex(
                (msg) => msg.id === earlyPersistedId
              );
              const updatedMessages = [...this.messages];

              if (existingIdx >= 0) {
                updatedMessages[existingIdx] = persistedMessage;
              } else {
                updatedMessages.push(persistedMessage);
              }

              await this.persistMessages(updatedMessages, excludeBroadcastIds);
            } else if (continuation) {
              const existingIdx = this.messages.findIndex(
                (msg) => msg.id === message.id
              );
              if (existingIdx >= 0) {
                const updatedMessages = [...this.messages];
                updatedMessages[existingIdx] = message;
                await this.persistMessages(
                  updatedMessages,
                  excludeBroadcastIds
                );
              } else {
                // No assistant message to append to, create new one
                await this.persistMessages(
                  [...this.messages, message],
                  excludeBroadcastIds
                );
              }
            } else {
              await this.persistMessages(
                [...this.messages, message],
                excludeBroadcastIds
              );
            }
            // A tool result that arrived while the reply was being stored
            // was applied to it in place. The store may have written the
            // reply before that, so store it again until nothing changed.
            const storedId = earlyPersistedId ?? message.id;
            while (storing.dirty && !resetSinceTurnStarted()) {
              storing.dirty = false;
              await this.persistMessages(
                this.messages.map((stored) =>
                  stored.id === storedId ? { ...message, id: storedId } : stored
                ),
                excludeBroadcastIds
              );
            }
            this._recordTurnReply(storedId);
          }
          if (this._replyBeingStored === storing) this._replyBeingStored = null;
          // Nothing to persist (or the persist threw, or an override never
          // reached the session write): settle the stream so it is not
          // mistaken for an interrupted turn.
          this.#pendingCutover = null;
          this._resumableStream.finalizePending();
          persisted = true;
          this._releaseTerminalFrames(id);
          // The reply held nothing and was not stored, but tabs drew what
          // streamed. A snapshot before the terminal frame is merged with
          // the stream a tab is still reading, so this one comes after it:
          // every tab drops the reply, as when a stored one is removed.
          if (
            replyIsEmpty(message) &&
            partsBeforeSettle > 0 &&
            !discardPartial &&
            !resetSinceTurnStarted()
          ) {
            this._broadcastChatMessage({
              messages: this._messagesForClientSync(),
              type: MessageType.CF_AGENT_CHAT_MESSAGES
            });
          }

          this._pendingChatResponseResults.push({
            message,
            requestId: id,
            continuation,
            status: streamResult.status,
            ...(streamResult.error !== undefined && {
              error: streamResult.error
            })
          });
          return streamResult;
        } finally {
          // Also when the persist threw: the reply is not coming back.
          if (this._replyBeingStored?.message.id === message.id) {
            this._replyBeingStored = null;
          }
          this.#pendingCutover = null;
          this._resumableStream.finalizePending();
          this._releaseTerminalFrames(
            id,
            persisted ? undefined : "Failed to save the response."
          );
          // The streamed assistant message (with all tool parts) is now
          // persisted: clear the stream-active gate and re-run the
          // auto-continuation barrier for a continuation it held (#1650). This
          // package-local hook is the SSE-loop equivalent of Think's
          // `_onStreamingTurnFinalized` in its `toUIMessageStream()` loop.
          // TODO(phase-5): the Tier-2 streaming-codec extraction touches this
          // same region — fold this finalize hook into the extracted codec
          // rather than leaving a second seam here.
          this._onStreamingTurnFinalized();
        }
      }, abortSignal)
    );
  }

  /**
   * When the DO is destroyed, cancel all pending requests and clean up resources
   */
  async destroy() {
    this._abortRegistry.destroyAll();
    this._resumableStream.destroy();
    await super.destroy();
  }
}
