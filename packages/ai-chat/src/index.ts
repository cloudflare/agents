import type {
  UIMessage,
  UIMessageChunk,
  GenerateTextOnFinishCallback,
  TextUIPart,
  ToolSet
} from "ai";
import { FIBER_TASK } from "agents/internal";
import {
  Agent,
  isPlatformTransientError,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext,
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
import type { ObservabilityEvent } from "agents/observability";
import type { TaskJson } from "agents/tasks";

import { MessageType, type OutgoingMessage } from "./types";
import { autoTransformMessages } from "./ai-chat-v5-migration";
import {
  LEGACY_MESSAGES_TABLE,
  hydrateMessages,
  mirrorTranscript,
  parseLegacyMessage,
  planPersist,
  rowsPastRetention,
  staleMessageIds,
  transcriptJson
} from "./transcript";
import {
  classifyProviderError,
  reconcileOrphanPartial,
  CHAT_REQUEST_CONTEXT_KEY,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
  planInterruptedTurn,
  requestContextFromLegacy,
  storableRequestContext,
  interruptedToolPartAsError,
  unwrapChatFiberSnapshot,
  CHAT_LAST_TERMINAL_KEY,
  recordRecentChatTerminal,
  type ChatTerminalRecord,
  type OrphanPersistStore
} from "agents/chat";
import {
  sendIfOpen,
  AgentToolProgressEmitter,
  abortReasonText,
  agentToolTurnChunks,
  agentToolTurnId,
  agentToolTurnOf,
  cancelAgentToolTurn,
  carryForwardAgentToolRuns,
  inspectAgentToolTurn,
  liveTurnsOf,
  recordAgentToolProgress,
  progressCreditOf,
  reclaimAgentToolStreams,
  RELEASED_AI_CHAT_AGENT_TOOL_TABLES,
  releasedAgentToolRunOfRequest,
  releasedAgentToolRunWaiting,
  startAgentToolTurn,
  tailAgentToolTurn,
  clientResolvableToolNames,
  settleInterruptedReply,
  type MessagePart
} from "agents/chat";
import {
  ChatFrames,
  createChatStreams,
  truncateProviderToolPayloads
} from "agents/chat";
import { ReplyStreams } from "agents/chat";
import type { Streams } from "agents/streams";
import { Sessions, type Session } from "agents/sessions";
import {
  CHAT_RECOVERY_TASK_NAME,
  broadcastReachesUnlistedSockets,
  type ChatRecoveryAttemptInput,
  type ChatRecoveryTaskHooks,
  createChatRecoveryTaskDefinition,
  createChatTurnTaskDefinition,
  runAppStart,
  clearRecentChatTerminals,
  storedAsFacet
} from "agents/chat";
import { type ClientToolSchema } from "agents/chat";
import {
  resolveChatRecoveryConfig,
  isTurnStopped,
  clearChatTerminal,
  buildChatRecoveringFrame,
  setChatRecovering,
  isDurableObjectResetError,
  type ResolvedRecoveryStream
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";
import { nanoid } from "nanoid";
import {
  cancelTurn,
  CHAT_CLEARED,
  forgetTab,
  resumeChat,
  chatClientView,
  hasPendingToolInteraction,
  chatDispatch,
  stopAllTurns,
  submitTurn,
  chatTurnDefinition,
  clearChat,
  parseProtocolMessage,
  type ChatArrival,
  type ChatDeps,
  type ChatHost,
  type ChatLane,
  type ChatTurnInput,
  type ChatTurnResult
} from "agents/chat";

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

// `ChatRecoveryIncident` / `ChatRecoveryKind` / `CHAT_RECOVERY_INCIDENT_KEY_PREFIX`
// are the canonical shared symbols from `agents/chat` (imported above); the
// persisted incident shape and key prefix are owned by the engine package so
// both consumers round-trip the same record across the deploy that ships them.

// The monotonic forward-progress marker the recovery budget keys off is
// derived from the stream log (`ReplyStreams.progressMarker`): durably
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

export type ChatMessage = UIMessage;

/**
 * Whether a response-reader error is a platform transient that bounded chat
 * recovery can retry. A deploy or storage reset is excluded: the isolate is
 * going away, and the restart's own recovery owns the turn.
 */
function isRecoverableStreamReadError(error: unknown): boolean {
  return isPlatformTransientError(error) && !isDurableObjectResetError(error);
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

/**
 * Extension of Agent with built-in chat capabilities
 * @template Env Environment type containing bindings
 */
/** The chat module's turn definition, as AIChatAgent registers it. */
/** The least time between two progress credits from agent-tool children. */
const AGENT_TOOL_PROGRESS_CREDIT_MS = 5_000;

const CHAT_TURN_DEFINITION = "__cf_ai_chat_turn";

export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends object = object
> extends Agent<Env, State, Props> {
  /**
   * Registry of per-request AbortControllers.
   * Used to propagate cancellation signals for any external calls made by the agent.
   */

  /** Durable chat history for this Agent (lifts the pre-Sessions table). */
  readonly sessions = new Sessions({
    legacyFlatMessages: {
      table: LEGACY_MESSAGES_TABLE,
      parse: parseLegacyMessage
    }
  });

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
   * The Streams capability backing `_replyStreams`: chat's in-flight
   * output lives in the shared durable chunk log, readable by any
   * `streams.read()` consumer on this Durable Object.
   */
  readonly streams: Streams = createChatStreams();

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

  /** Shared admission policy state for overlapping submit-message requests. */

  /**
   * Set of connection IDs that are pending stream resume.
   * These connections have received CF_AGENT_STREAM_RESUMING but haven't sent ACK yet.
   * They should be excluded from live stream broadcasts until they ACK.
   * @internal
   */
  private _pendingResumeConnections: Set<string> = new Set();

  /**
   * The reply streams a release left (its stream tables, a stream cut off
   * mid-reply): read only to carry that release's turn onto the chat's lane.
   * Every turn since writes the chat module's stream.
   */
  private readonly _releasedStreams = new ReplyStreams({
    streamStarted: () => {},
    streamEnded: () => {},
    originMessageIds: () => undefined,
    transaction: (fn) => this.ctx.storage.transactionSync(fn)
  });

  /** Where every chat frame to tabs goes out (the shared `ChatFrames`). */
  private readonly _frames = new ChatFrames({
    broadcast: (message, without) => this.broadcast(message, without),
    connections: () => this.getConnections(),
    reachesUnlisted: () => broadcastReachesUnlistedSockets(this),
    observed: () =>
      this._agentToolTailWaits.size > 0 ||
      this.broadcast !== AIChatAgent.prototype.broadcast,
    kv: this.ctx.storage.kv,
    resuming: this._pendingResumeConnections,
    // Turns name their messages on their own frames (the chat module).
    storedOriginIds: () => undefined,
    recoveryOriginIds: () => undefined,
    clientView: (messages) => this._clientView(messages)
  });

  /**
   * The list a tab is sent: the stored messages, then those the waiting
   * requests hold, in lane order, named in `queuedMessageIds` (a tab keeps
   * them apart and draws them last).
   */
  private _clientView<TMessage extends { id: string }>(
    messages: readonly TMessage[]
  ): { messages: TMessage[]; queuedMessageIds?: string[] } {
    return chatClientView(this.tasks, CHAT_TURN_DEFINITION, "", messages);
  }

  /**
   * `reportProgress`: frames coalesced as the release did, kept on the run's
   * metadata and put on its live reply, so a parent following it and this
   * agent's tabs see them as they come.
   */
  private readonly _agentToolProgress = new AgentToolProgressEmitter({
    resolveActiveRun: () => {
      const requestId = this._runningChatTurn();
      if (!requestId) return null;
      const meta = agentToolTurnOf(this._chatDeps(), requestId);
      return meta ? { runId: meta.runId, requestId } : null;
    },
    broadcast: (_requestId, body) => {
      liveTurnsOf(this.streams)
        .get(this._chatDeps().session ?? "")
        ?.inject(JSON.parse(body) as UIMessageChunk);
    },
    persistSnapshot: (runId, snapshot, at) => {
      recordAgentToolProgress(this._chatDeps(), agentToolTurnId(runId), {
        kind: "progress",
        snapshot: { ...snapshot, at }
      });
    },
    persistMilestone: (runId, name, data, at) => {
      const id = agentToolTurnId(runId);
      const fields = (
        this.tasks.peek(id)?.metadata as
          | { agentTool?: Record<string, unknown> }
          | undefined
      )?.agentTool;
      const sequence = Object.keys(fields ?? {}).filter((key) =>
        key.startsWith("milestone:")
      ).length;
      recordAgentToolProgress(this._chatDeps(), id, {
        kind: "milestone",
        milestone: {
          name,
          sequence,
          at,
          ...(data !== undefined && { data })
        } as AgentToolMilestone
      });
      return sequence;
    }
  });

  /**
   * Tails waiting for an agent-tool turn's stream to open, by the turn's
   * id: its first frame wakes them.
   */
  private readonly _agentToolTailWaits = new Map<string, Set<() => void>>();

  /**
   * The input of each agent-tool run started in this isolate, as it was
   * passed (its output hook gets it so), until its turn ends.
   */
  private readonly _agentToolInputs = new Map<string, unknown>();

  /** The released agent-tool run tables carried forward (reads await it). */
  private _agentToolRunsCarried: Promise<void> | undefined;

  /** When the running turn was last credited for its agent-tool child. */
  private _lastProgressCreditAt = 0;

  /**
   * An agent-tool child this agent's turn waits on streamed: that counts as
   * the turn's progress, so its no-progress window does not run out while
   * the child works. At most one credit per 5 s, as released.
   */
  protected override async _onAgentToolStreamProgress(): Promise<void> {
    const now = Date.now();
    if (now - this._lastProgressCreditAt < AGENT_TOOL_PROGRESS_CREDIT_MS)
      return;
    const requestId = this._runningChatTurn();
    if (!requestId) return;
    this._lastProgressCreditAt = now;
    this.tasks.patchMetadata(requestId, "chat", {
      progressCredit: progressCreditOf(this._chatDeps(), requestId) + 1
    });
  }

  /** The chat turn running now, if any. */
  private _runningChatTurn(): string | null {
    return (
      this._openChatTurns().find((run) => run.status === "running")?.runId ??
      null
    );
  }

  /**
   * The upgrade from a released version: each step turns rows that version
   * kept into the chat module's own, and drops them. Runs in the
   * constructor, before the Tasks capability starts runs, so a run it
   * creates is there when the lane is drained. Each step is cheap when it
   * has nothing to do (one read that finds no table or no row).
   */
  private _upgradeReleasedRows(): void {
    // ai-chat 0.12.x: `cf_ai_chat_request_context` → the session value.
    this._restoreRequestContext();
    // ai-chat 0.12.x: the last turn that ended in an error → the recent
    // terminals, which a tab that loads afterwards is told from.
    this._carryLastTerminal();
    // ai-chat 0.12.x: a turn left cut off (fiber row, incident, recovery
    // runs, stream rows) → a chat-turn run under its request id
    // (turn-task's step goes here).
    // ai-chat 0.12.x: the agent-tool run tables → chat-turn runs
    // `agent-tool:<runId>`, then the tables are dropped.
    this._agentToolRunsCarried = this._carryForwardAgentToolChildRuns();
  }

  /**
   * The carry-forward of the released run tables, finished. A carry that
   * failed is logged, not thrown at every read: the runs it carried read
   * as they are.
   */
  private async _agentToolCarry(): Promise<void> {
    try {
      await this._agentToolRunsCarried;
    } catch (error) {
      console.error(
        "[AIChatAgent] agent-tool runs carry-forward failed",
        error
      );
    }
  }

  /** The agent-tool runs a released version kept, onto this version's runs. */
  private async _carryForwardAgentToolChildRuns(): Promise<void> {
    await carryForwardAgentToolRuns(
      this._chatDeps(),
      this.ctx.storage.sql,
      RELEASED_AI_CHAT_AGENT_TOOL_TABLES,
      CHAT_TURN_DEFINITION,
      (requestId) => this._releasedTurnWaits(requestId),
      // A sub-agent (a facet) empties them; only a root drops them.
      () => !this._isFacetForCarry()
    );
  }

  private _carryLastTerminal(): void {
    const kv = this.ctx.storage.kv;
    const last = kv.get<ChatTerminalRecord>(CHAT_LAST_TERMINAL_KEY);
    if (last === undefined) return;
    recordRecentChatTerminal(kv, {
      id: last.requestId,
      body: last.body,
      done: true,
      error: true,
      ...(last.messageIds && { messageIds: last.messageIds })
    });
    kv.delete(CHAT_LAST_TERMINAL_KEY);
  }

  /** Whether this agent runs as a facet (a sub-agent). */
  private _isFacetForCarry(): boolean {
    return (this as unknown as { _isFacet?: boolean })._isFacet === true;
  }

  /** Whether a released turn of `requestId` is still to be carried. */
  private _releasedTurnWaits(requestId: string): boolean {
    const fiber = (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME;
    for (const record of this.tasks.peekList({
      definition: [fiber, CHAT_RECOVERY_TASK_NAME, FIBER_TASK],
      status: ["pending", "running"]
    })) {
      if (
        (record.metadata as { requestId?: unknown } | undefined)?.requestId ===
        requestId
      ) {
        return true;
      }
      const input = this.tasks.inputOf<{
        name?: unknown;
        data?: { originalRequestId?: unknown };
      }>(record.runId);
      // A released turn scheduled for recovery, or its fiber row carried
      // onto Tasks.
      if (
        input?.data?.originalRequestId === requestId ||
        input?.name === `${fiber}:${requestId}`
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * A released turn that is not carried on (the app declined it, or the
   * conversation moved on): its request ends, and an agent-tool run it
   * belonged to ends as an error, so its parent stops waiting.
   */
  private async _endUncarriedTurn(
    requestId: string,
    key: { requestId: string; metadata?: Record<string, TaskJson> }
  ): Promise<void> {
    this._frames.endUnstarted(null, requestId, "aborted");
    if (!key.metadata) return;
    await this.tasks.importRun({
      runId: key.requestId,
      definition: CHAT_TURN_DEFINITION,
      status: "error",
      attempt: 1,
      retain: true,
      metadata: key.metadata,
      error: "Agent tool run was not recovered after the upgrade.",
      createdAt: Date.now()
    });
    await this._carryForwardAgentToolChildRuns();
  }

  /**
   * The run id and metadata a released turn of `requestId` is carried
   * under: its open agent-tool run's, so that run carries on, or its own.
   */
  private _carriedTurnKey(requestId: string): {
    requestId: string;
    metadata?: Record<string, TaskJson>;
  } {
    const run = releasedAgentToolRunOfRequest(
      this.ctx.storage.sql,
      RELEASED_AI_CHAT_AGENT_TOOL_TABLES.runs,
      requestId
    );
    if (!run) return { requestId };
    return {
      requestId: agentToolTurnId(run.runId),
      metadata: {
        agentTool: {
          runId: run.runId,
          startMessageId: null,
          ...(run.terminalOnly && { terminalOnly: true })
        },
        // Its reply's stream is kept for its parent, as every agent-tool
        // turn's is.
        chat: { keepStream: true }
      }
    };
  }

  private _restoreRequestContext(): void {
    const stored = this.#session.internal_configNow(CHAT_REQUEST_CONTEXT_KEY);
    if (stored !== null) return;
    let rows: Array<{ key: string; value: string }>;
    try {
      rows = this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM cf_ai_chat_request_context"
        )
        .toArray();
    } catch {
      return; // No table: nothing kept by an earlier release.
    }
    // Nothing to carry: an earlier release created the table on every
    // start. The root drops it; a sub-agent keeps it empty (no DROP there).
    if (rows.length === 0) {
      if (!storedAsFacet(this.ctx.storage.kv)) {
        this.ctx.storage.sql.exec("DROP TABLE cf_ai_chat_request_context");
      }
      return;
    }
    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    const json = requestContextFromLegacy(
      value("lastClientTools"),
      value("lastBody")
    );
    // Written through the session once it is ready; the old rows go either
    // way, so a later clear cannot bring them back.
    void this.#session
      .internal_setConfig(
        CHAT_REQUEST_CONTEXT_KEY,
        storableRequestContext(json)
      )
      .catch((error: unknown) => {
        console.error(
          "[AIChatAgent] Failed to carry the request context forward:",
          error
        );
      })
      .finally(() => {
        // A sub-agent empties the table instead: a DROP at a facet's start
        // after an upgrade can reset its tree's storage.
        this.ctx.storage.sql.exec(
          storedAsFacet(this.ctx.storage.kv)
            ? "DELETE FROM cf_ai_chat_request_context"
            : "DROP TABLE IF EXISTS cf_ai_chat_request_context"
        );
      });
  }

  /**
   * Client tool schemas from the most recent chat request.
   * @internal Kept for subclasses written against earlier releases.
   */
  protected get _lastClientTools(): ClientToolSchema[] | undefined {
    return this._requestContextNow().clientTools;
  }
  protected set _lastClientTools(clientTools: ClientToolSchema[] | undefined) {
    void this._setRequestContext({ ...this._requestContextNow(), clientTools });
  }

  /**
   * Custom body data from the most recent chat request.
   * @internal Kept for subclasses written against earlier releases.
   */
  protected get _lastBody(): Record<string, unknown> | undefined {
    return this._requestContextNow().body;
  }
  protected set _lastBody(body: Record<string, unknown> | undefined) {
    void this._setRequestContext({ ...this._requestContextNow(), body });
  }

  /** The chat module's stored request context: the tools and body of the last request. */
  private _requestContextNow(): {
    clientTools?: ClientToolSchema[];
    body?: Record<string, unknown>;
  } {
    const stored = this.#session.internal_configNow(CHAT_REQUEST_CONTEXT_KEY);
    if (stored === null) return {};
    try {
      return JSON.parse(stored) as {
        clientTools?: ClientToolSchema[];
        body?: Record<string, unknown>;
      };
    } catch {
      return {};
    }
  }

  /** Replace the stored request context (`{}` deletes it). */
  protected async _setRequestContext(context: {
    clientTools?: ClientToolSchema[];
    body?: Record<string, unknown>;
  }): Promise<void> {
    const kept = {
      ...(context.clientTools?.length && { clientTools: context.clientTools }),
      ...(context.body && { body: context.body })
    };
    await this.#session.internal_setConfig(
      CHAT_REQUEST_CONTEXT_KEY,
      Object.keys(kept).length > 0 ? JSON.stringify(kept) : null
    );
  }

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

  /** Whether each running call continues a reply, for `onChatResponse`. */
  private readonly _callContinues = new Map<string, boolean>();

  /** What `onError` threw in place of a turn's error, for its waiting caller. */
  private readonly _onErrorReplaced = new Map<string, unknown>();

  /** Turns whose `onChatMessage` answered with a reply, until they end. */
  private readonly _answered = new Set<string>();

  /** Requests that waited behind another, so every tab was shown them queued. */
  private readonly _shownQueued = new Set<string>();

  /** Deliveries of `onChatResponse` not finished yet: the chat is not stable. */
  private readonly _responseDeliveries = new Set<Promise<void>>();

  /** True while `onChatResponse` runs: a turn the hook starts is delivered after it. */
  private _insideResponseHook = false;

  /** A stop's work goes on after the call that asked for it returns. */
  private _holdForStop(settled: Promise<void>): void {
    void this.keepAliveWhile(() => settled);
  }

  /** `onChatResponse` results waiting for their turn to leave the lane. */
  private readonly _chatResponses: ChatResponseResult[] = [];

  private async _deliverChatResponses(): Promise<void> {
    if (this._insideResponseHook) return;
    this._insideResponseHook = true;
    try {
      await this.keepAliveWhile(async () => {
        for (;;) {
          const next = this._chatResponses.shift();
          if (!next) return;
          try {
            await this.onChatResponse(next);
          } catch (error) {
            console.error("[AIChatAgent] onChatResponse failed:", error);
          }
        }
      });
    } finally {
      this._insideResponseHook = false;
    }
  }

  /** Callers waiting for the end of a turn they started, by request id. */
  private readonly _turnWaiters = new Map<
    string,
    (result: ChatTurnResult) => void
  >();

  /**
   * Start a server turn on the chat's lane and wait for its end: the turns
   * behind `saveMessages` and `continueLastTurn`.
   */
  private async _serverTurn(
    input: ChatTurnInput,
    options: {
      signal?: AbortSignal;
      storeContext?: boolean;
      requestId?: string;
      metadata?: Record<string, TaskJson>;
    } = {}
  ): Promise<SaveMessagesResult> {
    const requestId = options.requestId ?? nanoid();
    if (options.signal?.aborted) {
      return { requestId, status: "aborted", reason: "stopped" };
    }
    const ended = new Promise<ChatTurnResult>((resolve) =>
      this._turnWaiters.set(requestId, resolve)
    );
    await submitTurn(this._chatDeps(), this._chatLane(), input, {
      requestId,
      ...(options.signal && { signal: options.signal }),
      ...(options.storeContext && { storeContext: true }),
      ...(options.metadata && { metadata: options.metadata })
    });
    // A turn the lane ends without running it (a clear, a skip) never
    // reaches `onResponse`: its run's end answers instead.
    const settled = this.tasks.wait(requestId).then((record) =>
      record && record.status !== "completed"
        ? ({
            requestId,
            status: record.status === "aborted" ? "aborted" : "skipped"
          } as ChatTurnResult)
        : ended
    );
    const result = await Promise.race([ended, settled]);
    this._turnWaiters.delete(requestId);
    // `onError` replaced what `onChatMessage` threw: the caller gets that.
    if (this._onErrorReplaced.has(requestId)) {
      const replaced = this._onErrorReplaced.get(requestId);
      this._onErrorReplaced.delete(requestId);
      throw replaced;
    }
    // Skipped before anything ran: no request is named.
    const ranNothing =
      result.status === "skipped" &&
      (result.reason === "nothing-to-continue" ||
        result.reason === "awaiting-client");
    return {
      requestId: ranNothing ? "" : requestId,
      status: result.status,
      ...(result.error !== undefined && { error: result.error }),
      ...(result.reason !== undefined && {
        reason: result.reason as SaveMessagesResult["reason"]
      }),
      // Every stop of a server turn is a stop; an interruption is recovered.
      ...(result.status === "aborted" && { reason: "stopped" as const })
    };
  }

  /** What the chat module is given: the agent's capabilities and its tabs. */
  private _chatDeps(): ChatDeps {
    return {
      tasks: this.tasks,
      streams: this.streams,
      sessions: this.sessions,
      kv: this.ctx.storage.kv,
      // A turn's frames go out through `broadcast` (a terminal-only
      // agent-tool run's chunks stop there).
      webSockets: {
        getConnections: () => this.getConnections(),
        broadcast: (text, without) => this.broadcast(text, without)
      },
      sanitizeForPersistence: (message) =>
        this._sanitizeMessageForPersistence(message),
      // A turn stopped while it waited to be retried ends here: the same
      // end every other turn reports (`onChatResponse`, its waiter).
      turnEnded: (result) => this._chatHost().hooks?.onResponse?.(result),
      emit: (type, payload) => {
        this._emit(type as ObservabilityEvent["type"], payload);
        // The live "recovering" status (#1620): on while a turn's recovery
        // is under way, off when it ends. Tabs are told on each change, and
        // one that connects meanwhile is told on connect.
        const recovering =
          type === "chat:recovery:scheduled" ||
          type === "chat:recovery:detected" ||
          type === "chat:recovery:attempt"
            ? true
            : type === "chat:recovery:completed" ||
                type === "chat:recovery:skipped" ||
                type === "chat:recovery:failed"
              ? false
              : undefined;
        if (recovering !== undefined) {
          void this.keepAliveWhile(() =>
            this._setChatRecovering(
              recovering,
              typeof payload.requestId === "string"
                ? payload.requestId
                : undefined
            )
          ).catch((error: unknown) =>
            console.error("[AIChatAgent] recovering status failed", error)
          );
        }
      }
    };
  }

  /** The chat's lane: one turn at a time, joined as `messageConcurrency` says. */
  private _chatLane(): ChatLane {
    const concurrency = this.messageConcurrency;
    const arrival: ChatArrival =
      typeof concurrency === "object"
        ? {
            // A missing or invalid window falls back to the default.
            debounceMs:
              typeof concurrency.debounceMs === "number" &&
              Number.isFinite(concurrency.debounceMs) &&
              concurrency.debounceMs >= 0
                ? concurrency.debounceMs
                : AIChatAgent.MESSAGE_DEBOUNCE_MS
          }
        : concurrency;
    return {
      definition: CHAT_TURN_DEFINITION,
      lane: "chat",
      arrival
    };
  }

  /** How the chat module asks this agent for a reply and tells it the end. */
  private _chatHost(): ChatHost {
    const agent = this;
    return {
      respond: async (call) => {
        // Apps read the transcript the call is for from `this.messages`.
        const before = this.messages;
        this.messages = [...call.messages] as UIMessage[];
        // The other tabs learn what the turn stored or removed before it
        // asks the model (its question, a repaired reply): the whole list,
        // so each drops what is gone. The tab that sent it has it already.
        if (
          before.length !== this.messages.length ||
          before.some((message, i) => message !== this.messages[i])
        ) {
          const origin = (
            this.tasks.peek(call.requestId)?.metadata as
              | { chat?: { origin?: string } }
              | undefined
          )?.chat?.origin;
          // A tab shown its request as queued is told when it joins, too.
          const shown = this._shownQueued.delete(call.requestId);
          this._frames.broadcastMessages(
            this.messages,
            origin && !shown ? [origin] : []
          );
        }
        this._callContinues.set(call.requestId, call.mode === "continue");
        if (
          call.trigger === "submit-message" ||
          call.trigger === "regenerate-message"
        ) {
          this._emit("message:request");
        }
        // `getCurrentAgent()` in `onChatMessage` and its tools names the tab
        // that sent the request (or answered the call), when it is here.
        const originId = (
          this.tasks.peek(call.requestId)?.metadata as
            | { chat?: { origin?: string } }
            | undefined
        )?.chat?.origin;
        let originConnection: Connection | undefined;
        if (originId !== undefined) {
          for (const connection of this.getConnections()) {
            if (connection.id === originId) originConnection = connection;
          }
        }
        // `this.stash(data)` in the app's turn goes to the turn's run (the
        // chat module runs `respond` inside the turn's stash).
        const ask = () =>
          this.onChatMessage(async () => {}, {
            requestId: call.requestId,
            abortSignal: call.signal,
            // No client tools reach `onChatMessage` as none, as before.
            ...(call.clientTools.length > 0 && {
              clientTools: [...call.clientTools]
            }),
            // A request with no custom fields has no body, as before.
            ...(call.body !== undefined &&
              Object.keys(call.body).length > 0 && {
                body: { ...call.body }
              }),
            continuation: call.mode === "continue"
          });
        let response: Awaited<ReturnType<typeof ask>>;
        try {
          response = await agentContext.run(
            {
              agent: this,
              connection: originConnection,
              request: undefined,
              email: undefined
            },
            ask
          );
        } catch (error) {
          // `onError` observes what `onChatMessage` threw and may replace it
          // by throwing; the turn ends with the original either way, and a
          // caller waiting on it (`saveMessages`, `continueLastTurn`) gets
          // the replacement. A stop is not an error.
          if (!call.signal.aborted) {
            try {
              await this.onError(error);
            } catch (replaced) {
              this._onErrorReplaced.set(call.requestId, replaced);
            }
          }
          throw error;
        }
        // It answered with a reply: however that reply ends, the hook
        // hears of it.
        if (response) this._answered.add(call.requestId);
        return response;
      },
      hooks: {
        onResponse: async (result) => {
          this._shownQueued.delete(result.requestId);
          const toolRun = agentToolTurnOf(this._chatDeps(), result.requestId);
          if (toolRun) {
            this._agentToolProgress.forget(toolRun.runId);
            // A completed run's output and summary, made once from its reply
            // and kept on the run, as the release stored them.
            if (result.status === "completed") {
              this.tasks.patchMetadata(result.requestId, "agentTool", {
                result: this._agentToolResult(
                  toolRun.runId,
                  toolRun
                ) as TaskJson
              });
            }
            // What a recovery declined to keep, kept with the run so a
            // replay after it settled skips it too.
            const discarded = this.tasks.checkpointOf<number>(
              result.requestId,
              "chat:discarded"
            );
            if (discarded) {
              this.tasks.patchMetadata(result.requestId, "agentTool", {
                discarded
              });
            }
            this._agentToolInputs.delete(toolRun.runId);
          }
          const waiter = this._turnWaiters.get(result.requestId);
          // No caller waits on it (a tab's request): nothing gets it.
          if (!waiter) this._onErrorReplaced.delete(result.requestId);
          this._turnWaiters.delete(result.requestId);
          // Whether the model was asked: a turn stopped before it started
          // reports nothing to `onChatResponse`.
          const ran = this._callContinues.has(result.requestId);
          const answered = this._answered.delete(result.requestId);
          const continuation =
            this._callContinues.get(result.requestId) ?? false;
          this._callContinues.delete(result.requestId);
          // `this.messages` follows storage through the Sessions change feed
          // (`mirrorTranscript`): the turn's writes are in it already.
          if (result.status === "error") {
            this._emit("message:error", { error: result.error ?? "" });
          } else if (result.messageId !== undefined) {
            this._emit("message:response");
          }
          if (result.status === "skipped") {
            waiter?.(result);
            return;
          }
          // A continuation that failed before it stored anything reports
          // the reply it was continuing.
          const message =
            result.messageId !== undefined
              ? ((await this.#session.getMessage(
                  result.messageId
                )) as UIMessage | null)
              : continuation && result.status === "error"
                ? ([...this.messages]
                    .reverse()
                    .find((m) => m.role === "assistant") ?? null)
                : // A turn stopped before its reply held anything still
                  // reports how it ended, with the empty reply.
                  (result.status === "aborted" && ran) ||
                    (result.status === "error" && answered)
                  ? ({
                      id: result.requestId,
                      role: "assistant",
                      parts: []
                    } as UIMessage)
                  : null;
          if (!message) {
            waiter?.(result);
            return;
          }
          waiter?.(result);
          // Delivered once the turn has left the lane, so the hook may start
          // a turn of its own; one at a time, never inside another.
          this._chatResponses.push({
            message,
            requestId: result.requestId,
            continuation,
            status: result.status,
            ...(result.error !== undefined && { error: result.error })
          });
          const delivered = this.tasks
            .wait(result.requestId)
            .then(() => this._deliverChatResponses());
          this._responseDeliveries.add(delivered);
          void delivered.finally(() =>
            this._responseDeliveries.delete(delivered)
          );
        },
        sanitizeForPersistence: (message) =>
          this._sanitizeMessageForPersistence(message),
        onRecovery: (context) => this.onChatRecovery(context),
        // A tool call a cut-off reply left unanswered is settled by the
        // app's hook, as the release did.
        repairInterruptedToolPart: (part) =>
          this.repairInterruptedToolPart(part as never) as never,
        // What the provider's error says: a rate limit or a transient
        // failure goes into bounded chat recovery, like a dropped stream
        // (#1964). An in-band error is the provider's answer.
        classifyError: (error, inBand) =>
          (!inBand && isRecoverableStreamReadError(error)) ||
          isTransientProviderError(error)
            ? "transient"
            : "terminal"
      },
      options: {
        hydrationByteBudget: this.hydrationByteBudget,
        ...(this.maxPersistedMessages !== undefined && {
          maxPersistedMessages: this.maxPersistedMessages
        }),
        // The app's whole budget: the turn definition applies it. A stream
        // that sends nothing for the app's stall timeout is interrupted.
        // Read when a turn runs, so a value set after construction holds.
        get recovery() {
          const recovery = agent.chatRecovery;
          return {
            ...(typeof recovery === "object" && recovery),
            ...(agent.chatStreamStallTimeoutMs > 0 && {
              stallTimeoutMs: agent.chatStreamStallTimeoutMs
            })
          };
        }
      }
    };
  }

  /**
   * Register the shared chat-turn and chat-recovery Task definitions (see
   * `agents/chat` `createChatTurnTaskDefinition` for the turn logic): the
   * host wires its protected internals through the hooks.
   */
  private _registerChatTurnTaskDefinition(): void {
    // SAFETY: the recovery engine is the sole producer of each callback's
    // payload and Tasks persists it verbatim, so the callback name selects
    // the matching host input type.
    // A recovery an earlier version scheduled and had not run yet: its
    // turn is carried onto the chat's lane.
    const attempts: ChatRecoveryTaskHooks = {
      _chatRecoveryContinue: (data) =>
        this._carryReleasedRecovery(
          "continue",
          data as ChatRecoveryContinueData
        ),
      _chatRecoveryRetry: (data) =>
        this._carryReleasedRecovery("retry", data as ChatRecoveryRetryData)
    };
    const chatFiberName = (this.constructor as typeof AIChatAgent)
      .CHAT_FIBER_NAME;
    this.tasks.register(
      chatFiberName,
      createChatTurnTaskDefinition({
        storage: this.ctx.storage,
        snapshotKey: "__cfAIChatFiberSnapshot",
        keepAliveWhile: (fn) => this.keepAliveWhile(fn),
        withStash: (context, fn) => this._withFiberStash(context, fn),
        // Only a cut-off turn a release left runs here: it is carried onto
        // the chat's lane. No release queued requests on this definition,
        // and none of its runs park or back off here.
        recover: (turn) => this._recoverChatTurn(turn),
        replay: async () => {},
        parkUntil: () => {},
        laneHeldForRecovery: () => false,
        backingOff: () => {},
        holdParksUntil: () => {},
        attempts
      })
    );
    // The chat module's turn definition: every new turn runs here.
    this.tasks.register(
      CHAT_TURN_DEFINITION,
      chatTurnDefinition(this._chatDeps(), this._chatHost(), {
        name: CHAT_TURN_DEFINITION
      })
    );
    // The recovery Task, which only finishes runs an earlier version
    // enqueued.
    this.tasks.register(
      CHAT_RECOVERY_TASK_NAME,
      createChatRecoveryTaskDefinition(attempts)
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
    // A chunk of a terminal-only agent-tool run reaches its parent through
    // the run's stream, not this agent's tabs.
    if (typeof msg === "string" && msg.includes('"id":"agent-tool:')) {
      if (this._agentToolFrame(msg) === "suppress") return;
    }
    super.broadcast(msg, without);
  }

  /**
   * An agent-tool turn's frame: it wakes the tails waiting for the turn's
   * stream, and a chunk of a terminal-only run is not for this agent's tabs.
   */
  private _agentToolFrame(msg: string): "suppress" | "send" {
    let frame: { type?: unknown; id?: unknown; done?: unknown };
    try {
      frame = JSON.parse(msg) as typeof frame;
    } catch {
      return "send";
    }
    if (
      frame.type !== MessageType.CF_AGENT_USE_CHAT_RESPONSE ||
      typeof frame.id !== "string"
    ) {
      return "send";
    }
    const waiting = this._agentToolTailWaits.get(frame.id);
    if (waiting) {
      this._agentToolTailWaits.delete(frame.id);
      for (const wake of waiting) wake();
    }
    return frame.done !== true &&
      agentToolTurnOf(this._chatDeps(), frame.id)?.terminalOnly === true
      ? "suppress"
      : "send";
  }

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.sessions);
    this.lifecycle.use(this.streams);
    this._registerChatTurnTaskDefinition();
    this._withAgentSpan(
      "chat_initialization",
      "initialization",
      { "cloudflare.agents.component": "ai_chat" },
      (update) => {
        this._withAgentSpan(
          "initialize_chat_storage",
          "initialization",
          { "cloudflare.agents.component": "ai_chat" },
          () => {
            // Session storage is Sessions' business and is initialized by its
            // capability `onStart`; the constructor never reads or writes the
            // transcript. Legacy lift and hydration happen in `onStart`.
          }
        );

        // Rows an earlier release left, carried forward once, before any
        // turn runs: the request context, and (turn-task's step) a turn
        // that release left cut off.
        this._upgradeReleasedRows();

        // A reply stream a release left: its legacy tables imported, and a
        // stream it left in flight found, for the carry of its turn.
        this._releasedStreams.open(this.streams, this.sql.bind(this), () =>
          storedAsFacet(this.ctx.storage.kv)
        );
        update({
          "cloudflare.agents.chat.active_stream.restored":
            this._releasedStreams.hasActiveStream()
        });
      }
    );

    // `this.messages` mirrors durable storage through the Sessions change
    // feed rather than being hand-patched at each write site.
    mirrorTranscript(
      this.#session,
      () => this.messages,
      (messages) => {
        this.messages = messages;
      }
    );

    const _onStart = this.onStart.bind(this);
    this.onStart = async (props?: Props) => {
      await this._withAgentSpan(
        "load_chat_messages",
        "startup",
        { "cloudflare.agents.component": "ai_chat" },
        async (update) => {
          this.messages = await hydrateMessages(
            this.#session,
            this.hydrationByteBudget
          );
          update({
            "cloudflare.agents.chat.messages.loaded": this.messages.length
          });
        }
      );
      return runAppStart(async () => _onStart(props));
    };

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection, ctx: ConnectionContext) => {
      if (this._cf_requestTargetsSubAgent(ctx.request)) {
        return _onConnect(connection, ctx);
      }

      // A tab loads the transcript over HTTP. While requests wait, it is also
      // sent the message list, so it knows which messages are queued.
      // The HTTP transcript has the stored messages only; this list names
      // the queued ones, which a tab keeps apart and draws last.
      // One read of the lane answers both questions below.
      const open = this._openChatTurns();
      if (open.some((run) => run.status === "pending")) {
        const view = this._clientView(this.messages);
        if (view.queuedMessageIds) {
          this._frames.send(connection, {
            type: MessageType.CF_AGENT_CHAT_MESSAGES,
            connect: true,
            ...view
          });
        }
      }

      // A turn streams or waits to: the tab is offered its stream, or told
      // to wait for it (#1784) and offered it when it starts.
      // A turn being recovered: the tab is told so (#1620), whether it
      // waits for its next attempt with its stream open or between streams.
      const recoveringFrame = await this._buildRecoveringConnectFrame();
      if (recoveringFrame) {
        sendIfOpen(connection, JSON.stringify(recoveringFrame));
      }
      if (open.length > 0) {
        await resumeChat(this._chatDeps(), this._chatLane(), connection);
      }
      // Call consumer's onConnect
      return _onConnect(connection, ctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      // The chat module forgets the tab: it waits for no stream.
      forgetTab(this._chatDeps(), connection.id);
      return _onClose(connection, code, reason, wasClean);
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (!this._cf_connectionTargetsSubAgent(connection)) {
        // The chat module answers the chat protocol; a clear and a tab's
        // transcript push are this agent's.
        const event =
          typeof message === "string" ? parseProtocolMessage(message) : null;
        if (
          event &&
          event.type !== "clear" &&
          event.type !== "messages" &&
          typeof message === "string" &&
          (await chatDispatch(
            this._chatDeps(),
            this._chatLane(),
            connection,
            message
          ))
        ) {
          // A request that waits behind another: the other tabs are shown
          // its messages at once, after the transcript, named as queued.
          if (
            event.type === "chat-request" &&
            this.tasks.peek(event.id)?.status === "pending"
          ) {
            this._frames.broadcastMessages(this.messages, [connection.id]);
            this._shownQueued.add(event.id);
          }
          return;
        }
        if (event?.type === "clear") {
          await this._clearFromTab(connection);
          return;
        }
        if (event?.type === "messages") {
          await this._messagesFromTab(
            connection,
            event.messages as UIMessage[]
          );
          return;
        }
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      return this._tryCatchChat(async () => {
        const url = new URL(request.url);
        if (url.pathname.split("/").pop() === "get-messages") {
          return new Response(transcriptJson(this.#session), {
            headers: { "content-type": "application/json" }
          });
        }
        return _onRequest(request);
      });
    };
  }

  // ── Resumable stream ───────────────────────────────────────────────

  /**
   * Rebuild the reply an orphaned stream holds and store it
   * (`ReplyStreams.persistOrphan`). Each write goes through
   * `persistMessages`, which broadcasts it.
   * @internal
   */
  protected async _persistOrphanedStream(streamId: string): Promise<void> {
    await this._releasedStreams.persistOrphan(streamId, {
      store: this._orphanStore(),
      settle: (message) => this._settleInterruptedReply(message),
      // A stream from before #1691 recorded no id: it continued the last
      // assistant message, and holds only its own parts.
      legacyMessageId: () => this._findLastAssistantMessage()?.id,
      mergeLegacy: reconcileOrphanPartial
    });
  }

  /**
   * Settle the tool calls a cut-off reply left unanswered (the shared
   * `settleInterruptedReply`): a call no client is known to own becomes an
   * errored result through {@link repairInterruptedToolPart}.
   */
  private _settleInterruptedReply(message: UIMessage): UIMessage {
    return settleInterruptedReply(message, {
      repairPart: (part) => this.repairInterruptedToolPart(part),
      clientToolNames: clientResolvableToolNames(
        this._requestContextNow().clientTools
      )
    });
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
      appendMessage: async (message) => {
        await this.persistMessages([...this.messages, message]);
      },
      updateMessage: async (message) => {
        await this.persistMessages(
          this.messages.map((m) => (m.id === message.id ? message : m))
        );
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
      clientToolNames: clientResolvableToolNames(
        this._requestContextNow().clientTools
      )
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
    // Every unanswered call in the stored transcript counts, as the release
    // counts them; the client tools are the stored request's.
    return hasPendingToolInteraction({
      messages: this.messages,
      streaming: null,
      clientToolNames: new Set(
        (this._lastClientTools ?? []).map((tool) => tool.name)
      )
    });
  }

  /**
   * The ids of the messages the chat's waiting turns hold: questions not
   * stored yet, which a turn stores when it starts.
   */
  protected _queuedMessageIds(): Set<string> {
    const ids = new Set<string>();
    for (const run of this._openChatTurns()) {
      if (run.status !== "pending") continue;
      const input = this.tasks.inputOf<ChatTurnInput>(run.runId);
      for (const message of input?.messages ?? []) ids.add(message.id);
    }
    return ids;
  }

  /** The chat's turns that wait or run in its lane. */
  protected _openChatTurns(): readonly { runId: string; status: string }[] {
    return this.tasks.peekList({
      definition: CHAT_TURN_DEFINITION,
      lane: "chat",
      status: ["pending", "running"],
      results: false,
      order: "oldest"
    });
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
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;
    const pending =
      options?.pendingInteraction ?? (() => this.hasPendingInteraction());
    for (;;) {
      const [next] = this._openChatTurns();
      const left = deadline === null ? undefined : deadline - Date.now();
      if (left !== undefined && left <= 0) return false;
      if (next) {
        // Wait for the turn at the front of the lane, then look again.
        await this.tasks.wait(next.runId, {
          ...(left !== undefined && { timeoutMs: left })
        });
        continue;
      }
      // A turn's `onChatResponse` may start another.
      if (this._responseDeliveries.size > 0) {
        await Promise.all(this._responseDeliveries);
        continue;
      }
      if (!pending()) return true;
      // A reply waits on a client: its answer starts the next turn.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(left ?? 50, 50))
      );
    }
  }

  /** A tab cleared the chat. */
  private async _clearFromTab(connection: Connection): Promise<void> {
    // The chat module's lane: its turns end, waiting or running.
    this._shownQueued.clear();
    await clearChat(this._chatDeps(), this._chatLane());
    this.resetTurnState();
    await this.#session.clearMessages();
    // Drop any pending terminal record (#1645) so a stale exhaustion
    // can't replay onto a freshly-cleared (empty) conversation when a
    // client reconnects and runs the resume probe.
    await clearChatTerminal(this.ctx.storage);
    clearRecentChatTerminals(this.ctx.storage.kv);
    this._releasedStreams.clearAll();
    // `clearMessages()` above emptied `this.messages` through the
    // change feed.
    this._frames.broadcast({ type: MessageType.CF_AGENT_CHAT_CLEAR }, [
      connection.id
    ]);
    this._emit("message:clear");
  }

  /** A tab sent its transcript back. */
  private async _messagesFromTab(
    connection: Connection,
    messages: UIMessage[]
  ): Promise<void> {
    // A message a waiting request holds is stored when its turn
    // starts, not because a tab sent it back.
    const queued = this._queuedMessageIds();
    const transformedMessages = autoTransformMessages(messages).filter(
      (message) => !queued.has(message.id)
    );
    await this.persistMessages(transformedMessages, [connection.id]);
  }

  /**
   * Aborts the active turn and invalidates queued continuations. Call this
   * when intercepting `CF_AGENT_CHAT_CLEAR` before the SDK sees the message —
   * the built-in handler calls it automatically.
   */
  protected resetTurnState(): void {
    // The chat module's turns end as a clear ends them (nothing they stream
    // is kept); an agent-tool run's turn ends with them.
    this._holdForStop(
      stopAllTurns(this._chatDeps(), this._chatLane(), CHAT_CLEARED).then(
        // The replies settled agent-tool runs kept go with the chat.
        () => reclaimAgentToolStreams(this._chatDeps())
      )
    );
    this._chatResponses.length = 0;
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
    this._holdForStop(
      cancelTurn(
        this._chatDeps(),
        requestId,
        reason === undefined ? undefined : String(reason)
      ).then(() => {})
    );
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
    const deps = this._chatDeps();
    const why = reason === undefined ? undefined : String(reason);
    this._holdForStop(stopAllTurns(deps, this._chatLane(), why).then(() => {}));
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
    const result = this._agentToolProgress.report(progress, options);
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
    // Between turns: once the turns on the chat's lane have ended. The
    // delivery holds no place on the lane, so a `react` reply it starts
    // is a turn of its own that it may wait for.
    await this.keepAliveWhile(async () => {
      for (;;) {
        const [open] = this._openChatTurns();
        if (!open) break;
        await this.tasks.wait(open.runId).catch(() => {});
      }
      this._inSerializedDetachedDeliverySlot = true;
      try {
        await inContext();
      } finally {
        this._inSerializedDetachedDeliverySlot = false;
      }
    });
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
        await this._serverTurn({ trigger: "server" });
      } else if (this._openChatTurns().length > 0) {
        // Turns wait or run (perhaps the one this is called from): the
        // reaction is a server turn on the chat's lane, durable once
        // submitted, and runs when its place comes. Waiting for it here
        // could wait on the caller's own turn.
        await submitTurn(this._chatDeps(), this._chatLane(), {
          trigger: "server"
        });
      } else {
        await this._serverTurn({ trigger: "server" });
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
    await this._agentToolCarry();
    const { runId } = options;
    if (options.signal?.aborted) {
      return {
        runId,
        status: "aborted",
        startedAt: Date.now(),
        error: abortReasonText(options.signal.reason) ?? "cancelled"
      };
    }
    // The run is a server turn on the chat's lane under its own id. It
    // carries the run's input as its body and no client's tools.
    this._agentToolInputs.set(runId, input);
    await startAgentToolTurn(
      this._chatDeps(),
      this._chatLane(),
      runId,
      this.formatAgentToolInput(input, { runId }),
      {
        terminalOnly: options.eventDelivery === "terminal",
        startMessageId: this.messages.at(-1)?.id ?? null,
        body: { agentToolInput: input as never }
      }
    );
    // Marked cancelled in the abort itself; the stop follows.
    options.signal?.addEventListener(
      "abort",
      () =>
        void this._holdForStop(
          cancelAgentToolTurn(
            this._chatDeps(),
            runId,
            abortReasonText(options.signal?.reason) ?? "cancelled"
          ).then(() => {})
        ),
      { once: true }
    );
    return (
      (await this.inspectAgentToolRun(runId)) ?? {
        runId,
        status: "running",
        startedAt: Date.now()
      }
    );
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    await this._agentToolCarry();
    await this._holdForStop(
      cancelAgentToolTurn(
        this._chatDeps(),
        runId,
        abortReasonText(reason) ?? "cancelled"
      ).then(() => {})
    );
  }

  async inspectAgentToolRun(
    runId: string,
    _options?: { reconcile?: boolean }
  ): Promise<AgentToolRunInspection | null> {
    await this._agentToolCarry();
    const deps = this._chatDeps();
    // A released run whose turn is still to be carried: it runs.
    const waiting = releasedAgentToolRunWaiting(
      this.ctx.storage.sql,
      RELEASED_AI_CHAT_AGENT_TOOL_TABLES.runs,
      runId
    );
    if (waiting && !this.tasks.peek(agentToolTurnId(runId))) {
      return { runId, status: "running", startedAt: waiting.startedAt };
    }
    const inspection = inspectAgentToolTurn(deps, runId, () =>
      this._agentToolResult(
        runId,
        agentToolTurnOf(deps, agentToolTurnId(runId))
      )
    );
    // A clear ends the run as the release recorded it: skipped, an error.
    return inspection?.status === "aborted" && inspection.error === CHAT_CLEARED
      ? {
          ...inspection,
          status: "error",
          error: "Agent tool run was skipped because the chat was cleared."
        }
      : inspection;
  }

  /**
   * Run `runId`'s output and summary, from its input message on (a turn
   * that ended while it was queued is not the run's), else from what came
   * after the newest message when it was submitted.
   */
  private _agentToolResult(
    runId: string,
    meta: { startMessageId: string | null; inputMessageId?: string } | undefined
  ): { output: unknown; summary: string | null } {
    const input = this._agentToolInputs.has(runId)
      ? this._agentToolInputs.get(runId)
      : (
          this.tasks.inputOf<ChatTurnInput>(agentToolTurnId(runId))?.body as
            | { agentToolInput?: unknown }
            | undefined
        )?.agentToolInput;
    const inputAt = meta?.inputMessageId
      ? this.messages.findIndex((m) => m.id === meta.inputMessageId)
      : -1;
    const start = meta?.startMessageId
      ? this.messages.findIndex((m) => m.id === meta.startMessageId)
      : -1;
    const messagesAfterStart =
      inputAt >= 0
        ? this.messages.slice(inputAt)
        : this.messages.slice(start + 1);
    let output = this.getAgentToolOutput({ runId, input }, messagesAfterStart);
    // An output JSON cannot hold is kept as its string.
    try {
      JSON.stringify(output);
    } catch {
      output = String(output);
    }
    return {
      output,
      summary:
        this.getAgentToolSummary(
          { runId, input },
          output,
          messagesAfterStart
        ) ?? null
    };
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    await this._agentToolCarry();
    return agentToolTurnChunks(this._chatDeps(), runId, options);
  }

  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    await this._agentToolCarry();
    const tail = await tailAgentToolTurn(this._chatDeps(), runId, options);
    // The stream carries newline-delimited JSON; the RPC boundary types it
    // as the chunks it encodes.
    if (tail) return tail as unknown as ReadableStream<AgentToolStoredChunk>;
    // Returned at once, so the parent's deadlines apply from here: a turn
    // that has not opened its stream is waited for in the first read.
    let inner: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        inner ??= (
          await this._agentToolTailOnceOpen(runId, options)
        ).getReader();
        const next = await inner.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: async (reason) => {
        await inner?.cancel(reason);
      }
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  /**
   * Run `runId`'s tail once its turn has opened its stream (its first frame
   * wakes the wait), or the chunks it has when it ended or was stopped.
   */
  private async _agentToolTailOnceOpen(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<Uint8Array>> {
    const id = agentToolTurnId(runId);
    const open = () => {
      const status = this.tasks.peek(id)?.status;
      return status === "pending" || status === "running";
    };
    if (open() && !options?.signal?.aborted) {
      let wake!: () => void;
      const started = new Promise<void>((resolve) => (wake = resolve));
      const waits = this._agentToolTailWaits.get(id) ?? new Set();
      waits.add(wake);
      this._agentToolTailWaits.set(id, waits);
      const stopped = new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true
        })
      );
      try {
        await Promise.race([
          started,
          this.tasks.wait(id).then(() => {}),
          stopped
        ]);
      } finally {
        waits.delete(wake);
        if (waits.size === 0 && this._agentToolTailWaits.get(id) === waits) {
          this._agentToolTailWaits.delete(id);
        }
      }
      if (!options?.signal?.aborted) {
        const tail = await tailAgentToolTurn(this._chatDeps(), runId, options);
        if (tail) return tail;
      }
    }
    // Not streaming: the chunks there are, then the end.
    const chunks = await this.getAgentToolChunks(runId, options);
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      }
    });
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
    // The messages are worked out once the turns ahead have run, against
    // the transcript as they left it.
    // Queued at once. A function is worked out against the transcript now;
    // the turn carries only the messages the transcript does not hold, and
    // stores them when it starts, after the replies ahead of it.
    if (options?.signal?.aborted) {
      return { requestId: nanoid(), status: "aborted", reason: "stopped" };
    }
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    return this._serverTurn(
      { trigger: "server", messages: resolved },
      { ...(options?.signal && { signal: options.signal }) }
    );
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
    // The chat module decides: no reply to continue, a reply waiting on a
    // client, or a reply that holds nothing (removed, its question
    // answered again).
    const pinned = options as ProgrammaticTurnOptions | undefined;
    const turnBody = body ?? pinned?.body ?? undefined;
    return this._serverTurn(
      {
        trigger: "server",
        mode: "continue",
        ...(turnBody && { body: turnBody })
      },
      {
        ...(options?.signal && { signal: options.signal }),
        storeContext: body !== undefined
      }
    );
  }

  // ── Chat recovery via fibers ──────────────────────────────────────

  /**
   * Context passed to `onChatRecovery` when an interrupted chat stream
   * is detected after DO restart.
   */
  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

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
      broadcast: (frame) => this._frames.broadcast(frame as OutgoingMessage),
      now: Date.now()
    });
  }

  /**
   * A chat turn's fiber row an older version left in the fiber ledger: recover
   * it like a replayed chat-turn Task run. Every other fiber is the app's.
   */
  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    const prefix =
      (this.constructor as typeof AIChatAgent).CHAT_FIBER_NAME + ":";
    if (!ctx.name.startsWith(prefix)) return false;
    await this._recoverChatTurn({
      requestId: ctx.name.slice(prefix.length),
      persisted: ctx.snapshot,
      createdAt: ctx.createdAt
    });
    return true;
  }

  /**
   * Recover a chat turn whose isolate died before it finished. The lifecycle
   * (stream/partial → classify → begin-incident → exhausted-branch →
   * onChatRecovery → persist → complete → dispatch → catch→failed) lives in the
   * shared ChatRecoveryEngine; this binds the divergent organs as wake hooks,
   * symmetric with `Think`. `AIChatAgent` tracks no terminal stream status
   * (`streamStatus: undefined`, so every terminal-stream branch is dead) and
   * has no submission layer, so its dispatch is a leaf-only retry/continue/skip.
   * See design/rfc-chat-recovery-foundation.md.
   *
   * @param turn - `persisted` is the snapshot envelope the turn stored.
   */
  /**
   * A turn a release before the chat module left cut off (its Tasks run or
   * its fiber row, replayed here): carried onto the chat's lane as a turn of
   * its own, under its request id. The app's `onChatRecovery` is asked
   * first, as the release asked it. Replaying it again finds the turn
   * carried and does nothing.
   */
  private async _recoverChatTurn(turn: {
    requestId: string;
    persisted: unknown;
    createdAt: number;
    ended?: { incidentId: string; delivery: number };
    attempt?: (attempt: ChatRecoveryAttemptInput) => boolean;
  }): Promise<void> {
    const { requestId } = turn;
    const key = this._carriedTurnKey(requestId);
    if (await this.tasks.get(key.requestId)) return;
    const { snapshot, user } = unwrapChatFiberSnapshot<"ai-chat-turn">(
      "__cfAIChatFiberSnapshot",
      turn.persisted,
      "ai-chat-turn"
    );
    const body = snapshot?.lastBody ?? this._requestContextNow().body;
    const clientTools =
      snapshot?.lastClientTools ?? this._requestContextNow().clientTools;

    // What the cut-off reply streamed is stored as the reply, as the
    // release stored an orphaned stream.
    const before = await this.#session.getLatestLeaf();
    // A continuation extends a reply that was already stored: only the
    // parts after these are this turn's.
    const earlierParts =
      before?.role === "assistant"
        ? (this.messages.find((message) => message.id === before.id)?.parts
            .length ?? 0)
        : 0;
    const { streamId, streamStillActive } =
      this._resolveAIChatRecoveryStream(requestId);
    if (streamId && streamStillActive) {
      await this._persistOrphanedStream(streamId);
      this._releasedStreams.complete(streamId);
    }
    const leaf = await this.#session.getLatestLeaf();

    const continues = leaf?.role === "assistant";
    const reply = continues
      ? this.messages.find((message) => message.id === leaf.id)
      : undefined;
    // What this turn streamed: the whole reply, or what it added to the
    // reply it continued.
    const streamed = (reply?.parts ?? []).slice(
      leaf?.id === before?.id ? earlierParts : 0
    );
    // What the release recorded about this turn's recovery is not carried:
    // the turn starts on the lane with the budget of a new one.
    await this._forgetReleasedIncidents(requestId);
    let decision: ChatRecoveryOptions | void;
    try {
      decision = await this.onChatRecovery({
        incidentId: requestId,
        recoveryRootRequestId: snapshot?.recoveryRootRequestId ?? requestId,
        attempt: 1,
        maxAttempts: resolveChatRecoveryConfig(this.chatRecovery).maxAttempts,
        recoveryKind: continues ? "continue" : "retry",
        streamId,
        requestId,
        partialText: streamed
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
        partialParts: streamed as MessagePart[],
        recoveryData: user,
        messages: [...this.messages],
        ...(body !== undefined && { lastBody: body }),
        ...(clientTools !== undefined && { lastClientTools: clientTools }),
        createdAt: turn.createdAt
      });
    } catch (error) {
      // The app's hook failed: the turn is not continued, and what was
      // streamed stays stored.
      console.error("[AIChatAgent] onChatRecovery threw", error);
      await this._endUncarriedTurn(requestId, key);
      return;
    }
    // "Do not keep it" drops what this turn streamed, unless that holds a
    // tool's result: the tool ran, so its result stays.
    const droppable =
      decision?.persist === false &&
      leaf !== null &&
      leaf.id !== before?.id &&
      !streamed.some(
        (part) =>
          part.type.startsWith("tool-") &&
          ((part as { state?: string }).state === "output-available" ||
            (part as { state?: string }).state === "output-error")
      );
    // Continue without what was streamed: the question is answered again.
    if (droppable) await this.#session.deleteMessages([leaf.id]);
    // What to do with it, as the release decided: answer its question
    // again while that is still the latest message, continue the latest
    // reply, or nothing when the conversation moved on.
    const plan = planInterruptedTurn(
      { snapshot: snapshot ?? null },
      decision ?? {},
      droppable ? before : leaf
    );
    if (plan.action === "skip") {
      await this._endUncarriedTurn(requestId, key);
      return;
    }

    const context = {
      ...(body !== undefined && { body }),
      ...(clientTools !== undefined &&
        clientTools.length > 0 && { clientTools })
    };
    await submitTurn(
      this._chatDeps(),
      this._chatLane(),
      plan.action === "continue"
        ? { trigger: "server", mode: "continue", ...context }
        : {
            trigger:
              plan.regeneratedLeafId === undefined
                ? "submit-message"
                : "regenerate-message",
            questionId: plan.questionId,
            ...context
          },
      {
        requestId: key.requestId,
        // A carried turn takes its place in the lane: it is not a new
        // message that could skip the ones waiting.
        arrival: "queue",
        // An agent-tool run's turn: its run, kept for its parent.
        ...(key.metadata && { retain: true }),
        metadata: {
          ...key.metadata,
          // The user messages the request came from, so its end names them.
          ...(snapshot?.originMessageIds &&
            snapshot.originMessageIds.length > 0 && {
              chat: {
                ...(key.metadata?.chat as Record<string, TaskJson> | undefined),
                messageIds: snapshot.originMessageIds
              }
            })
        }
      }
    );
    if (key.metadata) await this._carryForwardAgentToolChildRuns();
  }

  /**
   * A recovery an earlier version had scheduled (its Task run, replayed
   * here): the reply it was to continue, or the question it was to answer
   * again, becomes a turn on the chat's lane under the original request id.
   * The version that scheduled it had asked `onChatRecovery` already.
   */
  private async _carryReleasedRecovery(
    kind: "continue" | "retry",
    data: ChatRecoveryContinueData & ChatRecoveryRetryData
  ): Promise<void> {
    // An old payload may not name its request: the turn still runs.
    const requestId = data.originalRequestId ?? nanoid();
    await this._forgetReleasedIncidents(requestId);
    const key = this._carriedTurnKey(requestId);
    if (await this.tasks.get(key.requestId)) return;
    const leaf = await this.#session.getLatestLeaf();
    // Only while the message it was scheduled for is still the latest: a
    // conversation that moved on has nothing of this turn's to finish.
    const target =
      kind === "continue" ? data.targetAssistantId : data.targetUserId;
    if (!leaf || (target !== undefined && leaf.id !== target)) {
      await this._endUncarriedTurn(requestId, key);
      return;
    }
    const body = data.lastBody ?? this._requestContextNow().body;
    const clientTools =
      data.lastClientTools ?? this._requestContextNow().clientTools;
    const context = {
      ...(body !== undefined && body !== null && { body }),
      ...(clientTools !== undefined &&
        clientTools !== null &&
        clientTools.length > 0 && { clientTools })
    };
    await submitTurn(
      this._chatDeps(),
      this._chatLane(),
      kind === "continue"
        ? { trigger: "server", mode: "continue", ...context }
        : { trigger: "submit-message", questionId: leaf.id, ...context },
      {
        requestId: key.requestId,
        arrival: "queue",
        ...(key.metadata && { retain: true }),
        metadata: {
          ...key.metadata,
          ...(data.originMessageIds &&
            data.originMessageIds.length > 0 && {
              chat: {
                ...(key.metadata?.chat as Record<string, TaskJson> | undefined),
                messageIds: data.originMessageIds
              }
            })
        }
      }
    );
    if (key.metadata) await this._carryForwardAgentToolChildRuns();
  }

  /**
   * Drop what an earlier version kept about the recovery of `requestId`:
   * its incident records and the chat's recovering status.
   */
  private async _forgetReleasedIncidents(requestId: string): Promise<void> {
    const incidents = await this.ctx.storage.list<{
      requestId?: string;
      recoveryRootRequestId?: string;
    }>({ prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX });
    const keys = [...incidents]
      .filter(
        ([, incident]) =>
          incident.requestId === requestId ||
          incident.recoveryRootRequestId === requestId
      )
      .map(([key]) => key);
    if (keys.length > 0) await this.ctx.storage.delete(keys);
    // The earlier version may have said the chat is recovering: the turn
    // is an ordinary one from here, and says so itself if it is cut off.
    await this._setChatRecovering(false);
  }

  private _resolveAIChatRecoveryStream(
    requestId: string
  ): ResolvedRecoveryStream {
    let streamId = "";
    if (requestId) {
      streamId =
        this._releasedStreams.latestStreamInfoForRequest(requestId)?.id ?? "";
    }
    if (!streamId && this._releasedStreams.hasActiveStream()) {
      streamId = this._releasedStreams.activeStreamId ?? "";
    }
    const streamStillActive = Boolean(
      streamId &&
      this._releasedStreams.hasActiveStream() &&
      this._releasedStreams.activeStreamId === streamId
    );
    return { streamId, streamStillActive };
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

  /** A continue an earlier version scheduled by name: carried onto the lane. */
  async _chatRecoveryContinue(data?: ChatRecoveryContinueData): Promise<void> {
    if (data) await this._carryReleasedRecovery("continue", data);
  }

  /** A retry an earlier version scheduled by name: carried onto the lane. */
  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    if (data) await this._carryReleasedRecovery("retry", data);
  }

  /**
   * Store `messages` as the transcript and broadcast it to every tab except
   * `excludeBroadcastIds`. A message whose stored copy is the same is not
   * written again. Override it to see or change what is stored; call
   * `super.persistMessages` to write.
   *
   * A persist a turn makes (a client request's messages, the turn's reply)
   * writes nothing once the chat was cleared since the turn started, checked
   * before each write. The check follows the call through an override, and
   * ends when that call returns: a persist started from work the override
   * left running writes as any other call does.
   *
   * Appending a message while a client tool call is waiting on its result
   * (a status note, say) moves the conversation on. When the result
   * arrives it is stored, but the reply is not continued: the next turn
   * reads the result. See `chat:continuation:dropped` with `moved_on`.
   */
  async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    /** @internal */
    options?: { _deleteStaleRows?: boolean }
  ) {
    // Snapshot the pre-write transcript: `this.messages` is mirrored from the
    // change feed and therefore mutates as the writes below land.
    const priorMessages = [...this.messages];
    const { merged: mergedMessages, toWrite } = planPersist(
      messages,
      priorMessages,
      (message) => this._sanitizeMessageForPersistence(message)
    );
    for (const message of toWrite) {
      await this.#session.upsertMessage(message);
    }
    if (options?._deleteStaleRows) {
      await this._deleteMessagesByIds(
        staleMessageIds(mergedMessages, priorMessages, this.messages)
      );
    }
    if (this.maxPersistedMessages != null) {
      await this._deleteMessagesByIds(
        await rowsPastRetention(this.#session, this.maxPersistedMessages)
      );
    }

    this._frames.broadcastMessages(mergedMessages, excludeBroadcastIds);
  }

  private _findLastAssistantMessage(): UIMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        return this.messages[i];
      }
    }

    return undefined;
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
      truncateProviderToolPayloads(part)
    ) as UIMessage["parts"];

    // Run user-overridable hook last
    return this.sanitizeMessageForPersistence({
      ...message,
      parts
    });
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
   * When the DO is destroyed, cancel all pending requests and clean up resources
   */
  async destroy() {
    this._releasedStreams.destroy();
    await super.destroy();
  }
}

/** A provider error that says to try again: a rate limit or a transient failure. */
function isTransientProviderError(error: unknown): boolean {
  const meaning = classifyProviderError(error);
  return meaning === "rate_limit" || meaning === "transient";
}
