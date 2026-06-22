import type {
  UIMessage,
  StreamTextOnFinishCallback,
  TextUIPart,
  ToolSet,
  UIMessageChunk
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
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
  reconcileMessages,
  resolveToolMergeId,
  reconcileOrphanPartial,
  repairInterruptedToolParts,
  persistReconstructedOrphan,
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot,
  type OrphanPersistStore
} from "agents/chat";
import {
  applyChunkToParts,
  aiSdkRecoveryCodec,
  ResumeHandshake,
  isReplayChunk,
  sanitizeMessage,
  enforceRowSizeLimit,
  parseProtocolMessage,
  sendIfOpen,
  TurnQueue,
  SubmitConcurrencyController,
  hasIncompleteToolBatch,
  partAwaitsClientInteraction,
  clientResolvableToolNames,
  type TurnResult,
  type MessagePart,
  type StreamChunkData,
  type SubmitConcurrencyDecision,
  type ChatFiberSnapshot
} from "agents/chat";
import {
  ResumableStream,
  cleanupStreamBuffers,
  STREAM_CLEANUP_DELAY_SECONDS
} from "agents/chat";
import { MAX_BOUND_PARAMS, buildInClauseStrings } from "agents/chat";
import {
  ContinuationState,
  AutoContinuationController,
  AbortRegistry,
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies,
  interceptAgentToolBroadcast,
  type ClientToolSchema
} from "agents/chat";
import {
  resolveChatRecoveryConfig,
  chatRecoverySchedulePolicy,
  ChatRecoveryEngine,
  runChatRecoveryExhaustion,
  ChatStreamStalledError,
  iterateWithStallWatchdog,
  sweepStaleChatRecoveryIncidents,
  classifyAgentToolChildRecovery,
  readChatRecoveryProgress,
  bumpChatRecoveryProgress,
  recordChatTerminal,
  clearChatTerminal,
  pendingChatTerminal,
  buildChatRecoveringFrame,
  setChatRecovering,
  AgentToolStreamProgressThrottle,
  StreamProgressCreditThrottle,
  shouldCreditStreamProgress,
  type ChatRecoveryAdapter,
  type ChatFiberWakeHooks,
  type ResolvedRecoveryStream,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type ChatRecoveryScheduleCallback,
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
  SaveMessagesResult
} from "agents/chat";

type ChatRecoveryRetryData = {
  targetUserId?: string;
  originalRequestId?: string;
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
};

