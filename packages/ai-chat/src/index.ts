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

import {
  MessageType,
  type IncomingMessage,
  type OutgoingMessage
} from "./types";
import { autoTransformMessages } from "./ai-chat-v5-migration";
import {
  reconcileMessages,
  resolveToolMergeId,
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot
} from "agents/chat";
import {
  applyChunkToParts,
  isReplayChunk,
  sanitizeMessage,
  byteLength as chatByteLength,
  ROW_MAX_BYTES,
  TurnQueue,
  SubmitConcurrencyController,
  type TurnResult,
  type MessagePart,
  type StreamChunkData,
  type SubmitConcurrencyDecision,
  type ChatFiberSnapshot
} from "agents/chat";
import { ResumableStream } from "agents/chat";
import { MAX_BOUND_PARAMS, buildInClauseStrings } from "agents/chat";
import {
  ContinuationState,
  AbortRegistry,
  type ClientToolSchema
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
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

type ChatRecoveryKind = "retry" | "continue";

type ChatRecoveryIncident = {
  incidentId: string;
  requestId: string;
  /** Stable request ID for the whole continuation chain (the recovery root). */
  recoveryRootRequestId?: string;
  recoveryKind: ChatRecoveryKind;
  attempt: number;
  maxAttempts: number;
  status:
    | "detected"
    | "scheduled"
    | "attempting"
    | "completed"
    | "skipped"
    | "exhausted"
    | "failed";
  firstSeenAt: number;
  lastAttemptAt: number;
  /**
   * Epoch ms of the last attempt that observed forward progress. The recovery
   * budget is keyed to this (`now - lastProgressAt > NO_PROGRESS_WINDOW`), so a
   * turn that keeps producing content survives churn indefinitely while a
   * genuinely stuck turn is sealed within the window (#1637). Optional for
   * backward-compat — falls back to `firstSeenAt`.
   */
  lastProgressAt?: number;
  reason?: string;
  /**
   * High-water mark of the durable, monotonic recovery-progress counter (see
   * `_chatRecoveryProgressMarker`) observed for this incident. Used to
   * distinguish a turn that is making forward progress but keeps getting
   * interrupted by isolate resets (deploys) — which should NOT exhaust the
   * budget — from one that genuinely fails to advance. Sourced from a persisted
   * counter rather than the live transcript so compaction cannot lower it
   * (#1628).
   */
  progress?: number;
  /**
   * Value of the durable progress counter when this incident first opened. The
   * runaway-loop work budget is `progress - workBaseline` (work produced since
   * the incident began); compared against `maxRecoveryWork`. Optional for
   * backward-compat with incidents persisted before this field existed — a
   * missing baseline is treated as the current marker (zero work so far), so an
   * in-flight incident from an older build is never falsely sealed.
   */
  workBaseline?: number;
};

const CHAT_RECOVERY_INCIDENT_KEY_PREFIX = "cf:chat-recovery:incident:";
// Durable, monotonic forward-progress counter for recovery budget resets.
// Bumped at production time when new content is streamed (`_storeStreamChunk`),
// so it reflects genuinely new content and is immune to reconnects/re-persists;
// never recomputed from the (compactable) transcript. See
// `_chatRecoveryProgressMarker`.
const CHAT_RECOVERY_PROGRESS_KEY = "cf:chat-recovery:progress";
// Secondary backstop only. The primary recovery bound is the no-progress
// wall clock below; with alarm debounce this cap rarely binds (it catches a
// pathological tight alarm-loop). Kept high so the no-progress window seals
// first under normal deploy cadence (#1637).
const DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS = 10;
// Runaway-loop guard default. `Infinity` = no SDK-imposed work cap: a turn that
// keeps making forward progress is never terminated by the framework on its own
// (rfc-chat-recovery-work-budget). Integrators bound a content-emitting runaway
// by setting `maxRecoveryWork` or a `shouldKeepRecovering` predicate.
const DEFAULT_CHAT_RECOVERY_MAX_WORK = Number.POSITIVE_INFINITY;
const DEFAULT_CHAT_RECOVERY_STABLE_TIMEOUT_MS = 10_000;
// Auto-continuation barrier (#1649): when the model emits parallel tool calls,
// the client answers each one independently and sends a tool result with
// `autoContinue` per result. A fast tool's result must NOT trigger inference
// while a slower sibling is still `input-available` — that feeds the provider
// an incomplete tool-result set. So we wait until the transcript is stable (no
// `input-available`/`approval-requested` parts) before continuing, bounded by
// this timeout so a genuinely orphaned tool call (e.g. the client disconnected
// mid-batch) still falls through instead of pinning the continuation open.
const AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS = 60_000;
// Delay before retrying a recovery that timed out waiting for stable state.
// Gives an actively-churning isolate (e.g. a deploy in flight) time to settle.
const CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS = 3;
const DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE =
  "The assistant was interrupted and could not recover. Please try again.";
// Durable record of an in-progress recovery so a "recovering…" status (#1620)
// can be broadcast live and survives the set/clear happening in different
// isolates (a continuation runs in a later alarm invocation). NOTE: this live
// "recovering…" status is NOT replayed on connect — only the terminal outcome
// is (#1645, via the resume handshake; see `CHAT_LAST_TERMINAL_KEY`). A client
// that connects mid-recovery isn't re-told it's recovering, but the live
// broadcast + reliable clear work regardless, and any terminal outcome is
// surfaced on reconnect.
const CHAT_RECOVERING_KEY = "cf:chat:recovering";
// Durable record of the last turn that ended in a terminal error / abandoned
// recovery (#1645). The terminal `CF_AGENT_USE_CHAT_RESPONSE` broadcast is
// transient, so a client disconnected at the moment recovery exhausts would
// otherwise never learn the turn failed and stay frozen. Replayed on the next
// reconnect via the resume handshake (`_replayTerminalOnResume`); cleared when
// a later turn supersedes it.
const CHAT_LAST_TERMINAL_KEY = "cf:chat:last-terminal";
// Incidents that have not seen a new attempt within this window are assumed
// abandoned and swept so durable storage does not grow without bound.
const CHAT_RECOVERY_INCIDENT_TTL_MS = 60 * 60 * 1000;
// Max keys per Durable Object KV `delete([...])` call.
// See https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
const KV_DELETE_MAX_KEYS = 128;
// PRIMARY recovery bound (#1637): seal an incident that has made no forward
// progress for this long. Keyed to `lastProgressAt`, which resets on every
// progress-bearing attempt — so a turn that keeps producing content survives
// deploy churn indefinitely, while a genuinely stuck turn dies within 5 min.
// Overridable per-agent via `chatRecovery.noProgressTimeoutMs`.
const DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
// Alarm debounce: recovery alarms bunched within this window collapse into a
// single attempt. A deploy rollout drops/reconnects the socket several times
// over ~11–22s; without this, one logical deploy would burn several attempts.
const CHAT_RECOVERY_ALARM_DEBOUNCE_MS = 30 * 1000;
// Staleness bound for the live "recovering…" flag (#1620). A flag older than
// this is treated as abandoned (the owning incident died without a terminal,
// e.g. the DO went idle) so it can neither pin the indicator on forever nor
// suppress a genuinely-new recovering signal. This is NOT a recovery budget —
// a progressing turn is bounded by work, not wall-clock
// (rfc-chat-recovery-work-budget).
const CHAT_RECOVERING_FLAG_TTL_MS = 15 * 60 * 1000;
// N9: while a parent re-attaches to and forwards a sub-agent's stream, credit
// the parent's recovery progress at most this often. The marker only needs to
// advance ≥once between recovery attempts (the no-progress window is minutes),
// so this caps storage writes during high-rate child streaming. The throttle
// state is in-memory (reset per isolate), so the first forwarded chunk after
// ANY restart always bumps — guaranteeing every recovery attempt that observes
// child output registers forward progress.
const AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS = 5_000;

// How far ahead to schedule the resumable-stream buffer cleanup alarm. Set to
// ResumableStream's short completion-grace window (COMPLETED_RETENTION_MS, 10m)
// so a finished buffer is reclaimed promptly. The re-arm-while-reclaimable loop
// (see _cleanupStreamBuffers) revisits any longer-lived rows — e.g. an
// abandoned in-flight buffer on its 1h window — by waking again each interval
// until they age out, then stops. Driving cleanup from an alarm (rather than
// only piggybacking on the next stream completion) ensures idle/one-off chat
// DOs still reclaim their buffers without waking forever (#1706).
const STREAM_CLEANUP_DELAY_SECONDS = 10 * 60;

type StreamResultStatus = {
  status: Exclude<SaveMessagesResult["status"], "skipped">;
  error?: string;
};

function sendIfOpen(connection: Connection, message: string): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}

function isWebSocketClosedSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

export type ChatMessage = UIMessage;

const TIMED_OUT = Symbol("timed-out");

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
   * Small debounce window to batch adjacent client-side tool results/approvals
   * into a single server continuation turn.
   */
  private static AUTO_CONTINUATION_COALESCE_MS = 10;

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
    // Inspect frames while any agent-tool run is in flight (live sequences
    // exist for the run's whole lifecycle), not only while a tailer is
    // attached — error capture must not depend on tailer timing (#1575).
    if (
      (this._agentToolForwarders.size > 0 ||
        this._agentToolLiveSequences.size > 0) &&
      typeof msg === "string"
    ) {
      try {
        const parsed = JSON.parse(msg) as {
          type?: unknown;
          body?: unknown;
          error?: unknown;
          id?: unknown;
        };
        if (
          parsed.type === MessageType.CF_AGENT_USE_CHAT_RESPONSE &&
          typeof parsed.id === "string"
        ) {
          // A frame belongs to a run iff it carries that run's turn request
          // id. Frames from unrelated turns (a user-driven turn on this
          // agent, or another run's turn) resolve to a different — or no —
          // run and are left alone, so concurrent runs cannot
          // cross-contaminate each other's progress or error state (#1575).
          const runId = this._agentToolRunForRequest(parsed.id);
          if (runId !== null) {
            if (parsed.error === true && typeof parsed.body === "string") {
              this._agentToolLastErrors.set(runId, parsed.body);
            } else if (
              typeof parsed.body === "string" &&
              parsed.body.length > 0
            ) {
              // Advance the live sequence even with no tailer attached so a
              // tailer registering mid-run resumes at the right offset.
              const sequence = this._agentToolLiveSequences.get(runId) ?? 0;
              this._agentToolLiveSequences.set(runId, sequence + 1);
              const chunk = { sequence, body: parsed.body };
              const forwarders = this._agentToolForwarders.get(runId);
              if (forwarders) {
                for (const forward of forwarders) forward(chunk);
              }
            }
          }
        }
      } catch {
        // Non-chat frames pass through unchanged.
      }
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
    const rows = this.sql<{ run_id: string }>`
      select run_id from cf_ai_chat_agent_tool_runs
      where request_id = ${requestId} and status = 'running'
      limit 1
    `;
    const runId = rows?.[0]?.run_id ?? null;
    this._agentToolRunsByRequestId.set(requestId, runId);
    return runId;
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

      // Handle AIChatAgent's internal messages first
      if (typeof message === "string") {
        let data: IncomingMessage;
        try {
          data = JSON.parse(message) as IncomingMessage;
        } catch (_error) {
          // Not JSON, forward to consumer
          return _onMessage(connection, message);
        }

        // Handle chat request
        if (
          data.type === MessageType.CF_AGENT_USE_CHAT_REQUEST &&
          data.init.method === "POST"
        ) {
          const { body } = data.init;
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
          const chatMessageId = data.id;
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
        if (data.type === MessageType.CF_AGENT_CHAT_CLEAR) {
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
        if (data.type === MessageType.CF_AGENT_CHAT_MESSAGES) {
          const transformedMessages = autoTransformMessages(data.messages);
          await this.persistMessages(transformedMessages, [connection.id]);
          return;
        }

        // Handle request cancellation
        if (data.type === MessageType.CF_AGENT_CHAT_REQUEST_CANCEL) {
          this._abortRegistry.cancel(data.id);
          this._emit("message:cancel", { requestId: data.id });
          return;
        }

        // Handle client-initiated stream resume request.
        // The client sends this after its message handler is registered,
        // avoiding the race condition where CF_AGENT_STREAM_RESUMING sent
        // in onConnect arrives before the client's handler is ready.
        if (data.type === MessageType.CF_AGENT_STREAM_RESUME_REQUEST) {
          if (this._resumableStream.hasActiveStream()) {
            if (
              this._continuation.activeRequestId ===
                this._resumableStream.activeRequestId &&
              this._continuation.activeConnectionId !== null &&
              this._continuation.activeConnectionId !== connection.id
            ) {
              sendIfOpen(
                connection,
                JSON.stringify({
                  type: MessageType.CF_AGENT_STREAM_RESUME_NONE
                })
              );
            } else {
              this._notifyStreamResuming(connection);
            }
          } else if (
            this._continuation.pending !== null &&
            (this._continuation.pending.connectionId === null ||
              this._continuation.pending.connectionId === connection.id)
          ) {
            this._continuation.awaitingConnections.set(
              connection.id,
              connection
            );
          } else if (await this._replayTerminalOnResume(connection)) {
            // A turn terminalized while no client was connected (#1645): drive
            // the resume handshake so the terminal error frame can be delivered
            // on the resumed stream (the only path that surfaces as an error on
            // the client) once this connection ACKs — see `_replayTerminalOnAck`.
          } else {
            sendIfOpen(
              connection,
              JSON.stringify({
                type: MessageType.CF_AGENT_STREAM_RESUME_NONE
              })
            );
          }
          return;
        }

        // Handle stream resume acknowledgment
        if (data.type === MessageType.CF_AGENT_STREAM_RESUME_ACK) {
          this._pendingResumeConnections.delete(connection.id);

          if (
            this._resumableStream.hasActiveStream() &&
            this._resumableStream.activeRequestId === data.id
          ) {
            const orphanedStreamId = this._resumableStream.replayChunks(
              connection,
              this._resumableStream.activeRequestId
            );

            // If the stream was orphaned (restored from SQLite after
            // hibernation with no live reader), reconstruct the partial
            // assistant message from stored chunks and persist it so it
            // survives further page refreshes.
            if (orphanedStreamId) {
              await this._persistOrphanedStream(orphanedStreamId);
            }
          } else if (this._resumableStream.hasActiveStream()) {
            // Ignore ACKs for a different active stream request id.
          } else if (await this._replayTerminalOnAck(connection, data.id)) {
            // Delivered the pending terminal error frame on the resumed stream
            // the client just ACKed (#1645).
          } else if (
            !this._resumableStream.replayCompletedChunksByRequestId(
              connection,
              data.id
            )
          ) {
            sendIfOpen(
              connection,
              JSON.stringify({
                body: "",
                done: true,
                id: data.id,
                type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
                replay: true
              })
            );
          }
          return;
        }

        // Handle client-side tool result
        if (data.type === MessageType.CF_AGENT_TOOL_RESULT) {
          const {
            toolCallId,
            toolName,
            output,
            state,
            errorText,
            autoContinue,
            clientTools
          } = data;

          // Update cached client tools so subsequent continuations use the latest schemas
          if (clientTools?.length) {
            this._lastClientTools = clientTools as ClientToolSchema[];
            this._persistRequestContext();
          }

          const overrideState =
            state === "output-error" ? "output-error" : undefined;

          this._emit("tool:result", { toolCallId, toolName });

          const applyPromise = this._enqueueInteractionApply(() =>
            this._applyToolResult(
              toolCallId,
              toolName,
              output,
              overrideState,
              errorText
            )
          );

          if (autoContinue) {
            this._enqueueAutoContinuation(
              connection,
              clientTools ?? this._lastClientTools,
              this._lastBody,
              "[AIChatAgent] Tool continuation failed:",
              applyPromise
            );
          }
          return;
        }

        // Handle client-side tool approval response
        if (data.type === MessageType.CF_AGENT_TOOL_APPROVAL) {
          const { toolCallId, approved, autoContinue } = data;
          this._emit("tool:approval", { toolCallId, approved });
          const approvalPromise = this._enqueueInteractionApply(() =>
            this._applyToolApproval(toolCallId, approved)
          );

          if (autoContinue) {
            this._enqueueAutoContinuation(
              connection,
              this._lastClientTools,
              this._lastBody,
              "[AIChatAgent] Tool approval continuation failed:",
              approvalPromise
            );
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

  private _mergeAutoContinuationPrerequisite(
    current: Promise<boolean> | null,
    next?: Promise<boolean>
  ): Promise<boolean> | null {
    if (!next) {
      return current;
    }

    if (!current) {
      return next;
    }

    return Promise.all([current, next]).then(
      ([currentApplied, nextApplied]) => {
        return currentApplied && nextApplied;
      }
    );
  }

  private _storeDeferredAutoContinuation(
    connection: Connection,
    clientTools: ClientToolSchema[] | undefined,
    body: Record<string, unknown> | undefined,
    errorPrefix: string,
    prerequisite?: Promise<boolean>
  ) {
    const existing = this._continuation.deferred;
    this._continuation.deferred = {
      connection,
      connectionId: connection.id,
      clientTools,
      body,
      errorPrefix,
      prerequisite: this._mergeAutoContinuationPrerequisite(
        existing?.prerequisite ?? null,
        prerequisite
      )
    };
  }

  private _activateDeferredAutoContinuation() {
    const pending = this._continuation.activateDeferred(() => nanoid());
    if (!pending) return;
    this._queueAutoContinuation(pending.requestId);
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
   * Notify a connection about an active stream that can be resumed.
   * The client should respond with CF_AGENT_STREAM_RESUME_ACK to receive chunks.
   * @param connection - The WebSocket connection to notify
   */
  private _notifyStreamResuming(connection: Connection) {
    if (!this._resumableStream.hasActiveStream()) {
      return;
    }

    // Notify client - they will send ACK when ready
    const sent = sendIfOpen(
      connection,
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUMING,
        id: this._resumableStream.activeRequestId
      })
    );
    if (sent) {
      // Add connection to pending set - they'll be excluded from live broadcasts
      // until they send ACK to receive the full stream replay
      this._pendingResumeConnections.add(connection.id);
    }
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
    options: { messageId?: string } = {}
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
   * Alarm callback: sweep aged stream buffers, then re-arm only while rows
   * remain so a fully-swept DO stops waking itself. Public so it is reachable
   * as a schedule callback.
   * @internal
   */
  async _cleanupStreamBuffers(): Promise<void> {
    this._resumableStream.cleanup();
    if (this._resumableStream.hasReclaimableStreams()) {
      // Must NOT be idempotent: this runs INSIDE the currently-executing
      // one-shot schedule row, which `alarm()` deletes only after we return. An
      // idempotent reschedule would dedup onto that row and then be deleted with
      // it — the re-arm would silently never fire, leaving buffers that survived
      // this sweep (e.g. a younger turn) uncollected. A fresh delayed row
      // survives the deletion.
      await this._ensureStreamCleanupScheduled({ idempotent: false });
    }
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

  /** Advance the recovery-progress counter when a chunk represents genuinely
   *  new produced content — a started text/reasoning segment or a settled tool
   *  input/output. Bumped at production time (the streaming path), so it
   *  reflects real forward progress and is immune to client reconnects /
   *  recovery re-persists (which replay or re-materialize stored chunks rather
   *  than flow through here). This is what the recovery no-progress window keys
   *  off (#1637), and stays compaction-proof (#1628). */
  private async _maybeBumpRecoveryProgress(
    type: string | undefined
  ): Promise<void> {
    if (
      type === "text-start" ||
      type === "reasoning-start" ||
      type === "tool-input-available" ||
      type === "tool-output-available" ||
      type === "tool-output-error" ||
      type === "tool-output-denied"
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
   * Replays each chunk body through `applyChunkToParts` to rebuild the
   * message parts, then persists the result so it survives further refreshes.
   * @internal
   */
  protected async _persistOrphanedStream(streamId: string): Promise<void> {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (!chunks.length) return;

    const fallbackId = `assistant_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const message: UIMessage = {
      id: fallbackId,
      role: "assistant",
      parts: []
    };

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk.body);

        // Capture a provider `start.messageId` if present. The live path adopts
        // it for new turns (see `_streamSSEReply`'s "start" handling), so
        // recovery must reuse it to land under the same id a completed live
        // turn would. Continuations have it stripped before storage (#1229).
        if (data.type === "start" && data.messageId != null) {
          message.id = data.messageId;
        }
        if (
          (data.type === "start" ||
            data.type === "finish" ||
            data.type === "message-metadata") &&
          data.messageMetadata != null
        ) {
          message.metadata = message.metadata
            ? { ...message.metadata, ...data.messageMetadata }
            : data.messageMetadata;
        }

        applyChunkToParts(message.parts, data);
      } catch {
        // Skip malformed chunk bodies
      }
    }

    if (message.parts.length > 0) {
      // Resolve the id to persist under when the chunks carried no provider
      // `start.messageId` (the common case — most providers don't emit one, and
      // continuations have it stripped, #1229). When a provider id WAS present
      // it was applied above and is kept, since the live path adopts it too.
      if (message.id === fallbackId) {
        // Preferred: the id allocated when the stream started, recorded in
        // stream metadata (#1691) — the SAME id the live path persists under
        // (it only adopts a provider id, never invents one). A new turn stored
        // its own fresh id, so it becomes its own message; a continuation
        // stored the cloned last-assistant id, so it merges (via the
        // existing-index check below). This is what stops a new turn after a
        // later user message from being folded into the previous assistant
        // message (the #1691 corruption).
        const storedId = this._resumableStream.getStreamMessageId(streamId);
        if (storedId != null) {
          message.id = storedId;
        } else {
          // Legacy row written before the metadata column existed: fall back to
          // the last assistant message, matching pre-#1691 behavior.
          for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === "assistant") {
              message.id = this.messages[i].id;
              break;
            }
          }
        }
      }

      // Check if a message with this ID already exists (e.g., from an
      // early persist during tool approval, or a continuation resuming
      // the last assistant message). Update in place if so.
      const existingIdx = this.messages.findIndex((m) => m.id === message.id);
      if (existingIdx >= 0) {
        // Merge: keep existing parts and append new ones from the stream.
        // A tool part is identified by its toolCallId, so a reconstructed part
        // whose toolCallId already exists is NOT re-appended — otherwise an
        // early persist (at tool approval) followed by recovery, which replays
        // the SAME chunks, would leave two parts for one tool call. The kept
        // (persisted) part is also the one that may have received a tool result
        // applied in place, so preserving it avoids regressing settled state.
        const existing = this.messages[existingIdx];
        const existingToolCallIds = new Set(
          existing.parts
            .filter(
              (p): p is typeof p & { toolCallId: string } => "toolCallId" in p
            )
            .map((p) => p.toolCallId)
        );
        const newParts = message.parts.filter(
          (p) => !("toolCallId" in p && existingToolCallIds.has(p.toolCallId))
        );
        message.parts = [...existing.parts, ...newParts];
        if (existing.metadata) {
          message.metadata = message.metadata
            ? { ...existing.metadata, ...message.metadata }
            : existing.metadata;
        }
      }
      const updatedMessages =
        existingIdx >= 0
          ? this.messages.map((m, i) => (i === existingIdx ? message : m))
          : [...this.messages, message];
      await this.persistMessages(updatedMessages);
      // NOTE: progress is bumped at production/flush time in `_storeStreamChunk`
      // (#1637), NOT here — persisting on recovery or a client reconnect must
      // not be miscounted as new forward progress.
    }
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
    await this._submitConcurrency.waitForIdle(() =>
      this._turnQueue.waitForIdle()
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
   */
  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;

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

      if (!this.hasPendingInteraction()) {
        return true;
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

  private async _awaitWithDeadline<T>(
    promise: Promise<T>,
    deadline: number | null
  ): Promise<T | typeof TIMED_OUT> {
    if (deadline == null) {
      return promise;
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
      })
    ]);
    clearTimeout(timer!);
    return result;
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
    if (!("state" in part)) return false;
    const record = part as Record<string, unknown>;
    const state = record.state;
    if (state === "approval-requested") return true;
    if (state !== "input-available") return false;
    const toolName = this._toolPartName(record);
    return toolName != null && clientResolvable.has(toolName);
  }

  /** Extract a tool part's name from its `tool-<name>` / `dynamic-tool` shape. */
  private _toolPartName(record: Record<string, unknown>): string | undefined {
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "dynamic-tool") {
      return typeof record.toolName === "string" ? record.toolName : undefined;
    }
    if (type.startsWith("tool-")) {
      return type.slice("tool-".length);
    }
    return undefined;
  }

  /**
   * Names of the CLIENT-resolvable tools (the client-provided schemas from the
   * last request, which have no server `execute`). Mirrors `@cloudflare/think`.
   */
  private _clientResolvableToolNames(): Set<string> {
    const names = new Set<string>();
    for (const tool of this._lastClientTools ?? []) {
      if (tool?.name) names.add(tool.name);
    }
    return names;
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
                // over the resume handshake (`_replayTerminalOnResume`). Mirrors
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

  private _enqueueAutoContinuation(
    connection: Connection,
    clientTools: ClientToolSchema[] | undefined,
    body: Record<string, unknown> | undefined,
    errorPrefix: string,
    prerequisite?: Promise<boolean>
  ) {
    if (this._continuation.pending) {
      if (this._continuation.pending.pastCoalesce) {
        this._storeDeferredAutoContinuation(
          connection,
          clientTools,
          body,
          errorPrefix,
          prerequisite
        );
        return;
      }

      this._continuation.pending.connection = connection;
      this._continuation.pending.connectionId = connection.id;
      this._continuation.awaitingConnections.set(connection.id, connection);
      this._continuation.pending.clientTools = clientTools;
      this._continuation.pending.body = body;
      this._continuation.pending.errorPrefix = errorPrefix;
      this._continuation.pending.prerequisite =
        this._mergeAutoContinuationPrerequisite(
          this._continuation.pending.prerequisite,
          prerequisite
        );
      return;
    }

    const requestId = nanoid();
    this._continuation.pending = {
      connection,
      connectionId: connection.id,
      requestId,
      clientTools,
      body,
      errorPrefix,
      prerequisite: this._mergeAutoContinuationPrerequisite(null, prerequisite),
      pastCoalesce: false
    };
    this._continuation.awaitingConnections.set(connection.id, connection);
    this._queueAutoContinuation(requestId);
  }

  private async _awaitPendingAutoContinuationPrerequisite(): Promise<boolean> {
    while (true) {
      const prerequisite = this._continuation.pending?.prerequisite;
      if (!prerequisite) {
        break;
      }

      const applied = await prerequisite;
      if (!applied) {
        return false;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, AIChatAgent.AUTO_CONTINUATION_COALESCE_MS)
      );

      if (this._continuation.pending?.prerequisite === prerequisite) {
        break;
      }
    }

    // #1649 barrier: the prior step may have emitted parallel tool calls. The
    // client answers each one independently, so the result that triggered this
    // continuation can arrive while slower siblings are still `input-available`
    // (or `approval-requested`). Continuing now would send the provider an
    // incomplete tool-result set. Hold until the batch settles, bounded so a
    // genuinely orphaned tool call (client disconnected mid-batch) still falls
    // through rather than pinning the continuation open forever.
    await this._awaitPendingInteractionBarrier();
    return true;
  }

  /**
   * Block until the latest assistant step's parallel tool batch is fully
   * answered, or `AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS` elapses. Awaits the
   * in-flight tool-result apply when one exists (so a sibling that lands
   * mid-wait is observed promptly) and polls otherwise. Runs inside the
   * continuation turn, so — unlike `waitUntilStable` — it must not wait on the
   * turn queue (that would deadlock).
   *
   * No concurrent-entry guard is needed (unlike Think's `_continuationBarrier
   * Active`): this runs inside the exclusive continuation turn, and a sibling
   * result arriving while it waits hits the merge branch of
   * `_enqueueAutoContinuation` (it updates `pending.prerequisite`) rather than
   * enqueuing a second turn — so the turn queue serializes barrier waits.
   */
  private async _awaitPendingInteractionBarrier(): Promise<void> {
    const deadline = Date.now() + AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // The pending continuation was cleared (chat clear / turn reset) — nothing
      // to wait for; bail so the turn isn't held by a stale wait.
      if (!this._continuation.pending) return;
      const pending = this._pendingInteractionPromise;
      if (pending) {
        // `_pendingInteractionPromise` is a single slot — awaiting it is only a
        // "wake up as soon as an apply lands" optimization, NOT the correctness
        // gate (that is `_hasIncompleteToolBatch()`, re-checked each loop). If
        // sibling results overwrite the slot, each apply still patches the cache.
        try {
          await pending;
        } catch {
          // Ignore — re-evaluate the batch below.
        }
        continue;
      }
      if (!this._hasIncompleteToolBatch()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Timed out with the batch still incomplete: a sibling tool result never
    // arrived (e.g. the client disconnected mid-batch). Proceed anyway rather
    // than pinning the continuation turn open forever.
    console.warn(
      `[AIChatAgent] Auto-continuation proceeding after waiting ${AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS}ms for unanswered parallel tool result(s) (#1649).`
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
    // Zero-allocation backward scan for the latest assistant message — this
    // runs on every barrier poll tick, and `this.messages` can be large.
    const messages = this.messages;
    let leaf: (typeof messages)[number] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        leaf = messages[i];
        break;
      }
    }
    if (!leaf) return false;
    let hasPending = false;
    let hasSettled = false;
    for (const part of leaf.parts) {
      const record = part as Record<string, unknown>;
      const state = record.state;
      if (state === "input-available" || state === "approval-requested") {
        hasPending = true;
      } else if (
        typeof record.type === "string" &&
        (record.type.startsWith("tool-") || record.type === "dynamic-tool") &&
        (state === "output-available" ||
          state === "output-error" ||
          state === "output-denied" ||
          state === "approval-responded")
      ) {
        hasSettled = true;
      }
      if (hasPending && hasSettled) return true;
    }
    return false;
  }

  private _queueAutoContinuation(requestId: string) {
    const epoch = this._turnQueue.generation;
    // _runExclusiveChatTurn must be called synchronously so the chat turn
    // queue is set up immediately — otherwise waitForIdle() can resolve
    // before the continuation starts.  keepAlive() is called inside the
    // turn to prevent hibernation while waiting for prerequisites /
    // streaming, without deferring the queue registration.
    this._runExclusiveChatTurn(
      requestId,
      async () => {
        const dispose = await this.keepAlive();
        try {
          const applied =
            await this._awaitPendingAutoContinuationPrerequisite();
          if (!applied) {
            this._clearAllAutoContinuationState(true);
            return;
          }

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
  private async _classifyAgentToolChildRecovery(): Promise<
    "in-progress" | "failed" | "none"
  > {
    const entries = await this.ctx.storage.list<ChatRecoveryIncident>({
      prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
    });
    let failed = false;
    for (const incident of entries.values()) {
      if (
        incident.status === "detected" ||
        incident.status === "scheduled" ||
        incident.status === "attempting"
      ) {
        return "in-progress";
      }
      if (incident.status === "exhausted" || incident.status === "failed") {
        failed = true;
      }
    }
    return failed ? "failed" : "none";
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
    const raw = this.chatRecovery;
    const custom = typeof raw === "object" ? raw : undefined;
    return {
      enabled: raw !== false,
      maxAttempts: Math.max(
        1,
        Math.floor(custom?.maxAttempts ?? DEFAULT_CHAT_RECOVERY_MAX_ATTEMPTS)
      ),
      stableTimeoutMs: Math.max(
        0,
        Math.floor(
          custom?.stableTimeoutMs ?? DEFAULT_CHAT_RECOVERY_STABLE_TIMEOUT_MS
        )
      ),
      terminalMessage:
        custom?.terminalMessage ?? DEFAULT_CHAT_RECOVERY_TERMINAL_MESSAGE,
      noProgressTimeoutMs: Math.max(
        0,
        Math.floor(
          custom?.noProgressTimeoutMs ??
            DEFAULT_CHAT_RECOVERY_NO_PROGRESS_TIMEOUT_MS
        )
      ),
      maxRecoveryWork:
        typeof custom?.maxRecoveryWork === "number" &&
        custom.maxRecoveryWork >= 0
          ? custom.maxRecoveryWork
          : DEFAULT_CHAT_RECOVERY_MAX_WORK,
      ...(custom?.shouldKeepRecovering
        ? { shouldKeepRecovering: custom.shouldKeepRecovering }
        : {}),
      ...(custom?.onExhausted ? { onExhausted: custom.onExhausted } : {})
    };
  }

  private _chatRecoveryIncidentId(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    targetAssistantId?: string | null;
    recoveryKind: ChatRecoveryKind;
  }): string {
    // `recoveryKind` is intentionally NOT part of the identity: a single
    // interrupted turn can flip between "retry" (no chunks persisted) and
    // "continue" (partial chunks exist) across restarts, and the attempt
    // budget must be shared so recovery stays bounded by `maxAttempts`.
    return [
      input.recoveryRootRequestId ?? input.requestId,
      input.latestUserMessageId ?? ""
    ].join(":");
  }

  private _chatRecoveryIncidentKey(incidentId: string): string {
    return `${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}${encodeURIComponent(incidentId)}`;
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
    return (
      (await this.ctx.storage.get<number>(CHAT_RECOVERY_PROGRESS_KEY)) ?? 0
    );
  }

  /** Advance the durable recovery-progress counter. Called from
   *  `_maybeBumpRecoveryProgress` when new content is streamed (real,
   *  reconnect-immune forward progress). */
  private async _bumpChatRecoveryProgress(): Promise<void> {
    const current =
      (await this.ctx.storage.get<number>(CHAT_RECOVERY_PROGRESS_KEY)) ?? 0;
    await this.ctx.storage.put(CHAT_RECOVERY_PROGRESS_KEY, current + 1);
  }

  /** In-memory wall-clock of the last N9 child-stream progress bump (reset per
   *  isolate so the first forwarded chunk after a restart always credits). */
  private _lastAgentToolStreamProgressAt = 0;

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
    const now = Date.now();
    if (
      now - this._lastAgentToolStreamProgressAt <
      AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS
    ) {
      return;
    }
    this._lastAgentToolStreamProgressAt = now;
    await this._bumpChatRecoveryProgress();
  }

  /** Whether a reconstructed partial carries any settled (provider-accepted)
   *  tool result — the completed, often non-idempotent work that a
   *  `{ persist: false }` recovery return would silently discard.
   *  `convertToModelMessages` treats `output-available` / `output-error` /
   *  `output-denied` (or a part carrying `output`/`result`) as settled. */
  private _partialHasSettledToolResults(parts: MessagePart[]): boolean {
    return parts.some((part) => {
      const record = part as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (!(type.startsWith("tool-") || type === "dynamic-tool")) return false;
      if ("output" in record || "result" in record) return true;
      const state = typeof record.state === "string" ? record.state : "";
      return (
        state === "output-available" ||
        state === "output-error" ||
        state === "output-denied"
      );
    });
  }

  /** Sweep recovery incidents that have been inactive past the TTL. */
  private async _sweepStaleChatRecoveryIncidents(now: number): Promise<void> {
    const entries = await this.ctx.storage.list<ChatRecoveryIncident>({
      prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX
    });
    const staleKeys: string[] = [];
    for (const [key, incident] of entries) {
      const lastActive = incident?.lastAttemptAt ?? incident?.firstSeenAt ?? 0;
      if (now - lastActive > CHAT_RECOVERY_INCIDENT_TTL_MS) {
        staleKeys.push(key);
      }
    }
    // Batch deletes — the DO storage KV delete accepts up to 128 keys per call,
    // collapsing N awaited round-trips into ceil(N / 128).
    for (let i = 0; i < staleKeys.length; i += KV_DELETE_MAX_KEYS) {
      await this.ctx.storage.delete(staleKeys.slice(i, i + KV_DELETE_MAX_KEYS));
    }
  }

  private async _beginChatRecoveryIncident(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    targetAssistantId?: string | null;
    recoveryKind: ChatRecoveryKind;
    /** Test-only clock injection for deterministic debounce/window timing. */
    nowMs?: number;
  }): Promise<{
    incident: ChatRecoveryIncident;
    config: ResolvedChatRecoveryConfig;
    exhausted: boolean;
  }> {
    const config = this._resolveChatRecoveryConfig();
    const incidentId = this._chatRecoveryIncidentId(input);
    const key = this._chatRecoveryIncidentKey(incidentId);
    const now = input.nowMs ?? Date.now();
    await this._sweepStaleChatRecoveryIncidents(now);
    const existing = await this.ctx.storage.get<ChatRecoveryIncident>(key);

    // Forward-progress detection. A mid-turn deploy resets the Durable Object
    // ("code was updated"); the interrupted continuation is re-detected on the
    // next wake. A turn that followed real progress (more durably-produced
    // content than the last attempt saw) is environmental churn, not a poison
    // turn.
    const prevProgress = existing?.progress ?? 0;
    const currentProgress = await this._chatRecoveryProgressMarker();
    const madeProgress = existing != null && currentProgress > prevProgress;

    // A turn parked on a pending CLIENT interaction (an `input-available`
    // client-tool part or an `approval-requested` part — see
    // `hasPendingClientInteraction`) is WAITING ON THE HUMAN, not stuck. It
    // produces no forward progress by design until the client replays the
    // tool-result / approval after reconnect, which drives a fresh continuation
    // independently of recovery. Spending the recovery budget on that wait would
    // seal a perfectly healthy turn whose human is simply slow (e.g. a mid-turn
    // deploy during a confirmation prompt the user takes longer than
    // `noProgressTimeoutMs` to answer). So while a client interaction is pending
    // the turn is budget-free: the no-progress window, attempt cap, work budget,
    // and caller predicate are all suppressed, and the no-progress clock is kept
    // fresh so the turn has a full window once the human finally answers.
    // SERVER-tool orphans are excluded (their `execute` died with the isolate),
    // so they still recover normally. The recovery continuation additionally
    // PARKS (skips, no reschedule) on a stable-state timeout while this holds;
    // see `_chatRecoveryContinue`/`_chatRecoveryRetry`.
    const awaitingClientInteraction = this.hasPendingClientInteraction();

    // Recovery budget (#1637, rfc-chat-recovery-work-budget). A turn making
    // genuine forward progress survives unbounded deploy churn — duration is
    // never a bound. The instruments are decoupled by what they catch:
    //  • STUCK — no-progress window: `lastProgressAt` resets on every
    //    progress-bearing attempt, so a turn that keeps producing content
    //    survives churn indefinitely; a stuck turn is sealed after 5 min.
    //  • DEBOUNCE — alarms bunched within `ALARM_DEBOUNCE_MS` collapse into one
    //    attempt, so a single rollout's reconnect storm isn't N attempts.
    //  • ALARM-LOOP — the attempt cap (resets on progress) catches a tight
    //    no-progress alarm loop.
    //  • RUNAWAY — the work budget seals a loop that keeps emitting content but
    //    never converges. Keyed to WORK done (produced content/tool units since
    //    the incident opened), not wall-clock, because a healthy long turn and a
    //    runaway differ by bounded work, not duration. Defaults to no cap.
    //  • CALLER — `shouldKeepRecovering` lets the integrator express a
    //    token/cost/step budget the SDK should not hardcode.
    const lastProgressAt =
      madeProgress || awaitingClientInteraction
        ? now
        : (existing?.lastProgressAt ?? existing?.firstSeenAt ?? now);
    const noProgressExceeded =
      existing != null &&
      !awaitingClientInteraction &&
      now - lastProgressAt > config.noProgressTimeoutMs;
    // Reuse the durable progress counter as a work meter. Baseline is captured
    // when the incident opens; `work` is what the turn produced since.
    const workBaseline = existing?.workBaseline ?? currentProgress;
    const progress = Math.max(prevProgress, currentProgress);
    const work = progress - workBaseline;
    const workBudgetExceeded =
      existing != null &&
      Number.isFinite(config.maxRecoveryWork) &&
      work > config.maxRecoveryWork;
    const debounced =
      existing != null &&
      !madeProgress &&
      now - existing.lastAttemptAt < CHAT_RECOVERY_ALARM_DEBOUNCE_MS;

    const attempt = madeProgress
      ? 1
      : debounced
        ? (existing?.attempt ?? 1)
        : (existing?.attempt ?? 0) + 1;

    // Consult the caller predicate only when no hard bound has already sealed
    // the incident — a buggy/expensive hook must not run after we've decided,
    // and a throwing hook must not wedge the turn (log and treat as "continue").
    let abortedByCaller = false;
    if (
      existing != null &&
      !awaitingClientInteraction &&
      config.shouldKeepRecovering &&
      !noProgressExceeded &&
      !workBudgetExceeded &&
      attempt <= config.maxAttempts
    ) {
      try {
        const decision = await config.shouldKeepRecovering({
          incidentId,
          requestId: input.requestId,
          recoveryRootRequestId: input.recoveryRootRequestId ?? input.requestId,
          attempt,
          maxAttempts: config.maxAttempts,
          recoveryKind: input.recoveryKind,
          work,
          ageMs: now - (existing.firstSeenAt ?? now)
        });
        abortedByCaller = decision === false;
      } catch (error) {
        console.error(
          "[AIChatAgent] chatRecovery shouldKeepRecovering hook threw",
          error
        );
      }
    }

    const exhausted =
      !awaitingClientInteraction &&
      (noProgressExceeded ||
        workBudgetExceeded ||
        abortedByCaller ||
        attempt > config.maxAttempts);
    const incident: ChatRecoveryIncident = {
      incidentId,
      requestId: input.requestId,
      recoveryRootRequestId: input.recoveryRootRequestId ?? input.requestId,
      recoveryKind: input.recoveryKind,
      attempt,
      maxAttempts: config.maxAttempts,
      status: exhausted ? "exhausted" : "attempting",
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastAttemptAt: now,
      lastProgressAt,
      progress,
      workBaseline,
      ...(exhausted
        ? {
            reason: workBudgetExceeded
              ? "work_budget_exceeded"
              : noProgressExceeded
                ? "no_progress_timeout"
                : abortedByCaller
                  ? "recovery_aborted"
                  : "max_attempts_exceeded"
          }
        : {})
    };
    await this.ctx.storage.put(key, incident);

    if (!existing) {
      this._emit("chat:recovery:detected", {
        incidentId,
        requestId: input.requestId,
        attempt,
        maxAttempts: config.maxAttempts,
        recoveryKind: input.recoveryKind
      });
    }
    this._emit("chat:recovery:attempt", {
      incidentId,
      requestId: input.requestId,
      attempt,
      maxAttempts: config.maxAttempts,
      recoveryKind: input.recoveryKind
    });

    return { incident, config, exhausted };
  }

  private async _updateChatRecoveryIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string
  ): Promise<void> {
    if (!incidentId) return;
    const key = this._chatRecoveryIncidentKey(incidentId);
    const incident = await this.ctx.storage.get<ChatRecoveryIncident>(key);
    if (!incident) return;
    // A completed recovery is terminal and will not be retried, so drop the
    // record instead of leaving it in storage forever. Non-completed states
    // (scheduled/skipped/failed) are retained so the attempt budget survives
    // across restarts; the TTL sweep eventually reclaims abandoned ones.
    if (status === "completed") {
      await this.ctx.storage.delete(key);
    } else {
      const updated: ChatRecoveryIncident = {
        ...incident,
        status,
        ...(reason ? { reason } : {})
      };
      await this.ctx.storage.put(key, updated);
    }
    const eventType =
      status === "completed"
        ? "chat:recovery:completed"
        : status === "skipped"
          ? "chat:recovery:skipped"
          : status === "failed"
            ? "chat:recovery:failed"
            : undefined;
    if (eventType) {
      this._emit(eventType, {
        incidentId,
        requestId: incident.requestId,
        attempt: incident.attempt,
        maxAttempts: incident.maxAttempts,
        recoveryKind: incident.recoveryKind,
        ...(reason ? { reason } : {})
      });
    }

    // Live "recovering…" status (#1620): a scheduled continuation/retry means
    // recovery is in progress; a terminal incident state resolves it.
    if (status === "scheduled") {
      await this._setChatRecovering(
        true,
        incident.recoveryRootRequestId ?? incident.requestId
      );
    } else if (
      status === "completed" ||
      status === "skipped" ||
      status === "failed"
    ) {
      await this._setChatRecovering(false);
    }
  }

  private async _exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    partial: { text: string; parts: MessagePart[] },
    streamId: string,
    createdAt: number
  ): Promise<void> {
    const ctx: ChatRecoveryExhaustedContext = {
      incidentId: incident.incidentId,
      requestId: incident.requestId,
      recoveryRootRequestId:
        incident.recoveryRootRequestId ?? incident.requestId,
      attempt: incident.attempt,
      maxAttempts: incident.maxAttempts,
      recoveryKind: incident.recoveryKind,
      streamId,
      createdAt,
      partialText: partial.text,
      partialParts: partial.parts,
      reason: incident.reason ?? "max_attempts_exceeded",
      terminalMessage: config.terminalMessage
    };
    this._emit("chat:recovery:exhausted", ctx);
    // A throwing onExhausted hook must not prevent the terminal UX from being
    // delivered, otherwise the turn wedges with no user-visible resolution.
    try {
      await config.onExhausted?.(ctx);
    } catch (error) {
      console.error("[AIChatAgent] chatRecovery onExhausted hook threw", error);
    }
    // Persist the terminal outcome BEFORE broadcasting it (#1645): the
    // broadcast is transient, so a client disconnected at this moment (a
    // deploy/reconnect storm exhausting recovery) would otherwise never learn
    // the turn failed. The record is replayed on the next reconnect via the
    // resume handshake (`_replayTerminalOnResume`).
    await this._recordChatTerminal(incident.requestId, config.terminalMessage);
    this._broadcastChatMessage({
      body: config.terminalMessage,
      done: true,
      error: true,
      id: incident.requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });
    // Exhaustion resolves recovery — clear the "recovering…" status (#1620).
    await this._setChatRecovering(false);
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
    await this.ctx.storage.put(CHAT_LAST_TERMINAL_KEY, { requestId, body });
  }

  /** Clear the durable terminal record once a later turn supersedes it (#1645). */
  private async _clearChatTerminal(): Promise<void> {
    await this.ctx.storage.delete(CHAT_LAST_TERMINAL_KEY);
  }

  private async _pendingChatTerminal(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return (
      (await this.ctx.storage.get<{ requestId: string; body: string }>(
        CHAT_LAST_TERMINAL_KEY
      )) ?? null
    );
  }

  /**
   * Replay a pending terminal outcome (#1645) over the resume handshake so a
   * reconnecting client surfaces it exactly like a live exhaustion. The bare
   * terminal frame is dropped by the client unless it arrives on a resumed
   * stream — the only path that reaches the transport's stream reader and
   * becomes `useChat.error` — so we drive `STREAM_RESUMING` here and deliver
   * the error frame once the client ACKs (see `_replayTerminalOnAck`).
   * Returns true if a terminal was pending (and `STREAM_RESUMING` was sent).
   */
  private async _replayTerminalOnResume(
    connection: Connection
  ): Promise<boolean> {
    const pending = await this._pendingChatTerminal();
    if (!pending) return false;
    sendIfOpen(
      connection,
      JSON.stringify({
        type: MessageType.CF_AGENT_STREAM_RESUMING,
        id: pending.requestId
      })
    );
    return true;
  }

  /**
   * Deliver the pending terminal error frame on the resumed stream the client
   * ACKed (#1645). The record is retained (not cleared) so concurrent
   * reconnects (e.g. multiple tabs) each learn the outcome; it is cleared when
   * a later turn supersedes it.
   */
  private async _replayTerminalOnAck(
    connection: Connection,
    requestId: string
  ): Promise<boolean> {
    const pending = await this._pendingChatTerminal();
    if (!pending || pending.requestId !== requestId) return false;
    // Replay any partial content the errored stream produced before the
    // error, so the reconnecting client observes the same sequence a live
    // client did — content chunks, then the terminal error (#1575). If the
    // connection drops mid-replay, skip the terminal frame; the record is
    // retained, so the next reconnect retries the whole sequence.
    if (
      !this._resumableStream.replayErroredChunksByRequestId(
        connection,
        pending.requestId
      )
    ) {
      return true;
    }
    sendIfOpen(
      connection,
      JSON.stringify({
        body: pending.body,
        done: true,
        error: true,
        id: pending.requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      })
    );
    return true;
  }

  /**
   * Set or clear the live "recovering…" status (#1620). Persists a durable
   * record (so set/clear stay consistent across the isolates a recovery spans)
   * and broadcasts a `CF_AGENT_CHAT_RECOVERING` frame on a genuine transition.
   * NOTE: the live "recovering…" signal is still not replayed on connect — only
   * the terminal outcome is (#1645, via the resume handshake).
   */
  private async _setChatRecovering(
    active: boolean,
    requestId?: string
  ): Promise<void> {
    const existing = await this.ctx.storage.get<{
      requestId?: string;
      at?: number;
    }>(CHAT_RECOVERING_KEY);
    // A flag older than the TTL is stale: the owning incident was abandoned
    // without a terminal (e.g. the DO went idle before recovery could resolve).
    // Treat it as not-recovering so it can't suppress a genuinely-new recovering
    // signal.
    const activeExisting =
      existing && Date.now() - (existing.at ?? 0) < CHAT_RECOVERING_FLAG_TTL_MS;
    if (active) {
      if (activeExisting) return; // already recovering — idempotent, no re-broadcast
      await this.ctx.storage.put(CHAT_RECOVERING_KEY, {
        ...(requestId ? { requestId } : {}),
        at: Date.now()
      });
    } else {
      if (!existing) return; // not recovering — nothing to clear
      await this.ctx.storage.delete(CHAT_RECOVERING_KEY);
      requestId = requestId ?? existing.requestId;
    }
    this._broadcastChatMessage({
      type: MessageType.CF_AGENT_CHAT_RECOVERING,
      recovering: active,
      ...(requestId ? { id: requestId } : {})
    });
  }

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    const chatPrefix =
      (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME + ":";
    if (!ctx.name.startsWith(chatPrefix)) {
      return false;
    }

    const requestId = ctx.name.slice(chatPrefix.length);
    const { snapshot: recoverySnapshot, user: recoveryData } =
      unwrapChatFiberSnapshot<"ai-chat-turn">(
        "__cfAIChatFiberSnapshot",
        ctx.snapshot,
        "ai-chat-turn"
      );

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

    const partial = streamId
      ? this._getPartialStreamText(streamId)
      : { text: "", parts: [] as MessagePart[] };

    // Only persist while the stream is still active. The ACK handler (client
    // reconnect → replayChunks) may have already persisted + completed the
    // orphaned stream before fiber recovery runs; persisting again on the same
    // chunks would double the assistant message's parts.
    const streamStillActive =
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId;

    const shouldRetryPreStream = this._shouldRetryRecoveredPreStreamTurn(
      recoverySnapshot,
      streamId ?? "",
      partial
    );
    // A new turn whose stream produced no assistant partial at all (interrupted
    // before the first chunk materialized) will be re-run fresh rather than
    // continued (#1691) — and that is knowable *before* `onChatRecovery`,
    // because an empty partial persists nothing and leaves the conversation
    // leaf at the user message regardless of what the hook returns. Report it
    // as "retry" so the hook and the incident match the action that follows.
    // The sibling `persist: false` case (a NON-empty partial the hook chooses
    // to discard) only becomes a retry based on the hook's own return value, so
    // it cannot be pre-detected here — the hook still sees "continue" there and
    // only the `chat:recovery:scheduled` event reflects the final "retry".
    const preStreamLeaf =
      this.messages.length > 0
        ? this.messages[this.messages.length - 1]
        : undefined;
    const emptyPartialNewTurn =
      !!streamId &&
      recoverySnapshot?.continuation === false &&
      !!recoverySnapshot.latestUserMessageId &&
      partial.text === "" &&
      partial.parts.length === 0 &&
      preStreamLeaf?.role === "user" &&
      preStreamLeaf.id === recoverySnapshot.latestUserMessageId;
    const recoveryKind: ChatRecoveryKind =
      shouldRetryPreStream || emptyPartialNewTurn ? "retry" : "continue";
    const recoveryRootRequestId =
      recoverySnapshot?.recoveryRootRequestId ?? requestId;
    const { incident, config, exhausted } =
      await this._beginChatRecoveryIncident({
        requestId,
        recoveryRootRequestId,
        latestUserMessageId: recoverySnapshot?.latestUserMessageId,
        recoveryKind
      });

    if (exhausted) {
      // Preserve the settled partial before sealing the turn. Exhaustion is
      // decided BEFORE `onChatRecovery` is consulted, so without this the
      // settled (often non-idempotent) tool results the turn already produced
      // are discarded and the model re-runs them on the next message (#1631).
      if (streamStillActive) {
        await this._persistOrphanedStream(streamId);
      }
      await this._exhaustChatRecovery(
        incident,
        config,
        partial,
        streamId,
        ctx.createdAt
      );
      return true;
    }

    // Any throw after the incident is opened (user `onChatRecovery`, orphan
    // persistence, scheduling) must flip the incident to a terminal `failed`
    // state and emit, otherwise it leaks in `attempting` and is never
    // observable as a stuck turn.
    try {
      const options =
        (await this.onChatRecovery({
          incidentId: incident.incidentId,
          recoveryRootRequestId,
          attempt: incident.attempt,
          maxAttempts: incident.maxAttempts,
          recoveryKind,
          streamId: streamId ?? "",
          requestId,
          partialText: partial.text,
          partialParts: partial.parts,
          recoveryData,
          messages: [...this.messages],
          lastBody: recoverySnapshot?.lastBody ?? this._lastBody,
          lastClientTools:
            recoverySnapshot?.lastClientTools ?? this._lastClientTools,
          createdAt: ctx.createdAt
        })) ?? {};

      // Settled work — completed, often non-idempotent tool results — is NEVER
      // dropped by recovery. `persist: false` only suppresses persistence of a
      // partial that has nothing settled to lose; a partial carrying settled
      // tool results is persisted regardless, so an app can never accidentally
      // discard completed work (and never needs `{ persist: true }` just to be
      // safe). A safe default beats a warning about an unsafe one (#1631).
      if (
        streamStillActive &&
        (options.persist !== false ||
          this._partialHasSettledToolResults(partial.parts))
      ) {
        await this._persistOrphanedStream(streamId);
      }

      if (streamStillActive) {
        this._resumableStream.complete(streamId);
        void this._ensureStreamCleanupScheduled();
      }

      // A NEW turn (not a continuation) that produced no persisted assistant
      // partial — interrupted before any part materialized, or `persist: false`
      // discarded it — leaves the conversation leaf at the user message.
      // Continuing here would clone the PREVIOUS assistant turn (the most recent
      // assistant message, found by walking back past the trailing user
      // message) and merge this turn into it (#1691). Re-run the user turn fresh
      // instead, so it becomes its own message. Checked AFTER the persist step,
      // so a partial that WAS persisted (now the assistant leaf) still continues.
      const leaf =
        this.messages.length > 0
          ? this.messages[this.messages.length - 1]
          : undefined;
      const lostPartialUserId =
        recoverySnapshot?.continuation === false &&
        recoverySnapshot.latestUserMessageId &&
        leaf?.role === "user" &&
        leaf.id === recoverySnapshot.latestUserMessageId
          ? recoverySnapshot.latestUserMessageId
          : undefined;

      const targetId =
        shouldRetryPreStream || lostPartialUserId !== undefined
          ? undefined
          : this._findLastAssistantMessage()?.id;

      if (shouldRetryPreStream && options.continue !== false) {
        await this._updateChatRecoveryIncident(
          incident.incidentId,
          "scheduled"
        );
        this._emit("chat:recovery:scheduled", {
          incidentId: incident.incidentId,
          requestId,
          attempt: incident.attempt,
          maxAttempts: incident.maxAttempts,
          recoveryKind
        });
        await this.schedule(
          0,
          "_chatRecoveryRetry",
          {
            targetUserId: recoverySnapshot.latestUserMessageId,
            originalRequestId: recoveryRootRequestId,
            incidentId: incident.incidentId,
            lastBody: recoverySnapshot.lastBody ?? null,
            lastClientTools: recoverySnapshot.lastClientTools ?? null
          },
          { idempotent: true }
        );
      } else if (
        lostPartialUserId !== undefined &&
        options.continue !== false
      ) {
        // Re-run the orphaned new turn fresh instead of continuing (and
        // merging into) the previous assistant message.
        await this._updateChatRecoveryIncident(
          incident.incidentId,
          "scheduled"
        );
        this._emit("chat:recovery:scheduled", {
          incidentId: incident.incidentId,
          requestId,
          attempt: incident.attempt,
          maxAttempts: incident.maxAttempts,
          recoveryKind: "retry"
        });
        await this.schedule(
          0,
          "_chatRecoveryRetry",
          {
            targetUserId: lostPartialUserId,
            originalRequestId: recoveryRootRequestId,
            incidentId: incident.incidentId,
            lastBody: recoverySnapshot?.lastBody ?? null,
            lastClientTools: recoverySnapshot?.lastClientTools ?? null
          },
          { idempotent: true }
        );
      } else if (options.continue !== false) {
        await this._updateChatRecoveryIncident(
          incident.incidentId,
          "scheduled"
        );
        this._emit("chat:recovery:scheduled", {
          incidentId: incident.incidentId,
          requestId,
          attempt: incident.attempt,
          maxAttempts: incident.maxAttempts,
          recoveryKind
        });
        await this.schedule(
          0,
          "_chatRecoveryContinue",
          {
            ...(targetId ? { targetAssistantId: targetId } : {}),
            originalRequestId: recoveryRootRequestId,
            incidentId: incident.incidentId,
            ...(recoverySnapshot
              ? {
                  lastBody: recoverySnapshot.lastBody ?? null,
                  lastClientTools: recoverySnapshot.lastClientTools ?? null
                }
              : {})
          },
          { idempotent: true }
        );
      } else {
        await this._updateChatRecoveryIncident(
          incident.incidentId,
          "skipped",
          "continue_disabled"
        );
      }

      return true;
    } catch (error) {
      await this._updateChatRecoveryIncident(
        incident.incidentId,
        "failed",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
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
        timeout: recoveryConfig.stableTimeoutMs
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
   * Reschedule a recovery callback that timed out waiting for stable state,
   * consuming one attempt. Returns `true` if rescheduled, `false` if the
   * attempt budget is exhausted (caller should then fail terminally).
   */
  private async _rescheduleRecoveryAfterStableTimeout(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    maxAttempts: number
  ): Promise<boolean> {
    const incidentKey = data?.incidentId
      ? this._chatRecoveryIncidentKey(data.incidentId)
      : null;
    const incident = incidentKey
      ? await this.ctx.storage.get<ChatRecoveryIncident>(incidentKey)
      : null;
    if (!incident || !incidentKey) return false;
    const attempt = incident.attempt ?? 0;
    if (attempt >= (incident.maxAttempts ?? maxAttempts)) return false;
    await this.ctx.storage.put(incidentKey, {
      ...incident,
      attempt: attempt + 1,
      status: "scheduled",
      lastAttemptAt: Date.now(),
      reason: "stable_timeout_retry"
    });
    // Must NOT be idempotent: this runs inside the currently-executing one-shot
    // schedule row (deleted by `alarm()` only after we return). An idempotent
    // reschedule would dedup onto that row and be deleted with it — the retry
    // would never fire. A fresh delayed row survives.
    await this.schedule(
      CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS,
      callback,
      data ?? {},
      { idempotent: false }
    );
    return true;
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
   * Resolve the stream id for a recovery turn so the give-up terminalization
   * can surface whatever partial the turn produced. Prefers the durable stream
   * row keyed by the recovery-root request id; falls back to the live active
   * stream. Returns `""` when neither is available.
   */
  private _resolveRecoveryStreamId(requestId: string): string {
    if (requestId) {
      const fromMetadata = this._resumableStream
        .getAllStreamMetadata()
        .find((metadata) => metadata.request_id === requestId)?.id;
      if (fromMetadata) return fromMetadata;
    }
    return this._resumableStream.hasActiveStream()
      ? (this._resumableStream.activeStreamId ?? "")
      : "";
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
   * to short-circuit a duplicate alarm earlier. The sealed incident is
   * re-persisted even when the record was found missing, so a swept record is
   * re-armed for the guard on the next alarm.
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
  private async _exhaustRecoveryAfterStableTimeout(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<void> {
    const config = this._resolveChatRecoveryConfig();
    const incidentKey = data?.incidentId
      ? this._chatRecoveryIncidentKey(data.incidentId)
      : null;
    const stored = incidentKey
      ? await this.ctx.storage.get<ChatRecoveryIncident>(incidentKey)
      : null;

    // Re-entry guard (see method doc): a sealed incident means terminalization
    // already happened, so a duplicate stale alarm must not re-fire
    // `onExhausted` / re-broadcast the banner. This is ai-chat's ONLY guard.
    if (stored?.status === "exhausted") return;

    const rootRequestId =
      data?.originalRequestId ??
      this._activeChatRecoveryRootRequestId ??
      stored?.recoveryRootRequestId ??
      stored?.requestId ??
      "";

    // `stable_timeout` distinguishes a give-up driven by repeated stable-state
    // timeouts from the generic max-attempts / no-progress exhaustion reasons.
    const incident: ChatRecoveryIncident = stored
      ? { ...stored, status: "exhausted", reason: "stable_timeout" }
      : {
          // Silent-drop guard: the incident record is gone (no `incidentId`, or
          // it was swept/deleted before this stale alarm fired). Synthesize a
          // minimal incident so the turn STILL terminalizes through
          // `onExhausted` instead of being dropped with no terminal UX.
          incidentId: data?.incidentId ?? crypto.randomUUID(),
          requestId: rootRequestId,
          recoveryRootRequestId: rootRequestId,
          recoveryKind:
            callback === "_chatRecoveryRetry" ? "retry" : "continue",
          attempt: config.maxAttempts,
          maxAttempts: config.maxAttempts,
          status: "exhausted",
          firstSeenAt: Date.now(),
          lastAttemptAt: Date.now(),
          reason: "stable_timeout"
        };

    // Persist the sealed incident (retained for inspection / TTL sweep) so the
    // re-entry guard above sees `exhausted` if a duplicate stale alarm fires.
    if (incidentKey) {
      await this.ctx.storage.put(incidentKey, incident);
    }

    const streamId = this._resolveRecoveryStreamId(
      incident.recoveryRootRequestId ?? incident.requestId
    );
    const partial = streamId
      ? this._getPartialStreamText(streamId)
      : { text: "", parts: [] as MessagePart[] };

    await this._exhaustChatRecovery(
      incident,
      config,
      partial,
      streamId,
      incident.firstSeenAt
    );
  }

  private _shouldRetryRecoveredPreStreamTurn(
    snapshot: ChatFiberSnapshot<"ai-chat-turn"> | null,
    streamId: string,
    partial: { text: string; parts: MessagePart[] }
  ): snapshot is ChatFiberSnapshot<"ai-chat-turn"> & {
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
        timeout: recoveryConfig.stableTimeoutMs
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
  } {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    const parts: MessagePart[] = [];

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk.body);
        applyChunkToParts(parts, data);
      } catch {
        // Skip malformed chunk bodies
      }
    }

    const text = parts
      .filter(
        (p): p is MessagePart & { type: "text"; text: string } =>
          p.type === "text" && "text" in p
      )
      .map((p) => p.text)
      .join("");

    return { text, parts };
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
    let json = JSON.stringify(message);
    let size = chatByteLength(json);
    if (size <= ROW_MAX_BYTES) return message;

    if (message.role !== "assistant") {
      // Non-assistant messages (user/system) are harder to compact safely.
      // Truncate the entire message JSON as a last resort.
      console.warn(
        `[AIChatAgent] Non-assistant message ${message.id} is ${size} bytes, ` +
          `exceeds row limit. Truncating text parts.`
      );
      return this._truncateTextParts(message);
    }

    console.warn(
      `[AIChatAgent] Message ${message.id} is ${size} bytes, ` +
        `compacting tool outputs to fit SQLite row limit`
    );

    // Pass 1: compact tool outputs
    const compactedToolCallIds: string[] = [];
    const compactedParts = message.parts.map((part) => {
      if (
        "output" in part &&
        "toolCallId" in part &&
        "state" in part &&
        part.state === "output-available"
      ) {
        const outputJson = JSON.stringify((part as { output: unknown }).output);
        if (outputJson.length > 1000) {
          compactedToolCallIds.push(part.toolCallId as string);
          return {
            ...part,
            output:
              "This tool output was too large to persist in storage " +
              `(${outputJson.length} bytes). ` +
              "If the user asks about this data, suggest re-running the tool. " +
              `Preview: ${outputJson.slice(0, 500)}...`
          };
        }
      }
      return part;
    }) as UIMessage["parts"];

    let result: UIMessage = {
      ...message,
      parts: compactedParts
    };

    if (compactedToolCallIds.length > 0) {
      result.metadata = {
        ...(result.metadata ?? {}),
        compactedToolOutputs: compactedToolCallIds
      };
    }

    // Check if tool compaction was enough
    json = JSON.stringify(result);
    size = chatByteLength(json);
    if (size <= ROW_MAX_BYTES) return result;

    // Pass 2: truncate text parts
    console.warn(
      `[AIChatAgent] Message ${message.id} still ${size} bytes after tool compaction, truncating text parts`
    );
    return this._truncateTextParts(result);
  }

  /**
   * Truncates text parts in a message to fit within the row size limit.
   * Truncates from the first text part forward, keeping the last text part
   * as intact as possible (it is usually the most relevant).
   */
  private _truncateTextParts(message: UIMessage): UIMessage {
    const compactedTextPartIndices: number[] = [];
    const parts = [...message.parts];

    // Truncate text parts from oldest to newest until we fit
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type === "text" && "text" in part) {
        const text = (part as { text: string }).text;
        if (text.length > 1000) {
          compactedTextPartIndices.push(i);
          parts[i] = {
            ...part,
            text:
              `[Text truncated for storage (${text.length} chars). ` +
              `First 500 chars: ${text.slice(0, 500)}...]`
          } as UIMessage["parts"][number];

          // Check if we fit now
          const candidate = { ...message, parts };
          if (chatByteLength(JSON.stringify(candidate)) <= ROW_MAX_BYTES) {
            break;
          }
        }
      }
    }

    const result: UIMessage = { ...message, parts };
    if (compactedTextPartIndices.length > 0) {
      result.metadata = {
        ...(result.metadata ?? {}),
        compactedTextParts: compactedTextPartIndices
      };
    }
    return result;
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
            // 2. Convert the internal "finish" event's finishReason into the
            //    UIMessageStreamPart messageMetadata format (#677).
            let eventToSend: unknown = data;
            if (continuation && data.type === "start" && "messageId" in data) {
              const { messageId: _, ...rest } = data as {
                messageId: unknown;
                [key: string]: unknown;
              };
              eventToSend = rest;
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
        const streamId = this._startStream(id, { messageId: message.id });

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
            if (streamCompleted.value && streamResult.status !== "error") {
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
              await this.persistMessages(updatedMessages, excludeBroadcastIds);
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
          ...(streamResult.error !== undefined && { error: streamResult.error })
        });
        return streamResult;
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