type ChatRecoveryContinueData = {
  targetAssistantId?: string;
  originalRequestId?: string;
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

// The durable, monotonic forward-progress counter (`CHAT_RECOVERY_PROGRESS_KEY`)
// and its read/bump helpers now live in the shared engine (agents/chat) —
// `readChatRecoveryProgress` / `bumpChatRecoveryProgress`. Bumped at production
// time when new content is streamed (`_storeStreamChunk`), so it reflects
// genuinely new content and is immune to reconnects/re-persists; never recomputed
// from the (compactable) transcript.
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
// re-arm loop now live in agents/chat as `STREAM_CLEANUP_DELAY_SECONDS` /
// `cleanupStreamBuffers`. The `sendIfOpen` / `isWebSocketClosedSendError` WS send
// guard is shared via agents/chat.)

type StreamResultStatus = {
  status: Exclude<SaveMessagesResult["status"], "skipped">;
  error?: string;
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
 * you get full Zod type safety, server-side execution, and simpler code.
 * Use `onToolCall` in `useAgentChat` for tools that need client-side execution.
 *
 * **For SDKs and platforms** where the tool surface is determined dynamically
 * by the embedding application at runtime, client tool schemas let the
 * client register tools the server does not know about at deploy time.
 *
 * Note: Uses `parameters` (JSONSchema7) rather than AI SDK's `inputSchema`
 * because this is the wire format. Zod schemas cannot be serialized.
 */
export type { ClientToolSchema } from "agents/chat";

type ChatRequestTrigger = "submit-message" | "regenerate-message";
type AIChatAgentToolRunStatus = "running" | "completed" | "error" | "aborted";
type AIChatAgentToolRunRow = {
  run_id: string;
  request_id: string | null;
  status: AIChatAgentToolRunStatus;
  input_json: string | null;
  output_json: string | null;
  summary: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
};
type AIChatStreamMetadataRow = {
  id: string;
  status: string;
  request_id: string;
};

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
const agentToolChunkEncoder = new TextEncoder();

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private _activeChatRecoveryRootRequestId: string | undefined;

  /**
   * Registry of per-request AbortControllers.
   * Used to propagate cancellation signals for any external calls made by the agent.
   */
  private _abortRegistry: AbortRegistry;

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
  private _pendingInteractionPromise: Promise<boolean> | null = null;

  /**
   * Serialization tail for client-tool result/approval applies (#1649). Each
   * apply is a read-modify-write of the full message; running siblings from a
   * parallel tool batch concurrently lets last-write-wins clobber the others
   * back to `input-available`. Chaining every apply off this tail makes them
   * commit atomically in arrival order.
   */
  private _interactionApplyTail: Promise<void> = Promise.resolve();

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
  private _turnQueue = new TurnQueue();

  /**
   * When true, chat turns are wrapped in `runFiber` for durable execution.
   * Enables `onChatRecovery` hook and `this.stash()` during streaming.
   * Set to `true` in subclasses to enable durable streaming.
   *
   * Assign this as a class field or in the constructor — NOT in `onStart()`.
   * On every wake the SDK evaluates recovery budgets (and may seal an
   * interrupted turn, firing `onExhausted`) before `onStart()` runs, so a config
   * set in `onStart()` is applied too late and the built-in defaults are used
   * for the recovery that matters. See {@link ChatRecoveryConfig}.
   */
  chatRecovery: ChatRecoveryConfig = false;

  /**
   * Inactivity watchdog for the live model/transport stream, in milliseconds.
   * If more than this many ms elapse between stream chunks, the turn is aborted
   * and — when {@link chatRecovery} is enabled — routed into bounded recovery
   * (the same continuation machinery as a deploy/eviction interruption, #1626)
   * rather than parking forever on a hung provider. With recovery disabled, a
   * stall instead surfaces as a terminal stream error (kills the spinner).
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
  private _submitConcurrency = new SubmitConcurrencyController({
    defaultDebounceMs: AIChatAgent.MESSAGE_DEBOUNCE_MS
  });

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
  private _continuation = new ContinuationState<Connection>();
  private _agentToolForwarders = new Map<
    string,
    Set<(chunk: AgentToolStoredChunk) => void>
  >();
  private _agentToolClosers = new Map<string, Set<() => void>>();
  private _agentToolAbortControllers = new Map<string, AbortController>();
  private _agentToolLastErrors = new Map<string, string>();
  private _agentToolPreTurnAssistantIds = new Map<string, Set<string>>();
  private _agentToolLiveSequences = new Map<string, number>();
  /**
   * Request id → run id for in-flight agent-tool turns (null = resolved as
   * not an agent-tool turn, cached so unrelated turns don't re-query SQLite
   * per frame). Drives frame attribution in {@link broadcast}: a frame
   * belongs to a run iff it carries that run's turn request id, so an error
   * in a user-driven turn or a concurrent run can never leak into another
   * run's state (#1575).
   */
  private _agentToolRunsByRequestId = new Map<string, string | null>();

  /**
   * Client tool schemas from the most recent chat request.
   * Stored so they can be passed to onChatMessage during tool continuations.
   * @internal
   */
  protected _lastClientTools: ClientToolSchema[] | undefined;

  /**
   * Custom body data from the most recent chat request.
   * Stored so it can be passed to onChatMessage during tool continuations.
   * @internal
   */
  protected _lastBody: Record<string, unknown> | undefined;

  /**
   * Cache of last-persisted JSON for each message ID.
   * Used for incremental persistence: skip SQL writes for unchanged messages.
   * Lost on hibernation, repopulated from SQLite on wake.
   * @internal
   */
  private _persistedMessageCache: Map<string, string> = new Map();

  /**
   * Shared auto-continuation barrier (#1649 / #1650): owns the coalesce timer
   * and the double-fire guard. Parameterized by this agent's stream-active
   * signal, apply-drain, and continuation-turn pipeline (`_fireAutoContinuation`).
   */
  private _autoContinuation = new AutoContinuationController<Connection>({
    continuation: this._continuation,
    generateRequestId: () => nanoid(),
    isStreamActive: () => this._streamingTurnActive,
    hasPendingInteraction: () => this._pendingInteractionPromise !== null,
    hasIncompleteToolBatch: () => this._hasIncompleteToolBatch(),
    drainInteractionApplies: () => this._drainInteractionApplies(),
    keepAliveWhile: <T>(fn: () => Promise<T>) => this.keepAliveWhile(fn),
    fire: () => this._fireAutoContinuation()
  });

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

  private async _runChatRecoveryFiber<T>(
    requestId: string,
    continuation: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    const snapshot = createChatFiberSnapshot({
      kind: "ai-chat-turn",
      requestId,
      recoveryRootRequestId: this._activeChatRecoveryRootRequestId ?? requestId,
      continuation,
      messages: this.messages,
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools
    });

    return this._runFiberWithStashWrapper(
      `${(this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME}:${requestId}`,
      async () => fn(),
      {
        initialSnapshot: wrapChatFiberSnapshot(
          "__cfAIChatFiberSnapshot",
          snapshot,
          null
        ),
        wrapStash: (data) =>
          wrapChatFiberSnapshot("__cfAIChatFiberSnapshot", snapshot, data)
      }
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
    // Cheap idle guard so the common (no agent-tool child) broadcast path stays
    // allocation-free — only build the snoop hooks while a run is in flight.
    if (
      this._agentToolForwarders.size > 0 ||
      this._agentToolLiveSequences.size > 0
    ) {
      interceptAgentToolBroadcast(msg, {
        forwarders: this._agentToolForwarders,
        liveSequences: this._agentToolLiveSequences,
        lastErrors: this._agentToolLastErrors,
        responseType: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        runForRequest: (requestId) => this._agentToolRunForRequest(requestId)
      });
    }
    super.broadcast(msg, without);
  }

  /**
   * Resolve the agent-tool run whose turn owns a request id, or null when the
   * request is not an agent-tool turn. Falls back to the persisted run row
   * (written when the turn starts, see `_registerAgentToolTurn`) so
   * attribution survives a DO restart mid-run; either outcome is cached.
   */
  private _agentToolRunForRequest(requestId: string): string | null {
    const cached = this._agentToolRunsByRequestId.get(requestId);
    if (cached !== undefined) return cached;
    // Active-run predicate: a child run is in flight while `status` is
    // `starting`/`running`. ai-chat inserts rows directly as `running` (no
    // `starting` phase), but we match on both for parity with
    // `@cloudflare/think` and to stay correct if a `starting` phase is ever
    // added. Terminal rows set `status` AND `completed_at` together.
    const rows = this.sql<{ run_id: string }>`
      select run_id from cf_ai_chat_agent_tool_runs
      where request_id = ${requestId} and status in ('starting', 'running')
      limit 1
    `;
    const runId = rows?.[0]?.run_id ?? null;
    this._agentToolRunsByRequestId.set(requestId, runId);
    return runId;
  }

  /**
   * Re-bind this facet's in-flight agent-tool child run to the CURRENT turn's
   * request id. Parity with `@cloudflare/think`'s
   * `_rebindAgentToolChildRunRequestId`.
   *
   * When this facet runs as an agent-tool child and its turn is interrupted, the
   * recovery continuation (`continueLastTurn` / `_retryLastUserTurn`) mints a NEW
   * request id but never flows through `startAgentToolRun`'s
   * `_registerAgentToolTurn`. So `cf_ai_chat_agent_tool_runs.request_id` (and the
   * in-memory attribution map) still point at the pre-eviction turn, and
   * `broadcast` can no longer attribute the recovered turn's frames to the run.
   * A long-running child then forwards nothing to the parent's re-attach tail,
   * its no-progress budget elapses, and a healthy child is abandoned as
   * `interrupted`. Re-binding keeps attribution alive across recovery.
   *
   * Safe to call on EVERY recovery continuation:
   *   - Facets that never ran as an agent-tool child have no
   *     `cf_ai_chat_agent_tool_runs` table → the guarded SELECT throws → no-op.
   *   - A facet whose run already settled has no active row → no-op.
   *   - A child DO is addressed by its `runId` (`subAgent(cls, runId)`), so it
   *     owns AT MOST ONE child-run row for its whole lifetime and is never reused
   *     as a top-level chat agent — the single active row is unambiguously this
   *     recovery's run. The `order by started_at desc limit 1` is defensive
   *     belt-and-suspenders for that invariant.
   *
   * Uses the same `status in ('starting','running')` active-run predicate as
   * `_agentToolRunForRequest` and the `@cloudflare/think` counterpart.
   */
  private _rebindAgentToolChildRunRequestId(requestId: string): void {
    let runId: string | undefined;
    try {
      const rows = this.sql<{ run_id: string }>`
        select run_id from cf_ai_chat_agent_tool_runs
        where status in ('starting', 'running')
        order by started_at desc
        limit 1
      `;
      runId = rows?.[0]?.run_id;
    } catch {
      // No child-run table on this facet (it never ran as a child).
      return;
    }
    if (!runId) return;
    this._agentToolRunsByRequestId.set(requestId, runId);
    this.sql`
      update cf_ai_chat_agent_tool_runs
      set request_id = ${requestId}
      where run_id = ${runId}
    `;
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.sql`create table if not exists cf_ai_chat_agent_messages (
      id text primary key,
      message text not null,
      created_at datetime default current_timestamp
    )`;

    // Key-value table for request context that must survive hibernation
    // (e.g., custom body fields, client tools from the last chat request).
    this.sql`create table if not exists cf_ai_chat_request_context (
      key text primary key,
      value text not null
    )`;

    this._ensureAgentToolTables();

    // Restore request context from SQLite (survives hibernation)
    this._restoreRequestContext();

    // Initialize resumable stream manager (creates its own tables + restores state)
    this._resumableStream = new ResumableStream(this.sql.bind(this));

    // Load messages and automatically transform them to v5 format.
    // Note: _loadMessagesFromDb() runs structural validation which requires
    // `parts` to be an array. Legacy v4 messages (with `content` instead of
    // `parts`) would fail this check — but that's fine because autoTransformMessages
    // already migrated them on a previous load, and persistMessages wrote them back.
    // Any message still without `parts` at this point is genuinely corrupt.
    const rawMessages = this._loadMessagesFromDb();

    // Automatic migration following https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages
    this.messages = autoTransformMessages(rawMessages);

    this._abortRegistry = new AbortRegistry();
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      if (this._cf_requestTargetsSubAgent(ctx.request)) {
        return _onConnect(connection, ctx);
      }

      // Notify client about active streams that can be resumed
      if (this._resumableStream.hasActiveStream()) {
        this._notifyStreamResuming(connection);
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
      // Call consumer's onClose
      return _onClose(connection, code, reason, wasClean);
    };

    // Wrap onMessage
    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
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
          const requestClientTools = clientTools?.length
            ? clientTools
            : undefined;
          const requestBody =
            Object.keys(customBody).length > 0 ? customBody : undefined;
          const epoch = this._turnQueue.generation;
          const concurrencyDecision =
            this._getSubmitConcurrencyDecision(requestTrigger);

          if (concurrencyDecision.action === "drop") {
            this._rollbackDroppedSubmit(connection);
            this._completeSkippedRequest(connection, chatMessageId);
            return;
          }

          // A genuinely-new turn supersedes any pending terminal record (#1645)
          // so a stale exhaustion can't replay on a later reconnect once the
          // user has moved on.
          await this._clearChatTerminal();

          // Track that this request is past the concurrency decision but
          // not yet enqueued in _turnQueue. Decremented synchronously
          // before _runExclusiveChatTurn (which increments queuedCount).
          const releasePendingEnqueue = this._submitConcurrency.beginEnqueue();
          try {
            // Persist and broadcast user messages before entering the turn
            // queue so other tabs see the new message immediately and so
            // overlapping submits under latest/merge/debounce can inspect
            // the full message list when their turn starts.
            this._broadcastChatMessage(
              {
                messages: transformedMessages,
                type: MessageType.CF_AGENT_CHAT_MESSAGES
              },
              [connection.id]
            );

            await this.persistMessages(transformedMessages, [connection.id], {
              _deleteStaleRows: true
            });

            if (concurrencyDecision.strategy === "merge") {
              await this._mergeQueuedUserMessages(epoch);
            }
          } finally {
            releasePendingEnqueue();
          }
          return this._runExclusiveChatTurn(
            chatMessageId,
            async () => {
              if (
                this._submitConcurrency.isSuperseded(
                  concurrencyDecision.submitSequence
                )
              ) {
                this._completeSkippedRequest(connection, chatMessageId);
                return;
              }

              if (concurrencyDecision.debounceUntilMs !== null) {
                await this._submitConcurrency.waitForTimestamp(
                  concurrencyDecision.debounceUntilMs
                );

                if (this._turnQueue.generation !== epoch) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }

                if (
                  this._submitConcurrency.isSuperseded(
                    concurrencyDecision.submitSequence
                  )
                ) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }
              }

              // Re-merge inside the lock: more overlapping submits may have
              // persisted additional user messages while this turn was queued.
              if (concurrencyDecision.strategy === "merge") {
                await this._mergeQueuedUserMessages(epoch);

                if (this._turnQueue.generation !== epoch) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }

                if (
                  this._submitConcurrency.isSuperseded(
                    concurrencyDecision.submitSequence
                  )
                ) {
                  this._completeSkippedRequest(connection, chatMessageId);
                  return;
                }
              }

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

              this._setRequestContext(requestClientTools, requestBody);

              this._emit("message:request");

              const abortSignal = this._abortRegistry.getSignal(chatMessageId);

              return this._tryCatchChat(async () => {
                // Wrap in agentContext.run() to propagate connection context to onChatMessage
                // This ensures getCurrentAgent() returns the connection inside tool execute functions
                return agentContext.run(
                  {
                    agent: this,
                    connection,
                    request: undefined,
                    email: undefined
                  },
                  async () => {
                    const chatTurnBody = async () => {
                      try {
                        await this._repairInterruptedToolsBeforeTurn();
                        const response = await this.onChatMessage(
                          async (_finishResult) => {
                            // User-provided hook. Cleanup is now handled by _reply,
                            // so this is optional for the user to pass to streamText.
                          },
                          {
                            requestId: chatMessageId,
                            abortSignal,
                            clientTools: requestClientTools,
                            body: requestBody,
                            continuation: false
                          }
                        );

                        if (response) {
                          await this._reply(
                            chatMessageId,
                            response,
                            [connection.id],
                            {
                              chatMessageId
                            }
                          );
                        } else {
                          console.warn(
                            `[AIChatAgent] onChatMessage returned no response for chatMessageId: ${chatMessageId}`
                          );
                          this._broadcastChatMessage(
                            {
                              body: "No response was generated by the agent.",
                              done: true,
                              id: chatMessageId,
                              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
                            },
                            [connection.id]
                          );
                        }
                      } finally {
                        this._abortRegistry.remove(chatMessageId);
                      }
                    };

                    if (this.chatRecovery) {
                      await this._runChatRecoveryFiber(
                        chatMessageId,
                        false,
                        chatTurnBody
                      );
                    } else {
                      await chatTurnBody();
                    }
                  }
                );
              });
            },
            {
              epoch,
              onStale: () =>
                this._completeSkippedRequest(connection, chatMessageId)
            }
          );
        }

        // Handle clear chat
        if (event.type === "clear") {
          this.resetTurnState();
          this.sql`delete from cf_ai_chat_agent_messages`;
          // Drop any pending terminal record (#1645) so a stale exhaustion
          // can't replay onto a freshly-cleared (empty) conversation when a
          // client reconnects and runs the resume probe.
          await this._clearChatTerminal();
          this._resumableStream.clearAll();
          this._pendingResumeConnections.clear();
          this._lastClientTools = undefined;
          this._lastBody = undefined;
          this._persistRequestContext();
          this._persistedMessageCache.clear();
          this.messages = [];
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
          this._abortRegistry.cancel(event.id);
          this._emit("message:cancel", { requestId: event.id });
          return;
        }

        // Handle client-initiated stream resume request.
        // The client sends this after its message handler is registered,
        // avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
        // in onConnect arrives before the client's handler is ready.
        if (event.type === "stream-resume-request") {
          await this._resumeHandshake().handleResumeRequest(connection);
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

          // Update cached client tools so subsequent continuations use the latest schemas
          if (clientTools?.length) {
            this._lastClientTools = clientTools as ClientToolSchema[];
            this._persistRequestContext();
          }

          const overrideState =
            state === "output-error" ? "output-error" : undefined;

          this._emit("tool:result", { toolCallId, toolName });

          this._enqueueInteractionApply(() =>
            this._applyToolResult(
              toolCallId,
              toolName,
              output,
              overrideState,
              errorText
            )
          );

          if (autoContinue) {
            this._scheduleAutoContinuation(
              connection,
              (clientTools as ClientToolSchema[] | undefined) ??
                this._lastClientTools,
              this._lastBody,
              "[AIChatAgent] Tool continuation failed:"
            );
          } else {
            // A result that arrived WITHOUT autoContinue (e.g. a standalone
            // errored tool) can still be the one that completes a parallel batch
            // a sibling already opted to continue — re-arm the barrier so that
            // continuation fires once the batch is whole (#1650). Never CREATES
            // a pending continuation.
            this._rearmPendingAutoContinuationForBatch();
          }
          return;
        }

        // Handle client-side tool approval response
        if (event.type === "tool-approval") {
          const { toolCallId, approved, autoContinue } = event;
          this._emit("tool:approval", { toolCallId, approved });
          this._enqueueInteractionApply(() =>
            this._applyToolApproval(toolCallId, approved)
          );

          if (autoContinue) {
            this._scheduleAutoContinuation(
              connection,
              this._lastClientTools,
              this._lastBody,
              "[AIChatAgent] Tool approval continuation failed:"
            );
          } else {
            this._rearmPendingAutoContinuationForBatch();
          }
          return;
        }
      }

      // Forward unhandled messages to consumer's onMessage
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      return this._tryCatchChat(async () => {
        const url = new URL(request.url);
        if (url.pathname.split("/").pop() === "get-messages") {
          return Response.json(this._loadMessagesFromDb());
        }
        return _onRequest(request);
      });
    };
  }

  private _ensureAgentToolTables() {
    this.sql`create table if not exists cf_ai_chat_agent_tool_runs (
      run_id text primary key,
      request_id text,
      status text not null,
      input_json text,
      output_json text,
      summary text,
      error_message text,
      started_at integer not null,
      completed_at integer
    )`;
    const addColumnIfNotExists = (sql: string) => {
      try {
        this.ctx.storage.sql.exec(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) {
          throw error;
        }
      }
    };
    addColumnIfNotExists(
      "alter table cf_ai_chat_agent_tool_runs add column input_json text"
    );
    addColumnIfNotExists(
      "alter table cf_ai_chat_agent_tool_runs add column output_json text"
    );
    addColumnIfNotExists(
      "alter table cf_ai_chat_agent_tool_runs add column summary text"
    );
    this.sql`create index if not exists idx_ai_chat_agent_tool_request_id
      on cf_ai_chat_agent_tool_runs(request_id)`;
  }

  private _flushAwaitingStreamStartConnections() {
    if (!this._resumableStream.hasActiveStream()) {
      return;
    }

    this._continuation.flushAwaitingConnections((c) =>
      this._notifyStreamResuming(c)
    );
  }

  private _activateDeferredAutoContinuation() {
    // Run the freshly-activated continuation through the event-driven barrier
    // (#1650) rather than enqueuing it directly — its batch may still be
    // incomplete (or a stream may be active), in which case it parks and
    // re-arms instead of firing inference against a half-complete transcript.
    this._autoContinuation.activateDeferredAndReschedule();
  }

  private _clearAllAutoContinuationState(sendNone = false) {
    this._clearPendingAutoContinuation(sendNone);
    this._continuation.clearDeferred();
  }

  private _clearPendingAutoContinuation(sendNone = false) {
    if (sendNone) {
      this._continuation.sendResumeNone();
    }
    this._continuation.clearPending();
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
      pendingResumeConnections: this._pendingResumeConnections,
      pendingChatTerminal: () => this._pendingChatTerminal(),
      persistOrphanedStream: (streamId) => this._persistOrphanedStream(streamId)
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
    const streamId = this._resumableStream.start(requestId, options);
    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._flushAwaitingStreamStartConnections();
      this._activateDeferredAutoContinuation();
    }
    // Arm on START as well as finish so a stream whose DO is evicted mid-flight
    // and never reaches a finish still gets a future sweep instead of leaking.
    // This matters for `chatRecovery: false` (the default): those turns don't
    // run inside `runFiber`, so there is no durable keepAlive alarm and no
    // fiber-recovery scan — if the client never reconnects, nothing else ever
    // wakes the DO to finalize the orphan. (With `chatRecovery: true` the
    // leftover keepAlive alarm wakes the DO within ~keepAliveIntervalMs and
    // recovery finalizes the stream, which arms cleanup anyway — so this is
    // belt-and-suspenders there.) The last-activity sweep threshold keeps an
    // actively streaming run from being reclaimed before it goes quiet (#1706).
    void this._ensureStreamCleanupScheduled();
    return streamId;
  }

  /** @internal Delegate to _resumableStream */
  protected _completeStream(streamId: string) {
    const completedRequestId = this._resumableStream.activeRequestId;
    this._resumableStream.complete(streamId);
    this._pendingResumeConnections.clear();
    if (completedRequestId === this._continuation.activeRequestId) {
      this._continuation.activeRequestId = null;
      this._continuation.activeConnectionId = null;
    }
    void this._ensureStreamCleanupScheduled();
  }

  /**
   * Ensure a single cleanup alarm is pending for this DO's resumable-stream
   * buffers. Armed whenever a stream finishes (completes or errors) so that
   * idle/one-off chat DOs still reclaim their buffers — the lazy sweep in
   * {@link ResumableStream} only fires when a *subsequent* stream completes,
   * which never happens for a chat that receives a single turn (#1706).
   *
   * `idempotent` dedupes on (callback, payload, owner) so repeated finishes
   * collapse onto one pending alarm rather than stacking.
   * @internal
   */
  protected async _ensureStreamCleanupScheduled({
    idempotent = true
  }: { idempotent?: boolean } = {}): Promise<void> {
    await this.schedule(
      STREAM_CLEANUP_DELAY_SECONDS,
      "_cleanupStreamBuffers",
      undefined,
      { idempotent }
    );
  }

  /**
   * Alarm callback: sweep aged stream buffers, re-arming while rows remain (see
   * the shared {@link cleanupStreamBuffers}). Public so it is reachable as a
   * schedule callback.
   * @internal
   */
  async _cleanupStreamBuffers(): Promise<void> {
    await cleanupStreamBuffers(this._resumableStream, () =>
      this._ensureStreamCleanupScheduled({ idempotent: false })
    );
  }

  /** @internal Delegate to _resumableStream. Also advances the recovery
   *  progress counter at production time (see `_maybeBumpRecoveryProgress`). */
  protected async _storeStreamChunk(streamId: string, body: string) {
    this._resumableStream.storeChunk(streamId, body);
    let type: string | undefined;
    try {
      type = (JSON.parse(body) as { type?: string }).type;
    } catch {
      // non-JSON chunk body — nothing to credit
    }
    await this._maybeBumpRecoveryProgress(type);
  }

  /** Per-isolate throttle for crediting recovery progress from mid-segment
   *  streaming-content deltas (the shared `agents/chat` rule); reset per isolate
   *  so the first delta after a restart always credits. */
  private _streamProgressCredit = new StreamProgressCreditThrottle();

  /** Advance the recovery-progress counter when a chunk represents genuinely
   *  new produced content. Uses the shared host-agnostic rule
   *  ({@link shouldCreditStreamProgress}): a milestone (started segment / settled
   *  tool) always credits, and a long single segment's streaming deltas credit
   *  through a time throttle so the no-progress window doesn't false-fire while
   *  content streams across crashes. Bumped at production time, so it reflects
   *  real forward progress and is immune to client reconnects / recovery
   *  re-persists (which replay or re-materialize stored chunks rather than flow
   *  through here). This is what the recovery no-progress window keys off
   *  (#1637), and stays compaction-proof (#1628). */
  private async _maybeBumpRecoveryProgress(
    type: string | undefined
  ): Promise<void> {
    if (
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type,
        throttle: this._streamProgressCredit,
        now: Date.now()
      })
    ) {
      await this._bumpChatRecoveryProgress();
    }
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
    this._pendingResumeConnections.clear();
    if (erroredRequestId === this._continuation.activeRequestId) {
      this._continuation.activeRequestId = null;
      this._continuation.activeConnectionId = null;
    }
    void this._ensureStreamCleanupScheduled();
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
   *   - (c)+(d) upsert-by-id over the flat array, the `SessionProvider`-subset
   *     store-write shape (`getMessage` → `updateMessage` / `appendMessage`)
   *     that `Think._upsertMessageInHistory` implements over a Session tree.
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
        return message;
      },
      merge: (existing, incoming) => reconcileOrphanPartial(existing, incoming)
    });
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
   * The orphan-persist store adapter — orphan-persist steps **(c)/(d)** route
   * their write through this shared `OrphanPersistStore` seam (the
   * `SessionProvider` write-subset). Backed by ai-chat's flat `this.messages`
   * array + the existing `persistMessages` whole-array write path, so
   * reconcile/sanitize/row-size/broadcast all stay intact. Each mutating call
   * is exactly one `persistMessages` invocation; `parentId` is unused (a flat
   * array has no tree to attach to).
   * @internal
   */
  protected _orphanStore(): OrphanPersistStore {
    return {
      getMessage: (id) => this.messages.find((m) => m.id === id) ?? null,
      appendMessage: (message) =>
        this.persistMessages([...this.messages, message]),
      updateMessage: (message) =>
        this.persistMessages(
          this.messages.map((m) => (m.id === message.id ? message : m))
        )
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
    return {
      ...part,
      state: "output-error",
      errorText: "The tool call was interrupted before a result was recorded."
    } as UIMessage["parts"][number];
  }

  /**
   * Transcript repair, run before EVERY inference chokepoint (live submit, tool
   * auto-continuation, `continueLastTurn`, `saveMessages`/retry, and the chat
   * recovery callbacks). An interrupted server-tool orphan is flipped to a
   * settled (errored) result — via the shared `agents/chat`
   * `repairInterruptedToolParts` primitive, the SAME logic `@cloudflare/think`
   * runs before its own inference (`_assembleModelMessages`) — so the app's next
   * `convertToModelMessages(this.messages)` doesn't 400 with
   * `AI_MissingToolResultsError`. Because the app owns the inference call, the
   * framework can't repair "inside" it the way Think does; it repairs
   * `this.messages` at each point right before handing control to
   * `onChatMessage` instead. This reaches the cases the recovery-only repair
   * missed: a mixed client+server orphan whose client replay drives an
   * auto-continuation, and any agent running with `chatRecovery` disabled.
   *
   * Scope: repair only ever flips a DEAD SERVER orphan (an interrupted tool with
   * no settled result whose `execute()` died with the evicted isolate). A part
   * still legitimately awaiting a CLIENT interaction — an `input-available`
   * client tool the SPA replays, or an `approval-requested` part the user may
   * still answer — is left verbatim via the shared `shouldRepair` skip, so it is
   * never clobbered with an error. This is per-part (not a whole-transcript
   * guard), so a fresh dead-server orphan at the leaf is still repaired even if
   * an unrelated abandoned client orphan sits earlier in history.
   *
   * Repair only ever reshapes ASSISTANT tool parts; it never touches user
   * messages, so per-channel policy carried on the user message's
   * `metadata.channel` (re-resolved on wake) is structurally untouched. It is a
   * no-op (no write, no broadcast) when nothing needs repair — the common case
   * for a healthy transcript. When anything changes, the corrected transcript is
   * persisted and broadcast through the normal `persistMessages` write path (one
   * write, one broadcast), which also refreshes `this.messages`.
   * @internal
   */
  private async _repairInterruptedToolsBeforeTurn(): Promise<void> {
    const clientResolvable = this._clientResolvableToolNames();
    const repaired = repairInterruptedToolParts(this.messages, {
      repairPart: (part) => this.repairInterruptedToolPart(part),
      shouldRepair: (part) =>
        !this._partAwaitsClientInteraction(part, clientResolvable)
    });
    if (repaired.removedToolCalls === 0 && repaired.normalizedInputs === 0) {
      return;
    }
    await this.persistMessages(repaired.messages);
  }

  /**
   * Restore _lastBody and _lastClientTools from SQLite.
   * Called in the constructor so these values survive DO hibernation.
   * @internal
   */
  private _restoreRequestContext() {
    const rows =
      this.sql<{ key: string; value: string }>`
        select key, value from cf_ai_chat_request_context
      ` || [];

    for (const row of rows) {
      try {
        if (row.key === "lastBody") {
          this._lastBody = JSON.parse(row.value);
        } else if (row.key === "lastClientTools") {
          this._lastClientTools = JSON.parse(row.value);
        }
      } catch {
        // Corrupted row — ignore and let the next request overwrite it
      }
    }
  }

  /**
   * Persist _lastBody and _lastClientTools to SQLite so they survive hibernation.
   * Uses upsert (INSERT OR REPLACE) so repeated calls are safe.
   * @internal
   */
  private _persistRequestContext() {
    // Persist or delete body
    if (this._lastBody) {
      this.sql`
        insert or replace into cf_ai_chat_request_context (key, value)
        values ('lastBody', ${JSON.stringify(this._lastBody)})
      `;
    } else {
      this.sql`delete from cf_ai_chat_request_context where key = 'lastBody'`;
    }
    // Persist or delete client tools
    if (this._lastClientTools) {
      this.sql`
        insert or replace into cf_ai_chat_request_context (key, value)
        values ('lastClientTools', ${JSON.stringify(this._lastClientTools)})
      `;
    } else {
      this
        .sql`delete from cf_ai_chat_request_context where key = 'lastClientTools'`;
    }
  }

  private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
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
    await this._storeStreamChunk(streamId, body);
    this._broadcastChatMessage({
      body,
      done: false,
      id: event.id,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      ...(continuation && { continuation: true })
    });
  }

  private _loadMessagesFromDb(): UIMessage[] {
    const rows =
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      [];

    // Populate the persistence cache from DB so incremental persistence
    // can skip SQL writes for messages already stored.
    this._persistedMessageCache.clear();

    return rows
      .map((row) => {
        try {
          const messageStr = row.message as string;
          const parsed = JSON.parse(messageStr) as UIMessage;

          // Structural validation: ensure required fields exist and have
          // the correct types. This catches corrupted rows, manual tampering,
          // or schema drift from older versions without crashing the agent.
          if (!isValidMessageStructure(parsed)) {
            console.warn(
              `[AIChatAgent] Skipping invalid message ${row.id}: ` +
                "missing or malformed id, role, or parts"
            );
            return null;
          }

          // Cache the raw JSON keyed by message ID
          this._persistedMessageCache.set(parsed.id, messageStr);
          return parsed;
        } catch (error) {
          console.error(`Failed to parse message ${row.id}:`, error);
          return null;
        }
      })
      .filter((msg): msg is UIMessage => msg !== null);
  }

  private async _tryCatchChat<T>(fn: () => T | Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      throw this.onError(e);
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
    for (;;) {
      await this._submitConcurrency.waitForIdle(() =>
        this._turnQueue.waitForIdle()
      );
      // An armed coalesce timer / in-flight barrier drain means an
      // auto-continuation decision is imminent (#1650): it will either enqueue
      // a continuation turn (re-busying the queue) or park on an incomplete
      // batch. Wait for that decision to resolve before reporting idle so a
      // debounced continuation isn't missed by idle observers (tests,
      // recovery).
      if (!this._hasArmedContinuation()) return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, AutoContinuationController.COALESCE_MS)
      );
    }
  }

  /**
   * `true` when an auto-continuation is armed and going to fire on its own —
   * its coalesce timer is still pending or its completeness barrier is
   * mid-drain (#1650). Such an agent is NOT idle/stable: a continuation turn is
   * imminent, so idle observers (recovery, idle-eviction, tests) must keep
   * waiting until it either enqueues a turn or parks on an incomplete batch.
   * A continuation that has already entered its turn (`pastCoalesce`) is
   * covered by the turn queue, and a parked one (waiting on an unanswered
   * sibling) is covered by `hasPendingInteraction()`, so neither is reported
   * here.
   */
  private _hasArmedContinuation(): boolean {
    return (
      this._continuation.pending !== null &&
      !this._continuation.pending.pastCoalesce &&
      this._autoContinuation.isArmed()
    );
  }

  private _getSubmitConcurrencyDecision(
    trigger: ChatRequestTrigger
  ): SubmitConcurrencyDecision {
    const decision = this._submitConcurrency.decide({
      concurrency: this.messageConcurrency,
      isSubmitMessage: trigger === "submit-message",
      queuedTurns: this._turnQueue.queuedCount()
    });

    if (decision.strategy === "merge") {
      if (
        !this._mergeQueuedUserStartIndexByEpoch.has(this._turnQueue.generation)
      ) {
        this._mergeQueuedUserStartIndexByEpoch.set(
          this._turnQueue.generation,
          this.messages.length
        );
      }
    }

    return decision;
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
    this._lastClientTools = clientTools?.length ? clientTools : undefined;
    this._lastBody = body && Object.keys(body).length > 0 ? body : undefined;
    this._persistRequestContext();
  }

  private _messagesForClientSync(): readonly UIMessage[] {
    if (!this._streamingMessage || this._streamingMessage.parts.length === 0) {
      return this.messages;
    }

    const existingIdx = this.messages.findIndex(
      (message) => message.id === this._streamingMessage?.id
    );

    if (existingIdx >= 0) {
      return this.messages.map((message, idx) =>
        idx === existingIdx && this._streamingMessage
          ? this._streamingMessage
          : message
      );
    }

    return [...this.messages, this._streamingMessage];
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

  private _completeSkippedRequest(connection: Connection, requestId: string) {
    this._sendDirectMessage(connection, {
      body: "",
      done: true,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });
  }

  private _rollbackDroppedSubmit(connection: Connection) {
    this._sendDirectMessage(connection, {
      messages: this._messagesForClientSync(),
      type: MessageType.CF_AGENT_CHAT_MESSAGES
    });
  }

  /** `true` when an assistant message is waiting on a client tool result or approval. */
  protected hasPendingInteraction(): boolean {
    if (
      this._streamingMessage &&
      this._messageHasPendingInteraction(this._streamingMessage)
    ) {
      return true;
    }

    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageHasPendingInteraction(message)
    );
  }

  /**
   * Waits until the conversation is fully stable — no active stream, no
   * pending client-tool interactions, and no queued continuation turns.
   *
   * Returns `true` when stable. Returns `false` if `timeout` expires before
   * a pending interaction resolves. Safe to call at any time; if there is
   * nothing pending it returns immediately.
   *
   * `pendingInteraction` overrides which "still waiting" predicate gates
   * stability. It defaults to the broad {@link hasPendingInteraction} (any
   * `input-available` / `approval-requested` part) to preserve the documented
   * semantics for app overrides. The recovery paths pass the narrower
   * {@link hasPendingClientInteraction} so a DEAD server-tool `input-available`
   * orphan (its `execute()` died with the evicted isolate; nothing will resolve
   * it) does NOT block stability — recovery then repairs it to an errored
   * result and continues, instead of waiting until the budget is spent. This
   * mirrors `@cloudflare/think`, whose single pending predicate is already
   * client-only by construction.
   */
  protected async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;
    const hasPendingInteraction =
      options?.pendingInteraction ?? (() => this.hasPendingInteraction());

    while (true) {
      // Drain active turns AND any in-flight submits past the concurrency
      // decision (mid-`persistMessages`) so `hasPendingInteraction()`
      // reflects settled message state rather than in-flight streaming
      // state. Just `_turnQueue.waitForIdle()` would miss submits whose
      // handlers have bumped `_latestOverlappingSubmitSequence` and
      // incremented `_pendingEnqueueCount` but haven't yet enqueued.
      while (true) {
        if (
          (await this._awaitWithDeadline(
            this._turnQueue.waitForIdle(),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
        if (this._submitConcurrency.pendingEnqueueCount === 0) break;
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, 5)),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
      }

      if (!hasPendingInteraction()) {
        if (!this._hasArmedContinuation()) {
          return true;
        }
        // An auto-continuation is armed (#1650) — not stable yet. Wait for it
        // to fire (enqueuing a turn the outer loop then drains) or park, then
        // re-check.
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) =>
              setTimeout(resolve, AutoContinuationController.COALESCE_MS)
            ),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
        continue;
      }

      const pending = this._pendingInteractionPromise;
      if (pending) {
        let result: boolean | typeof TIMED_OUT;
        try {
          result = await this._awaitWithDeadline(pending, deadline);
        } catch {
          continue;
        }

        if (result === TIMED_OUT) {
          return false;
        }
      } else {
        // No tool result/approval apply is currently in flight; we are still
        // waiting for the user to resolve the interaction.
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
      }
    }
  }

  private abortActiveTurn(): boolean {
    if (!this._turnQueue.activeRequestId) {
      return false;
    }

    this._abortRegistry.cancel(this._turnQueue.activeRequestId);
    return true;
  }

  /**
   * Aborts the active turn and invalidates queued continuations. Call this
   * when intercepting `CF_AGENT_CHAT_CLEAR` before the SDK sees the message —
   * the built-in handler calls it automatically.
   */
  protected resetTurnState(): void {
    this._mergeQueuedUserStartIndexByEpoch.delete(this._turnQueue.generation);
    this._turnQueue.reset();
    this._abortRegistry.destroyAll();
    this._submitConcurrency.reset();
    this._pendingInteractionPromise = null;
    // Drop the apply chain so new interactions don't serialize behind a stale
    // (possibly hung) apply from the turn we just reset (#1649).
    this._interactionApplyTail = Promise.resolve();
    // Tear down the event-driven auto-continuation barrier (#1650): cancel the
    // coalesce timer and clear the double-fire / stream-active gates so a reset
    // mid-park can't leave a stale flag pinning future continuations.
    this._autoContinuation.reset();
    this._streamingTurnActive = false;
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
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
    this._abortRegistry.cancel(requestId, reason);
  }

  /**
   * Abort every in-flight chat turn on this agent.
   *
   * Aborts all controllers in the registry and clears it. Used by
   * subclasses that drive single-purpose turns (e.g. an RPC-driven
   * sub-agent helper that runs one turn at a time) and want a coarse
   * "cancel whatever is running" handle without tracking request ids.
   *
   * Does NOT reset queued turns, continuation timers, or submit
   * concurrency state — use {@link resetTurnState} for the full
   * teardown that runs on `chat-clear`.
   */
  protected abortAllRequests(reason?: unknown): void {
    this._abortRegistry.destroyAll(reason);
  }

  private _awaitWithDeadline<T>(
    promise: Promise<T>,
    deadline: number | null
  ): Promise<T | typeof TIMED_OUT> {
    return awaitWithDeadline(promise, deadline);
  }

  private _messageHasPendingInteraction(message: UIMessage): boolean {
    return message.parts.some(
      (part) =>
        "state" in part &&
        (part.state === "input-available" ||
          part.state === "approval-requested")
    );
  }

  /**
   * `true` when the turn is parked on a pending interaction that the CLIENT can
   * still resolve after a restart — an `approval-requested` part, or an
   * `input-available` part for a CLIENT tool (no server `execute`) whose
   * `tool-result` the SPA replays over the WebSocket on reconnect.
   *
   * This is intentionally NARROWER than `hasPendingInteraction()` (which
   * `waitUntilStable` uses): a SERVER tool's `input-available` orphan is
   * excluded, because its `execute()` promise died with the evicted isolate and
   * nothing will ever post its result — so it must NOT be treated as a healthy
   * "waiting on the human" wait. Used to make a HITL turn budget-free during
   * recovery so a slow human can't trip the no-progress / attempt / stable-
   * timeout budgets; see `_beginChatRecoveryIncident` and
   * `_parkRecoveryForPendingInteraction`. Mirrors `@cloudflare/think`'s
   * `hasPendingInteraction`, which is already client-only by construction.
   */
  protected hasPendingClientInteraction(): boolean {
    const clientResolvable = this._clientResolvableToolNames();
    if (
      this._streamingMessage &&
      this._messageAwaitsClientInteraction(
        this._streamingMessage,
        clientResolvable
      )
    ) {
      return true;
    }
    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageAwaitsClientInteraction(message, clientResolvable)
    );
  }

  private _messageAwaitsClientInteraction(
    message: UIMessage,
    clientResolvable: Set<string>
  ): boolean {
    return message.parts.some((part) =>
      this._partAwaitsClientInteraction(part, clientResolvable)
    );
  }

  /**
   * Whether a part is still awaiting a CLIENT interaction that can genuinely
   * arrive after a restart: an `approval-requested` part (a reconnecting client
   * replays the approval) or an `input-available` part for a CLIENT tool (the
   * SPA replays the `tool-result`). A SERVER tool's `input-available` is NOT
   * pending — its `execute()` died with the isolate. Mirrors `@cloudflare/think`.
   */
  private _partAwaitsClientInteraction(
    part: UIMessage["parts"][number],
    clientResolvable: Set<string>
  ): boolean {
    return partAwaitsClientInteraction(part, clientResolvable);
  }

  /**
   * Names of the CLIENT-resolvable tools (the client-provided schemas from the
   * last request, which have no server `execute`). Mirrors `@cloudflare/think`.
   */
  private _clientResolvableToolNames(): Set<string> {
    return clientResolvableToolNames(this._lastClientTools);
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
      result = await this._turnQueue.enqueue(requestId, fn, {
        generation
      });
    } finally {
      // Clean merge map when all turns for a generation complete
      const gen = generation ?? this._turnQueue.generation;
      if (this._turnQueue.queuedCount(gen) === 0) {
        this._mergeQueuedUserStartIndexByEpoch.delete(gen);
      }

      if (
        this._pendingChatResponseResults.length > 0 &&
        !this._insideResponseHook
      ) {
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
                await this._clearChatTerminal();
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
                await this._recordChatTerminal(
                  chatResult.requestId,
                  chatResult.error ?? "The assistant encountered an error."
                );
              }
              try {
                await this.onChatResponse(chatResult);
              } catch (hookError) {
                console.error("[AIChatAgent] onChatResponse threw:", hookError);
              }
            }
          });
        } finally {
          this._insideResponseHook = false;
        }
      }
    }

    if (result!.status === "stale") {
      options?.onStale?.();
      return undefined as T;
    }
    return result!.value;
  }

  /**
   * Schedule an auto-continuation for a tool result/approval that opted in with
   * `autoContinue: true` (#1650). Thin host wrapper that builds the
   * {@link ContinuationSpec} and delegates to the shared
   * {@link AutoContinuationController}, which owns the coalesce timer and the
   * completeness-gated fire (shared with `@cloudflare/think`).
   */
  private _scheduleAutoContinuation(
    connection: Connection,
    clientTools: ClientToolSchema[] | undefined,
    body: Record<string, unknown> | undefined,
    errorPrefix: string
  ) {
    this._autoContinuation.schedule({
      connection,
      clientTools,
      body,
      errorPrefix
    });
  }

  /**
   * Re-arm the barrier for a result/approval that arrived WITHOUT `autoContinue`
   * (#1650). A standalone errored result declines to continue on its own, but in
   * a parallel batch a SIBLING may already have opted in — and this result can be
   * the one that completes the batch, so we must re-run the barrier check. Unlike
   * `_scheduleAutoContinuation` this NEVER creates a pending continuation (a
   * standalone errored tool with no opted-in sibling must not auto-continue), and
   * it no-ops once the continuation is running (`pastCoalesce`).
   */
  private _rearmPendingAutoContinuationForBatch(): void {
    this._autoContinuation.rearmForBatch();
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
    this._autoContinuation.rearmForBatch();
  }

  /**
   * Drain every in-flight tool-result/approval apply, including any enqueued
   * while we wait, so the subsequent `_hasIncompleteToolBatch()` re-check sees
   * every result that has ALREADY arrived. Bounded by real apply activity (a
   * storage write each), never by a fixed timer: the loop re-reads
   * `_interactionApplyTail` after each await because a sibling can extend the
   * tail mid-drain, and stops once the tail stops advancing. Mirrors
   * `@cloudflare/think`'s `_drainInteractionApplies`.
   */
  private _drainInteractionApplies(): Promise<void> {
    return drainInteractionApplies(
      () => this._continuation.pending !== null,
      () => this._interactionApplyTail
    );
  }

  /**
   * `true` when the latest assistant message is mid-batch: it carries at least
   * one settled tool result AND at least one tool call/approval still awaiting a
   * client result. That is the #1649 signature — the model fanned out parallel
   * tool calls and only some have been answered. Scoped to the leaf (the step
   * the continuation answers) so an unrelated dangling tool in an earlier
   * message doesn't block a legitimate follow-up continuation.
   */
  private _hasIncompleteToolBatch(): boolean {
    return hasIncompleteToolBatch(this.messages);
  }

  private _fireAutoContinuation() {
    const pending = this._continuation.pending;
    if (!pending) return;
    const requestId = pending.requestId;

    const epoch = this._turnQueue.generation;
    // _runExclusiveChatTurn must be called synchronously so the chat turn
    // queue is set up immediately — otherwise waitForIdle() can resolve
    // before the continuation starts.  keepAlive() is called inside the
    // turn to prevent hibernation while streaming, without deferring the queue
    // registration.
    this._runExclusiveChatTurn(
      requestId,
      async () => {
        const dispose = await this.keepAlive();
        try {
          const connection = this._continuation.pending?.connection;
          if (!connection) {
            this._clearAllAutoContinuationState(true);
            return;
          }

          const clientTools = this._continuation.pending?.clientTools;
          const body = this._continuation.pending?.body;
          if (this._continuation.pending) {
            this._continuation.pending.pastCoalesce = true;
          }

          const abortSignal = this._abortRegistry.getSignal(requestId);

          return this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              async () => {
                const autoContinuationBody = async () => {
                  try {
                    await this._repairInterruptedToolsBeforeTurn();
                    const response = await this.onChatMessage(
                      async (_finishResult) => {},
                      {
                        requestId,
                        abortSignal,
                        clientTools,
                        body,
                        continuation: true
                      }
                    );

                    if (response) {
                      const replyResult = await this._reply(
                        requestId,
                        response,
                        [],
                        {
                          continuation: true,
                          chatMessageId: requestId
                        }
                      );
                      if (replyResult.status === "error") {
                        this._clearAllAutoContinuationState(true);
                        return;
                      }
                      this._activateDeferredAutoContinuation();
                    } else {
                      this._clearPendingAutoContinuation(true);
                      this._activateDeferredAutoContinuation();
                    }
                  } finally {
                    this._abortRegistry.remove(requestId);
                  }
                };

                if (this.chatRecovery) {
                  await this._runChatRecoveryFiber(
                    requestId,
                    true,
                    autoContinuationBody
                  );
                } else {
                  await autoContinuationBody();
                }
              }
            );
          });
        } finally {
          dispose();
        }
      },
      {
        epoch,
        onStale: () => this._clearAllAutoContinuationState(true)
      }
    ).catch((error) => {
      const errorPrefix =
        this._continuation.pending?.errorPrefix ??
        "[AIChatAgent] Auto-continuation failed:";
      this._clearAllAutoContinuationState(true);
      console.error(errorPrefix, error);
    });
  }

  /**
   * @returns Terminal status for the turn.
   */
  private async _runProgrammaticChatTurn(
    requestId: string,
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<StreamResultStatus> {
    this._setRequestContext(clientTools, body);
    let wasAborted = false;
    let status: StreamResultStatus = { status: "completed" };

    await this._tryCatchChat(async () => {
      return agentContext.run(
        {
          agent: this,
          connection: undefined,
          request: undefined,
          email: undefined
        },
        async () => {
          const abortSignal = this._abortRegistry.getSignal(requestId);
          // Wire the optional external signal to the registry's
          // controller. Detacher MUST run in `finally` to avoid leaking
          // listeners on long-lived parent signals — including the case
          // where `runFiber` itself throws (e.g. SQLite error inserting
          // the fiber row) before `programmaticBody` is ever invoked.
          const detachExternal = this._abortRegistry.linkExternal(
            requestId,
            externalSignal
          );
          try {
            const programmaticBody = async () => {
              await this._repairInterruptedToolsBeforeTurn();
              const response = await this.onChatMessage(() => {}, {
                requestId,
                abortSignal,
                clientTools,
                body,
                continuation: false
              });

              if (response) {
                status = await this._reply(requestId, response, [], {
                  chatMessageId: requestId
                });
              }
            };

            if (this.chatRecovery) {
              await this._runChatRecoveryFiber(
                requestId,
                false,
                programmaticBody
              );
            } else {
              await programmaticBody();
            }
          } finally {
            if (abortSignal?.aborted) wasAborted = true;
            detachExternal();
            this._abortRegistry.remove(requestId);
          }
        }
      );
    });

    if (status.status === "completed" && wasAborted) {
      return { status: "aborted" };
    }
    return status;
  }

  /**
   * Handle incoming chat messages and generate a response
   * @param onFinish Callback to be called when the response is finished
   * @param options Options including abort signal and client-defined tools
   * @returns Response to send to the client or undefined
   */
  async onChatMessage(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
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

  /**
   * Bind the child turn that is about to stream to its agent-tool run, at
   * the moment the turn's request id is first knowable (inside the turn,
   * before any frame is broadcast). The in-memory mapping drives frame
   * attribution in {@link broadcast}; the run row's `request_id` is
   * persisted here rather than at terminal so attribution also survives a
   * DO restart mid-run (#1575).
   */
  private _registerAgentToolTurn(runId: string): void {
    const requestId = this._turnQueue.activeRequestId;
    if (requestId === null) {
      // Invariant: this runs inside the turn's enqueued fn, so the turn
      // queue's active request id is set. If it ever isn't, the run can't be
      // bound to its frames and its error/progress capture silently degrades
      // (#1575) — surface it rather than fail quietly.
      console.warn(
        `[AIChatAgent] agent-tool run ${runId} has no active request id at turn start; frame attribution will be skipped`
      );
      return;
    }
    this._agentToolRunsByRequestId.set(requestId, runId);
    this.sql`
      update cf_ai_chat_agent_tool_runs
      set request_id = ${requestId}
      where run_id = ${runId}
    `;
  }

  async startAgentToolRun(
    input: unknown,
    options: { runId: string; signal?: AbortSignal }
  ): Promise<AgentToolRunInspection> {
    const existing = await this.inspectAgentToolRun(options.runId);
    if (existing) return existing;

    const startedAt = Date.now();
    const controller = new AbortController();
    const assistantIdsBeforeStart = new Set(
      this.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id)
    );

    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${options.runId}, null, 'running', ${AIChatAgent._stringifyAgentToolValue(input)}, ${startedAt})
    `;
    this._agentToolAbortControllers.set(options.runId, controller);
    this._agentToolPreTurnAssistantIds.set(
      options.runId,
      assistantIdsBeforeStart
    );
    this._agentToolLiveSequences.set(options.runId, 0);

    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, {
        once: true
      });
    }

    const lifecycle = async () => {
      let requestId: string | undefined;
      try {
        const previousClientTools = this._lastClientTools;
        const previousBody = this._lastBody;
        this._setRequestContext(undefined, { agentToolInput: input });
        const result = await this.saveMessages(
          async (messages) => {
            this._registerAgentToolTurn(options.runId);
            return [
              ...messages,
              this.formatAgentToolInput(input, { runId: options.runId })
            ];
          },
          { signal: controller.signal }
        ).finally(() => {
          this._setRequestContext(previousClientTools, previousBody);
        });
        requestId = result.requestId;

        if (result.status === "aborted") {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId}, status = 'aborted',
                completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }

        if (result.status === "skipped") {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId}, status = 'error',
                error_message = 'Agent tool run was skipped because the chat was cleared.',
                completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }

        const streamError =
          result.error ?? this._agentToolLastErrors.get(options.runId);
        if (result.status === "error" || streamError) {
          const errorMessage =
            streamError ?? "Agent tool run failed during streaming.";
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId}, status = 'error',
                error_message = ${errorMessage}, completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }

        const messagesAfterStart = this._getAgentToolMessagesAfterStart(
          options.runId
        );
        const output = this.getAgentToolOutput(
          { runId: options.runId, input },
          messagesAfterStart
        );
        const summary = this.getAgentToolSummary(
          { runId: options.runId, input },
          output,
          messagesAfterStart
        );

        this.sql`
          update cf_ai_chat_agent_tool_runs
          set request_id = ${requestId}, status = 'completed',
              output_json = ${AIChatAgent._stringifyAgentToolValue(output)},
              summary = ${summary}, error_message = null,
              completed_at = ${Date.now()}
          where run_id = ${options.runId}
        `;
      } catch (error) {
        if (controller.signal.aborted) {
          this.sql`
            update cf_ai_chat_agent_tool_runs
            set request_id = ${requestId ?? null}, status = 'aborted',
                completed_at = ${Date.now()}
            where run_id = ${options.runId}
          `;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this._agentToolLastErrors.set(options.runId, message);
        this.sql`
          update cf_ai_chat_agent_tool_runs
          set request_id = ${requestId ?? null}, status = 'error',
              error_message = ${message}, completed_at = ${Date.now()}
          where run_id = ${options.runId}
        `;
      } finally {
        options.signal?.removeEventListener("abort", abortFromParent);
        this._agentToolAbortControllers.delete(options.runId);
        this._agentToolLiveSequences.delete(options.runId);
        // Drop this run's request-id mappings. When no runs remain in flight
        // clear the whole map, so negatively-cached (null) entries for
        // unrelated turns can't accumulate for the DO's lifetime — the map is
        // only consulted while a run is active (#1575).
        if (this._agentToolAbortControllers.size === 0) {
          this._agentToolRunsByRequestId.clear();
        } else {
          for (const [reqId, runId] of this._agentToolRunsByRequestId) {
            if (runId === options.runId) {
              this._agentToolRunsByRequestId.delete(reqId);
            }
          }
        }
        this._agentToolLastErrors.delete(options.runId);
        this._agentToolPreTurnAssistantIds.delete(options.runId);
        this._closeAgentToolTailers(options.runId);
      }
    };

    void this.keepAliveWhile(lifecycle);

    return {
      runId: options.runId,
      status: "running",
      startedAt
    };
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    // Stop the original in-isolate run if it's still live...
    this._agentToolAbortControllers.get(runId)?.abort(reason);
    // ...and any in-flight chat-recovery turn driving this child facet after an
    // eviction. A recovered turn re-runs via `_chatRecoveryContinue` /
    // `_chatRecoveryRetry` outside `startAgentToolRun`, so it has no entry in
    // `_agentToolAbortControllers`; a child facet is dedicated to a single
    // agent-tool run, so cancelling whatever turn is running tears the recovery
    // down instead of letting it keep grinding (and holding a keep-alive) after
    // the parent gave up and sealed `interrupted` (#1630 follow-up). Mirrors
    // Think's `_submissionAbortControllers` sweep.
    this.abortAllRequests(reason);
    this.sql`
      update cf_ai_chat_agent_tool_runs
      set status = 'aborted', completed_at = coalesce(completed_at, ${Date.now()})
      where run_id = ${runId} and status = 'running'
    `;
    this._closeAgentToolTailers(runId);
  }

  /**
   * Classify any in-flight chat-recovery on this child facet (#1630 / N6). A
   * child facet is dedicated to a single agent-tool run, so any recovery
   * incident is that run's. Incidents in `detected`/`scheduled`/`attempting`
   * mean recovery is still resolving the interrupted turn; `exhausted`/`failed`
   * mean recovery gave up; a completed recovery deletes its incident.
   */
  private _classifyAgentToolChildRecovery(): Promise<
    "in-progress" | "failed" | "none"
  > {
    return classifyAgentToolChildRecovery(this.ctx.storage);
  }

  /**
   * Reconcile a stale (post-eviction) child run row from the child's own
   * durable recovery (#1630). The child facet self-heals its interrupted turn
   * via `chatRecovery`, but that path never writes the run row, so without this
   * the row strands `running` and the parent can only collect `interrupted`.
   *
   * Persisting the terminal here (rather than only computing it) is intentional:
   * it's a lazy materialization of the run's true terminal that also lets a
   * tailing parent's stream close promptly and makes subsequent inspects cheap.
   * While recovery is still resolving (active stream or in-progress incident)
   * the row is left `running` so the parent's bounded re-attach keeps waiting.
   * Mutates `row` in place when it settles so the caller can report it.
   */
  private async _reconcileStaleAgentToolChildRun(
    runId: string,
    row: AIChatAgentToolRunRow
  ): Promise<void> {
    const recovery = await this._classifyAgentToolChildRecovery();
    if (recovery === "in-progress" || this._resumableStream.hasActiveStream()) {
      return;
    }
    const messagesAfterStart = this._getAgentToolMessagesAfterStart(runId);
    // A settled recovery that produced an assistant turn is `completed`, even if
    // it ended on a tool result with no final text — keying off text alone would
    // mis-seal a legitimately-finished (but text-less) run as `error`.
    // `getAgentToolSummary` falls back when there is no text.
    const recoveredTurn =
      recovery !== "failed" &&
      messagesAfterStart.some((message) => message.role === "assistant");
    if (recoveredTurn) {
      const input = AIChatAgent._parseAgentToolValue(row.input_json);
      const output = this.getAgentToolOutput(
        { runId, input },
        messagesAfterStart
      );
      const summary = this.getAgentToolSummary(
        { runId, input },
        output,
        messagesAfterStart
      );
      const completedAt = Date.now();
      this.sql`
        update cf_ai_chat_agent_tool_runs
        set status = 'completed',
            output_json = ${AIChatAgent._stringifyAgentToolValue(output)},
            summary = ${summary}, error_message = null,
            completed_at = ${completedAt}
        where run_id = ${runId} and status = 'running'
      `;
      row.status = "completed";
      row.output_json = AIChatAgent._stringifyAgentToolValue(output);
      row.summary = summary;
      row.error_message = null;
      row.completed_at = completedAt;
      this._closeAgentToolTailers(runId);
    } else {
      const error =
        "Agent tool run was interrupted before the child could finish.";
      this.sql`
        update cf_ai_chat_agent_tool_runs
        set status = 'error', error_message = ${error}, completed_at = ${Date.now()}
        where run_id = ${runId}
      `;
      row.status = "error";
      row.error_message = error;
      row.completed_at = Date.now();
      this._closeAgentToolTailers(runId);
    }
  }

  /**
   * Eagerly terminalize this child facet's OWN agent-tool run row(s) once a
   * recovered turn has settled. A recovered turn re-runs via either
   * `_chatRecoveryContinue` → `continueLastTurn` or, for a pre-stream eviction,
   * `_chatRecoveryRetry` → `_retryLastUserTurn` — neither flows through
   * `startAgentToolRun`'s finalizer, so without this the row strands `running`
   * and its tailers stay open until a parent inspect lazily reconciles it —
   * forcing a re-attached parent to wait out a full no-progress window before
   * collecting an already-finished result (#1630 follow-up). Reconciling here
   * closes the tail promptly so the parent collects the terminal immediately.
   * No-op on non-child facets (their `cf_ai_chat_agent_tool_runs` table is
   * empty) and on rows whose in-memory run is still live; the underlying
   * reconcile leaves a row `running` while its recovery is still in progress.
   * Mirrors `@cloudflare/think`.
   */
  private async _reconcileOwnStaleAgentToolChildRuns(): Promise<void> {
    let rows: Array<{ run_id: string }>;
    try {
      rows = this.sql<{ run_id: string }>`
        select run_id from cf_ai_chat_agent_tool_runs
        where status = 'running'
      `;
    } catch {
      // No child-run table on this facet (it never ran as a child).
      return;
    }
    for (const { run_id } of rows) {
      if (this._agentToolAbortControllers.has(run_id)) continue;
      const row = this._getAgentToolRunRow(run_id);
      if (!row || row.status !== "running") continue;
      try {
        await this._reconcileStaleAgentToolChildRun(run_id, row);
      } catch {
        // Best-effort: a parent inspect still reconciles lazily.
      }
    }
  }

  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    const row = this._getAgentToolRunRow(runId);
    if (!row) return null;

    // A `running` row with no live abort controller means the original
    // in-isolate run is gone (e.g. the parent was evicted while this child run
    // was in flight, #1630) — lazily reconcile it from the child's own durable
    // recovery before reporting (mutates `row` in place when it settles).
    if (
      row.status === "running" &&
      !this._agentToolAbortControllers.has(runId)
    ) {
      await this._reconcileStaleAgentToolChildRun(runId, row);
    }

    const streamId = row.request_id
      ? this._getAgentToolStreamId(row.request_id)
      : undefined;
    const messagesAfterStart = this._getAgentToolMessagesAfterStart(runId);
    const input = AIChatAgent._parseAgentToolValue(row.input_json);
    const output =
      row.status === "completed"
        ? (AIChatAgent._parseAgentToolValue(row.output_json) ??
          this.getAgentToolOutput({ runId, input }, messagesAfterStart))
        : undefined;

    return {
      runId,
      status: row.status,
      requestId: row.request_id ?? undefined,
      streamId,
      output,
      summary: row.status === "completed" ? (row.summary ?? "") : undefined,
      error:
        row.status === "error" ? (row.error_message ?? undefined) : undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined
    };
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    this._flushChunkBuffer();
    const row = this._getAgentToolRunRow(runId);
    if (!row?.request_id) return [];

    return this._getAgentToolStoredChunks(
      row.request_id,
      options?.afterSequence
    );
  }

  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          controller.close();
        };
        const onAbort = () => close();

        try {
          if (options?.signal?.aborted) {
            close();
            return;
          }
          options?.signal?.addEventListener("abort", onAbort, { once: true });

          for (const chunk of await this.getAgentToolChunks(runId, options)) {
            if (closed) return;
            controller.enqueue(
              agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
            );
          }

          const inspection = await this.inspectAgentToolRun(runId);
          if (!inspection || inspection.status !== "running") {
            close();
            return;
          }

          const forwarders =
            this._agentToolForwarders.get(runId) ??
            new Set<(chunk: AgentToolStoredChunk) => void>();
          const forward = (chunk: AgentToolStoredChunk) => {
            if (closed) return;
            try {
              controller.enqueue(
                agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
              );
            } catch {
              // The consumer detached (e.g. a parent's bounded re-attach budget
              // expired) between the read view closing and our close() running.
              // Drop the chunk instead of surfacing a stream rejection; the
              // child run is unaffected.
              close();
            }
          };
          forwarders.add(forward);
          this._agentToolForwarders.set(runId, forwarders);

          const closers =
            this._agentToolClosers.get(runId) ?? new Set<() => void>();
          closers.add(close);
          this._agentToolClosers.set(runId, closers);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: () => {}
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  private _getAgentToolRunRow(runId: string): AIChatAgentToolRunRow | null {
    const rows = this.sql<AIChatAgentToolRunRow>`
      select run_id, request_id, status, input_json, output_json, summary,
             error_message, started_at, completed_at
      from cf_ai_chat_agent_tool_runs
      where run_id = ${runId}
    `;
    return rows[0] ?? null;
  }

  private _getAgentToolStreamId(requestId: string): string | undefined {
    const rows = this.sql<AIChatStreamMetadataRow>`
      select id, status, request_id
      from cf_ai_chat_stream_metadata
      where request_id = ${requestId}
      order by rowid desc
      limit 1
    `;
    return rows[0]?.id;
  }

  private _getAgentToolStoredChunks(
    requestId: string,
    afterSequence = -1
  ): AgentToolStoredChunk[] {
    const streamId = this._getAgentToolStreamId(requestId);
    if (!streamId) return [];

    // Read through ResumableStream so packed segment rows are unpacked into
    // individual chunk bodies with a running per-chunk index. That per-chunk
    // sequence matches the in-memory live counter (`_agentToolLiveSequences`),
    // so a tailing parent can switch from stored replay to live forwarding
    // without gaps or duplicates.
    return this._resumableStream
      .getStreamChunks(streamId)
      .filter((chunk) => chunk.chunk_index > afterSequence)
      .map((chunk) => ({ sequence: chunk.chunk_index, body: chunk.body }));
  }

  private _getAgentToolMessagesAfterStart(runId: string): UIMessage[] {
    const previousAssistantIds =
      this._agentToolPreTurnAssistantIds.get(runId) ?? new Set<string>();
    return this.messages.filter(
      (message) =>
        message.role !== "assistant" || !previousAssistantIds.has(message.id)
    );
  }

  private _closeAgentToolTailers(runId: string) {
    const closers = this._agentToolClosers.get(runId);
    if (closers) {
      for (const close of closers) close();
      this._agentToolClosers.delete(runId);
    }
    this._agentToolForwarders.delete(runId);
  }

  private static _stringifyAgentToolValue(value: unknown): string | null {
    if (value === undefined) return null;
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  }

  private static _parseAgentToolValue(value: string | null): unknown {
    if (value === null) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
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
   * Pre-aborted signals short-circuit before any model work runs.
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
    const requestId = nanoid();
    const clientTools = this._lastClientTools;
    const body = this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        const resolvedMessages =
          typeof messages === "function"
            ? await messages(this.messages)
            : messages;

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        await this.persistMessages(resolvedMessages);

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const turnResult = await this._runProgrammaticChatTurn(
          requestId,
          clientTools,
          body,
          options?.signal
        );
        status = turnResult.status;
        error = turnResult.error;
      },
      { epoch }
    );

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }

    return { requestId, status, ...(error !== undefined && { error }) };
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
    if (!this._findLastAssistantMessage()) {
      return { requestId: "", status: "skipped" };
    }

    const requestId = nanoid();
    // If this facet is an agent-tool child being recovered, re-bind its run row
    // to this turn's request id so the parent's re-attach tail keeps attributing
    // the continued turn's frames (no-op otherwise).
    this._rebindAgentToolChildRunRequestId(requestId);
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let wasAborted = false;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        this._setRequestContext(clientTools, resolvedBody);

        const turnBody = async () => {
          await this._tryCatchChat(async () => {
            return agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              async () => {
                const abortSignal = this._abortRegistry.getSignal(requestId);
                const detachExternal = this._abortRegistry.linkExternal(
                  requestId,
                  options?.signal
                );
                try {
                  await this._repairInterruptedToolsBeforeTurn();
                  const response = await this.onChatMessage(() => {}, {
                    requestId,
                    abortSignal,
                    clientTools,
                    body: resolvedBody,
                    continuation: true
                  });

                  if (response) {
                    const replyResult = await this._reply(
                      requestId,
                      response,
                      [],
                      {
                        continuation: true,
                        chatMessageId: requestId
                      }
                    );
                    status = replyResult.status;
                    error = replyResult.error;
                  }
                } finally {
                  if (abortSignal?.aborted) wasAborted = true;
                  detachExternal();
                  this._abortRegistry.remove(requestId);
                }
              }
            );
          });
        };

        if (this.chatRecovery) {
          await this._runChatRecoveryFiber(requestId, true, turnBody);
        } else {
          await turnBody();
        }
      },
      { epoch }
    );

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }

    return { requestId, status, ...(error !== undefined && { error }) };
  }

  private async _retryLastUserTurn(
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const lastMessage =
      this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
    if (!lastMessage || lastMessage.role !== "user") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = nanoid();
    // If this facet is an agent-tool child being recovered, re-bind its run row
    // to this turn's request id so the parent's re-attach tail keeps attributing
    // the retried turn's frames (no-op otherwise).
    this._rebindAgentToolChildRunRequestId(requestId);
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;

    await this._runExclusiveChatTurn(
      requestId,
      async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const turnResult = await this._runProgrammaticChatTurn(
          requestId,
          clientTools,
          body,
          options?.signal
        );
        status = turnResult.status;
        error = turnResult.error;
      },
      { epoch }
    );

    if (this._turnQueue.generation !== epoch && status === "completed") {
      status = "skipped";
    }

    return { requestId, status, ...(error !== undefined && { error }) };
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
   * its budget prematurely (#1628). Instead we read a durably-persisted counter
   * that only ever increments — bumped at production time when new content is
   * streamed (see `_storeStreamChunk` / `_maybeBumpRecoveryProgress`), which is
   * genuine forward progress and is immune to client reconnects / recovery
   * re-persists — so compaction can never lower it and a reconnect can't fake
   * it (#1637).
   */
  private async _chatRecoveryProgressMarker(): Promise<number> {
    // Storage read lives in the shared engine (agents/chat); this is the
    // package binding, symmetric with `Think`.
    return readChatRecoveryProgress(this.ctx.storage);
  }

  /** Advance the durable recovery-progress counter. Called from
   *  `_maybeBumpRecoveryProgress` when new content is streamed (real,
   *  reconnect-immune forward progress). The increment lives in the shared
   *  engine (agents/chat); this is the package binding. */
  private async _bumpChatRecoveryProgress(): Promise<void> {
    return bumpChatRecoveryProgress(this.ctx.storage);
  }

  /** Per-isolate N9 throttle gate (shared `agents/chat` helper); reset per
   *  isolate so the first forwarded chunk after a restart always credits. */
  private _agentToolStreamProgress = new AgentToolStreamProgressThrottle();

  /**
   * N9: forwarding a sub-agent's chunks IS forward progress for this parent
   * turn, so credit the parent's recovery progress marker — otherwise a parent
   * whose turn merely `await`s a child banks no progress of its own and its
   * no-progress window exhausts while the child is healthily streaming. Only
   * invoked after a child actually produced output (see
   * `_forwardAgentToolStream`), so a silent child still lets the parent exhaust.
   * Throttled (and reset per isolate) so we never write storage per token.
   */
  protected override async _onAgentToolStreamProgress(): Promise<void> {
    if (this._agentToolStreamProgress.shouldCredit(Date.now())) {
      await this._bumpChatRecoveryProgress();
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
      now: () => Date.now(),
      sweepStaleIncidents: (now) =>
        sweepStaleChatRecoveryIncidents(this.ctx.storage, now),
      getIncident: async (key) =>
        (await this.ctx.storage.get<ChatRecoveryIncident>(key)) ?? null,
      readProgress: () => this._chatRecoveryProgressMarker(),
      // A turn parked on a pending CLIENT interaction is waiting on the human,
      // not stuck, so the engine keeps it budget-free.
      isAwaitingClientInteraction: () => this.hasPendingClientInteraction(),
      putIncident: (key, incident) => this.ctx.storage.put(key, incident),
      deleteIncident: async (key) => {
        await this.ctx.storage.delete(key);
      },
      emitRecoveryEvent: (event) =>
        this._emit(event.type, {
          incidentId: event.incidentId,
          requestId: event.requestId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          recoveryKind: event.recoveryKind,
          ...(event.reason ? { reason: event.reason } : {})
        }),
      scheduleRecovery: async (callback, data, reason, delaySeconds) => {
        await this.schedule(
          delaySeconds,
          callback,
          data,
          chatRecoverySchedulePolicy(reason)
        );
      },
      setRecovering: (active, requestId) =>
        this._setChatRecovering(active, requestId),
      onShouldKeepRecoveringError: (error) =>
        console.error(
          "[AIChatAgent] chatRecovery shouldKeepRecovering hook threw",
          error
        ),
      exhaustChatRecovery: (incident, config, partial, streamId, createdAt) =>
        this._exhaustChatRecovery(
          incident,
          config,
          partial,
          streamId,
          createdAt
        ),
      resolveRecoveryStream: (requestId) =>
        this._resolveAIChatRecoveryStream(requestId),
      getPartialStreamText: (streamId) => this._getPartialStreamText(streamId),
      activeChatRecoveryRootRequestId: () =>
        this._activeChatRecoveryRootRequestId,
      onGiveUpBookkeepingError: (phase, error) =>
        console.error(
          phase === "read"
            ? "[AIChatAgent] failed to read recovery incident during give-up; synthesizing"
            : "[AIChatAgent] failed to persist sealed recovery incident during give-up",
          error
        )
    } satisfies ChatRecoveryAdapter));
  }

  private async _beginChatRecoveryIncident(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: ChatRecoveryKind;
    /** Test-only clock injection for deterministic debounce/window timing. */
    nowMs?: number;
  }): Promise<{
    incident: ChatRecoveryIncident;
    config: ResolvedChatRecoveryConfig;
    exhausted: boolean;
  }> {
    // Incident orchestration (sweep -> read -> budget eval -> persist -> emit,
    // with its ordering invariants) lives in the shared ChatRecoveryEngine; this
    // method is the package's adapter binding. See
    // design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().beginIncident(input);
  }

  private async _updateChatRecoveryIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string
  ): Promise<void> {
    // Incident state-machine transitions (delete-on-completed vs persist, the
    // completed/skipped/failed event emit, and the #1620 recovering-flag) live
    // in the shared ChatRecoveryEngine; this method is the package's adapter
    // binding. See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().updateIncident(
      incidentId,
      status,
      reason
    );
  }

  private async _exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    // `parts` is the engine's vocabulary-agnostic `unknown[]`; ai-chat owns the
    // AI SDK `UIMessage` vocabulary, so it re-asserts `MessagePart[]` at the
    // user-facing exhausted-context edge below.
    partial: { text: string; parts: unknown[] },
    streamId: string,
    createdAt: number
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
          this._broadcastChatMessage({
            body: ctx.terminalMessage,
            done: true,
            error: true,
            id: ctx.requestId,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
          });
          // The durable terminal record (#1645) is replayed to a client that
          // (re)connects after the turn ended (shared
          // `ResumeHandshake._replayTerminalOnResume`).
          await this._recordChatTerminal(ctx.requestId, ctx.terminalMessage);
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
    body: string
  ): Promise<void> {
    await recordChatTerminal(this.ctx.storage, requestId, body);
  }

  /** Clear the durable terminal record once a later turn supersedes it (#1645). */
  private async _clearChatTerminal(): Promise<void> {
    await clearChatTerminal(this.ctx.storage);
  }

  private async _pendingChatTerminal(): Promise<{
    requestId: string;
    body: string;
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
        void this._ensureStreamCleanupScheduled();
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
      const rows = this.sql<{ id: string }>`
        SELECT id FROM cf_ai_chat_stream_metadata
        WHERE request_id = ${requestId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length > 0) {
        streamId = rows[0].id;
      }
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
    const preStreamLeaf =
      this.messages.length > 0
        ? this.messages[this.messages.length - 1]
        : undefined;
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
    const leaf =
      this.messages.length > 0
        ? this.messages[this.messages.length - 1]
        : undefined;
    const lostPartialUserId =
      snapshot?.continuation === false &&
      snapshot.latestUserMessageId &&
      leaf?.role === "user" &&
      leaf.id === snapshot.latestUserMessageId
        ? snapshot.latestUserMessageId
        : undefined;

    const targetId =
      input.detail.shouldRetryPreStream || lostPartialUserId !== undefined
        ? undefined
        : this._findLastAssistantMessage()?.id;

    if (input.detail.shouldRetryPreStream && options.continue !== false) {
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: input.recoveryKind,
        callback: "_chatRecoveryRetry",
        data: {
          targetUserId: snapshot?.latestUserMessageId,
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          lastBody: snapshot?.lastBody ?? null,
          lastClientTools: snapshot?.lastClientTools ?? null
        }
      });
    } else if (lostPartialUserId !== undefined && options.continue !== false) {
      // Re-run the orphaned new turn fresh instead of continuing (and merging
      // into) the previous assistant message. The incident may have opened as
      // `continue`, but the action (and the reported kind) is a `retry`.
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: "retry",
        callback: "_chatRecoveryRetry",
        data: {
          targetUserId: lostPartialUserId,
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          lastBody: snapshot?.lastBody ?? null,
          lastClientTools: snapshot?.lastClientTools ?? null
        }
      });
    } else if (options.continue !== false) {
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: input.recoveryKind,
        callback: "_chatRecoveryContinue",
        data: {
          ...(targetId ? { targetAssistantId: targetId } : {}),
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          ...(snapshot
            ? {
                lastBody: snapshot.lastBody ?? null,
                lastClientTools: snapshot.lastClientTools ?? null
              }
            : {})
        }
      });
    } else {
      await this._updateChatRecoveryIncident(
        incident.incidentId,
        "skipped",
        "continue_disabled"
      );
    }
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
    const previousRootRequestId = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId =
      data?.originalRequestId ?? previousRootRequestId;
    try {
      const recoveryConfig = this._resolveChatRecoveryConfig();
      const ready = await this.waitUntilStable({
        timeout: recoveryConfig.stableTimeoutMs,
        // Recovery-scoped: a DEAD server-tool `input-available` orphan must not
        // block stability (A.2 repairs it below), so gate on the client-
        // resolvable predicate. A genuinely-pending CLIENT interaction still
        // keeps it unstable and parks via the `!ready` branch.
        pendingInteraction: () => this.hasPendingClientInteraction()
      });
      if (!ready) {
        // PARK, don't burn the budget: a stable-state timeout while a CLIENT
        // interaction is pending is not churn — the turn is correctly waiting
        // for the client to replay an interrupted tool-result / approval after
        // reconnect, which drives a fresh continuation independently of this
        // retry loop. Retrying here would just time out again (the human hasn't
        // answered) and eventually seal a healthy turn on `stable_timeout`. So
        // stop the loop, resolve the live "recovering…" indicator, and let the
        // client's replay resume the turn.
        if (await this._parkRecoveryForPendingInteraction(data)) {
          return;
        }
        console.warn(
          "[AIChatAgent] _chatRecoveryContinue timed out waiting for stable state"
        );
        // A stable-state timeout under deploy churn is usually transient (the
        // isolate is still settling / another deploy is in flight). Reschedule
        // within the attempt budget instead of permanently abandoning a
        // recoverable turn; only give up once the budget is exhausted.
        if (
          await this._rescheduleRecoveryAfterStableTimeout(
            "_chatRecoveryContinue",
            data,
            recoveryConfig.maxAttempts
          )
        ) {
          return;
        }
        // Budget spent: terminalize through the SAME exhaustion path as deploy
        // recovery (fires `onExhausted`, delivers the `terminalMessage` banner)
        // instead of silently dropping the turn — otherwise an app relying on
        // `onExhausted` sees an eternal spinner.
        await this._exhaustRecoveryAfterStableTimeout(
          "_chatRecoveryContinue",
          data
        );
        return;
      }

      const targetId = data?.targetAssistantId;
      if (targetId && this._findLastAssistantMessage()?.id !== targetId) {
        // The leaf moved, so this continuation is superseded — skip it.
        // NOTE: unlike `@cloudflare/think`, AIChatAgent does NOT distinguish an
        // assistant leaf (recovery's own forward progress) from a newer user
        // turn here, because AIChatAgent has no durable-submission layer to
        // protect — there is nothing to mark `skipped` vs leave `running`. If
        // AIChatAgent ever gains submissions, mirror Think's split in
        // `_chatRecoveryContinue` or this skip will silently clobber them.
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "conversation_changed"
        );
        return;
      }

      this._applyRecoveredRequestContext(data);
      // `continueLastTurn` repairs interrupted server-tool orphans before it
      // re-enters inference (`_repairInterruptedToolsBeforeTurn`), so the
      // recovered transcript is settled and the next `convertToModelMessages`
      // doesn't 400 with `AI_MissingToolResultsError`.
      const result = await this.continueLastTurn();
      await this._updateChatRecoveryIncident(
        data?.incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
      );
    } finally {
      this._activeChatRecoveryRootRequestId = previousRootRequestId;
      // If this facet is an agent-tool child, its recovered turn just settled
      // outside `startAgentToolRun`'s finalizer — eagerly close the run so a
      // re-attached parent collects the terminal immediately rather than
      // waiting out a no-progress window.
      await this._reconcileOwnStaleAgentToolChildRuns();
    }
  }

  private _applyRecoveredRequestContext(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): void {
    if (!data) return;
    if ("lastClientTools" in data) {
      this._lastClientTools = data.lastClientTools ?? undefined;
    }
    if ("lastBody" in data) {
      this._lastBody = data.lastBody ?? undefined;
    }
    if ("lastClientTools" in data || "lastBody" in data) {
      this._persistRequestContext();
    }
  }

  /**
   * Route a live stream stall (the {@link chatStreamStallTimeoutMs} watchdog
   * fired) into the same bounded-recovery machinery a deploy/eviction
   * interruption uses (#1626). Mirrors `@cloudflare/think`'s stall path: open or
   * reuse the incident under the turn's recovery identity, deliver terminal UX
   * if the budget is spent, otherwise schedule a `_chatRecoveryContinue`.
   *
   * Unlike Think there is no durable-submission layer to complete here, so the
   * schedule payload carries no `recoveredRequestId`.
   *
   * Returns `"disabled"` when chat recovery is off (the caller then surfaces the
   * stall as a terminal stream error — the watchdog's "kill the spinner"
   * guarantee), `"exhausted"` when the budget was spent (terminal UX already
   * delivered), or `"scheduled"` when a continuation was queued.
   */
  private async _routeStallToBoundedRecovery(input: {
    requestId: string;
    streamId: string;
    partialParts: MessagePart[];
    targetAssistantId?: string;
  }): Promise<"scheduled" | "exhausted" | "disabled"> {
    // Stall-recovery is automatic only when chat recovery is enabled. With
    // recovery off there is no budget/continuation machinery to route into, so
    // the stall stays terminal.
    if (!this._resolveChatRecoveryConfig().enabled) return "disabled";
    const recoveryRootRequestId =
      this._activeChatRecoveryRootRequestId ?? input.requestId;
    const latestUserMessageId =
      [...this.messages].reverse().find((m) => m.role === "user")?.id ?? null;
    const { incident, config, exhausted } =
      await this._beginChatRecoveryIncident({
        requestId: input.requestId,
        recoveryRootRequestId,
        latestUserMessageId,
        recoveryKind: "continue"
      });
    if (exhausted) {
      // Budget spent: deliver the SAME terminal UX as deploy-recovery
      // exhaustion (terminalMessage + onExhausted + chat:recovery:exhausted)
      // instead of letting the raw stall error leak out. `firstSeenAt` is the
      // closest available turn-start proxy here.
      const partialText = input.partialParts
        .filter(
          (p): p is { type: "text"; text: string } =>
            (p as { type?: string }).type === "text"
        )
        .map((p) => p.text)
        .join("");
      await this._exhaustChatRecovery(
        incident,
        config,
        { text: partialText, parts: input.partialParts },
        input.streamId,
        incident.firstSeenAt
      );
      return "exhausted";
    }
    await this._chatRecoveryEngine().scheduleRecovery({
      incident,
      recoveryKind: "continue",
      callback: "_chatRecoveryContinue",
      data: {
        ...(input.targetAssistantId
          ? { targetAssistantId: input.targetAssistantId }
          : {}),
        originalRequestId: recoveryRootRequestId,
        incidentId: incident.incidentId,
        lastBody: this._lastBody ?? null,
        lastClientTools: this._lastClientTools ?? null
      }
    });
    return "scheduled";
  }

  /**
   * Reschedule a recovery callback that timed out waiting for stable state,
   * consuming one attempt. Returns `true` if rescheduled, `false` if the
   * attempt budget is exhausted (caller should then fail terminally).
   */
  private async _rescheduleRecoveryAfterStableTimeout(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    maxAttempts: number
  ): Promise<boolean> {
    // The attempt-bump + scheduled/stable_timeout_retry persist + delayed
    // non-idempotent reschedule live in the shared ChatRecoveryEngine; this
    // method is the package's adapter binding, symmetric with `Think`. See
    // design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().rescheduleAfterStableTimeout({
      incidentId: data?.incidentId,
      callback,
      data,
      fallbackMaxAttempts: maxAttempts
    });
  }

  /**
   * Park a recovery continuation that timed out waiting for stable state
   * because the turn is holding a pending CLIENT interaction (an
   * `input-available` client-tool part or an `approval-requested` part — see
   * `hasPendingClientInteraction`). Such a turn is WAITING ON THE HUMAN, not
   * stuck: the client replays the interrupted tool-result / approval after
   * reconnect, which drives a fresh continuation independently of the recovery
   * retry loop. Burning the attempt budget on that wait (each `waitUntilStable`
   * times out because the human hasn't answered) would seal a perfectly healthy
   * turn on `stable_timeout` — the symptom behind HITL "session recovery errors"
   * under deploy churn.
   *
   * So instead of rescheduling or exhausting, we stop the loop and mark the
   * incident `skipped` (reason `awaiting_client_interaction`). That retains the
   * incident record (a later genuine interruption re-evaluates it) while
   * resolving the live "recovering…" indicator via `_updateChatRecoveryIncident`
   * so the client sees the parked tool-call UI rather than an eternal spinner.
   * A client that never returns is reclaimed by the incident TTL sweep and DO
   * idle-eviction. SERVER-tool orphans are excluded by `hasPendingClientInteraction`
   * (their `execute` died with the isolate), so they still reschedule / exhaust
   * via the normal path. Mirrors the same helper in `@cloudflare/think`.
   *
   * Returns `true` when the recovery was parked (caller must return), `false`
   * when there is no pending client interaction (caller proceeds to the normal
   * reschedule / exhaustion path).
   */
  private async _parkRecoveryForPendingInteraction(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<boolean> {
    if (!this.hasPendingClientInteraction()) return false;
    await this._updateChatRecoveryIncident(
      data?.incidentId,
      "skipped",
      "awaiting_client_interaction"
    );
    return true;
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
   *    invocation — every production scheduler carries one): the synthesized
   *    incident can't be persisted (no key), so the guard can't arm.
   *  • The record is swept AGAIN between two alarms (the guard re-persists on
   *    the first, so this needs a second independent sweep) — vanishingly
   *    unlikely.
   */
  private _exhaustRecoveryAfterStableTimeout(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<void> {
    // The give-up spine (read → re-entry-guard → build-exhausted-incident →
    // terminalize-before-seal → best-effort seal) lives in the shared
    // ChatRecoveryEngine; this is the package binding, symmetric with `Think`.
    // `AIChatAgent` always gives up with `stable_timeout` (its only give-up
    // trigger) and never sets `recoveredRequestId`, so the engine's unified
    // root-id chain collapses to `originalRequestId ?? activeRoot ?? stored…`
    // exactly as before. The terminalize + stream/partial hooks are wired on
    // the adapter above. See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().exhaustRecoveryGiveUp({
      callback,
      data,
      reason: "stable_timeout"
    });
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

    const lastMessage =
      this.messages.length > 0 ? this.messages[this.messages.length - 1] : null;
    return (
      lastMessage?.role === "user" &&
      lastMessage.id === snapshot.latestUserMessageId
    );
  }

  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    const previousRootRequestId = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId =
      data?.originalRequestId ?? previousRootRequestId;
    try {
      const recoveryConfig = this._resolveChatRecoveryConfig();
      const ready = await this.waitUntilStable({
        timeout: recoveryConfig.stableTimeoutMs,
        // Recovery-scoped narrow predicate (see `_chatRecoveryContinue`): a dead
        // server-tool orphan must not block stability; a real client
        // interaction still parks via the `!ready` branch.
        pendingInteraction: () => this.hasPendingClientInteraction()
      });
      if (!ready) {
        // PARK while a CLIENT interaction is pending — the turn is waiting for
        // the human, not churning; see `_chatRecoveryContinue` for the full
        // rationale.
        if (await this._parkRecoveryForPendingInteraction(data)) {
          return;
        }
        console.warn(
          "[AIChatAgent] _chatRecoveryRetry timed out waiting for stable state"
        );
        if (
          await this._rescheduleRecoveryAfterStableTimeout(
            "_chatRecoveryRetry",
            data,
            recoveryConfig.maxAttempts
          )
        ) {
          return;
        }
        // Budget spent: terminalize through the SAME exhaustion path as deploy
        // recovery (fires `onExhausted`, delivers the `terminalMessage` banner)
        // instead of silently dropping the turn — otherwise an app relying on
        // `onExhausted` sees an eternal spinner.
        await this._exhaustRecoveryAfterStableTimeout(
          "_chatRecoveryRetry",
          data
        );
        return;
      }

      const lastMessage =
        this.messages.length > 0
          ? this.messages[this.messages.length - 1]
          : null;
      if (!lastMessage || lastMessage.role !== "user") {
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "no_unanswered_user_message"
        );
        return;
      }

      if (data?.targetUserId && lastMessage.id !== data.targetUserId) {
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "conversation_changed"
        );
        return;
      }

      this._applyRecoveredRequestContext(data);
      // The retry runs through `_runProgrammaticChatTurn`, which repairs any
      // interrupted tool orphan before re-entering inference
      // (`_repairInterruptedToolsBeforeTurn`). The retry path normally re-runs
      // an unanswered user-message tail (no assistant orphan to repair), so that
      // is a defensive no-op here, but keeps both recovery entrypoints converged.
      const result = await this._retryLastUserTurn(
        this._lastClientTools,
        this._lastBody
      );
      await this._updateChatRecoveryIncident(
        data?.incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
      );
    } finally {
      this._activeChatRecoveryRootRequestId = previousRootRequestId;
      // If this facet is an agent-tool child, its recovered turn just settled
      // outside `startAgentToolRun`'s finalizer — eagerly close the run so a
      // re-attached parent collects the terminal immediately rather than
      // waiting out a no-progress window. The pre-stream retry path settles via
      // `_retryLastUserTurn`, which (like `continueLastTurn`) never hits the
      // finalizer, so it needs the same reconcile as `_chatRecoveryContinue`.
      await this._reconcileOwnStaleAgentToolChildRuns();
    }
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

  async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    /** @internal */
    options?: { _deleteStaleRows?: boolean }
  ) {
    const mergedMessages = reconcileMessages(messages, this.messages, (msg) =>
      this._sanitizeMessageForPersistence(msg)
    );

    // Persist only new or changed messages (incremental persistence).
    // Compares serialized JSON against a cache of last-persisted versions.
    for (const message of mergedMessages) {
      const sanitizedMessage = this._sanitizeMessageForPersistence(message);
      const resolved = resolveToolMergeId(sanitizedMessage, this.messages);
      const safe = this._enforceRowSizeLimit(resolved);
      const json = JSON.stringify(safe);

      // Skip SQL write if the message is identical to what's already persisted
      if (this._persistedMessageCache.get(safe.id) === json) {
        continue;
      }

      this.sql`
        insert into cf_ai_chat_agent_messages (id, message)
        values (${safe.id}, ${json})
        on conflict(id) do update set message = excluded.message
      `;
      this._persistedMessageCache.set(safe.id, json);
    }

    // Reconcile: delete DB rows not present in the incoming message set.
    // Only safe when the incoming set is a subset of the server state
    // (e.g. regenerate() trims the last assistant message). When the
    // client appends new messages (IDs unknown to the server), it may
    // not have the full history, so deleting "missing" rows would
    // destroy server-generated assistant messages the client hasn't
    // seen yet.
    // This MUST use mergedMessages (post-merge IDs) because
    // reconcileMessages can remap client IDs to server IDs.
    if (options?._deleteStaleRows) {
      const serverIds = new Set(this.messages.map((m) => m.id));
      const isSubsetOfServer = mergedMessages.every((m) => serverIds.has(m.id));

      if (isSubsetOfServer) {
        const keepIds = new Set(mergedMessages.map((m) => m.id));
        const allDbRows =
          this.sql<{ id: string }>`
            select id from cf_ai_chat_agent_messages
          ` || [];
        const staleIds = allDbRows
          .map((row) => row.id)
          .filter((id) => !keepIds.has(id));
        this._deleteMessagesByIds(staleIds);
      }
    }

    // Enforce maxPersistedMessages: delete oldest messages if over the limit
    if (this.maxPersistedMessages != null) {
      this._enforceMaxPersistedMessages();
    }

    // refresh in-memory messages
    const persisted = this._loadMessagesFromDb();
    this.messages = autoTransformMessages(persisted);
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
        return structuredClone(lastAssistant);
      }
    }

    return {
      id: `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      role: "assistant",
      parts: []
    };
  }

  /**
   * Sanitizes a message for persistence by removing ephemeral provider-specific
   * data that should not be stored or sent back in subsequent requests.
   *
   * Pipeline:
   *
   * 1. **Strip OpenAI ephemeral fields**: The AI SDK's @ai-sdk/openai provider
   *    (v2.0.x+) defaults to using OpenAI's Responses API which assigns unique
   *    itemIds and reasoningEncryptedContent to message parts. When persisted
   *    and sent back, OpenAI rejects duplicate itemIds.
   *
   * 2. **Truncate provider-executed tool payloads**: Server-side tool
   *    executions (e.g. Anthropic code_execution, text_editor) can produce
   *    200KB+ payloads in `input` and `output`. These are truncated since the
   *    model has already consumed the results.
   *
   * 3. **Filter truly empty reasoning parts**: After stripping, reasoning parts
   *    with no text and no remaining providerMetadata are removed. Parts that
   *    still carry providerMetadata (e.g. Anthropic's redacted_thinking blocks
   *    with providerMetadata.anthropic.redactedData) are preserved, as they
   *    contain data required for round-tripping with the provider API.
   *
   * 4. **User hook**: Calls the overridable `sanitizeMessageForPersistence()`
   *    method, allowing subclasses to apply custom transformations.
   *
   * @param message - The message to sanitize
   * @returns A new message with ephemeral provider data removed
   */
  private _sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    // Base sanitization: strip OpenAI ephemeral fields + filter empty reasoning parts
    const baseSanitized = sanitizeMessage(message);

    // ai-chat-specific: truncate large payloads in provider-executed tool parts
    const parts = baseSanitized.parts.map((part) =>
      AIChatAgent._truncateProviderExecutedToolPayloads(part)
    ) as UIMessage["parts"];

    // Run user-overridable hook last
    return this.sanitizeMessageForPersistence({
      ...baseSanitized,
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
   * Delete the given message rows from SQLite in batched `IN (...)` queries
   * and evict them from the persistence cache. Batches stay within the SQLite
   * 100 bound-parameter limit. No-op for an empty list.
   * @internal
   */
  private _deleteMessagesByIds(ids: string[]) {
    for (let i = 0; i < ids.length; i += MAX_BOUND_PARAMS) {
      const batch = ids.slice(i, i + MAX_BOUND_PARAMS);
      const strings = buildInClauseStrings(
        "delete from cf_ai_chat_agent_messages where id in ",
        batch.length
      );
      this.sql(strings, ...batch);
      for (const id of batch) {
        this._persistedMessageCache.delete(id);
      }
    }
  }

  /**
   * Deletes oldest messages from SQLite when the count exceeds maxPersistedMessages.
   * Called after each persist to keep storage bounded.
   */
  private _enforceMaxPersistedMessages() {
    if (this.maxPersistedMessages == null) return;

    const countResult = this.sql<{ cnt: number }>`
      select count(*) as cnt from cf_ai_chat_agent_messages
    `;
    const count = countResult?.[0]?.cnt ?? 0;

    if (count <= this.maxPersistedMessages) return;

    const excess = count - this.maxPersistedMessages;

    // Delete the oldest messages (by created_at)
    // Also remove them from the persistence cache
    const toDelete = this.sql<{ id: string }>`
      select id from cf_ai_chat_agent_messages 
      order by created_at asc 
      limit ${excess}
    `;

    if (toDelete && toDelete.length > 0) {
      this._deleteMessagesByIds(toDelete.map((row) => row.id));
    }
  }

  /**
   * Enforces SQLite row size limits by compacting tool outputs and text parts
   * when a serialized message exceeds the safety threshold (1.8MB).
   *
   * Only fires in pathological cases (extremely large tool outputs or text).
   * Returns the message unchanged if it fits within limits.
   *
   * Compaction strategy:
   * 1. Compact tool outputs over 1KB (replace with LLM-friendly summary)
   * 2. If still too big, truncate text parts from oldest to newest
   * 3. Add metadata so clients can detect compaction
   *
   * @param message - The message to check
   * @returns The message, compacted if necessary
   */
  private _enforceRowSizeLimit(message: UIMessage): UIMessage {
    return enforceRowSizeLimit(message, {
      warn: (m) => console.warn(`[AIChatAgent] ${m}`)
    });
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
   * @param callerName - Name for log messages (e.g. "_applyToolResult")
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
    // Find the message containing this tool call.
    // Check streaming message first (in-memory, not yet persisted), then
    // retry persisted messages with backoff.
    let message: UIMessage | undefined;

    if (this._streamingMessage) {
      for (const part of this._streamingMessage.parts) {
        if ("toolCallId" in part && part.toolCallId === toolCallId) {
          message = this._streamingMessage;
          break;
        }
      }
    }

    if (!message) {
      for (let attempt = 0; attempt < 10; attempt++) {
        message = this._findMessageByToolCallId(toolCallId);
        if (message) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (!message) {
      console.warn(
        `[AIChatAgent] ${callerName}: Could not find message with toolCallId ${toolCallId} after retries`
      );
      return false;
    }

    const isStreamingMessage = message === this._streamingMessage;
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
        const safe = this._enforceRowSizeLimit(updatedMessage);
        const json = JSON.stringify(safe);

        this.sql`
          update cf_ai_chat_agent_messages 
          set message = ${json}
          where id = ${message.id}
        `;
        this._persistedMessageCache.set(message.id, json);

        const persisted = this._loadMessagesFromDb();
        this.messages = autoTransformMessages(persisted);
      }
    }

    if (!wasFound) {
      console.warn(
        `[AIChatAgent] ${callerName}: Tool part with toolCallId ${toolCallId} not in expected state (expected: ${matchStates.join("|")})`
      );
      return false;
    }

    // Idempotent no-op: caller asked us to apply something we'd already
    // applied (e.g. a duplicate cf_agent_tool_result, or a cross-tab
    // re-delivery). Skip the broadcast — clients are already in the
    // correct state and a redundant MESSAGE_UPDATED would just churn UI.
    if (!hasRealChange) {
      return true;
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

    return true;
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
    // `.then(apply, apply)` runs regardless of a predecessor's outcome so one
    // rejected apply can't poison the rest of the batch.
    const resultPromise = this._interactionApplyTail.then(apply, apply);
    this._interactionApplyTail = resultPromise.then(
      () => undefined,
      () => undefined
    );
    this._pendingInteractionPromise = resultPromise;
    resultPromise
      .finally(() => {
        if (this._pendingInteractionPromise === resultPromise) {
          this._pendingInteractionPromise = null;
        }
      })
      .catch(() => {});
    return resultPromise;
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
   * @returns true if the result was applied, false if the message was not found
   */
  private async _applyToolResult(
    toolCallId: string,
    _toolName: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<boolean> {
    return this._findAndUpdateToolPart(
      toolCallId,
      "_applyToolResult",
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

    // During continuation, the first text-start and reasoning-start from the
    // model should merge into existing parts (from the cloned message) rather
    // than creating new blocks. Track whether we've already resumed each type.
    let continuationTextResumed = false;
    let continuationReasoningResumed = false;

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
        this._completeStream(streamId);
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

            // During continuation, merge into existing parts rather than
            // creating new blocks:
            // - text-start: suppressed only when the last text part has
            //   state "streaming" (interrupted mid-generation). Parts with
            //   state "done" or no state create new blocks as usual (e.g.
            //   tool auto-continuation).
            // - reasoning-start: suppressed when resuming an interrupted
            //   assistant turn (an existing reasoning part is still streaming,
            //   or the message has progressed to a still-streaming text part).
            //   Completed reasoning blocks from earlier tool-continuation steps
            //   must not swallow new continuation reasoning, otherwise the
            //   streamed reasoning block disappears when the final persisted
            //   message replaces the live stream.
            let skipServerApply = false;
            if (continuation) {
              if (!continuationTextResumed && data.type === "text-start") {
                for (let k = message.parts.length - 1; k >= 0; k--) {
                  const part = message.parts[k];
                  if (part.type === "text") {
                    if (
                      "state" in part &&
                      (part as { state: string }).state === "streaming"
                    ) {
                      continuationTextResumed = true;
                    }
                    break;
                  }
                }
                if (continuationTextResumed) continue;
              }
              if (
                !continuationReasoningResumed &&
                data.type === "reasoning-start"
              ) {
                for (let k = message.parts.length - 1; k >= 0; k--) {
                  const part = message.parts[k];
                  if (part.type === "text") {
                    if (
                      "state" in part &&
                      (part as { state: string }).state === "streaming"
                    ) {
                      continuationReasoningResumed = true;
                    }
                    break;
                  }
                  if (part.type === "reasoning") {
                    if (
                      "state" in part &&
                      (part as { state: string }).state === "streaming"
                    ) {
                      continuationReasoningResumed = true;
                    }
                    break;
                  }
                }
                // For interrupted continuations, keep appending to the cloned
                // reasoning part but still forward reasoning-start to the
                // client. AI SDK v6 requires reasoning-start before any
                // reasoning-delta in the stream processor's active-part
                // registry.
                skipServerApply = continuationReasoningResumed;
              }
            }

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
              continue;
            }

            // Delegate message building to the shared parser.
            // It handles: text, reasoning, file, source, tool lifecycle,
            // step boundaries — all the part types needed for UIMessage.
            const handled = skipServerApply
              ? true
              : applyChunkToParts(message.parts, data);

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
              const json = JSON.stringify(sanitized);
              this.sql`
                INSERT INTO cf_ai_chat_agent_messages (id, message)
                VALUES (${sanitized.id}, ${json})
                ON CONFLICT(id) DO UPDATE SET message = excluded.message
              `;
              // Track that we persisted early so stream completion can update
              // in place rather than appending a duplicate.
              this._approvalPersistedMessageId = sanitized.id;
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
              const { finishReason, ...rest } = data as {
                finishReason: string;
                [key: string]: unknown;
              };
              eventToSend = {
                ...rest,
                type: "finish",
                messageMetadata: { finishReason }
              };
            }

            // Store chunk for replay and broadcast to clients
            const chunkBody = JSON.stringify(eventToSend);
            await this._storeStreamChunk(streamId, chunkBody);
            this._broadcastChatMessage({
              body: chunkBody,
              done: false,
              id,
              type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
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
      this._completeStream(streamId);
      streamCompleted.value = true;
      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
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
    // During continuation, if the last text part was still streaming
    // (interrupted mid-generation), reuse it so the resumed content
    // stays in the same block.
    let textPart: TextUIPart | undefined;
    if (continuation) {
      for (let k = message.parts.length - 1; k >= 0; k--) {
        const part = message.parts[k];
        if (part.type === "text") {
          if (
            "state" in part &&
            (part as { state: string }).state === "streaming"
          ) {
            textPart = part as TextUIPart;
          }
          break;
        }
      }
    }

    if (textPart) {
      // Skip broadcasting text-start — the client already has this part
    } else {
      // if not AI SDK SSE format, we need to inject text-start and text-end events ourselves
      await this._broadcastTextEvent(
        streamId,
        { type: "text-start", id },
        continuation
      );

      // Use a single text part and accumulate into it, so the persisted message
      // has one text part regardless of how many network chunks the response spans.
      textPart = { type: "text", text: "", state: "streaming" };
      message.parts.push(textPart);
    }

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
        this._completeStream(streamId);
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
      this._completeStream(streamId);
      streamCompleted.value = true;
      this._broadcastChatMessage({
        body: "",
        done: true,
        id,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
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
   * @returns true if the approval was applied, false if the message was not found
   */
  private async _applyToolApproval(
    toolCallId: string,
    approved: boolean
  ): Promise<boolean> {
    return this._findAndUpdateToolPart(
      toolCallId,
      "_applyToolApproval",
      ["input-available", "approval-requested"],
      (part) => ({
        ...part,
        state: approved ? "approval-responded" : "output-denied",
        // Merge with existing approval data to preserve the id field.
        // convertToModelMessages needs approval.id to produce a valid
        // tool-approval-request content part with approvalId.
        approval: {
          ...(part.approval as Record<string, unknown> | undefined),
          approved
        }
      })
    );
  }

  private async _reply(
    id: string,
    response: Response,
    excludeBroadcastIds: string[] = [],
    options: { continuation?: boolean; chatMessageId?: string } = {}
  ): Promise<StreamResultStatus> {
    const { continuation = false, chatMessageId } = options;
    // Look up the abort signal for this request so we can cancel the reader
    // loop if the client sends a cancel message. This is a safety net —
    // users should also pass abortSignal to streamText for proper cancellation.
    const abortSignal = chatMessageId
      ? this._abortRegistry.getExistingSignal(chatMessageId)
      : undefined;

    // Keep the DO alive during streaming to prevent idle eviction
    return this.keepAliveWhile(() =>
      this._tryCatchChat(async () => {
        if (!response.body) {
          // Send empty response if no body
          this._clearPendingAutoContinuation(true);
          this._broadcastChatMessage({
            body: "",
            done: true,
            id,
            type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
            ...(continuation && { continuation: true })
          });
          this._activateDeferredAutoContinuation();
          return { status: "completed" };
        }

        // Parsing state adapted from:
        // https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts#L295
        const message = this._createStreamingAssistantMessage(continuation);

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
        const streamId = this._startStream(id, {
          messageId: message.id,
          continuation
        });

        const reader = response.body.getReader();

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

        // Stream-active gate for the auto-continuation barrier (#1650): while
        // this assistant turn is streaming the parallel tool batch can still
        // grow, so no completeness check is meaningful. The gate clears only in
        // the outer `finally` below — AFTER the streamed message (with all its
        // tool parts) is persisted to `this.messages` — so the re-armed barrier
        // check sees the fully-materialized batch.
        this._streamingTurnActive = true;
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
            // A stall watchdog abort (#1626) is a recoverable interruption, not a
            // terminal error. Persist the settled partial (so the continuation
            // re-anchors without re-running completed tool calls, and the user
            // keeps generated content), then route into bounded recovery; only
            // fall through to the terminal path once the budget is exhausted or
            // recovery is disabled.
            if (
              error instanceof ChatStreamStalledError &&
              !streamCompleted.value
            ) {
              // The partial generated so far lives on the in-memory `message`; the
              // unconditional post-stream persistence block below writes it under
              // `message.id` (the same path a normal turn uses), so the scheduled
              // continuation re-anchors onto it via `targetAssistantId`. (Unlike a
              // cold deploy recovery, there is no need to reconstruct from stored
              // chunks here — the live `message` is authoritative.)
              const targetAssistantId =
                message.parts.length > 0 ? message.id : undefined;
              const outcome = await this._routeStallToBoundedRecovery({
                requestId: id,
                streamId,
                partialParts: message.parts,
                targetAssistantId
              });
              if (outcome === "scheduled") {
                // Recovering: close the stream cleanly (no terminal error frame);
                // the scheduled continuation drives the turn to completion. Report
                // `aborted` so this attempt does not terminalize the turn.
                this._completeStream(streamId);
                this._broadcastChatMessage({
                  body: "",
                  done: true,
                  id,
                  type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                  ...(continuation && { continuation: true })
                });
                streamResult = { status: "aborted" };
                streamCompleted.value = true;
                stallRouted = true;
              } else if (outcome === "exhausted") {
                // `_routeStallToBoundedRecovery` already delivered terminal UX
                // (terminalMessage + done/error frame + onExhausted), identical to
                // deploy-recovery exhaustion. Finalize the resumable stream and
                // report `aborted` so the generic terminal path is not re-run.
                this._markStreamError(streamId);
                streamResult = { status: "aborted" };
                streamCompleted.value = true;
                stallRouted = true;
              }
              // outcome === "disabled" (chat recovery off): fall through to the
              // generic terminal path — the watchdog's "kill the spinner"
              // guarantee.
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

          if (message.parts.length > 0) {
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
      })
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
