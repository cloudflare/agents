import {
  CHAT_REQUEST_CONTEXT_KEY,
  chatTurnStreamId,
  type ChatDeps,
  type ChatLane,
  cancelTurn,
  chatDispatch,
  aiSdkRecoveryCodec,
  type ChatTurnInput
} from "agents/chat";
import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions,
  type SaveMessagesResult
} from "../";
import type {
  UIMessage as ChatMessage,
  GenerateTextOnFinishCallback,
  LanguageModel,
  ToolSet
} from "ai";
import { APICallError, streamText } from "ai";
import {
  Agent,
  type AgentContext,
  getCurrentAgent,
  routeAgentRequest
} from "agents";
import { MessageType, type OutgoingMessage } from "../types";
import type {
  Connection,
  WSMessage,
  AgentToolEventMessage,
  AgentToolLifecycleResult,
  AgentToolRunInfo,
  AgentToolRunInspection,
  AgentToolStoredChunk,
  RunAgentToolResult
} from "agents";
import type {
  ClientToolSchema,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions
} from "../";
import {
  CHAT_RECOVERY_TASK_NAME,
  recentChatTerminal,
  REPLAY_CHUNK_BYTES,
  CHAT_RECOVERY_PROGRESS_KEY,
  type ReplyFlushState,
  type ReplyStreams
} from "agents/chat";

/** The agent's parent side of agent tools (an internal module). */
function agentToolsOf(agent: unknown): unknown {
  return (agent as { _agentTools: unknown })._agentTools;
}

/** The fiber run table of a release before fibers ran on Tasks. */
/**
 * This agent's non-terminal runs holding a scheduled recovery attempt for
 * `callback`, oldest first: a recovery Task run, or a replayed chat-turn run
 * whose `model-turn` step journaled the attempt it runs itself.
 */
/**
 * A point a fixture waits at until the test releases it, so a test can
 * hold a model call or a stream open while it does what it is about.
 */
class TestGate {
  reached = false;
  readonly #released: Promise<void>;
  #release!: () => void;

  constructor() {
    this.#released = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  pass(): Promise<void> {
    this.reached = true;
    return this.#released;
  }

  release(): void {
    this.#release();
  }
}

/**
 * Records the type of each socket message once `agent` has handled it, so
 * a test can wait for the server to have seen one it sent, instead of
 * sleeping. Call from a field initializer: it wraps the handler the agent's
 * constructor installed.
 */
function recordHandledMessages(agent: AIChatAgent): string[] {
  const handled: string[] = [];
  const handle = agent.onMessage;
  agent.onMessage = async (connection: Connection, message: WSMessage) => {
    let frame: { type?: unknown; id?: unknown } | undefined;
    if (typeof message === "string") {
      try {
        frame = JSON.parse(message) as typeof frame;
      } catch {
        // Not JSON: nothing to record.
      }
    }
    if (typeof frame?.id === "string") {
      messageReceivedAt.set(agent, {
        ...messageReceivedAt.get(agent),
        [frame.id]: Date.now()
      });
    }
    await handle.call(agent, connection, message);
    if (typeof frame?.type === "string") handled.push(frame.type);
  };
  return handled;
}

/** When each agent received a socket message, by the message's id. */
const messageReceivedAt = new WeakMap<AIChatAgent, Record<string, number>>();

/** When `agent` received the socket message with id `id`, if it has. */
function messageReceivedAtForTest(
  agent: AIChatAgent,
  id: string
): number | null {
  return messageReceivedAt.get(agent)?.[id] ?? null;
}

type ContinuationStateForTest = {
  /** A continuation is scheduled or running and has not streamed yet. */
  hasPending: boolean;
  /** A next continuation is scheduled behind one that runs. */
  hasNext: boolean;
  activeRequestId: string | null;
  activeConnectionId: string | null;
};

/** What `agent`'s auto-continuation holds: armed, next, running. */
/** AIChatAgent's chat-turn definition name (internal to ai-chat). */
const CHAT_TURN_DEFINITION = "__cf_ai_chat_turn";

/** The test definition that holds a chat's lane. */
const HELD_LANE_DEFINITION = "__cf_test_held_lane";
const heldLaneRegistered = new WeakSet<AIChatAgent>();
const heldLaneGates = new WeakMap<AIChatAgent, Promise<void>>();

function continuationStateForTest(
  agent: AIChatAgent
): ContinuationStateForTest {
  // The chat module's continuation turns: those of the lane that continue a
  // reply, waiting or running.
  const open = (
    agent as unknown as {
      _openChatTurns(): readonly { runId: string; status: string }[];
    }
  )._openChatTurns();
  const continuations = open.filter(
    (run) =>
      agent.tasks.inputOf<ChatTurnInput>(run.runId)?.mode === "continue" ||
      agent.tasks.inputOf<ChatTurnInput>(run.runId)?.trigger === "tool-answer"
  );
  const running = continuations.find((run) => run.status === "running");
  const waiting = continuations.some((run) => run.status === "pending");
  const origin = running
    ? (
        agent.tasks.peek(running.runId)?.metadata as
          | { chat?: { origin?: string } }
          | undefined
      )?.chat?.origin
    : undefined;
  return {
    hasPending: continuations.length > 0,
    hasNext: waiting && running !== undefined,
    activeRequestId: running?.runId ?? null,
    activeConnectionId: origin ?? null
  };
}

/** How many turns `agent`'s queue holds, the running one included. */
function queuedTurnCountForTest(agent: AIChatAgent): number {
  // The chat's lane: its turns and a test run holding it.
  return agent.tasks.peekList({
    definition: [CHAT_TURN_DEFINITION, HELD_LANE_DEFINITION],
    lane: "chat",
    status: ["pending", "running"],
    results: false
  }).length;
}

/** `agent` has no onChatResponse result waiting or being delivered. */
function chatResponseDrainIdleForTest(agent: AIChatAgent): boolean {
  const drain = agent as unknown as {
    _chatResponses: unknown[];
    _insideResponseHook: boolean;
  };
  return drain._chatResponses.length === 0 && !drain._insideResponseHook;
}

/**
 * The open runs that run an attempt of `callback`, oldest first: a run
 * started only for the attempt, a recovery Task run an earlier version
 * enqueued, and a turn's own run that kept the attempt.
 */
function pendingRecoveryRunIds(sql: SqlStorage, callback: string): string[] {
  return sql
    .exec<{ run_id: string }>(
      `SELECT run_id, created_at FROM cf_agents_task_runs
       WHERE definition IN (?, '__cf_internal_chat_turn')
         AND status IN ('pending', 'running')
         AND json_extract(metadata, '$.callback') = ?
       UNION
       SELECT r.run_id, r.created_at FROM cf_agents_task_runs r
       JOIN cf_agents_task_steps s
         ON s.run_id = r.run_id AND s.step_name = 'model-turn'
       WHERE r.status IN ('pending', 'running')
         AND json_extract(s.result, '$.callback') = ?
       ORDER BY created_at ASC`,
      CHAT_RECOVERY_TASK_NAME,
      callback,
      callback
    )
    .toArray()
    .map((row) => row.run_id);
}

function createLegacyFiberTableForTest(storage: DurableObjectStorage): void {
  // As a release before the one schema record left the Agent: its version
  // under its own key, so the start's fiber import is still to run.
  const record = storage.kv.get<Record<string, number>>(
    "cf_agents:schema_versions"
  );
  if (record && " " in record) {
    delete record[" "];
    storage.kv.put("cf_agents:schema_versions", record);
  }
  storage.kv.put("cf_agents:schema_version", 14);
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agents_runs (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, snapshot TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER, outcome TEXT,
      error_message TEXT, recovery_crashes INTEGER NOT NULL DEFAULT 0
    )
  `);
}

// Type helper for tool call parts - extracts from ChatMessage parts
type TestToolCallPart = Extract<
  ChatMessage["parts"][number],
  { type: `tool-${string}` }
>;

/**
 * Leave an interrupted turn the way production leaves one. A chat turn
 * (`CHAT_FIBER_NAME:<requestId>`) is a chat-turn Task run whose closure died
 * with its isolate, plus the snapshot it stored; anything else is a fiber
 * row. A restart replays the run as Tasks does any unfinished run, and
 * {@link recoverInterruptedTurnsForTest} replays it at once.
 */
async function insertInterruptedTurnForTest(
  agent: AIChatAgent,
  storage: DurableObjectStorage,
  name: string,
  snapshot?: unknown,
  /** Keep the snapshot where turns before checkpoints did. */
  legacySnapshot = false
): Promise<void> {
  const prefix = `${AIChatAgent.CHAT_FIBER_NAME}:`;
  if (!name.startsWith(prefix)) {
    createLegacyFiberTableForTest(
      (agent as unknown as { ctx: DurableObjectState }).ctx.storage
    );

    agent.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${`fiber-${crypto.randomUUID()}`}, ${name},
              ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
    return;
  }
  const nonce = crypto.randomUUID();
  const runId = `chat_${nonce}`;
  const requestId = name.slice(prefix.length);
  if (snapshot && legacySnapshot) {
    await storage.put(`__cf_chat_turn_snapshot:${runId}`, snapshot);
  }
  // Make sure the Tasks tables exist before writing a row into them.
  await agent.tasks.get(runId);
  const checkpoint =
    snapshot && !legacySnapshot ? JSON.stringify({ snapshot }) : null;
  const now = Date.now();
  agent.sql`
    INSERT INTO cf_agents_task_runs
      (run_id, definition, input, status, metadata, idempotency_key, retain,
       attempt, next_at, cancel_requested, created_at, updated_at, checkpoint)
    VALUES
      (${runId}, ${AIChatAgent.CHAT_FIBER_NAME},
       ${JSON.stringify({ requestId, continuation: false, nonce })}, 'pending',
       ${JSON.stringify({ requestId })}, NULL, 0, 0, ${now}, 0, ${now}, ${now},
       ${checkpoint})
  `;
}

/**
 * Replay what {@link insertInterruptedTurnForTest} left, as a wake does: each
 * unfinished chat-turn Task run runs again with no live closure, which hands
 * its turn to chat recovery, then the fiber scan recovers fiber rows.
 */
async function recoverInterruptedTurnsForTest(
  agent: AIChatAgent
): Promise<void> {
  const runs = agent.sql<{
    run_id: string;
    input: string;
    metadata: string;
    checkpoint: string | null;
  }>`
    SELECT run_id, input, metadata, checkpoint FROM cf_agents_task_runs
    WHERE definition = ${AIChatAgent.CHAT_FIBER_NAME} AND status = 'pending'
      AND json_extract(metadata, '$.callback') IS NULL
    ORDER BY created_at
  `;
  for (const run of runs) {
    // Accepted again under its id, so this invocation runs it; the
    // checkpoint it had goes back on the new row before the claim reads it.
    agent.sql`DELETE FROM cf_agents_task_runs WHERE run_id = ${run.run_id}`;
    if (run.checkpoint !== null) {
      // The new row gets the checkpoint as it is inserted, before the
      // attempt's claim reads it (a trigger cannot take parameters).
      agent.sql`
        CREATE TABLE IF NOT EXISTS cf_test_checkpoints (
          run_id TEXT PRIMARY KEY, checkpoint TEXT
        )
      `;
      agent.sql`
        INSERT OR REPLACE INTO cf_test_checkpoints VALUES (${run.run_id}, ${run.checkpoint})
      `;
      agent.sql`
        CREATE TRIGGER IF NOT EXISTS cf_test_restore_checkpoint
        AFTER INSERT ON cf_agents_task_runs
        BEGIN
          UPDATE cf_agents_task_runs SET checkpoint = (
            SELECT checkpoint FROM cf_test_checkpoints WHERE run_id = NEW.run_id
          )
          WHERE run_id = NEW.run_id
            AND NEW.run_id IN (SELECT run_id FROM cf_test_checkpoints);
        END
      `;
    }
    await agent.tasks.run(AIChatAgent.CHAT_FIBER_NAME, JSON.parse(run.input), {
      runId: run.run_id,
      retain: false,
      metadata: JSON.parse(run.metadata),
      start: "now"
    });
    agent.sql`DROP TRIGGER IF EXISTS cf_test_restore_checkpoint`;
    agent.sql`DROP TABLE IF EXISTS cf_test_checkpoints`;
  }
  await (
    agent as unknown as { _recoverFibers(): Promise<void> }
  )._recoverFibers();
}

/** The STORED rows, reassembled from their continuation rows. */
async function persistedMessages(agent: AIChatAgent): Promise<ChatMessage[]> {
  const history = await agent.sessions.session().getHistory();
  return history as ChatMessage[];
}

const sessionChangeCounters = new WeakMap<AIChatAgent, { count: number }>();

/**
 * Count of Sessions change-feed events seen by this instance. Arming is lazy
 * and idempotent: the first read subscribes and returns 0.
 */
function sessionChangeEventCount(agent: AIChatAgent): number {
  const existing = sessionChangeCounters.get(agent);
  if (existing) return existing.count;
  const counter = { count: 0 };
  sessionChangeCounters.set(agent, counter);
  agent.sessions.subscribe(() => {
    counter.count++;
  });
  return counter.count;
}

async function persistedMessageCount(agent: AIChatAgent): Promise<number> {
  return (await agent.sessions.session().getHistory()).length;
}

function makeSSEChunkResponse(chunks: ReadonlyArray<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

/**
 * An SSE response that streams a partial assistant turn (start + a text delta)
 * and then HANGS — the stream never closes and never emits another chunk. Used
 * to exercise the `chatStreamStallTimeoutMs` inactivity watchdog (#1626): the
 * gap after the last delta trips the watchdog, which aborts the turn into
 * bounded recovery.
 */
function makeHangingSSEResponse() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of [
        { type: "start" },
        { type: "text-start" },
        { type: "text-delta", delta: "partial before stall" }
      ]) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      // Intentionally never enqueue more or close: a hung provider.
    },
    cancel() {}
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export type FailingReaderPrelude =
  | "partial"
  | "approval"
  | "server-tool"
  | "start-only"
  | "none";

/**
 * An SSE response whose reader throws `errorMessage` after `prelude`, the way
 * a dropped platform connection surfaces mid-stream (#1964).
 */
function makeFailingSSEResponse(
  errorMessage: string,
  prelude: FailingReaderPrelude = "partial",
  responseHeaders?: Record<string, string>,
  statusCode?: number
) {
  const encoder = new TextEncoder();
  const chunks = {
    partial: [
      { type: "start" },
      { type: "text-start" },
      { type: "text-delta", delta: "partial before failure" }
    ],
    approval: [
      { type: "start" },
      {
        type: "tool-input-available",
        toolCallId: "call-approval",
        toolName: "deleteFile",
        input: { path: "notes.txt" }
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "call-approval"
      }
    ],
    // A server tool's call, cut off before its result.
    "server-tool": [
      { type: "start" },
      {
        type: "tool-input-available",
        toolCallId: "call-server",
        toolName: "getWeather",
        input: { city: "Paris" }
      }
    ],
    "start-only": [{ type: "start" }],
    none: []
  }[prelude];
  const stream = new ReadableStream({
    async pull(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      // A provider error carries its response headers (AI SDK
      // `APICallError.responseHeaders`).
      controller.error(
        Object.assign(new Error(errorMessage), {
          ...(responseHeaders && { responseHeaders }),
          // A provider's HTTP error (AI SDK `APICallError.statusCode`).
          ...(statusCode !== undefined && { statusCode })
        })
      );
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

export type Env = {
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
  CustomSanitizeAgent: DurableObjectNamespace<CustomSanitizeAgent>;
  OverridingPersistAgent: DurableObjectNamespace<OverridingPersistAgent>;
  OverridingPersistMergeAgent: DurableObjectNamespace<OverridingPersistMergeAgent>;
  AgentWithSuperCall: DurableObjectNamespace<AgentWithSuperCall>;
  AgentWithoutSuperCall: DurableObjectNamespace<AgentWithoutSuperCall>;
  LogOnlyOnErrorAgent: DurableObjectNamespace<LogOnlyOnErrorAgent>;
  SlowStreamAgent: DurableObjectNamespace<SlowStreamAgent>;
  ResponseAgent: DurableObjectNamespace<ResponseAgent>;
  ResponseContinuationAgent: DurableObjectNamespace<ResponseContinuationAgent>;
  ResponseThrowingAgent: DurableObjectNamespace<ResponseThrowingAgent>;
  ResponseSaveMessagesAgent: DurableObjectNamespace<ResponseSaveMessagesAgent>;
  LatestMessageConcurrencyAgent: DurableObjectNamespace<LatestMessageConcurrencyAgent>;
  MergeMessageConcurrencyAgent: DurableObjectNamespace<MergeMessageConcurrencyAgent>;
  DropMessageConcurrencyAgent: DurableObjectNamespace<DropMessageConcurrencyAgent>;
  DebounceMessageConcurrencyAgent: DurableObjectNamespace<DebounceMessageConcurrencyAgent>;
  InvalidDebounceMessageConcurrencyAgent: DurableObjectNamespace<InvalidDebounceMessageConcurrencyAgent>;
  MissingDebounceMessageConcurrencyAgent: DurableObjectNamespace<MissingDebounceMessageConcurrencyAgent>;
  WaitMcpTrueAgent: DurableObjectNamespace<WaitMcpTrueAgent>;
  WaitMcpTimeoutAgent: DurableObjectNamespace<WaitMcpTimeoutAgent>;
  WaitMcpFalseAgent: DurableObjectNamespace<WaitMcpFalseAgent>;
  ChatRecoveryTestAgent: DurableObjectNamespace<ChatRecoveryTestAgent>;
  NonChatRecoveryTestAgent: DurableObjectNamespace<NonChatRecoveryTestAgent>;
  RecoveryThrowingAgent: DurableObjectNamespace<RecoveryThrowingAgent>;
  RecoverySlowStreamAgent: DurableObjectNamespace<RecoverySlowStreamAgent>;
  AsyncStartAdmissionAgent: DurableObjectNamespace<AsyncStartAdmissionAgent>;
  OnStartTurnAgent: DurableObjectNamespace<OnStartTurnAgent>;
  AIChatAgentToolParent: DurableObjectNamespace<AIChatAgentToolParent>;
  AIChatAgentToolChild: DurableObjectNamespace<AIChatAgentToolChild>;
  StuckAgentToolChild: DurableObjectNamespace<StuckAgentToolChild>;
};

/**
 * Store a chunk the way a reply does (`ReplyStreams.store`), with one flush
 * state per stream, for tests that write a stream by hand.
 */
const testFlushStates = new Map<string, ReplyFlushState>();
function storeStreamChunk(
  agent: AIChatAgent<Env>,
  streamId: string,
  body: string
): number | undefined {
  const streams = (agent as unknown as { _releasedStreams: ReplyStreams })
    ._releasedStreams;
  let state = testFlushStates.get(streamId);
  if (!state) {
    state = { chunksSinceFlush: 0, hasFlushedContent: false };
    testFlushStates.set(streamId, state);
  }
  let chunk: { type: string };
  try {
    chunk = JSON.parse(body) as { type: string };
  } catch {
    chunk = { type: "" };
  }
  return streams.store(streamId, chunk, body, state);
}

function storeTurnStreamChunk(
  agent: AIChatAgent<Env>,
  streamId: string,
  body: string
): number | undefined {
  // The chat module's stream of the turn (the seam's agent tools read it).
  const sync = agent.streams.__DO_NOT_USE_WILL_BREAK__sync();
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > sync.maxChunkBytes) return undefined;
  return sync.appendJson(streamId, body, bytes, {
    maxChunks: 10,
    maxBytes: 512 * 1024
  });
}

/** Open the chat module's stream for turn `requestId`, as a turn does. */
function startTurnStreamForTest(
  agent: AIChatAgent<Env>,
  requestId: string
): string {
  const sync = agent.streams.__DO_NOT_USE_WILL_BREAK__sync();
  sync.ensureTables();
  const id = chatTurnStreamId(requestId);
  if (!sync.getStream(id)) sync.insertStream(id, requestId, undefined);
  return id;
}

/**
 * Run a parent's awaited agent-tool runs' checks until each has settled:
 * a re-attached run asks its child again on its next check, made due here
 * instead of waiting for its wake. Paced, so the re-attach budgets (real
 * time) still pass.
 */
async function runAgentToolChecksForTest(agent: unknown): Promise<void> {
  const self = agent as {
    tasks: {
      runDue(definition: string): Promise<unknown>;
      peekList(options: {
        definition: string;
        status: string[];
      }): Array<{ runId: string }>;
      wait(runId: string): Promise<unknown>;
    };
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await self.tasks.runDue("__cf_agent_tool");
    const open = self.tasks.peekList({
      definition: "__cf_agent_tool",
      status: ["pending", "running"]
    });
    if (open.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
    self.sql`
      UPDATE cf_agents_task_runs SET next_at = ${Date.now() - 1}
      WHERE definition = '__cf_agent_tool' AND status = 'pending'
    `;
  }
}

/**
 * The `cf_agent_tool_runs` table a released version kept, for tests that
 * seed its rows; the next start carries them into Task runs.
 */
function ensureReleasedAgentToolTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS cf_agent_tool_runs (
      run_id TEXT PRIMARY KEY, parent_tool_call_id TEXT,
      agent_type TEXT NOT NULL, input_preview TEXT,
      input_redacted INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
      summary TEXT, output_json TEXT, error_message TEXT,
      interrupted_reason TEXT, child_still_running INTEGER,
      display_metadata TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, completed_at INTEGER,
      detached INTEGER NOT NULL DEFAULT 0, detached_on_finish TEXT,
      detached_notify_source TEXT, detached_max_budget_at INTEGER,
      finish_claimed_at INTEGER, finish_delivered_at INTEGER,
      give_up_claimed_at INTEGER, give_up_delivered_at INTEGER,
      detached_no_progress_budget_ms INTEGER, last_progress_at INTEGER,
      detached_on_milestones TEXT, event_delivery TEXT
    )
  `);
}

export class TestChatAgent extends AIChatAgent<Env> {
  /**
   * Stand in for a child restarted mid-run (#2298): a persisted in-flight
   * agent-tool run with empty in-memory state, rebound to a recovery turn's
   * request id, whose chunk is then broadcast.
   */
  broadcastRecoveredAgentToolChunkForTest(
    eventDelivery: "full" | "terminal"
  ): void {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, started_at, event_delivery)
      values (${crypto.randomUUID()}, 'pre-restart', 'running', ${Date.now()},
        ${eventDelivery === "terminal" ? "terminal" : null})
    `;
    this["_agentToolRuns"].rebind("recovered-request", "pre-restart");
    this.broadcast(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: "recovered-request",
        body: JSON.stringify({ type: "text-delta", id: "t", delta: "hi" }),
        done: false
      })
    );
  }
  /** Messages the chat protocol left to the app's `onMessage`. */
  private _forwardedMessages: string[] = [];

  override onMessage(_connection: Connection, message: WSMessage): void {
    if (typeof message === "string") this._forwardedMessages.push(message);
  }

  forwardedMessagesForTest(): string[] {
    return this._forwardedMessages;
  }

  // Store captured context for testing
  private _capturedContext: {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null = null;
  // Store context captured from nested async function (simulates tool execute)
  private _nestedContext: {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null = null;
  // Store captured body from onChatMessage options for testing
  private _capturedBody: Record<string, unknown> | undefined = undefined;
  // Store captured clientTools from onChatMessage options for testing
  private _capturedClientTools: ClientToolSchema[] | undefined = undefined;
  // Store captured requestId from onChatMessage options for testing
  private _capturedRequestId: string | undefined = undefined;
  private _chatMessageCallCount = 0;
  private _failedFirstContinuation = false;
  private _releaseHeldTurnQueue: (() => void) | null = null;

  private _fallbackOnFailedContinuation = false;
  private _handlingResponse = false;
  private _reentrantResponseHooks = 0;
  private _responseStatuses: string[] = [];

  /**
   * Make `onChatResponse` answer a failed continuation with a fallback
   * message through `saveMessages`, the way an app would.
   */
  setFallbackOnFailedContinuationForTest(value: boolean): void {
    this._fallbackOnFailedContinuation = value;
  }

  responseHookReportForTest(): { statuses: string[]; reentrant: number } {
    return {
      statuses: this._responseStatuses,
      reentrant: this._reentrantResponseHooks
    };
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    if (this._handlingResponse) this._reentrantResponseHooks++;
    this._handlingResponse = true;
    try {
      this._responseStatuses.push(
        `${result.continuation ? "continuation" : "turn"}:${result.status}`
      );
      if (
        this._fallbackOnFailedContinuation &&
        result.continuation &&
        result.status === "error"
      ) {
        this._fallbackOnFailedContinuation = false;
        await this.setTestBody({});
        await this.saveMessages([
          ...this.messages,
          {
            id: "fallback-question",
            role: "user",
            parts: [{ type: "text", text: "Try again without the tool" }]
          }
        ]);
      }
    } finally {
      this._handlingResponse = false;
    }
  }

  private readonly _handledMessageTypes = recordHandledMessages(this);

  /** How many socket messages of `type` the agent has handled. */
  handledMessageCountForTest(type: string): number {
    return this._handledMessageTypes.filter((handled) => handled === type)
      .length;
  }

  /** When the agent received the socket message with this id. */
  receivedAtForTest(id: string): number | null {
    return messageReceivedAtForTest(this, id);
  }

  /** How many turns the queue holds, the running one included. */
  queuedTurnCountForTest(): number {
    return queuedTurnCountForTest(this);
  }

  /** Holds the next model call (inside onChatMessage) until released. */
  private _modelGate: TestGate | null = null;

  holdNextModelCallForTest(): void {
    this._modelGate = new TestGate();
  }

  isModelCallHeldForTest(): boolean {
    return this._modelGate?.reached ?? false;
  }

  releaseModelCallForTest(): void {
    this._modelGate?.release();
    this._modelGate = null;
  }

  /** Put a turn that does nothing at the front of the queue until released. */
  /**
   * Hold the chat's lane with a run of a test definition, so the turns that
   * arrive wait behind it until {@link releaseTurnQueueForTest}.
   */
  async holdTurnQueueForTest(): Promise<void> {
    const held = new Promise<void>((resolve) => {
      this._releaseHeldTurnQueue = resolve;
    });
    if (!heldLaneRegistered.has(this)) {
      heldLaneRegistered.add(this);
      this.tasks.register(HELD_LANE_DEFINITION, async () => {
        await heldLaneGates.get(this);
        return null;
      });
    }
    heldLaneGates.set(this, held);
    await this.tasks.run(HELD_LANE_DEFINITION, null, { lane: "chat" });
  }

  releaseTurnQueueForTest(): void {
    this._releaseHeldTurnQueue?.();
    this._releaseHeldTurnQueue = null;
  }

  /** The continuation whose stream comes next: running, else waiting. */
  pendingContinuationRequestIdForTest(): string | null {
    const state = continuationStateForTest(this);
    if (state.activeRequestId !== null) return state.activeRequestId;
    return (
      this._openChatTurnsForTest().find((run) => {
        const input = this.tasks.inputOf<ChatTurnInput>(run.runId);
        return input?.mode === "continue" || input?.trigger === "tool-answer";
      })?.runId ?? null
    );
  }

  private _openChatTurnsForTest(): readonly {
    runId: string;
    status: string;
  }[] {
    return (
      this as unknown as {
        _openChatTurns(): readonly { runId: string; status: string }[];
      }
    )._openChatTurns();
  }

  private _persistDelayForTest: {
    role: "user" | "assistant";
    ms: number;
  } | null = null;

  /**
   * Make `persistMessages` wait before it writes when the last message has
   * `role`, the way an app's override that awaits before `super` does.
   */
  setPersistDelayForTest(role: "user" | "assistant", ms: number): void {
    this._persistDelayForTest = { role, ms };
  }

  /** Holds the next `persistMessages` of a `role` message until released. */
  private _persistHold: { role: "user" | "assistant"; gate: TestGate } | null =
    null;

  holdPersistForTest(role: "user" | "assistant"): void {
    this._persistHold = { role, gate: new TestGate() };
  }

  isPersistHeldForTest(): boolean {
    return this._persistHold?.gate.reached ?? false;
  }

  releasePersistForTest(): void {
    this._persistHold?.gate.release();
    this._persistHold = null;
  }

  /** `saveMessages` with one more user message; returns the status. */
  async saveUserMessageForTest(text: string): Promise<string> {
    const result = await this.saveMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
    return result.status;
  }

  private _laterNoteForTest: TestGate | null = null;

  /**
   * Make the next `persistMessages` of a user message start work that
   * stores a note once the test calls `storeLaterNoteForTest`, the way an
   * override's fire-and-forget does.
   */
  storeNoteLaterFromPersistForTest(): void {
    this._laterNoteForTest = new TestGate();
  }

  storeLaterNoteForTest(): void {
    this._laterNoteForTest?.release();
  }

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    const later = this._laterNoteForTest;
    if (later && !later.reached && messages.at(-1)?.role === "user") {
      void later.pass().then(() =>
        this.persistMessages([
          ...this.messages,
          {
            id: "note-later",
            role: "assistant",
            parts: [{ type: "text", text: "Stored later." }]
          }
        ])
      );
    }
    const wait = this._persistDelayForTest;
    if (wait && messages.at(-1)?.role === wait.role) {
      await new Promise((resolve) => setTimeout(resolve, wait.ms));
    }
    const hold = this._persistHold;
    if (hold && !hold.gate.reached && messages.at(-1)?.role === hold.role) {
      await hold.gate.pass();
    }
    return super.persistMessages(messages, excludeBroadcastIds, options);
  }

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    this._chatMessageCallCount++;
    // What the model request would hold: tool calls with no result.
    this._unansweredAtModelCall = this.messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        const record = part as { toolCallId?: string; state?: string };
        return record.toolCallId &&
          (record.state === "input-available" ||
            record.state === "approval-requested")
          ? [record.toolCallId]
          : [];
      })
    );
    // Assistant messages the model request would end a turn of in reasoning.
    this._endsInReasoningAtModelCall = this.messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.parts.at(-1)?.type === "reasoning"
      )
      .map((message) => message.id);
    // Capture the body, clientTools, and requestId from options for testing
    this._capturedBody = options?.body;
    this._capturedClientTools = options?.clientTools;
    this._capturedRequestId = options?.requestId;

    // Capture getCurrentAgent() context for testing
    const { agent, connection } = getCurrentAgent();
    this._capturedContext = {
      hasAgent: agent !== undefined,
      hasConnection: connection !== undefined,
      connectionId: connection?.id
    };

    // Simulate what happens inside a tool's execute function:
    // It's a nested async function called from within onChatMessage
    await this._simulateToolExecute();

    const delayMs =
      typeof options?.body?.delayMs === "number" ? options.body.delayMs : 0;

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const modelGate = this._modelGate;
    if (modelGate && !modelGate.reached) await modelGate.pass();

    // Every continuation fails before it produces a response.
    if (
      options?.continuation === true &&
      options.body?.failContinuations === true
    ) {
      throw new Error("The model is unavailable");
    }

    // The first continuation fails before it produces a response.
    if (
      options?.continuation === true &&
      options.body?.failFirstContinuation === true &&
      !this._failedFirstContinuation
    ) {
      this._failedFirstContinuation = true;
      throw new Error("The model is unavailable");
    }

    const chainedContinuationResponse =
      this._getChainedContinuationRegressionResponse();
    if (chainedContinuationResponse) {
      return chainedContinuationResponse;
    }

    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");

    if (
      options?.body?.emptyContinuationResponse === true &&
      lastAssistant?.parts.some(
        (part) =>
          part.type.startsWith("tool-") &&
          "state" in part &&
          part.state === "output-available"
      )
    ) {
      return new Response(null);
    }

    // A turn that ends on a client tool call. The continuation that answers
    // its result falls through to the plain reply.
    if (options?.body?.clientToolCall === true && !options.continuation) {
      return makeSSEChunkResponse([
        { type: "start" },
        {
          type: "tool-input-available",
          toolCallId: "call-turn",
          toolName: "testTool",
          input: {}
        },
        { type: "finish" }
      ]);
    }

    // A server tool starts running and its stream never finishes: only a
    // stop, a stall or an eviction ends it.
    if (options?.body?.serverToolThenHang === true) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of [
              { type: "start" },
              {
                type: "tool-input-available",
                toolCallId: "call-server-hang",
                toolName: "slowServerTool",
                input: {}
              }
            ]) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }
          },
          cancel() {}
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    // The reply writes text, then the model's reasoning, and never
    // finishes: only a stop, a stall or an eviction ends it.
    if (options?.body?.reasoningThenHang === true) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            // `hangIn` picks where the reply hangs: in its reasoning with
            // no text before it, or in the middle of its text.
            const hangIn = options?.body?.hangIn;
            const text = [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Partial answer" }
            ];
            const reasoning = [
              { type: "reasoning-start", id: "r" },
              { type: "reasoning-delta", id: "r", delta: "Let me think" },
              { type: "reasoning-end", id: "r" }
            ];
            for (const chunk of [
              { type: "start" },
              { type: "start-step" },
              ...(hangIn === "reasoning"
                ? reasoning
                : hangIn === "text"
                  ? text
                  : [...text, { type: "text-end", id: "t" }, ...reasoning])
            ]) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
              );
            }
          },
          cancel() {}
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    if (options?.body?.sseWithMessageId === true) {
      return makeSSEChunkResponse([
        { type: "start", messageId: `fresh-msg-${Date.now()}` },
        { type: "text-start", id: "sse-t" },
        { type: "text-delta", id: "sse-t", delta: "SSE reply" },
        { type: "text-end", id: "sse-t" },
        { type: "finish" }
      ]);
    }

    // A custom stream that emits the approval request before the canonical
    // tool input, with no input deltas (#1872).
    if (options?.body?.lateToolInput === true) {
      return makeSSEChunkResponse([
        { type: "start" },
        {
          type: "tool-input-start",
          toolCallId: "call-late-input",
          toolName: "deleteFile"
        },
        {
          type: "tool-approval-request",
          toolCallId: "call-late-input",
          approvalId: "approval-late-input"
        },
        {
          type: "tool-input-available",
          toolCallId: "call-late-input",
          toolName: "deleteFile",
          input: { path: "notes.txt" }
        },
        { type: "finish" }
      ]);
    }

    // Mirrors the common provider (e.g. Workers AI) that emits a `start`
    // chunk WITHOUT a messageId, so the server must stamp its allocated id.
    if (options?.body?.sseWithoutMessageId === true) {
      return makeSSEChunkResponse([
        { type: "start" },
        { type: "text-start", id: "sse-t" },
        { type: "text-delta", id: "sse-t", delta: "SSE reply" },
        { type: "text-end", id: "sse-t" },
        { type: "finish" }
      ]);
    }

    const continuationStreamError = options?.body?.continuationStreamError;
    if (options?.continuation && typeof continuationStreamError === "string") {
      const delayMs =
        typeof options.body?.continuationStreamErrorDelayMs === "number"
          ? options.body.continuationStreamErrorDelayMs
          : 25;
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "error", errorText: continuationStreamError }
        ],
        delayMs,
        options.abortSignal
      );
    }

    if (
      options?.continuation === true &&
      options.body?.reasoningContinuation === true
    ) {
      const chunks = [
        { type: "start" },
        { type: "reasoning-start", id: "reasoning_issue_1480" },
        {
          type: "reasoning-delta",
          id: "reasoning_issue_1480",
          delta: "continuation reasoning"
        },
        { type: "reasoning-end", id: "reasoning_issue_1480" },
        { type: "text-start", id: "text_issue_1480" },
        {
          type: "text-delta",
          id: "text_issue_1480",
          delta: "continuation answer"
        },
        { type: "text-end", id: "text_issue_1480" },
        { type: "finish" }
      ];

      if (options.body.delayContinuationChunks === true) {
        return makeDelayedSSEChunkResponse(chunks, 100);
      }

      return makeSSEChunkResponse(chunks);
    }

    // A hand-written stream that carries a client tool call and the answer
    // in one step: no `start-step` between them, finish reason `stop`.
    if (
      options?.body?.answerInSameStepAsToolCall === true &&
      !options.continuation
    ) {
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          {
            type: "tool-input-available",
            toolCallId: "call_same_step",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "text-start", id: "text_same_step" },
          {
            type: "text-delta",
            id: "text_same_step",
            delta: "Here is the answer."
          },
          { type: "text-end", id: "text_same_step" },
          { type: "finish", finishReason: "stop" }
        ],
        75,
        options.abortSignal
      );
    }

    // Reproduce a client-tool result that round-trips while the original
    // multi-step stream is still active, followed by a final assistant step and
    // a normal stop. A second auto-continuation would be stale.
    if (options?.body?.consumeClientToolResultWithinStream === true) {
      if (options.continuation) {
        return new Response("Unexpected stale continuation");
      }
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call_consumed_within_stream",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "finish-step" },
          { type: "start-step" },
          { type: "text-start", id: "text_after_client_tool" },
          {
            type: "text-delta",
            id: "text_after_client_tool",
            delta: "The tool result was handled."
          },
          { type: "text-end", id: "text_after_client_tool" },
          { type: "finish-step" },
          { type: "finish", finishReason: "stop" }
        ],
        75,
        options.abortSignal
      );
    }

    // A stop with a sibling tool call still unanswered: the continuation opted
    // into by the first result must survive until the sibling answers.
    if (options?.body?.stopWithPendingSibling === true) {
      if (options.continuation) {
        return makeSSEChunkResponse([
          { type: "start" },
          { type: "start-step" },
          { type: "text-start", id: "text_after_batch" },
          { type: "text-delta", id: "text_after_batch", delta: "Both done." },
          { type: "text-end", id: "text_after_batch" },
          { type: "finish-step" },
          { type: "finish", finishReason: "stop" }
        ]);
      }
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call_sibling_a",
            toolName: "fastClientTool",
            input: {}
          },
          {
            type: "tool-input-available",
            toolCallId: "call_sibling_b",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "text-start", id: "text_with_pending_sibling" },
          {
            type: "text-delta",
            id: "text_with_pending_sibling",
            delta: "Waiting on the tools."
          },
          { type: "text-end", id: "text_with_pending_sibling" },
          { type: "finish-step" },
          { type: "finish", finishReason: "stop" }
        ],
        75,
        options.abortSignal
      );
    }

    // Companion control: when the stream stops at the tool call, the result has
    // not yet been consumed and stream finalization must still re-arm it.
    if (options?.body?.finishWithUnconsumedClientTool === true) {
      if (options.continuation) {
        return new Response("Expected tool continuation");
      }
      return makeDelayedSSEChunkResponse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "call_unconsumed_at_stream_end",
            toolName: "fastClientTool",
            input: {}
          },
          { type: "finish-step" },
          { type: "finish", finishReason: "tool-calls" }
        ],
        75,
        options.abortSignal
      );
    }

    // Issue #1404: simulate the OpenAI Responses API "provider replay"
    // pattern. When asked to continue after a tool result, some providers
    // re-emit the prior tool call (start + delta + available) plus the
    // result that was just supplied. Without the issue #1404 fix this
    // would visibly regress the AI SDK's tool part state on the client.
    if (
      options?.body?.replayPriorToolCall === true &&
      lastAssistant?.parts.some(
        (part) =>
          "toolCallId" in part &&
          part.toolCallId === options.body?.replayToolCallId &&
          "state" in part &&
          part.state === "output-available"
      )
    ) {
      const toolCallId = options.body.replayToolCallId as string;
      const toolName = options.body.replayToolName as string;
      const replayInput = options.body.replayInput;
      const replayOutput = options.body.replayOutput;
      return makeSSEChunkResponse([
        { type: "start" },
        { type: "start-step" },
        { type: "tool-input-start", toolCallId, toolName },
        { type: "tool-input-delta", toolCallId, input: {} },
        {
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: replayInput
        },
        { type: "tool-output-available", toolCallId, output: replayOutput },
        { type: "finish-step" },
        { type: "finish", finishReason: "tool-calls" }
      ]);
    }

    // Simple echo response for testing
    return new Response("Hello from chat agent!", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  // Test helper: apply a tool result the way the tool-result handler does,
  // with no auto-continuation, so tests can exercise the idempotency branch
  // (issue #1404).
  async testApplyToolResult(
    toolCallId: string,
    toolName: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<boolean> {
    void toolName;
    // The chat module's tool answer, as a tab sends it, with no
    // continuation. It applied when it changed the stored transcript.
    const deps = (this as unknown as { _chatDeps(): ChatDeps })._chatDeps();
    const lane = (this as unknown as { _chatLane(): ChatLane })._chatLane();
    const before = JSON.stringify(await this.sessions.session().getHistory());
    await chatDispatch(
      deps,
      lane,
      { id: "test-tool-result", send: () => {} } as unknown as Connection,
      JSON.stringify({
        type: MessageType.CF_AGENT_TOOL_RESULT,
        toolCallId,
        toolName,
        output,
        ...(overrideState && { state: overrideState }),
        ...(errorText !== undefined && { errorText }),
        autoContinue: false
      })
    );
    return (
      JSON.stringify(await this.sessions.session().getHistory()) !== before
    );
  }

  private _getChainedContinuationRegressionResponse(): Response | undefined {
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");

    if (!lastAssistant) {
      return undefined;
    }

    const readWorkflowPart = this._findToolPart(
      lastAssistant,
      "call_read_workflow_regression"
    );
    const editWorkflowPart = this._findToolPart(
      lastAssistant,
      "call_edit_workflow_regression"
    );

    if (
      readWorkflowPart?.state === "output-available" &&
      editWorkflowPart === undefined
    ) {
      return makeSSEChunkResponse([
        { type: "start-step" },
        { type: "text-start", id: "txt-approval-step" },
        {
          type: "text-delta",
          id: "txt-approval-step",
          delta: "Reviewing workflow edits now."
        },
        { type: "text-end", id: "txt-approval-step" },
        {
          type: "tool-input-available",
          toolCallId: "call_edit_workflow_regression",
          toolName: "editWorkflow",
          input: { patch: "set retries=3" }
        },
        {
          type: "tool-approval-request",
          toolCallId: "call_edit_workflow_regression",
          approvalId: "approval_edit_workflow_regression"
        }
      ]);
    }

    if (editWorkflowPart?.state === "approval-responded") {
      return makeSSEChunkResponse([
        { type: "start-step" },
        {
          type: "tool-output-available",
          toolCallId: "call_edit_workflow_regression",
          output: { applied: true }
        },
        { type: "text-start", id: "txt-final-step" },
        {
          type: "text-delta",
          id: "txt-final-step",
          delta: "Workflow edit approved and applied."
        },
        { type: "text-end", id: "txt-final-step" }
      ]);
    }

    return undefined;
  }

  private _findToolPart(
    message: ChatMessage,
    toolCallId: string
  ): TestToolCallPart | undefined {
    return message.parts.find(
      (part): part is TestToolCallPart =>
        "toolCallId" in part && part.toolCallId === toolCallId
    );
  }

  // This simulates an AI SDK tool's execute function being called
  private async _simulateToolExecute(): Promise<void> {
    // Add a small delay to ensure we're in a new microtask (like real tool execution)
    await Promise.resolve();

    // Capture context inside the "tool execute" function
    const { agent, connection } = getCurrentAgent();
    this._nestedContext = {
      hasAgent: agent !== undefined,
      hasConnection: connection !== undefined,
      connectionId: connection?.id
    };
  }

  getCapturedContext(): {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null {
    return this._capturedContext;
  }

  getNestedContext(): {
    hasAgent: boolean;
    hasConnection: boolean;
    connectionId: string | undefined;
  } | null {
    return this._nestedContext;
  }

  clearCapturedContext(): void {
    this._capturedContext = null;
    this._nestedContext = null;
    this._capturedBody = undefined;
    this._capturedClientTools = undefined;
    this._capturedRequestId = undefined;
  }

  getCapturedBody(): Record<string, unknown> | undefined {
    return this._capturedBody;
  }

  getCapturedClientTools(): ClientToolSchema[] | undefined {
    return this._capturedClientTools;
  }

  getCapturedRequestId(): string | undefined {
    return this._capturedRequestId;
  }

  waitUntilStableForTest(options?: { timeout?: number }): Promise<boolean> {
    return this.waitUntilStable(options);
  }

  async setTestBody(body: Record<string, unknown>): Promise<void> {
    // The chat module's request context: what a server turn runs with.
    await this.sessions
      .session()
      .internal_setConfig(CHAT_REQUEST_CONTEXT_KEY, JSON.stringify({ body }));
  }

  resetTurnStateForTest(): void {
    this.resetTurnState();
  }

  isChatTurnActiveForTest(): boolean {
    return this._openChatTurns().some((run) => run.status === "running");
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  getChatMessageCallCountForTest(): number {
    return this._chatMessageCallCount;
  }

  abortAllRequestsForTest(): void {
    this.abortAllRequests();
  }

  private _unansweredAtModelCall: string[] = [];

  private _endsInReasoningAtModelCall: string[] = [];

  /** Assistant messages that ended in reasoning when the model was called. */
  getEndsInReasoningAtModelCallForTest(): string[] {
    return this._endsInReasoningAtModelCall;
  }

  /** The client tools stored for later turns. */
  getStoredClientToolsForTest(): ClientToolSchema[] | undefined {
    return this._lastClientTools;
  }

  /** Store client tools as a request that sent them would. */
  async setClientToolsForTest(clientTools: ClientToolSchema[]): Promise<void> {
    await this._setRequestContext({ body: this._lastBody, clientTools });
  }

  /** Tool calls with no result in the transcript the last turn's model saw. */
  getUnansweredAtModelCallForTest(): string[] {
    return this._unansweredAtModelCall;
  }

  hasPendingInteractionForTest(): boolean {
    return this.hasPendingInteraction();
  }

  getContinuationStateForTest(): ContinuationStateForTest {
    return continuationStateForTest(this);
  }

  /** How turn `requestId` ended, as the chat recorded its end frame. */
  getTurnOutcomeForTest(requestId: string): string | null {
    return (
      recentChatTerminal(this.ctx.storage.kv, [requestId])?.outcome ?? null
    );
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  async getMessagesForTest(): Promise<ChatMessage[]> {
    // `this.messages` hydrates in `onStart`; native RPC bypasses fetch, so a
    // freshly woken object has to start the lifecycle before reading it.
    await this.__unsafe_ensureInitialized();
    return this.messages as ChatMessage[];
  }

  /**
   * Count of Sessions change-feed events. An unchanged row writes nothing and
   * dispatches no event, so this is the observable no-op signal.
   */
  sessionChangeEventCountForTest(): number {
    return sessionChangeEventCount(this);
  }

  /** Continuation rows the store currently holds for this object. */
  continuationRowCountForTest(): number {
    return Number(
      this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS count FROM cf_agents_session_message_chunks")
        .one().count
    );
  }

  async clearSessionForTest(): Promise<void> {
    await this.sessions.session().clearMessages();
    this.messages = [];
  }

  seedLegacyMessagesForTest(): void {
    this.sql`
      CREATE TABLE cf_ai_chat_agent_messages (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.sql`
      INSERT INTO cf_ai_chat_agent_messages (id, message, created_at)
      VALUES (
        'legacy-v4',
        ${JSON.stringify({ id: "legacy-v4", role: "user", content: "old format" })},
        '2026-01-01 00:00:00'
      )
    `;
    this.sql`
      INSERT INTO cf_ai_chat_agent_messages (id, message, created_at)
      VALUES (
        'legacy-v5',
        ${JSON.stringify({ id: "legacy-v5", role: "assistant", parts: [{ type: "text", text: "new format" }] })},
        '2026-01-01 00:00:01'
      )
    `;
  }

  legacyMessageTableNamesForTest(): string[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'cf_ai_chat_agent_messages%'
         ORDER BY name`
      )
      .toArray()
      .map((row) => String(row.name));
  }

  /**
   * Drive the `detached: { notify }` completion hook directly (the warm-path /
   * backbone delivery is exercised elsewhere). Called `times` times to prove the
   * deterministic message id collapses re-delivery to a single injected turn.
   */
  async notifyDetachedFinishForTest(options?: {
    runId?: string;
    notifySource?: string;
    status?: AgentToolLifecycleResult["status"];
    times?: number;
  }): Promise<void> {
    const runId = options?.runId ?? "detached-notify-run";
    const status = options?.status ?? "completed";
    const internals = this as unknown as {
      _cfDetachedNotifyFinish(
        run: AgentToolRunInfo,
        result: AgentToolLifecycleResult
      ): Promise<void>;
    };
    for (let i = 0; i < (options?.times ?? 1); i++) {
      await internals._cfDetachedNotifyFinish(
        {
          runId,
          agentType: "Researcher",
          status,
          inputPreview: "detached topic",
          displayOrder: 0,
          startedAt: Date.now(),
          ...(options?.notifySource !== undefined && {
            notifySource: options.notifySource
          })
        },
        { status, summary: "detached summary" }
      );
    }
  }

  /**
   * Drive the `detached: { onMilestones }` hook directly. Called `times` times to
   * prove the deterministic message id collapses warm-path + reconcile delivery
   * to a single injected message.
   */
  async notifyDetachedMilestoneForTest(options?: {
    runId?: string;
    name?: string;
    notifySource?: string;
    times?: number;
    mode?: "react" | "narrate";
  }): Promise<void> {
    const runId = options?.runId ?? "detached-milestone-run";
    const name = options?.name ?? "sources-gathered";
    const mode = options?.mode ?? "narrate";
    const internals = this as unknown as {
      _deliverDetachedMilestone(
        run: AgentToolRunInfo,
        milestone: {
          name: string;
          sequence: number;
          at: number;
          data?: unknown;
        },
        mode: "react" | "narrate"
      ): Promise<void>;
    };
    for (let i = 0; i < (options?.times ?? 2); i++) {
      await internals._deliverDetachedMilestone(
        {
          runId,
          agentType: "Researcher",
          status: "running",
          inputPreview: "detached topic",
          displayOrder: 0,
          startedAt: Date.now(),
          ...(options?.notifySource !== undefined && {
            notifySource: options.notifySource
          })
        },
        { name, sequence: 0, at: Date.now(), data: { sources: 2 } },
        mode
      );
    }
  }

  async testPersistToolCall(messageId: string, toolName: string) {
    const toolCallPart: TestToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "input-available",
      input: { location: "London" }
    };

    const messageWithToolCall: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolCallPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithToolCall]);
    return messageWithToolCall;
  }

  async testPersistApprovalRequest(messageId: string, toolName: string) {
    const toolApprovalPart: TestToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "approval-requested",
      input: { location: "London" },
      approval: { id: `approval_${messageId}` }
    };

    const messageWithApprovalRequest: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolApprovalPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithApprovalRequest]);
    return messageWithApprovalRequest;
  }

  async testPersistToolResult(
    messageId: string,
    toolName: string,
    output: string
  ) {
    const toolResultPart: TestToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "output-available",
      input: { location: "London" },
      output
    };

    const messageWithToolOutput: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolResultPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithToolOutput]);
    return messageWithToolOutput;
  }

  // Resumable streaming test helpers

  testStartStream(
    requestId: string,
    options?: { messageId?: string; continuation?: boolean }
  ): string {
    return this["_releasedStreams"].start(requestId, options);
  }

  async testStoreStreamChunk(
    streamId: string,
    body: string
  ): Promise<number | undefined> {
    return storeStreamChunk(this, streamId, body);
  }

  async testBroadcastLiveChunk(
    requestId: string,
    streamId: string,
    body: string
  ): Promise<void> {
    await storeStreamChunk(this, streamId, body);
    const message: OutgoingMessage = {
      body,
      done: false,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    };
    (
      this as unknown as {
        _frames: { broadcast(msg: OutgoingMessage, exclude?: string[]): void };
      }
    )._frames.broadcast(message);
  }

  testFlushChunkBuffer(): void {
    this["_releasedStreams"].flushBuffer();
  }

  /**
   * Retire a stream (a cutover) and credit once, then read the KV key
   * earlier versions mirrored the progress marker into.
   */
  async probeProgressMirrorForTest(): Promise<unknown> {
    const stream = this["_releasedStreams"];
    const id = stream.start("req-mirror");
    for (let i = 0; i < 10; i++) stream.storeChunk(id, `{"i":${i}}`);
    stream.finish(id);
    stream.cutover(id, () => {});
    stream.creditProgress();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return this.ctx.storage.get(CHAT_RECOVERY_PROGRESS_KEY);
  }

  testCompleteStream(streamId: string): void {
    this["_releasedStreams"].complete(streamId);
  }

  testMarkStreamError(streamId: string): void {
    this["_releasedStreams"].error(streamId);
  }

  getActiveStreamId(): string | null {
    return this["_releasedStreams"].activeStreamId;
  }

  getActiveRequestId(): string | null {
    return (
      this._openChatTurns().find((run) => run.status === "running")?.runId ??
      null
    );
  }

  getStreamChunks(
    streamId: string
  ): Array<{ body: string; chunk_index: number }> {
    // Delegate to ReplyStreams so tests see the same unpacked, per-chunk
    // view that production consumers get (packed segment rows are expanded).
    return this["_releasedStreams"].getStreamChunks(streamId);
  }

  /** Rows a stream's chunks are stored in. */
  getStreamBlockRowCount(streamId: string): number {
    return (
      this.sql<{ cnt: number }>`
        select count(*) as cnt from cf_agents_stream_blocks
        where stream_id = ${streamId}
      `[0]?.cnt ?? 0
    );
  }

  /**
   * Number of stored seqs for a stream (one per chunk; a packed segment
   * from an older version counts as 1): the cursor, read from the block
   * log's tail.
   */
  getStreamChunkRowCount(streamId: string): number {
    const result = this.sql<{ cnt: number | null }>`
      select max(seq_to) as cnt from cf_agents_stream_blocks
      where stream_id = ${streamId}
    `;
    return result?.[0]?.cnt ?? 0;
  }

  /**
   * Seed legacy one-row-per-chunk records (the pre-packing storage format) so
   * tests can verify backward-compatible unpacking of older data.
   */
  insertLegacyChunkRows(
    streamId: string,
    requestId: string,
    bodies: string[]
  ): void {
    const now = Date.now();
    this.sql`
      insert into cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at, closed_at)
      values (${streamId}, 'completed', ${requestId}, ${JSON.stringify({ cfChat: 1 })},
              ${bodies.length}, ${now}, ${now}, ${now})
    `;
    if (bodies.length > 0) {
      this.sql`
        insert into cf_agents_stream_blocks
          (stream_id, block, seq_from, seq_to, body, created_at, updated_at)
        values (${streamId}, 0, 0, ${bodies.length},
                ${bodies.map((b) => JSON.stringify(b)).join(",")}, ${now}, ${now})
      `;
    }
  }

  getStreamMetadata(
    streamId: string
  ): { status: string; request_id: string } | null {
    return this["_releasedStreams"].getStreamMetadata(streamId);
  }

  /**
   * Stream metadata captured at stream start, keyed by request id. The rows
   * themselves are discarded as soon as the turn's message persists, so a
   * test that wants to see what the live path recorded reads it here.
   */
  private _startedStreams = new Map<
    string,
    { id: string; message_id: string | null }
  >();

  /**
   * Store a reply, cut off a stream that continued it, and rebuild the
   * stream's reply twice (a reconnect, then recovery). Returns the stored
   * reply's text parts.
   */
  async rebuildContinuedReplyTwiceForTest(): Promise<string[]> {
    await this.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Before", state: "done" }]
      }
    ]);
    const self = this as unknown as {
      _persistOrphanedStream(streamId: string): Promise<void>;
    };
    const streamId = this["_releasedStreams"].start("req-continued", {
      messageId: "a1",
      continuation: true,
      basePartCount: 1
    });
    for (const chunk of [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "After" }
    ]) {
      this["_releasedStreams"].storeChunk(streamId, JSON.stringify(chunk));
    }
    this["_releasedStreams"].flushBuffer();
    await self._persistOrphanedStream(streamId);
    await self._persistOrphanedStream(streamId);
    const reply = this.messages.find((m) => m.id === "a1");
    return (reply?.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
  }

  /** Record every stream started from now on, for {@link getStartedStreamMetadata}. */
  captureStreamStarts(): void {
    const stream = this["_releasedStreams"];
    const start = stream.start.bind(stream);
    stream.start = (requestId, options) => {
      const streamId = start(requestId, options);
      this._startedStreams.set(requestId, {
        id: streamId,
        message_id: stream.getStreamMessageId(streamId)
      });
      return streamId;
    };
  }

  getStartedStreamMetadata(
    requestId: string
  ): { id: string; message_id: string | null } | null {
    return this._startedStreams.get(requestId) ?? null;
  }

  getAllStreamMetadata(): Array<{
    id: string;
    status: string;
    request_id: string;
    created_at: number;
    message_id: string | null;
  }> {
    return this["_releasedStreams"].getAllStreamMetadata();
  }

  testInsertStaleStream(
    streamId: string,
    requestId: string,
    ageMs: number
  ): void {
    const createdAt = Date.now() - ageMs;
    this.streams.__DO_NOT_USE_WILL_BREAK__sync().importStream({
      streamId,
      state: "streaming",
      tag: requestId,
      metadata: { cfChat: 1 },
      chunkCount: 0,
      createdAt,
      updatedAt: createdAt,
      closedAt: null
    });
  }

  /** Append a chunk to a stream dated `ageMs` in the past (last-activity sweep). */
  testInsertStreamChunkAt(streamId: string, ageMs: number): void {
    this.streams
      .__DO_NOT_USE_WILL_BREAK__sync()
      .importChunk(streamId, '{"type":"text"}', Date.now() - ageMs);
  }

  testInsertOldErroredStream(
    streamId: string,
    requestId: string,
    ageMs: number
  ): void {
    const createdAt = Date.now() - ageMs;
    const completedAt = createdAt + 1000;
    this.sql`
      insert into cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at, closed_at)
      values (${streamId}, 'errored', ${requestId}, ${JSON.stringify({ cfChat: 1 })},
              0, ${createdAt}, ${completedAt}, ${completedAt})
    `;
  }

  testRestoreActiveStream(): void {
    this["_releasedStreams"].restore();
  }

  /** Reclaim leftover chat streams now, as the next stream start would. */
  testReclaimStreams(nowMs?: number): number {
    return this["_releasedStreams"].reclaim(nowMs);
  }

  /** Number of pending stream-cleanup schedules (always 0: none are armed). */
  testCountStreamCleanupSchedules(): number {
    return this.getSchedules().filter(
      (s) => s.callback === "_cleanupStreamBuffers"
    ).length;
  }

  /**
   * Simulate DO hibernation wake by reopening the reply stream log.
   * Opening calls restore() which reads from SQLite and sets
   * _activeStreamId, but _isLive remains false (no live LLM reader).
   * This mimics the DO constructor running after eviction.
   */
  /** The recorded end of `requestId` (the recent terminals), or null. */
  recentTerminalForTest(requestId: string): unknown {
    return recentChatTerminal(this.ctx.storage.kv, [requestId]);
  }

  testSimulateHibernationWake(): void {
    this["_releasedStreams"].open(this.streams, this.sql.bind(this));
  }

  /**
   * Insert a raw JSON string as a message directly into SQLite.
   * Used to test validation of malformed/corrupt messages.
   */
  async insertRawMessage(rowId: string, rawJson: string): Promise<void> {
    const parentId =
      (await this.sessions.session().getLatestLeaf())?.id ?? null;
    this.sql`
      INSERT INTO cf_agents_session_messages
        (id, session_id, seq, parent_id, role, content, token_estimate,
         created_at)
      VALUES (
        ${rowId}, '',
        (SELECT COALESCE(MAX(seq), 0) + 1
         FROM cf_agents_session_messages WHERE session_id = ''),
        ${parentId}, 'user', ${rawJson}, 0, ${Date.now()}
      )
    `;
  }

  setMaxPersistedMessages(max: number | null): void {
    this.maxPersistedMessages = max ?? undefined;
  }

  getMessageCount(): Promise<number> {
    return persistedMessageCount(this);
  }

  /**
   * Returns the number of active abort controllers.
   * Used to verify that cleanup happens after stream completion.
   * If controllers leak, this count grows with each request.
   */
  getAbortControllerCount(): number {
    return this._openChatTurns().filter((run) => run.status === "running")
      .length;
  }
}

/**
 * Test agent that overrides sanitizeMessageForPersistence to strip custom data.
 * Used to verify the user-overridable hook runs after built-in sanitization.
 */
/**
 * A subclass that overrides `persistMessages` the way application code
 * does: extra side effects, then `super` with only the messages. The
 * cutover must still reach the session write — the finished turn leaves no
 * stream row behind — even though the override forwards no third argument.
 */
export class OverridingPersistAgent extends TestChatAgent {
  private _persistOverrideCalls = 0;

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    this._persistOverrideCalls++;
    await super.persistMessages(messages, excludeBroadcastIds);
  }

  getPersistOverrideCalls(): number {
    return this._persistOverrideCalls;
  }
}

export class CustomSanitizeAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    return new Response("ok");
  }

  protected sanitizeMessageForPersistence(message: ChatMessage): ChatMessage {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (
          "output" in part &&
          part.output != null &&
          typeof part.output === "object" &&
          "content" in (part.output as Record<string, unknown>)
        ) {
          return {
            ...part,
            output: {
              ...(part.output as Record<string, unknown>),
              content: "[custom-redacted]"
            }
          };
        }
        return part;
      }) as ChatMessage["parts"]
    };
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

/**
 * Test agent that streams chunks slowly, useful for testing cancel/abort.
 *
 * Control via request body fields:
 * - `format`: "sse" | "plaintext" (default: "plaintext")
 * - `useAbortSignal`: boolean — whether to connect abortSignal to the stream
 * - `responseDelayMs`: delay before returning the response (default: 0)
 * - `chunkCount`: number of chunks to emit (default: 20)
 * - `chunkDelayMs`: delay between chunks in ms (default: 50)
 */
export class SlowStreamAgent extends AIChatAgent<Env> {
  private readonly _handledMessageTypes = recordHandledMessages(this);

  /** How many socket messages of `type` the agent has handled. */
  handledMessageCountForTest(type: string): number {
    return this._handledMessageTypes.filter((handled) => handled === type)
      .length;
  }

  /** When the agent received the socket message with this id. */
  receivedAtForTest(id: string): number | null {
    return messageReceivedAtForTest(this, id);
  }

  /** Reset this agent's isolate, as an eviction or a deploy does. */
  async resetIsolateForTest(): Promise<void> {
    this.ctx.abort("test: forced reset");
  }

  /** Every recovery incident's status and reason. */
  async getIncidentsForTest(): Promise<string[]> {
    const incidents = await this.ctx.storage.list<{
      status: string;
      reason?: string;
    }>({ prefix: "cf:chat-recovery:incident:" });
    return [...incidents.values()].map(
      (incident) => `${incident.status}:${incident.reason ?? ""}`
    );
  }

  /** The next admission record write fails, as SQLite's row limit would. */
  failNextAdmissionForTest(): void {
    // A client request's record is its run on the chat lane.
    const tasks = this.tasks as unknown as {
      run: (...args: unknown[]) => Promise<unknown>;
    };
    const run = tasks.run;
    tasks.run = (...args: unknown[]) => {
      if (args[0] !== CHAT_TURN_DEFINITION) {
        return run.apply(this.tasks, args);
      }
      tasks.run = run;
      return Promise.reject(new Error("SQLITE_TOOBIG: string or blob too big"));
    };
  }

  /** Make every admission record `ms` older, as a long wait would. */
  ageAdmissionsForTest(ms: number): void {
    this.sql`
      UPDATE cf_agents_task_runs SET created_at = created_at - ${ms}
      WHERE lane = 'chat'
    `;
  }

  /** The client requests waiting on the chat lane, in order. */
  getAdmissionsForTest(): Array<{ requestId: string; stopped: boolean }> {
    try {
      // A request that waits is its chat-turn run on the lane that has not
      // started (the running turn is not a record).
      return this.sql<{ request_id: string; stopped: number | null }>`
        SELECT run_id AS request_id,
               json_extract(metadata, '$.chat.stopped') AS stopped
        FROM cf_agents_task_runs
        WHERE lane = 'chat' AND status = 'pending'
          AND definition = ${CHAT_TURN_DEFINITION}
        ORDER BY seq
      `.map((row) => ({
        requestId: row.request_id,
        stopped: row.stopped === 1
      }));
    } catch {
      return [];
    }
  }

  /**
   * A record left between a turn's fiber and the record's delete. There is
   * no such window any more: the record is the turn's run, which recovery
   * owns once its model call began. Nothing to write.
   */
  seedAdmissionForTest(_requestId: string, _messageIds: string[]): void {}

  /** The messages waiting requests hold, not stored yet. */
  getQueuedMessageIdsForTest(): string[] {
    return [...this._queuedMessageIds()];
  }

  /** The transcript each `onChatMessage` call in this isolate saw. */
  getTranscriptsSeenForTest(): string[][] {
    return this._transcriptsSeen;
  }

  /** The body later turns run with. */
  getStoredBodyForTest(): Record<string, unknown> | undefined {
    return this._lastBody;
  }

  private _startedRequestIds: string[] = [];
  /** The transcript each `onChatMessage` call saw, by message id. */
  private _transcriptsSeen: string[][] = [];
  private _requestStartTimes = new Map<string, number>();
  private _chatResponseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    this._transcriptsSeen.push(this.messages.map((message) => message.id));
    const streamGate = this._takeStreamGate(options?.requestId);
    if (options?.requestId) {
      this._startedRequestIds.push(options.requestId);
      this._requestStartTimes.set(options.requestId, Date.now());
      this._requestBodies.set(options.requestId, options.body);
    }

    const body = options?.body as
      | {
          format?: string;
          useAbortSignal?: boolean;
          responseDelayMs?: number;
          chunkCount?: number;
          chunkDelayMs?: number;
          streamError?: string;
          /** Emit this many text-delta chunks before the in-band error (#1575). */
          errorAfterChunks?: number;
          throwError?: boolean;
        }
      | undefined;
    const format = body?.format ?? "plaintext";
    const useAbortSignal = body?.useAbortSignal ?? false;
    const responseDelayMs = body?.responseDelayMs ?? 0;
    const chunkCount = body?.chunkCount ?? 20;
    const chunkDelayMs = body?.chunkDelayMs ?? 50;
    const streamError = body?.streamError;
    const errorAfterChunks = body?.errorAfterChunks ?? 0;
    const throwError = body?.throwError ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    // The reply calls a tool, and its stream stays open: only a stop,
    // a stall or an eviction ends it. The answer's continuation falls
    // through to the plain reply.
    // With `"approval"` the call is a server tool's, waiting on approval.
    const hangOn = (
      options?.body as { toolThenHang?: "call" | "approval" } | undefined
    )?.toolThenHang;
    if (hangOn && !options?.continuation) {
      const sse = (chunk: unknown) =>
        new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(sse({ type: "start" }));
            controller.enqueue(
              sse({
                type: "tool-input-available",
                toolCallId: "call-hang",
                toolName: hangOn === "call" ? "chooseOption" : "deleteFile",
                input: {}
              })
            );
            if (hangOn === "approval") {
              controller.enqueue(
                sse({
                  type: "tool-approval-request",
                  toolCallId: "call-hang",
                  approvalId: "approval-hang"
                })
              );
            }
          }
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    const failOnAbort = (options?.body as { failOnAbort?: string } | undefined)
      ?.failOnAbort;
    if (failOnAbort) {
      // Behaves like app code that passes the turn's signal on: when the
      // signal aborts, the pending work fails with the signal's reason.
      const signal = options?.abortSignal;
      const aborted = new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      });
      this._stopWithReasonStarted?.();
      if (failOnAbort === "before-response") return aborted;
      const sse = (chunk: unknown) =>
        new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(sse({ type: "text-start", id: "t" }));
            controller.enqueue(
              sse({ type: "text-delta", id: "t", delta: "Hi" })
            );
            try {
              await aborted;
            } catch (reason) {
              if (failOnAbort === "stream") return controller.error(reason);
              // What `streamText().toUIMessageStreamResponse()` sends for
              // a failure that is not an `AbortError`.
              controller.enqueue(
                sse({ type: "error", errorText: String(reason) })
              );
              controller.close();
            }
          }
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    if (responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    }
    const responseGate = this._responseGate;
    if (responseGate && !responseGate.reached) await responseGate.pass();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (format === "sse" && streamError) {
          // Optionally stream real content first so the in-band error
          // arrives mid-message — the #1575 partial-content scenario.
          if (errorAfterChunks > 0) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text-start", id: "t-err" })}\n\n`
              )
            );
            for (let i = 0; i < errorAfterChunks; i++) {
              await new Promise((r) => setTimeout(r, chunkDelayMs));
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "text-delta",
                    id: "t-err",
                    delta: `partial-${i} `
                  })}\n\n`
                )
              );
            }
          }
          const chunk = JSON.stringify({
            type: "error",
            errorText: streamError
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          controller.close();
          return;
        }
        for (let i = 0; i < chunkCount; i++) {
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }
          await new Promise((r) => setTimeout(r, chunkDelayMs));
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }
          if (throwError && i === Math.floor(chunkCount / 2)) {
            throw new Error("Simulated stream error");
          }
          if (format === "sse") {
            const chunk = JSON.stringify({
              type: "text-delta",
              delta: `chunk-${i} `
            });
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`chunk-${i} `));
          }
          if (i === 0 && streamGate) await streamGate.pass();
        }
        if (format === "sse") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      }
    });

    const contentType = format === "sse" ? "text/event-stream" : "text/plain";
    return new Response(stream, {
      headers: { "Content-Type": contentType }
    });
  }

  /**
   * Streams held after their first chunk until released: by request id,
   * or "next" for whichever stream starts next (a continuation's id is not
   * known ahead).
   */
  private _streamGates = new Map<string, TestGate>();

  private _takeStreamGate(requestId: string | undefined): TestGate | undefined {
    const byId = requestId ? this._streamGates.get(requestId) : undefined;
    if (byId) return byId;
    const next = this._streamGates.get("next");
    if (!next || next.reached) return undefined;
    // Keep it under the request's id too, for release and checks by id.
    if (requestId) this._streamGates.set(requestId, next);
    return next;
  }

  getContinuationStateForTest(): ContinuationStateForTest {
    return continuationStateForTest(this);
  }

  /** How many turns the queue holds, the running one included. */
  queuedTurnCountForTest(): number {
    return queuedTurnCountForTest(this);
  }

  /** Holds the next response (before any chunk) until released. */
  private _responseGate: TestGate | null = null;

  holdNextResponseForTest(): void {
    this._responseGate = new TestGate();
  }

  isResponseHeldForTest(): boolean {
    return this._responseGate?.reached ?? false;
  }

  releaseResponseForTest(): void {
    this._responseGate?.release();
    this._responseGate = null;
  }

  holdStreamForTest(requestId = "next"): void {
    this._streamGates.set(requestId, new TestGate());
  }

  isStreamHeldForTest(requestId = "next"): boolean {
    return this._streamGates.get(requestId)?.reached ?? false;
  }

  releaseStreamForTest(requestId = "next"): void {
    const gate = this._streamGates.get(requestId);
    gate?.release();
    for (const [key, value] of this._streamGates) {
      if (value === gate) this._streamGates.delete(key);
    }
  }

  private _stopWithReasonStarted: (() => void) | undefined;
  private _onErrorCallsForTest: string[] = [];

  override onError(connection: Connection, error: unknown): void;
  override onError(error: unknown): void;
  override onError(connectionOrError: Connection | unknown, error?: unknown) {
    const thrown = error === undefined ? connectionOrError : error;
    this._onErrorCallsForTest.push(
      thrown instanceof Error ? thrown.message : String(thrown)
    );
  }

  getOnErrorCallsForTest(): string[] {
    return [...this._onErrorCallsForTest];
  }

  /**
   * A turn is stopped through its own signal while `onChatMessage` or its
   * stream waits on that signal and fails with the signal's reason.
   * Returns everything that could tell an app the turn failed.
   */
  async stopWithReasonForTest(options: {
    entry: "saveMessages" | "continueLastTurn" | "abortRequest";
    phase: "before-response" | "stream" | "error-chunk";
    reason: "none" | "string" | "error";
  }): Promise<{
    status: string;
    responses: string[];
    onErrorCalls: string[];
    errorFrames: number;
  }> {
    if (options.entry === "continueLastTurn") {
      await this.saveMessages([
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "first turn" }]
        }
      ]);
    }
    this._chatResponseResults = [];
    this._onErrorCallsForTest = [];
    await this.setTestBody({ failOnAbort: options.phase });
    const started = new Promise<void>((resolve) => {
      this._stopWithReasonStarted = resolve;
    });
    let errorFrames = 0;
    const self = this as unknown as {
      _frames: { broadcast(...args: unknown[]): void };
      abortRequest(requestId: string, reason?: unknown): void;
      continueLastTurn(
        body?: Record<string, unknown>,
        options?: { signal?: AbortSignal }
      ): Promise<SaveMessagesResult>;
    };
    const broadcast = self._frames.broadcast;
    self._frames.broadcast = (...args) => {
      if ((args[0] as { error?: boolean }).error === true) errorFrames++;
      return broadcast.apply(self._frames, args);
    };
    const caller = new AbortController();
    const reason =
      options.reason === "string"
        ? "caller-stop"
        : options.reason === "error"
          ? new Error("caller-stop")
          : undefined;
    try {
      const turn =
        options.entry === "continueLastTurn"
          ? self.continueLastTurn(undefined, { signal: caller.signal })
          : this.saveMessages(
              [
                ...this.messages,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: "stop me" }]
                }
              ],
              options.entry === "saveMessages"
                ? { signal: caller.signal }
                : undefined
            );
      await started;
      if (options.entry === "abortRequest") {
        const requestId = this._startedRequestIds.at(-1);
        if (!requestId) throw new Error("no request id to abort");
        self.abortRequest(requestId, reason);
      } else {
        caller.abort(reason);
      }
      const status = await turn.then(
        (value) => value.status,
        (error) => `threw: ${error instanceof Error ? error.message : error}`
      );
      await this.waitUntilStable({ pendingInteraction: () => false });
      return {
        status,
        responses: this._chatResponseResults.map((r) => r.status),
        onErrorCalls: [...this._onErrorCallsForTest],
        errorFrames
      };
    } finally {
      self._frames.broadcast = broadcast;
      this._stopWithReasonStarted = undefined;
      await this.setTestBody({});
    }
  }

  getAbortControllerCount(): number {
    return this._openChatTurns().filter((run) => run.status === "running")
      .length;
  }

  getStartedRequestIds(): string[] {
    return [...this._startedRequestIds];
  }

  /** Whether every tool call in `toolCallIds` has its output applied. */
  toolOutputsAppliedForTest(toolCallIds: string[]): boolean {
    const applied = new Set<string>();
    for (const message of this.messages) {
      for (const part of message.parts) {
        if (
          "toolCallId" in part &&
          "state" in part &&
          part.state === "output-available"
        ) {
          applied.add(part.toolCallId as string);
        }
      }
    }
    return toolCallIds.every((id) => applied.has(id));
  }

  private _requestBodies = new Map<
    string,
    Record<string, unknown> | undefined
  >();

  /** The body `onChatMessage` got for a request. */
  getRequestBodyForTest(requestId: string): Record<string, unknown> | null {
    return this._requestBodies.get(requestId) ?? null;
  }

  abortAllRequestsForTest(): void {
    this.abortAllRequests();
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  getRequestStartTime(requestId: string): number | null {
    return this._requestStartTimes.get(requestId) ?? null;
  }

  isChatTurnActiveForTest(): boolean {
    return this._openChatTurns().some((run) => run.status === "running");
  }

  async waitForIdleForTest(): Promise<boolean> {
    await this.waitUntilStable({ pendingInteraction: () => false });
    return true;
  }

  /**
   * Wait for idle and report, from inside the agent at the moment it
   * settled, the turns started so far and whether one is still active.
   */
  async waitForIdleStartsForTest(): Promise<{
    started: string[];
    active: boolean;
  }> {
    await this.waitUntilStable({ pendingInteraction: () => false });
    return {
      started: [...this._startedRequestIds],
      active: this.isChatTurnActiveForTest()
    };
  }

  waitUntilStableForTest(options?: { timeout?: number }): Promise<boolean> {
    return this.waitUntilStable(options);
  }

  /**
   * Number of submits that arrived while a turn was queued or running,
   * under `latest`, `merge` or debounce. Regenerations, and submits under
   * `queue` or `drop`, are not counted.
   *
   * A barrier in concurrency tests: wait until the agent took every
   * overlapping submit before asserting on which turns ran.
   */
  getOverlappingSubmitCountForTest(): number {
    // Every chat request after the first arrives while a turn waits or runs
    // in these tests: the barrier waits until the agent took them all.
    const requests = this._requestsTaken.filter(
      (type) => type === MessageType.CF_AGENT_USE_CHAT_REQUEST
    ).length;
    return Math.max(0, requests - 1);
  }

  private readonly _requestsTaken = recordHandledMessages(this);

  resetTurnStateForTest(): void {
    this.resetTurnState();
  }

  getLastBodyForTest(): Record<string, unknown> | undefined {
    return this._lastBody;
  }

  async saveSyntheticUserMessage(text: string): Promise<void> {
    const message: ChatMessage = {
      id: `saved-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };

    await this.saveMessages([...this.messages, message]);
  }

  async setTestBody(body: Record<string, unknown>): Promise<void> {
    // The chat module's request context: what a server turn runs with.
    await this.sessions
      .session()
      .internal_setConfig(CHAT_REQUEST_CONTEXT_KEY, JSON.stringify({ body }));
  }

  async enqueueSyntheticUserMessage(
    text: string,
    options?: {
      body?: Record<string, unknown>;
    }
  ): Promise<SaveMessagesResult> {
    if (options?.body) {
      await this.setTestBody(options.body);
    }
    return this.saveMessages((messages) => [
      ...messages,
      {
        id: `enqueued-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  async enqueueSyntheticUserMessagesInOrder(
    messages: Array<{
      text: string;
      body?: Record<string, unknown>;
    }>
  ): Promise<SaveMessagesResult[]> {
    return Promise.all(
      messages.map((message) =>
        this.enqueueSyntheticUserMessage(message.text, {
          body: message.body
        })
      )
    );
  }

  // ── External AbortSignal seams (issue #1406) ─────────────────────
  //
  // AbortSignal can't cross the DurableObject RPC boundary, so each
  // scenario is constructed inside the DO and surfaces just the
  // resulting `SaveMessagesResult` to the test runner.

  async testSaveMessagesWithSignal(
    text: string,
    options: {
      preAbort?: boolean;
      abortAfterMs?: number;
      abortAfterCompletion?: boolean;
      body?: Record<string, unknown>;
    }
  ): Promise<SaveMessagesResult> {
    if (options.body) await this.setTestBody(options.body);
    const controller = new AbortController();
    if (options.preAbort) {
      controller.abort(new Error("pre-aborted"));
    } else if (
      typeof options.abortAfterMs === "number" &&
      !options.abortAfterCompletion
    ) {
      const ms = options.abortAfterMs;
      setTimeout(() => controller.abort(new Error("mid-stream abort")), ms);
    }

    const result = await this.saveMessages(
      [
        ...this.messages,
        {
          id: `signal-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text }]
        }
      ],
      { signal: controller.signal }
    );

    if (options.abortAfterCompletion) {
      controller.abort(new Error("post-completion abort"));
    }
    return result;
  }

  async testContinueLastTurnWithSignal(options: {
    preAbort?: boolean;
    abortAfterMs?: number;
    body?: Record<string, unknown>;
  }): Promise<SaveMessagesResult> {
    const controller = new AbortController();
    if (options.preAbort) {
      controller.abort(new Error("pre-aborted"));
    } else if (typeof options.abortAfterMs === "number") {
      const ms = options.abortAfterMs;
      setTimeout(() => controller.abort(new Error("mid-stream abort")), ms);
    }

    return (
      this as unknown as {
        continueLastTurn(
          body?: Record<string, unknown>,
          options?: { signal?: AbortSignal }
        ): Promise<SaveMessagesResult>;
      }
    ).continueLastTurn(options.body, { signal: controller.signal });
  }

  async testSaveMessagesCancelledByAbortAllRequests(
    text: string,
    cancelAfterMs: number,
    body?: Record<string, unknown>
  ): Promise<SaveMessagesResult> {
    if (body) await this.setTestBody(body);
    setTimeout(() => {
      (this as unknown as { abortAllRequests(): void }).abortAllRequests();
    }, cancelAfterMs);

    return this.saveMessages([
      ...this.messages,
      {
        id: `public-abort-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  /**
   * Queue a second `saveMessages` turn behind a running one, then call
   * `abortAllRequests()` while the second still waits in the queue.
   */
  async testQueuedSaveMessagesStoppedByAbortAllRequests(
    cancelAfterMs: number,
    body: Record<string, unknown>
  ): Promise<{ running: SaveMessagesResult; queued: SaveMessagesResult }> {
    await this.setTestBody(body);
    const turn = (text: string) =>
      this.saveMessages((messages) => [
        ...messages,
        {
          id: `queued-abort-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text }]
        }
      ]);
    setTimeout(() => {
      (this as unknown as { abortAllRequests(): void }).abortAllRequests();
    }, cancelAfterMs);
    const [running, queued] = await Promise.all([
      turn("Running"),
      turn("Queued")
    ]);
    return { running, queued };
  }

  async getPersistedUserTexts(): Promise<string[]> {
    return (await this.getPersistedMessages())
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      );
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._chatResponseResults.push(result);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._chatResponseResults];
  }

  async persistToolCallMessage(
    messageId: string,
    toolCallId: string,
    toolName: string
  ): Promise<void> {
    await this.persistMessages([
      ...this.messages,
      {
        id: messageId,
        role: "assistant",
        parts: [
          {
            type: `tool-${toolName}`,
            toolCallId,
            state: "input-available",
            input: { test: true }
          }
        ]
      } as ChatMessage
    ]);
  }

  getMessageCount(): Promise<number> {
    return persistedMessageCount(this);
  }
}

/**
 * Test agent that records onChatResponse calls for verification.
 * Uses slow streaming so tests can cancel/abort mid-stream.
 */
export class ResponseAgent extends AIChatAgent<Env> {
  private _responseResults: ChatResponseResult[] = [];

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const body = options?.body as
      | {
          format?: string;
          chunkCount?: number;
          chunkDelayMs?: number;
          throwError?: boolean;
          streamError?: string;
          streamErrorAfterText?: boolean;
          useAbortSignal?: boolean;
          noResponse?: boolean;
        }
      | undefined;

    if (body?.noResponse) return undefined;

    const format = body?.format ?? "plaintext";
    const chunkCount = body?.chunkCount ?? 3;
    const chunkDelayMs = body?.chunkDelayMs ?? 10;
    const throwError = body?.throwError ?? false;
    const streamError = body?.streamError;
    const streamErrorAfterText = body?.streamErrorAfterText ?? false;
    const useAbortSignal = body?.useAbortSignal ?? false;
    const abortSignal = useAbortSignal ? options?.abortSignal : undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (format === "sse" && streamError && !streamErrorAfterText) {
          const chunk = JSON.stringify({
            type: "error",
            errorText: streamError
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          controller.close();
          return;
        }
        for (let i = 0; i < chunkCount; i++) {
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }
          if (chunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, chunkDelayMs));
          }
          if (abortSignal?.aborted) {
            controller.close();
            return;
          }

          if (throwError && i === Math.floor(chunkCount / 2)) {
            throw new Error("Simulated stream error");
          }

          if (format === "sse") {
            const chunk = JSON.stringify({
              type: "text-delta",
              delta: `chunk-${i} `
            });
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`chunk-${i} `));
          }
        }
        if (format === "sse" && streamError) {
          const chunk = JSON.stringify({
            type: "error",
            errorText: streamError
          });
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        } else if (format === "sse") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      }
    });

    const contentType = format === "sse" ? "text/event-stream" : "text/plain";
    return new Response(stream, {
      headers: { "Content-Type": contentType }
    });
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._responseResults.push(result);
  }

  /** No onChatResponse result is waiting or being delivered. */
  isChatResponseDrainIdleForTest(): boolean {
    return chatResponseDrainIdleForTest(this);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._responseResults];
  }

  clearChatResponseResults(): void {
    this._responseResults = [];
  }

  private _failNextAssistantPersist = false;

  /** Make the next persist that ends in an assistant message throw. */
  failNextAssistantPersist(): void {
    this._failNextAssistantPersist = true;
  }

  private _blockNextAssistantPersist = false;
  private _releaseBlockedPersist: (() => void) | null = null;

  /** Hold the next persist that ends in an assistant message until released. */
  blockNextAssistantPersist(): void {
    this._blockNextAssistantPersist = true;
  }

  isAssistantPersistBlocked(): boolean {
    return this._releaseBlockedPersist !== null;
  }

  releaseAssistantPersist(): void {
    this._releaseBlockedPersist?.();
    this._releaseBlockedPersist = null;
  }

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    if (
      this._failNextAssistantPersist &&
      messages.at(-1)?.role === "assistant"
    ) {
      this._failNextAssistantPersist = false;
      throw new Error("Simulated persistence failure");
    }
    if (
      this._blockNextAssistantPersist &&
      messages.at(-1)?.role === "assistant"
    ) {
      this._blockNextAssistantPersist = false;
      await new Promise<void>((resolve) => {
        this._releaseBlockedPersist = resolve;
      });
    }
    return super.persistMessages(messages, excludeBroadcastIds, options);
  }

  async saveSyntheticUserMessage(text: string): Promise<void> {
    const message: ChatMessage = {
      id: `saved-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text }]
    };
    await this.saveMessages([...this.messages, message]);
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

/**
 * Test agent that records onChatResponse and supports tool continuation.
 * Used to verify onChatResponse fires with continuation=true after auto-continue.
 */
export class ResponseContinuationAgent extends AIChatAgent<Env> {
  isChatResponseDrainIdleForTest(): boolean {
    return chatResponseDrainIdleForTest(this);
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  private _responseResults: ChatResponseResult[] = [];
  private _failContinuation: false | "throw" | "locked-body" = false;

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    if (options?.continuation && this._failContinuation === "throw") {
      throw new Error("continuation failed before streaming");
    }
    if (options?.continuation && this._failContinuation === "locked-body") {
      const response = new Response("unreadable", {
        headers: { "Content-Type": "text/plain" }
      });
      response.body?.getReader();
      return response;
    }
    return new Response("Continuation response", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._responseResults.push(result);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._responseResults];
  }

  setFailContinuation(value: false | "throw" | "locked-body"): void {
    this._failContinuation = value;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

/**
 * Test agent whose onChatResponse throws — verifies the framework handles it
 * gracefully without breaking the stream or masking the original error.
 */
export class ResponseThrowingAgent extends AIChatAgent<Env> {
  private _streamCompleted = false;

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const throwError = (options?.body as { throwError?: boolean } | undefined)
      ?.throwError;

    if (throwError) {
      const stream = new ReadableStream({
        pull() {
          throw new Error("Stream-level error");
        }
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/plain" }
      });
    }

    return new Response("Success response", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  protected async onChatResponse(_result: ChatResponseResult) {
    this._streamCompleted = true;
    throw new Error("onChatResponse hook crashed");
  }

  getStreamCompleted(): boolean {
    return this._streamCompleted;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

/**
 * Test agent that calls saveMessages from inside onChatResponse.
 * Uses a queue of messages to process sequentially — each onChatResponse
 * picks the next item and calls saveMessages, relying on the framework's
 * drain loop to fire onChatResponse again for the inner turn's result.
 */
export class ResponseSaveMessagesAgent extends AIChatAgent<Env> {
  isChatResponseDrainIdleForTest(): boolean {
    return chatResponseDrainIdleForTest(this);
  }

  private _responseResults: ChatResponseResult[] = [];
  private _messageQueue: string[] = [];

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    _options?: OnChatMessageOptions
  ) {
    return new Response("Agent reply", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  protected async onChatResponse(result: ChatResponseResult) {
    this._responseResults.push(result);

    if (this._messageQueue.length > 0) {
      const text = this._messageQueue.shift()!;
      const followUp: ChatMessage = {
        id: `followup-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text }]
      };
      await this.saveMessages([...this.messages, followUp]);
    }
  }

  enqueueMessages(messages: string[]): void {
    this._messageQueue.push(...messages);
  }

  getChatResponseResults(): ChatResponseResult[] {
    return [...this._responseResults];
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }
}

export class LatestMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "latest" as const;
}

export class MergeMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "merge" as const;
}

/**
 * {@link MergeMessageConcurrencyAgent} with a `persistMessages` override
 * that passes only the messages and the exclusions on, as an app may.
 */
export class OverridingPersistMergeAgent extends SlowStreamAgent {
  messageConcurrency = "merge" as const;

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = []
  ) {
    await super.persistMessages(messages, excludeBroadcastIds);
  }
}

export class DropMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = "drop" as const;
}

export class DebounceMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = {
    strategy: "debounce",
    debounceMs: 80
  } as const;
}

export class InvalidDebounceMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = {
    strategy: "debounce",
    debounceMs: Number.NaN
  } as const;
}

export class MissingDebounceMessageConcurrencyAgent extends SlowStreamAgent {
  messageConcurrency = {
    strategy: "debounce"
  } as const;
}

// Test agents for waitForMcpConnections config
export class WaitMcpTrueAgent extends AIChatAgent<Env> {
  waitForMcpConnections = true as const;

  async onChatMessage() {
    const tools = this.mcp.getAITools();
    return new Response(
      JSON.stringify({ toolCount: Object.keys(tools).length }),
      { headers: { "Content-Type": "text/plain" } }
    );
  }
}

export class WaitMcpTimeoutAgent extends AIChatAgent<Env> {
  waitForMcpConnections = { timeout: 1000 };

  async onChatMessage() {
    const tools = this.mcp.getAITools();
    return new Response(
      JSON.stringify({ toolCount: Object.keys(tools).length }),
      { headers: { "Content-Type": "text/plain" } }
    );
  }
}

export class WaitMcpFalseAgent extends AIChatAgent<Env> {
  waitForMcpConnections = false as const;

  async onChatMessage() {
    const tools = this.mcp.getAITools();
    return new Response(
      JSON.stringify({ toolCount: Object.keys(tools).length }),
      { headers: { "Content-Type": "text/plain" } }
    );
  }
}

// Test agent that overrides onRequest and calls super.onRequest()
export class AgentWithSuperCall extends AIChatAgent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/custom-route")) {
      return new Response("custom route");
    }
    return super.onRequest(request);
  }

  async onChatMessage() {
    return new Response("chat response");
  }
}

// Test agent that overrides onRequest WITHOUT calling super.onRequest()
export class AgentWithoutSuperCall extends AIChatAgent<Env> {
  async onRequest(_request: Request): Promise<Response> {
    return new Response("custom only");
  }

  async onChatMessage() {
    return new Response("chat response");
  }
}

// Test agent whose onRequest throws and whose onError only logs, as the docs
// show. Its onFetchError answers with the error it received.
export class LogOnlyOnErrorAgent extends AIChatAgent<Env> {
  async onRequest(): Promise<Response> {
    throw new Error("chat request failed");
  }

  override onError(connection: Connection, error: unknown): void;
  override onError(error: unknown): void;
  override onError(_connectionOrError: Connection | unknown, _error?: unknown) {
    // Log only: return instead of rethrowing.
  }

  override onFetchError(_request: Request, error: unknown): Response {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 }
    );
  }

  async onChatMessage() {
    return new Response("chat response");
  }
}

// ── ChatRecoveryTestAgent (chat recovery) ─────────────────────────────

/**
 * The carry of a release's request context writes it through the session
 * and then empties its table: wait until the table holds no row.
 */
async function untilRequestContextCarried(sql: SqlStorage): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const rows = sql
        .exec("SELECT 1 FROM cf_ai_chat_request_context LIMIT 1")
        .toArray();
      if (rows.length === 0) return;
    } catch {
      return; // The table is gone.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export class ChatRecoveryTestAgent extends AIChatAgent<Env> {
  /** The recorded end of `requestId` (the recent terminals), or null. */
  recentTerminalForTest(requestId: string): unknown {
    return recentChatTerminal(this.ctx.storage.kv, [requestId]);
  }

  recoveryContexts: ChatRecoveryContext[] = [];
  exhaustedContexts: ChatRecoveryExhaustedContext[] = [];
  recoveryOverride: ChatRecoveryOptions | null = null;
  onChatMessageCallCount = 0;
  onChatMessageBodies: Array<Record<string, unknown> | undefined> = [];
  onChatMessageClientTools: Array<ClientToolSchema[] | undefined> = [];
  includeReasoningInResponse = false;
  private _stashData: unknown = null;
  private _stashResult: { success: boolean; error?: string } | null = null;

  async onChatMessage(
    _onFinish?: unknown,
    ctx?: {
      requestId?: string;
      body?: Record<string, unknown>;
      clientTools?: ClientToolSchema[];
    }
  ) {
    this.onChatMessageCallCount++;
    this.onChatMessageBodies.push(ctx?.body);
    this.onChatMessageClientTools.push(ctx?.clientTools);
    // A recovered turn keeps its request id: it is its own root.
    this._recoveryRootsSeen.push(ctx?.requestId ?? null);
    if (this._throwFromNextTurn) {
      const message = this._throwFromNextTurn;
      this._throwFromNextTurn = null;
      throw new Error(message);
    }

    // A hold kept for the isolate after a reset: taken by its first turn.
    if (
      this.ctx.storage.kv.get("test:hold-turn-after-reset") &&
      !this._turnHold
    ) {
      this.ctx.storage.kv.delete("test:hold-turn-after-reset");
      this.holdNextTurnForTest();
    }
    const hold = this._turnHold;
    if (hold && !hold.waiting) {
      hold.waiting = true;
      this._heldTurnRequestId = ctx?.requestId ?? null;
      await hold.released;
    }

    // The turn ends before the model returned a reply.
    const endBeforeReply = this._endBeforeReply;
    if (endBeforeReply) {
      this._endBeforeReply = null;
      if (endBeforeReply === "nothing") return undefined;
      throw new Error("onChatMessage failed before a reply");
    }

    if (this._hangTurnsRemaining > 0) {
      this._hangTurnsRemaining--;
      return makeHangingSSEResponse();
    }

    if (this._stashData !== null) {
      try {
        this.stash(this._stashData);
        this._stashResult = { success: true };
      } catch (e) {
        this._stashResult = {
          success: false,
          error: e instanceof Error ? e.message : String(e)
        };
      }
    }

    if (this._streamTextProviderError) {
      const { statusCode, rethrow } = this._streamTextProviderError;
      this._streamTextProviderError = null;
      // A provider that answers with an HTTP error, behind `streamText`.
      const model = {
        specificationVersion: "v3",
        provider: "test",
        modelId: "failing",
        supportedUrls: {},
        doGenerate: () => {
          throw new Error("not used");
        },
        doStream: async () => {
          if (statusCode === 0) {
            // Anthropic's in-stream overload: a plain object, no status.
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({
                    type: "error",
                    error: { type: "overloaded_error", message: "Overloaded" }
                  });
                  controller.close();
                }
              })
            };
          }
          throw new APICallError({
            message: "Rate limit reached for requests",
            url: "https://api.example.com/v1/chat",
            requestBodyValues: {},
            statusCode
          });
        }
      } as unknown as LanguageModel;
      return streamText({
        model,
        prompt: "hi",
        maxRetries: 0
      }).toUIMessageStreamResponse(
        rethrow
          ? {
              // Let the provider's error fail the stream, so the host
              // reads its status, instead of masking it as text.
              onError: (error) => {
                if (APICallError.isInstance(error)) throw error;
                return error instanceof Error
                  ? error.message
                  : JSON.stringify(error);
              }
            }
          : undefined
      );
    }

    if (this._failingTurn) {
      this._failingReaderCalls++;
      const { message, remaining, prelude, responseHeaders, statusCode } =
        this._failingTurn;
      this._failingTurn =
        remaining > 1
          ? {
              message,
              remaining: remaining - 1,
              prelude,
              responseHeaders,
              statusCode
            }
          : null;
      return makeFailingSSEResponse(
        message,
        prelude,
        responseHeaders,
        statusCode
      );
    }

    if (this._emitStreamError) {
      // Surface a terminal stream error (the way a provider 500 arrives as an
      // SSE `error` part). The turn resolves with status "error".
      return makeSSEChunkResponse([
        { type: "start" },
        { type: "error", errorText: this._emitStreamError }
      ]);
    }

    const chunks: Array<Record<string, unknown>> = [];
    if (this.includeReasoningInResponse) {
      chunks.push(
        { type: "reasoning-start" },
        { type: "reasoning-delta", delta: "Thinking about continuation." },
        { type: "reasoning-end" }
      );
    }
    chunks.push(
      { type: "text-start" },
      { type: "text-delta", delta: "Continued response." },
      { type: "text-end" },
      { type: "finish" }
    );
    return makeSSEChunkResponse(chunks);
  }

  private _emitStreamError: string | null = null;

  private _throwFromNextTurn: string | null = null;
  private _recoveryRootsSeen: Array<string | null> = [];
  private _saveFromNextResponse = false;

  /** Make the next `onChatMessage` call throw `message`. */
  throwFromNextTurnForTest(message: string | null): void {
    this._throwFromNextTurn = message;
  }

  /**
   * The recovery root request id each `onChatMessage` call ran under, or
   * `null` for a turn that was not a recovery attempt's.
   */
  getRecoveryRootsSeenForTest(): Array<string | null> {
    return this._recoveryRootsSeen;
  }

  /** Make the next `onChatResponse` start a turn of its own. */
  saveFromNextResponseForTest(): void {
    this._saveFromNextResponse = true;
  }

  /**
   * The record ai-chat 0.12.x kept of the last turn that ended in an error
   * (async KV key `cf:chat:last-terminal`), then a reset.
   */
  async leaveReleasedLastTerminalForTest(record: {
    requestId: string;
    body: string;
  }): Promise<void> {
    await this.ctx.storage.put("cf:chat:last-terminal", record);
    await this.ctx.storage.sync();
    this.ctx.abort("test: forced reset");
  }

  /** Whether that record is still stored. */
  async hasReleasedLastTerminalForTest(): Promise<boolean> {
    return (await this.ctx.storage.get("cf:chat:last-terminal")) !== undefined;
  }

  private _endedRequestIds: string[] = [];

  /** The request ids of the turns that have ended, oldest first. */
  endedRequestIdsForTest(): string[] {
    return this._endedRequestIds;
  }

  protected override async onChatResponse(_result: ChatResponseResult) {
    this._endedRequestIds.push(_result.requestId);
    if (this._clearDuringResponseHook) {
      this._clearDuringResponseHook = false;
      this.resetTurnState();
      return;
    }
    if (!this._saveFromNextResponse) return;
    this._saveFromNextResponse = false;
    const followUp = await this.saveMessages((messages) => [
      ...messages,
      {
        id: `follow-up-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "follow-up from onChatResponse" }]
      }
    ]);
    this._followUpRequestId = followUp.requestId;
  }

  /**
   * Store text (which stays buffered) then a tool call, and report how many
   * chunks are in SQLite before and after the call.
   */
  async probeToolCallDurabilityForTest(): Promise<{
    beforeCall: number;
    afterCall: number;
  }> {
    const streamId = this["_releasedStreams"].start("req-tool-call-durability");
    const store = (chunk: Record<string, unknown>) =>
      storeStreamChunk(this, streamId, JSON.stringify(chunk));
    const rawCount = (): number =>
      this.sql<{ count: number }>`
        SELECT COALESCE(MAX(seq_to), 0) as count FROM cf_agents_stream_blocks
        WHERE stream_id = ${streamId}
      `[0]?.count ?? 0;
    await store({ type: "reasoning-delta", id: "r", delta: "Let me " });
    await store({ type: "reasoning-delta", id: "r", delta: "look." });
    const beforeCall = rawCount();
    await store({
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "getWeather",
      input: { city: "Paris" }
    });
    return { beforeCall, afterCall: rawCount() };
  }

  /** Holds the next onChatMessage call until released: the model is slow. */
  private _turnHold: {
    waiting: boolean;
    released: Promise<void>;
    release: () => void;
  } | null = null;

  holdNextTurnForTest(): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._turnHold = { waiting: false, released, release };
  }

  /**
   * Reset this isolate; the first turn of the next one is held on the
   * model as {@link holdNextTurnForTest} holds one (kept in storage).
   */
  async resetHoldingNextTurnForTest(): Promise<void> {
    this.ctx.storage.kv.put("test:hold-turn-after-reset", true);
    await this.ctx.storage.sync();
    this.ctx.abort("test: forced reset");
  }

  private _heldTurnRequestId: string | null = null;

  /** The request id of the turn held in onChatMessage. */
  heldTurnRequestIdForTest(): string | null {
    return this._heldTurnRequestId;
  }

  isTurnHeldForTest(): boolean {
    return this._turnHold?.waiting ?? false;
  }

  releaseHeldTurnForTest(): void {
    this._turnHold?.release();
    this._turnHold = null;
  }

  setStashData(data: unknown): void {
    this._stashData = data;
  }

  getStashResult(): { success: boolean; error?: string } | null {
    return this._stashResult;
  }

  setIncludeReasoning(value: boolean): void {
    this.includeReasoningInResponse = value;
  }

  recoveryShouldThrow = false;
  onExhaustedCalls = 0;
  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.recoveryContexts.push(ctx);
    if (this.recoveryShouldThrow) {
      throw new Error("onChatRecovery boom");
    }

    if (this.recoveryOverride) return this.recoveryOverride;
    return {};
  }

  getRecoveryContexts(): ChatRecoveryContext[] {
    return this.recoveryContexts;
  }

  setRecoveryOverride(options: ChatRecoveryOptions): void {
    this.recoveryOverride = options;
  }

  setRecoveryShouldThrowForTest(shouldThrow: boolean): void {
    this.recoveryShouldThrow = shouldThrow;
  }

  /** Configure recovery with a built-in `shouldKeepRecovering` predicate.
   *  Functions can't cross the RPC boundary, so this sets the predicate in-DO
   *  rather than accepting one through `setChatRecoveryConfigForTest`. */
  setShouldKeepRecoveringForTest(keepRecovering: boolean): void {
    this.chatRecovery = { shouldKeepRecovering: () => keepRecovering };
  }

  enableThrowingOnExhaustedForTest(
    maxAttempts: number,
    terminalMessage: string
  ): void {
    this.onExhaustedCalls = 0;
    this.chatRecovery = {
      maxAttempts,
      terminalMessage,
      onExhausted: () => {
        this.onExhaustedCalls++;
        throw new Error("onExhausted boom");
      }
    };
  }

  getOnExhaustedCallsForTest(): number {
    return this.onExhaustedCalls;
  }

  /** Capture the `onExhausted` context for assertions (instead of throwing). */
  enableExhaustedCaptureForTest(
    maxAttempts: number,
    terminalMessage?: string
  ): void {
    this.exhaustedContexts = [];
    this.chatRecovery = {
      maxAttempts,
      ...(terminalMessage ? { terminalMessage } : {}),
      onExhausted: (exhaustedCtx) => {
        this.exhaustedContexts.push(exhaustedCtx);
      }
    };
  }

  getExhaustedContextsForTest(): ChatRecoveryExhaustedContext[] {
    return this.exhaustedContexts;
  }

  setChatRecoveryConfigForTest(config: ChatRecoveryConfig): void {
    this.chatRecovery = config;
  }

  /** Push an incident's `lastAttemptAt` back so a subsequent real-time recovery
   *  isn't collapsed by alarm-debounce (#1637). */
  async ageIncidentForTest(incidentId: string, ms: number): Promise<void> {
    const key = `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`;
    const inc = await this.ctx.storage.get<{ lastAttemptAt: number }>(key);
    if (!inc) return;
    inc.lastAttemptAt -= ms;
    await this.ctx.storage.put(key, inc);
  }

  async seedIncidentForTest(incident: {
    incidentId: string;
    requestId: string;
    recoveryKind: "retry" | "continue";
    attempt: number;
    maxAttempts: number;
    status: string;
    firstSeenAt: number;
    lastAttemptAt: number;
    lastProgressAt?: number;
    progress?: number;
    workBaseline?: number;
    interruptedAttempts?: number;
    scheduled?: {
      callback: "_chatRecoveryContinue" | "_chatRecoveryRetry";
      targetMessageId?: string;
    };
  }): Promise<void> {
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incident.incidentId)}`,
      incident
    );
  }

  /**
   * Leave the entry an attempt writes before its isolate dies: an
   * `attemptsInFlight` entry from an isolate that no longer exists (#2613). A
   * test isolate never dies, so this is how a test reproduces a real reset.
   */
  async simulateDeadAttemptForTest(incidentId: string): Promise<void> {
    const key = `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`;
    const incident = await this.ctx.storage.get<Record<string, unknown>>(key);
    if (!incident) throw new Error(`No recovery incident ${incidentId}`);
    await this.ctx.storage.put(key, {
      ...incident,
      attemptsInFlight: [
        { isolate: `dead-${crypto.randomUUID()}`, token: crypto.randomUUID() }
      ]
    });
  }

  /** Run a recovery callback through its real entry point. */
  async runRecoveryCallbackForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: Record<string, unknown>
  ): Promise<void> {
    if (callback === "_chatRecoveryContinue") {
      await this._chatRecoveryContinue(data);
    } else {
      await this._chatRecoveryRetry(data);
    }
  }

  async getChatRecoveryIncidentsForTest(): Promise<unknown[]> {
    const entries = await this.ctx.storage.list({
      prefix: "cf:chat-recovery:incident:"
    });
    return [...entries.values()];
  }

  private _forceStableTimeout = false;

  /** A subclass's own answer to "is a client still to answer?". */
  private _clientInteractionOverride: boolean | null = null;

  setPendingClientInteractionForTest(value: boolean | null): void {
    this._clientInteractionOverride = value;
  }

  protected override hasPendingClientInteraction(): boolean {
    return (
      this._clientInteractionOverride ?? super.hasPendingClientInteraction()
    );
  }

  setForceStableTimeoutForTest(value: boolean): void {
    this._forceStableTimeout = value;
  }

  /** Holds the next waitUntilStable until released, then times it out. */
  private _stableHold: {
    waiting: boolean;
    released: Promise<void>;
    release: () => void;
  } | null = null;

  /** The protected "cancel whatever is running". */
  abortAllRequestsForTest(): void {
    this.abortAllRequests();
  }

  holdStableWaitForTest(): void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._stableHold = { waiting: false, released, release };
  }

  isStableWaitHeldForTest(): boolean {
    return this._stableHold?.waiting ?? false;
  }

  releaseStableWaitForTest(): void {
    this._stableHold?.release();
    this._stableHold = null;
  }

  /** Makes waitUntilStable throw, as a bug inside a recovery attempt would. */
  private _stableWaitError: string | null = null;

  setStableWaitErrorForTest(message: string | null): void {
    this._stableWaitError = message;
  }

  override async waitUntilStable(options?: {
    timeout?: number;
    pendingInteraction?: () => boolean;
  }): Promise<boolean> {
    if (this._forceStableTimeout) return false;
    if (this._stableWaitError) throw new Error(this._stableWaitError);
    const hold = this._stableHold;
    if (hold && !hold.waiting) {
      hold.waiting = true;
      await hold.released;
      return false;
    }
    return super.waitUntilStable(options);
  }

  /**
   * The chat turns' Task runs not yet settled: a turn a replay could
   * recover. A run started only for a recovery attempt is not one.
   */
  private _startedFailingTurn: Promise<string> | null = null;

  /**
   * Start a turn whose reply fails with `message`, and return once its run
   * waits for its next attempt (hold that wait with a `retry-after` header).
   * Returns the turn's request id; `startedFailingTurnStatusForTest` gives
   * how it ended.
   */
  async startFailingReaderTurnForTest(
    message: string,
    turns: number,
    options: {
      responseHeaders?: Record<string, string>;
      /** How far ahead the next attempt must be for the turn to count as waiting. */
      waitsAtLeastMs?: number;
    } = {}
  ): Promise<string> {
    this._failingTurn = {
      message,
      remaining: turns,
      prelude: "partial",
      responseHeaders: options.responseHeaders
    };
    this._startedFailingTurn = this.saveMessages((current) => [
      ...current,
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "tell me a long story" }]
      }
    ]).then(
      (result) => result.status,
      (error) => `threw: ${String(error)}`
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [waiting] = this.sql<{ run_id: string }>`
        SELECT run_id FROM cf_agents_task_runs
        WHERE lane = 'chat' AND status IN ('pending', 'running')
          AND next_at > ${Date.now() + (options.waitsAtLeastMs ?? 5_000)}
      `;
      if (waiting) return waiting.run_id;
      if (Date.now() > deadline) {
        throw new Error("the failing turn's run never waited for a retry");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** How the turn `startFailingReaderTurnForTest` started ended. */
  async startedFailingTurnStatusForTest(): Promise<string> {
    if (!this._startedFailingTurn) throw new Error("no turn was started");
    return this._startedFailingTurn;
  }

  /**
   * End the wait of every chat turn that waits for its next attempt: the
   * attempt is made due and the alarm run. Returns how many waited.
   */
  async endRetryWaitsForTest(): Promise<number> {
    const past = Date.now() - 1_000;
    const waiting = this.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agents_task_runs
      WHERE lane = 'chat' AND status IN ('pending', 'running')
        AND next_at > ${Date.now() + 1_000}
    `;
    for (const { run_id } of waiting) {
      this.sql`
        UPDATE cf_agents_task_runs SET next_at = ${past}
        WHERE run_id = ${run_id}
      `;
      this.sql`
        UPDATE cf_agents_jobs SET time = ${past}
        WHERE id = ${`task:${run_id}`}
      `;
    }
    if (waiting.length > 0) await this.alarm();
    return waiting.length;
  }

  /** Chat turn runs of the chat lane that have not ended. */
  openChatLaneRunsForTest(): number {
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE lane = 'chat' AND status IN ('pending', 'running')
      `[0]?.count ?? 0
    );
  }

  openChatTurnRunsForTest(): number {
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE definition = '__cf_internal_chat_turn'
          AND json_extract(metadata, '$.callback') IS NULL
          AND status IN ('pending', 'running')
      `[0]?.count ?? 0
    );
  }

  /**
   * Drive a turn that is cut off, and stop its request as soon as the
   * turn's result is back: before its run starts waiting out the recovery's
   * backoff.
   *
   * @returns `backingOffAtStop`: how many runs were already backing off
   *   when the stop was issued (0 when the stop landed in the window).
   */
  async driveFailingReaderTurnThenStopForTest(
    message: string,
    options: { responseHeaders?: Record<string, string> } = {}
  ): Promise<{
    status: SaveMessagesResult["status"];
    requestId: string;
    backingOffAtStop: number;
  }> {
    this._failingTurn = {
      message,
      remaining: 2,
      prelude: "partial",
      responseHeaders: options.responseHeaders,
      statusCode: undefined
    };
    const result = await this.saveMessages((current) => [
      ...current,
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "tell me a long story" }]
      }
    ]);
    const backingOffAtStop = this.backingOffChatTurnRunsForTest();
    await cancelTurn(this["_chatDeps"](), result.requestId);
    return {
      status: result.status,
      requestId: result.requestId,
      backingOffAtStop
    };
  }

  /**
   * Chat-turn Task runs not yet settled, a recovery attempt's own run
   * included.
   */
  chatTurnRunsInFlightForTest(): number {
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE definition = '__cf_internal_chat_turn'
          AND status IN ('pending', 'running')
      `[0]?.count ?? 0
    );
  }

  isChatResponseDrainIdleForTest(): boolean {
    return chatResponseDrainIdleForTest(this);
  }

  /** How many chat-turn runs are waiting out a recovery's backoff. */
  backingOffChatTurnRunsForTest(): number {
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE definition = '__cf_internal_chat_turn'
          AND status = 'pending' AND wait_reason = 'sleep'
      `[0]?.count ?? 0
    );
  }

  /**
   * End the backoff of every chat-turn run that is waiting one out, and run
   * it, as its wake would once the time had passed. A test holds a
   * recovery's backoff by giving the failure a long `retry-after`, and ends
   * it here when it wants the attempt to run.
   *
   * @returns How many runs were waiting.
   */
  async endRecoveryBackoffsForTest(): Promise<number> {
    const past = Date.now() - 1_000;
    const waiting = this.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agents_task_runs
      WHERE definition = '__cf_internal_chat_turn'
        AND status = 'pending' AND wait_reason = 'sleep'
    `;
    for (const { run_id } of waiting) {
      this.sql`
        UPDATE cf_agents_task_steps SET next_at = ${past}
        WHERE run_id = ${run_id} AND kind = 'sleep' AND state = 'waiting'
      `;
      this.sql`
        UPDATE cf_agents_task_runs SET next_at = ${past}
        WHERE run_id = ${run_id}
      `;
      this.sql`
        UPDATE cf_agents_jobs SET time = ${past}
        WHERE id = ${`task:${run_id}`}
      `;
    }
    if (waiting.length > 0) await this.alarm();
    return waiting.length;
  }

  /** Run every open chat-turn Task run now, as a later wake would. */
  async runOpenChatTurnRunsForTest(): Promise<void> {
    const past = Date.now() - 1_000;
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${past}
      WHERE definition = '__cf_internal_chat_turn'
        AND status IN ('pending', 'running')
    `;
    this.sql`
      UPDATE cf_agents_task_steps SET next_at = ${past}
      WHERE run_id IN (
        SELECT run_id FROM cf_agents_task_runs
        WHERE definition = '__cf_internal_chat_turn'
      )
    `;
    this.sql`
      UPDATE cf_agents_jobs SET time = ${past} WHERE id LIKE 'task:%'
    `;
    await this.alarm();
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  async rvContinueWithStreamErrorForTest(message: string): Promise<string> {
    this._emitStreamError = message;
    try {
      return (await this.continueLastTurn()).status;
    } finally {
      this._emitStreamError = null;
    }
  }

  async rvIncidentRawForTest(incidentId: string): Promise<unknown> {
    return this.ctx.storage.get(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`
    );
  }

  /**
   * Leave a recovery run as the release enqueued it: a run of the recovery
   * Task, with the options its `chatRecoveryTaskRunOptions` built for a
   * first schedule.
   */
  async seedReleasedRecoveryRunForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry",
    data: Record<string, unknown>,
    delaySeconds: number
  ): Promise<void> {
    const incidentId =
      typeof data.incidentId === "string" ? data.incidentId : undefined;
    await this.tasks.run(
      CHAT_RECOVERY_TASK_NAME,
      { callback, data, delaySeconds },
      {
        retain: false,
        ...(incidentId && {
          idempotencyKey: `chat-recovery:${callback}:${incidentId}${
            typeof data.delivery === "number" ? `:${data.delivery}` : ""
          }`
        }),
        metadata: { callback, ...(incidentId && { incidentId }) },
        start: "alarm"
      }
    );
  }

  /** The open runs of the recovery Task, which only earlier versions enqueue. */
  openReleasedRecoveryRunsForTest(): number {
    return (
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE definition = ${CHAT_RECOVERY_TASK_NAME}
          AND status IN ('pending', 'running')
      `[0]?.count ?? 0
    );
  }

  /** The steps of the open runs that run a continue attempt, by name. */
  recoveryRunStepsForTest(): string[] {
    return pendingRecoveryRunIds(
      this.ctx.storage.sql,
      "_chatRecoveryContinue"
    ).flatMap((runId) =>
      this.sql<{ step_name: string; state: string }>`
        SELECT step_name, state FROM cf_agents_task_steps
        WHERE run_id = ${runId} ORDER BY step_name ASC
      `.map((row) => `${row.step_name}:${row.state}`)
    );
  }

  async getChatRecoveringForTest(): Promise<{ requestId?: string } | null> {
    return (
      (await this.ctx.storage.get<{ requestId?: string }>(
        "cf:chat:recovering"
      )) ?? null
    );
  }

  /** Build the on-connect "recovering…" replay frame (#1620), exactly as
   *  `onConnect` does when no stream is active. `null` when nothing (or only a
   *  stale record) is pending. Used to assert the on-connect convergence. */
  getRecoveringConnectFrameForTest(): Promise<Record<string, unknown> | null> {
    const self = this as unknown as {
      _buildRecoveringConnectFrame(): Promise<Record<string, unknown> | null>;
    };
    return self._buildRecoveringConnectFrame();
  }

  /** Read the durable terminal record (#1645) so tests can assert it is
   *  recorded on exhaustion and cleared once a later turn succeeds. */
  async getPendingChatTerminalForTest(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return (
      (await this.ctx.storage.get<{ requestId: string; body: string }>(
        "cf:chat:last-terminal"
      )) ?? null
    );
  }

  /** Drive a successful turn purely server-side (no client request), the way
   *  an app's own code would via `saveMessages`. Used to verify that a
   *  succeeding programmatic turn supersedes a stale terminal record (#1645). */
  async driveSuccessfulTurnForTest(): Promise<SaveMessagesResult["status"]> {
    const result = await this.saveMessages([
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      }
    ]);
    return result.status;
  }

  /** Number of upcoming turns whose model stream hangs (see
   *  {@link makeHangingSSEResponse}) before reverting to the normal response. */
  private _hangTurnsRemaining = 0;

  /** Configure the live-stream inactivity watchdog (slice 3b, #1626). */
  setChatStreamStallTimeoutForTest(ms: number): void {
    this.chatStreamStallTimeoutMs = ms;
  }

  /** Make the next `hangTurns` model streams hang, for a WebSocket-driven turn. */
  armStallingTurnsForTest(timeoutMs: number, hangTurns: number): void {
    this.chatStreamStallTimeoutMs = timeoutMs;
    this._hangTurnsRemaining = hangTurns;
  }

  private _blockNextAssistantPersist = false;
  private _releaseBlockedPersist: (() => void) | null = null;

  /** Hold the next persist that ends in an assistant message until released. */
  blockNextAssistantPersistForTest(): void {
    this._blockNextAssistantPersist = true;
  }

  isAssistantPersistBlockedForTest(): boolean {
    return this._releaseBlockedPersist !== null;
  }

  releaseAssistantPersistForTest(): void {
    this._releaseBlockedPersist?.();
    this._releaseBlockedPersist = null;
  }

  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ) {
    if (
      this._blockNextAssistantPersist &&
      messages.at(-1)?.role === "assistant"
    ) {
      this._blockNextAssistantPersist = false;
      await new Promise<void>((resolve) => {
        this._releaseBlockedPersist = resolve;
      });
    }
    await super.persistMessages(messages, excludeBroadcastIds, options);
    // A stop that lands right after a turn's messages are stored.
    if (this._abortAfterUserPersist && messages.at(-1)?.role === "user") {
      const controller = this._abortAfterUserPersist;
      this._abortAfterUserPersist = null;
      controller.abort(new Error("stopped after the messages were stored"));
    }
  }

  private _abortAfterUserPersist: AbortController | null = null;

  /**
   * Drive a turn whose model stream hangs after a partial, with a short stall
   * timeout configured, so the inactivity watchdog fires and routes the turn
   * into bounded recovery. `hangTurns` controls how many turns hang (1 = only
   * the first attempt hangs, so a scheduled continuation would complete).
   * Returns the server-side turn status (`"aborted"` once the stall is routed).
   */
  async driveStallingTurnForTest(options?: {
    timeoutMs?: number;
    hangTurns?: number;
  }): Promise<SaveMessagesResult["status"]> {
    this.chatStreamStallTimeoutMs = options?.timeoutMs ?? 50;
    this._hangTurnsRemaining = options?.hangTurns ?? 1;
    const result = await this.saveMessages([
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "tell me a long story" }]
      }
    ]);
    return result.status;
  }

  private _failingTurn: {
    message: string;
    remaining: number;
    prelude: FailingReaderPrelude;
    responseHeaders?: Record<string, string>;
    statusCode?: number;
  } | null = null;
  private _failingReaderCalls = 0;
  private _streamTextProviderError: {
    statusCode: number;
    rethrow: boolean;
  } | null = null;

  /** Run one turn through `streamText` against a provider failing with `statusCode`. */
  async driveStreamTextProviderErrorForTest(
    statusCode: number,
    rethrow: boolean
  ): Promise<SaveMessagesResult["status"]> {
    this._streamTextProviderError = { statusCode, rethrow };
    const result = await this.saveMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "hello" }]
      }
    ]);
    return result.status;
  }

  private _transientInRecoveryOnce = false;
  private _throwsBeforeHandoff = 0;
  private _transientThrown = false;

  /**
   * Make the next recovery's `continueLastTurn` throw a transient error,
   * then its replacement attempt's `onChatRecovery` throw one
   * `throwsBeforeHandoff` times, before it hands off.
   */
  armTransientInRecoveryForTest(throwsBeforeHandoff = 0): void {
    this._transientInRecoveryOnce = true;
    this._throwsBeforeHandoff = throwsBeforeHandoff;
    // The replacement's leaf check, before its handoff, throws.
    const self = this as unknown as { _recoveryLeaf(): unknown };
    const leaf = self._recoveryLeaf.bind(this);
    self._recoveryLeaf = () => {
      if (this._transientThrown && this._throwsBeforeHandoff > 0) {
        this._throwsBeforeHandoff--;
        throw new Error("Network connection lost.");
      }
      return leaf();
    };
  }

  /** How many of the replacement's throws before its handoff are left. */
  throwsBeforeHandoffLeftForTest(): number {
    return this._throwsBeforeHandoff;
  }

  /**
   * The open runs started only to run a recovery attempt, as `status` or
   * `status:waitReason`.
   */
  openAttemptRunsForTest(): string[] {
    return this.sql<{ status: string; wait_reason: string | null }>`
      SELECT status, wait_reason FROM cf_agents_task_runs
      WHERE definition = '__cf_internal_chat_turn'
        AND json_extract(metadata, '$.callback') IS NOT NULL
        AND status IN ('pending', 'running')
    `.map((row) =>
      row.wait_reason ? `${row.status}:${row.wait_reason}` : row.status
    );
  }

  /** Run every open attempt run now, as its later wake would. */
  async runOpenAttemptRunsForTest(): Promise<void> {
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${Date.now() - 1_000}
      WHERE definition = '__cf_internal_chat_turn'
        AND json_extract(metadata, '$.callback') IS NOT NULL
        AND status IN ('pending', 'running')
    `;
    await this.tasks.runDue("__cf_internal_chat_turn");
  }

  protected override async continueLastTurn(
    body?: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<SaveMessagesResult> {
    if (this._transientInRecoveryOnce && options?.signal) {
      this._transientInRecoveryOnce = false;
      this._transientThrown = true;
      throw new Error("Network connection lost.");
    }
    return super.continueLastTurn(body, options);
  }

  getFailingReaderCallsForTest(): number {
    return this._failingReaderCalls;
  }

  /**
   * Make the next turn's first attempt stream a little and fail with a
   * provider asking for a minute's wait: the turn waits to be recovered
   * until `endRetryWaitsForTest()`.
   */
  armHeldFailingTurnForTest(message: string): void {
    this._failingTurn = {
      message,
      remaining: 1,
      prelude: "partial",
      responseHeaders: { "retry-after": "60" }
    };
  }

  /** Make the next turn's reader throw `message` after `prelude`. */
  armFailingReaderTurnForTest(
    message: string,
    prelude: FailingReaderPrelude
  ): void {
    this._failingTurn = { message, remaining: 1, prelude };
  }

  /**
   * Drive a turn whose response reader throws `message` after `prelude`.
   * `turns` controls how many attempts fail before the normal response;
   * `priorAssistant` seeds an earlier answered exchange first.
   */
  async driveFailingReaderTurnForTest(
    message: string,
    turns = 1,
    options: {
      prelude?: FailingReaderPrelude;
      priorAssistant?: boolean;
      responseHeaders?: Record<string, string>;
      statusCode?: number;
    } = {}
  ): Promise<SaveMessagesResult["status"]> {
    if (options.priorAssistant) {
      await this.persistMessages([
        {
          id: "prior-user",
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        },
        {
          id: "prior-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Earlier answer." }]
        }
      ]);
    }
    this._failingTurn = {
      message,
      remaining: turns,
      prelude: options.prelude ?? "partial",
      responseHeaders: options.responseHeaders,
      statusCode: options.statusCode
    };
    const result = await this.saveMessages((current) => [
      ...current,
      {
        id: `u-${crypto.randomUUID()}`,
        role: "user",
        parts: [{ type: "text", text: "tell me a long story" }]
      }
    ]);
    return result.status;
  }

  /**
   * An agent-tool run on an agent that already holds a request body from
   * its own client. With `recovered`, the run's reply is cut off once and
   * chat recovery finishes it. Returns the stored body once the run is
   * over.
   */
  async storedBodyAfterAgentToolRunForTest(recovered: boolean): Promise<{
    status: string | undefined;
    body: Record<string, unknown> | undefined;
  }> {
    await this._setRequestContext({ body: { theme: "dark" } });
    const runId = crypto.randomUUID();
    if (recovered) {
      this._failingTurn = {
        message: "Network connection lost.",
        remaining: 1,
        prelude: "partial"
      };
    }
    await this.startAgentToolRun("the run's own input", { runId });
    const deadline = Date.now() + 8000;
    let inspection = await this.inspectAgentToolRun(runId);
    while (inspection?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await this.inspectAgentToolRun(runId);
    }
    await this.waitUntilStable({ pendingInteraction: () => false });
    return { status: inspection?.status, body: this._lastBody };
  }

  /** The request id of the turn `onChatResponse` last started. */
  private _followUpRequestId: string | undefined;

  /**
   * An agent-tool run on an agent whose `onChatResponse` starts a turn of
   * its own once the run's reply completes. With `recovered`, the run's
   * reply is cut off once and chat recovery finishes it. Returns which
   * request the run's row names, and whose chunks the run reports.
   */
  async agentToolRunWithFollowUpTurnForTest(recovered: boolean): Promise<{
    status: string | undefined;
    rowIsFollowUp: boolean;
    followUpRan: boolean;
    followUpChunksInRun: number;
  }> {
    const runId = crypto.randomUUID();
    if (recovered) {
      this._failingTurn = {
        message: "Network connection lost.",
        remaining: 1,
        prelude: "partial"
      };
    }
    this._saveFromNextResponse = true;
    this._followUpRequestId = undefined;
    await this.startAgentToolRun("answer, then a follow-up follows", { runId });
    const deadline = Date.now() + 8000;
    let inspection = await this.inspectAgentToolRun(runId);
    while (
      (inspection?.status === "running" || !this._followUpRequestId) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await this.inspectAgentToolRun(runId);
    }
    await this.waitUntilStable({ pendingInteraction: () => false });
    const followUp = this._followUpRequestId;
    const row = this["_agentToolRuns"].store.read(runId);
    const followUpStream = followUp
      ? this["_releasedStreams"].latestStreamInfoForRequest(followUp)?.id
      : undefined;
    return {
      status: inspection?.status,
      rowIsFollowUp: followUp !== undefined && row?.requestId === followUp,
      followUpRan: followUp !== undefined,
      followUpChunksInRun:
        followUpStream !== undefined &&
        (await this.inspectAgentToolRun(runId))?.streamId === followUpStream
          ? (await this.getAgentToolChunks(runId)).length
          : 0
    };
  }

  /**
   * An agent-tool run's reply is cut off, so the run is left open for chat
   * recovery, with a parent tailing it. Then the run's request is stopped
   * on the child, one of the ways an app or a client can stop it.
   */
  async stopLeftOpenAgentToolRunForTest(
    how: "abortRequest" | "abortAllRequests" | "client-cancel"
  ): Promise<{
    beforeStop: string | undefined;
    status: string | undefined;
    error: string | undefined;
    tailClosed: boolean;
    readerCalls: number;
  }> {
    const runId = crypto.randomUUID();
    this._failingTurn = {
      message: "Network connection lost.",
      remaining: 1,
      prelude: "partial"
    };
    await this.startAgentToolRun("get cut off, then stopped", { runId });
    const runs = this["_agentToolRuns"];
    // A parent's tail of the run. `tailClosed` flips when it ends.
    let tailClosed = false;
    const reader = (
      (await this.tailAgentToolRun(runId, {
        afterSequence: -1
      })) as unknown as ReadableStream<Uint8Array>
    ).getReader();
    void (async () => {
      try {
        while (!(await reader.read()).done) {
          // Drain.
        }
      } catch {
        // A broken tail has ended too.
      }
      tailClosed = true;
    })();

    const deadline = Date.now() + 8000;
    while (runs.isLive(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const beforeStop = runs.store.read(runId)?.status;
    const requestId = runs.store.read(runId)?.requestId;
    if (!requestId) throw new Error("the run never bound a request");
    const readerCalls = this._failingReaderCalls;

    if (how === "abortRequest") {
      this.abortRequest(requestId, "stopped");
    } else if (how === "abortAllRequests") {
      this.abortAllRequests("stopped");
    } else {
      // What the `cancel` WebSocket message does.
      await cancelTurn(this["_chatDeps"](), requestId);
    }
    // Long enough for a recovery that was not cancelled to run.
    const tailDeadline = Date.now() + 3000;
    while (!tailClosed && Date.now() < tailDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const closedBeforeInspect = tailClosed;
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Read the row, not an inspection: an inspection would settle it.
    const row = runs.store.read(runId);
    return {
      beforeStop,
      status: row?.status,
      error: row?.error ?? undefined,
      tailClosed: closedBeforeInspect,
      readerCalls: this._failingReaderCalls - readerCalls
    };
  }

  /**
   * An agent-tool run whose reply is cut off once (the reader throws after a
   * partial reply) and is then finished by chat recovery, in one isolate.
   */
  async agentToolRunWithFailingReaderForTest(): Promise<{
    afterCutOff: string | undefined;
    final: string | undefined;
    summary: string | undefined;
    readerCalls: number;
  }> {
    const runId = crypto.randomUUID();
    this._failingTurn = {
      message: "Network connection lost.",
      remaining: 1,
      prelude: "partial"
    };
    await this.startAgentToolRun("tell me a long story", { runId });
    const runs = this["_agentToolRuns"];
    const deadline = Date.now() + 8000;
    // The run's own lifecycle ends when its turn hands back.
    while (runs.isLive(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const afterCutOff = runs.store.read(runId)?.status;
    let inspection = await this.inspectAgentToolRun(runId);
    while (inspection?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      inspection = await this.inspectAgentToolRun(runId);
    }
    return {
      afterCutOff,
      final: inspection?.status,
      summary: inspection?.summary,
      readerCalls: this._failingReaderCalls
    };
  }

  /**
   * Drive an aborted turn purely server-side (no client request), through
   * the caller's signal. `"after-store"` stops it once its messages are
   * stored and before the model is called: the conversation moved, so the
   * turn supersedes a stale terminal record (#1645). `"before"` passes a
   * signal that is already aborted: the turn does nothing.
   */
  async driveAbortedTurnForTest(
    when: "before" | "after-store" = "after-store"
  ): Promise<{
    status: SaveMessagesResult["status"];
    userTexts: string[];
    chatCalls: number;
  }> {
    const controller = new AbortController();
    if (when === "before") {
      controller.abort(new Error("pre-aborted"));
    } else {
      this._abortAfterUserPersist = controller;
    }
    const callsBefore = this.onChatMessageCallCount;
    const result = await this.saveMessages(
      (messages) => [
        ...messages,
        {
          id: `u-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        }
      ],
      { signal: controller.signal }
    );
    this._abortAfterUserPersist = null;
    return {
      status: result.status,
      userTexts: this.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
        ),
      chatCalls: this.onChatMessageCallCount - callsBefore
    };
  }

  /** Drive a turn that ends in a terminal (non-recovered) stream error — the
   *  way a provider 500 arrives as an SSE `error` part. Used to verify the
   *  error is durably recorded so it replays to a reconnecting client (#1645),
   *  matching Think. Returns the resulting status (`"error"`). */
  async driveErroredTurnForTest(
    message: string
  ): Promise<SaveMessagesResult["status"]> {
    this._emitStreamError = message;
    try {
      const result = await this.saveMessages([
        {
          id: `u-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        }
      ]);
      return result.status;
    } finally {
      this._emitStreamError = null;
    }
  }

  async getIncidentForTest(incidentId: string): Promise<{
    attempt: number;
    status: string;
    reason?: string;
    startedDelivery?: number;
  } | null> {
    const incident = await this.ctx.storage.get<{
      attempt: number;
      status: string;
      reason?: string;
      startedDelivery?: number;
    }>(`cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`);
    return incident
      ? {
          attempt: incident.attempt,
          status: incident.status,
          reason: incident.reason,
          ...(incident.startedDelivery !== undefined && {
            startedDelivery: incident.startedDelivery
          })
        }
      : null;
  }

  /**
   * Simulate forward recovery progress by persisting one assistant message
   * (what `_persistOrphanedStream` does after a partial). Used to exercise the
   * progress-aware attempt-budget reset in `_beginChatRecoveryIncident`.
   */
  async addAssistantMessageForTest(id: string): Promise<void> {
    const message = {
      id,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "progress" }]
    };
    this.messages = [...this.messages, message];
    await this.persistMessages(this.messages);
  }

  /** Persist an assistant message parked on a tool's `input-available` orphan,
   *  to exercise the pending-CLIENT-interaction recovery exemption. The tool is
   *  treated as client-resolvable only if its name was registered via
   *  `setRequestContextForTest`. */
  async persistPendingToolCallForTest(
    messageId: string,
    toolName: string,
    options: { cutOff?: boolean } = {}
  ): Promise<void> {
    const reply: ChatMessage = {
      id: messageId,
      role: "assistant" as const,
      parts: [
        {
          type: `tool-${toolName}`,
          toolCallId: `call_${messageId}`,
          state: "input-available",
          input: {}
        }
      ] as ChatMessage["parts"]
    };
    // A reply whose stream was cut off is settled before it is stored, the
    // way `_reply` and the orphan path store one.
    await this.persistMessages([
      options.cutOff
        ? (
            this as unknown as {
              _settleInterruptedReply(message: ChatMessage): ChatMessage;
            }
          )._settleInterruptedReply(reply)
        : reply
    ]);
  }

  /** Simulate recovery forward progress: advance the durable progress counter
   *  exactly as `_persistOrphanedStream` does when it materializes a non-empty
   *  partial. The recovery budget keys off this counter (not the live message
   *  count), so this is how a test marks "the turn advanced". */
  async bumpRecoveryProgressForTest(): Promise<void> {
    // One explicit credit — the same unit a flushed segment or a forwarded
    // child chunk adds to the derived marker.
    this["_releasedStreams"].creditProgress();
  }

  /** The recovery progress marker as the engine would read it now. */
  async readProgressMarkerForTest(): Promise<number> {
    return this["_releasedStreams"].progressMarker();
  }

  /** Simulate a parent re-attach that forwards `chunks` of a child's stream by
   *  driving the real `_forwardAgentToolStream` over a synthetic child stream.
   *  The in-memory throttle is reset first so this models a fresh post-restart
   *  isolate. Returns the durable recovery-progress counter before/after so a
   *  test can assert forwarding child output credits the PARENT's progress
   *  marker (N9) — and that a SILENT child (chunks = 0) does NOT. */
  async forwardChildStreamProgressForTest(chunks: number): Promise<{
    start: number;
    after: number;
  }> {
    const self = agentToolsOf(this) as {
      _forwardAgentToolStream(
        stream: ReadableStream<{ body: string }>,
        parentToolCallId: string | undefined,
        runId: string,
        sequence: number
      ): Promise<number>;
    };
    const read = async (): Promise<number> =>
      this["_releasedStreams"].progressMarker();
    const start = await read();
    const bodies = Array.from({ length: chunks }, (_, i) => ({
      body: `chunk-${i}`
    }));
    const stream = new ReadableStream<{ body: string }>({
      start(controller) {
        for (const b of bodies) controller.enqueue(b);
        controller.close();
      }
    });
    await self._forwardAgentToolStream(stream, undefined, "n9-probe-run", 1);
    const after = await read();
    return { start, after };
  }

  /** Simulate compaction collapsing the transcript by dropping all assistant
   *  messages from the live cache. Used to prove the recovery progress signal
   *  is compaction-immune (#1628). */
  async dropAssistantMessagesForTest(): Promise<void> {
    this.messages = this.messages.filter((m) => m.role !== "assistant");
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  getPartialText(streamId?: string) {
    const id = streamId ?? this["_releasedStreams"].activeStreamId ?? undefined;
    if (!id) return { text: "", parts: [] };
    return aiSdkRecoveryCodec.toRecoveryPartial(
      this["_releasedStreams"].getStreamChunks(id).map((chunk) => chunk.body)
    );
  }

  async callContinueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn(body);
  }

  private async _runQueuedRecoveryTaskForTest(
    callback: "_chatRecoveryContinue" | "_chatRecoveryRetry"
  ): Promise<boolean> {
    const runId = pendingRecoveryRunIds(this.ctx.storage.sql, callback)[0];
    if (!runId) return false;
    const past = Date.now() - 1_000;
    this.sql`
      UPDATE cf_agents_task_runs
      SET next_at = ${past},
          input = CASE
            WHEN json_type(input, '$.attempt') = 'object'
              THEN json_set(input, '$.attempt.delaySeconds', 0)
            ELSE json_set(input, '$.delaySeconds', 0)
          END
      WHERE run_id = ${runId}
    `;
    this.sql`
      UPDATE cf_agents_task_steps SET next_at = ${past}
      WHERE run_id = ${runId} AND kind = 'sleep'
    `;
    this.sql`
      UPDATE cf_agents_jobs SET time = ${past}
      WHERE id = ${`task:${runId}`}
    `;
    await this.alarm();
    await this.waitUntilStable({ pendingInteraction: () => false });
    return true;
  }

  async runScheduledRecoveryRetryForTest(): Promise<void> {
    if (await this._runQueuedRecoveryTaskForTest("_chatRecoveryRetry")) return;
    const rows = this.sql<{ payload: string }>`
      SELECT json_extract(payload, '$.payload') AS payload FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = '_chatRecoveryRetry'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) {
      await this.waitUntilStable({ pendingInteraction: () => false });
      return;
    }
    await this._chatRecoveryRetry(
      JSON.parse(rows[0].payload) as {
        targetUserId?: string;
        lastBody?: Record<string, unknown>;
        lastClientTools?: ClientToolSchema[];
      }
    );
  }

  async runScheduledRecoveryContinueForTest(): Promise<void> {
    if (await this._runQueuedRecoveryTaskForTest("_chatRecoveryContinue")) {
      return;
    }
    const rows = this.sql<{ payload: string }>`
      SELECT json_extract(payload, '$.payload') AS payload FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = '_chatRecoveryContinue'
      ORDER BY time ASC
      LIMIT 1
    `;
    if (!rows[0]) {
      await this.waitUntilStable({ pendingInteraction: () => false });
      return;
    }
    await this._chatRecoveryContinue(
      JSON.parse(rows[0].payload) as {
        targetAssistantId?: string;
        lastBody?: Record<string, unknown> | null;
        lastClientTools?: ClientToolSchema[] | null;
      }
    );
  }

  /** The request context stored for later turns. */
  getRequestContextForTest(): {
    body: Record<string, unknown> | undefined;
    clientTools: ClientToolSchema[] | undefined;
  } {
    return { body: this._lastBody, clientTools: this._lastClientTools };
  }

  async setRequestContextForTest(
    body?: Record<string, unknown>,
    clientTools?: ClientToolSchema[]
  ): Promise<void> {
    await this._setRequestContext({ body, clientTools });
  }

  /**
   * Leave the request context the way an earlier release did: rows in
   * `cf_ai_chat_request_context` and no session value. Reset the isolate
   * next, so the start reads them the way it does after an upgrade.
   */
  async seedLegacyRequestContextForTest(
    lastClientTools: string | null,
    lastBody: string | null
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cf_ai_chat_request_context (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    // Null for both: the empty table every earlier release created.
    if (lastClientTools !== null && lastBody !== null)
      sql.exec(
        "INSERT OR REPLACE INTO cf_ai_chat_request_context (key, value) VALUES ('lastClientTools', ?), ('lastBody', ?)",
        lastClientTools,
        lastBody
      );
    await this.sessions
      .session()
      .internal_setConfig("transcript:chat:request", null);
  }

  /** Reset this agent's isolate, as an eviction does. */
  async resetIsolateForTest(): Promise<void> {
    this.ctx.abort("test: forced reset");
  }

  /** What this isolate holds, what is stored, and whether the old table is left. */
  async requestContextStateForTest(): Promise<{
    clientTools: string[] | null;
    body: string | null;
    stored: string | null;
    tableLeft: boolean;
  }> {
    await untilRequestContextCarried(this.ctx.storage.sql);
    return {
      clientTools: this._lastClientTools?.map((tool) => tool.name) ?? null,
      body: JSON.stringify(this._lastBody ?? null),
      stored: await this.sessions
        .session()
        .internal_config("transcript:chat:request"),
      tableLeft:
        this.ctx.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name = 'cf_ai_chat_request_context'"
          )
          .toArray().length > 0
    };
  }

  /** The next turn's response reader throws `message` after a partial. */
  armFailingReaderForTest(message: string): void {
    this._failingTurn = { message, remaining: 1, prelude: "partial" };
  }

  private _endBeforeReply: "nothing" | "throw" | null = null;

  /** The next `onChatMessage` returns no response, or throws. */
  endNextTurnBeforeReplyForTest(how: "nothing" | "throw"): void {
    this._endBeforeReply = how;
  }

  /** Call `continueLastTurn` the way an app does. */
  async continueLastTurnForTest(): Promise<string> {
    try {
      return (await this.continueLastTurn()).status;
    } catch (error) {
      return `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** The stored request context: what the chat's next turn would run with. */
  getStoredRequestContextForTest(): {
    body: Record<string, unknown> | null;
    clientTools: string[] | null;
  } {
    return {
      body: this._lastBody ?? null,
      clientTools: this._lastClientTools?.map((tool) => tool.name) ?? null
    };
  }

  private _pinnedTurnForTest: Promise<SaveMessagesResult> | null = null;

  /** Start a turn whose caller pins its own body, as an agent-tool run does. */
  startPinnedTurnForTest(body: Record<string, unknown>): void {
    // A server turn that brings its own body and no client tools (as an
    // agent-tool run's turn does): the chat module's turn on the lane.
    this._pinnedTurnForTest = (
      this as unknown as {
        _serverTurn(input: ChatTurnInput): Promise<SaveMessagesResult>;
      }
    )._serverTurn({
      trigger: "server",
      messages: [
        {
          id: `pinned-${crypto.randomUUID()}`,
          role: "user",
          parts: [{ type: "text", text: "pinned turn" }]
        }
      ],
      body,
      clientTools: []
    });
  }

  async awaitPinnedTurnForTest(): Promise<string> {
    return (await this._pinnedTurnForTest)?.status ?? "none";
  }

  private _clearDuringResponseHook = false;

  /** A clear lands while the next `onChatResponse` runs. */
  clearDuringNextResponseHookForTest(): void {
    this._clearDuringResponseHook = true;
  }

  async saveSyntheticUserMessage(
    text: string
  ): Promise<{ requestId: string; status: string }> {
    return this.saveMessages((messages) => [
      ...messages,
      {
        id: `synth-${crypto.randomUUID()}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text }]
      }
    ]);
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getOnChatMessageBodies(): Array<Record<string, unknown> | undefined> {
    return this.onChatMessageBodies;
  }

  getOnChatMessageClientTools(): Array<ClientToolSchema[] | undefined> {
    return this.onChatMessageClientTools;
  }

  getRecoveryTransportCountsForTest(callback: string): {
    tasks: number;
    schedules: number;
  } {
    const schedules = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = ${callback}
    `;
    const tasks = [
      { count: pendingRecoveryRunIds(this.ctx.storage.sql, callback).length }
    ];
    return {
      tasks: tasks[0]?.count ?? 0,
      schedules: schedules[0]?.count ?? 0
    };
  }

  private _recoveryTaskKeyed: boolean[] = [];

  getRecoveryTaskKeyedForTest(): boolean[] {
    return this._recoveryTaskKeyed;
  }

  /** The backoff, in seconds, of the recovery attempt scheduled last. */
  getScheduledRecoveryDelayForTest(): number | null {
    return (
      // An attempt run's input, or the attempt a turn's run journaled.
      this.sql<{ delay: number | null }>`
        SELECT delay FROM (
          SELECT json_extract(input, '$.attempt.delaySeconds') AS delay,
                 created_at
          FROM cf_agents_task_runs
          WHERE json_extract(input, '$.attempt.callback') IS NOT NULL
          UNION ALL
          SELECT json_extract(result, '$.delaySeconds') AS delay, updated_at
          FROM cf_agents_task_steps
          WHERE step_name = 'model-turn'
            AND json_extract(result, '$.callback') IS NOT NULL
        )
        ORDER BY created_at DESC
        LIMIT 1
      `[0]?.delay ?? null
    );
  }

  getScheduleCountForCallback(callback: string): number {
    const scheduled = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_jobs
      WHERE capability = 'scheduler' AND fn = ${callback}
    `;
    const tasks = [
      { count: pendingRecoveryRunIds(this.ctx.storage.sql, callback).length }
    ];
    return (scheduled[0]?.count ?? 0) + (tasks[0]?.count ?? 0);
  }

  getRunFiberCountForTest(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition IN ('__cf_fiber', '__cf_managed_fiber')
        AND status IN ('pending', 'running')
    `;
    return rows[0]?.count ?? 0;
  }

  /**
   * Run the real DO alarm handler (schedule dispatch + one-shot row delete).
   * Swallows a thrown alarm the way the platform does — workerd absorbs a
   * rejected alarm and retries it later under the at-least-once guarantee — so
   * tests can inspect the post-alarm state.
   */
  async runAlarmForTest(): Promise<void> {
    try {
      await (this as unknown as { alarm(): Promise<void> }).alarm();
    } catch {
      // Platform absorbs and retries; intentionally swallowed for inspection.
    }
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  async triggerInterruptedStreamCheck(): Promise<void> {
    // SAFETY: a test reads whether the restored stream has a reader.
    const live = (this["_releasedStreams"] as unknown as { _isLive: boolean })
      ._isLive;
    if (!this["_releasedStreams"].hasActiveStream() || live) {
      return;
    }

    const streamId = this["_releasedStreams"].activeStreamId!;
    const requestId = this["_releasedStreams"].activeRequestId ?? "";

    const partial = this.getPartialText(streamId);

    const metadataRows = this.sql<{ created_at: number }>`
      select created_at from cf_agents_streams where stream_id = ${streamId}
    `;
    const createdAt = metadataRows[0]?.created_at ?? Date.now();

    const options =
      (await this.onChatRecovery({
        incidentId: `test:${requestId}`,
        recoveryRootRequestId: requestId,
        attempt: 1,
        maxAttempts: 6,
        recoveryKind: "continue",
        streamId,
        requestId,
        partialText: partial.text,
        partialParts: partial.parts as ChatRecoveryContext["partialParts"],
        recoveryData: null,
        messages: [...this.messages],
        lastBody: this._lastBody,
        lastClientTools: this._lastClientTools,
        createdAt
      })) ?? {};

    if (options.persist !== false) {
      await this._persistOrphanedStream(streamId);
    }

    this["_releasedStreams"].complete(streamId);

    if (options.continue !== false) {
      const targetId = this.messages
        .slice()
        .reverse()
        .find((m) => m.role === "assistant")?.id;
      // As a release scheduled it: under the request it continues.
      await this.schedule(
        0,
        "_chatRecoveryContinue",
        {
          originalRequestId: requestId,
          ...(targetId && { targetAssistantId: targetId })
        },
        { idempotent: true }
      );
    }
  }

  /**
   * Leave an interrupted turn: a chat turn (`CHAT_FIBER_NAME:<requestId>`)
   * as a chat-turn Task run, anything else as a fiber row.
   */
  /**
   * A chat turn's lane run an isolate left: `began` when its model call had
   * begun (its envelope and `stash` in the checkpoint), or still queued.
   */
  async insertInterruptedLaneTurn(
    requestId: string,
    began: boolean,
    stash?: unknown
  ): Promise<void> {
    const nonce = crypto.randomUUID();
    const runId = `chat_${nonce}`;
    await this.tasks.get(runId);
    const checkpoint = began
      ? JSON.stringify({
          snapshot: { __cfAIChatFiberSnapshot: null, user: null },
          ...(stash !== undefined && { stash })
        })
      : null;
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, status, metadata, idempotency_key, retain,
         attempt, next_at, cancel_requested, created_at, updated_at, lane, seq,
         checkpoint)
      VALUES
        (${runId}, ${AIChatAgent.CHAT_FIBER_NAME},
         ${JSON.stringify({ requestId, continuation: false, nonce, lane: true })},
         'pending', ${JSON.stringify({ requestId })},
         NULL, 0, ${began ? 1 : 0}, ${now}, 0, ${now}, ${now}, 'chat', 1,
         ${checkpoint})
    `;
  }

  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown,
    legacySnapshot?: boolean
  ): Promise<void> {
    await insertInterruptedTurnForTest(
      this,
      this.ctx.storage,
      name,
      snapshot,
      legacySnapshot
    );
  }

  /** Replay every interrupted turn, as a wake does. */
  async triggerFiberRecovery(): Promise<void> {
    await recoverInterruptedTurnsForTest(this);
  }

  /** Leave a chat turn's fiber row, as a version before Tasks did. */
  insertLegacyChatFiberForTest(requestId: string, snapshot?: unknown): void {
    createLegacyFiberTableForTest(this.ctx.storage);

    this.sql`
      INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
      VALUES (${`fiber-${crypto.randomUUID()}`},
              ${`${AIChatAgent.CHAT_FIBER_NAME}:${requestId}`},
              ${snapshot ? JSON.stringify(snapshot) : null}, ${Date.now()})
    `;
  }

  insertInterruptedStream(
    streamId: string,
    requestId: string,
    chunks: Array<{ body: string; index: number }>,
    ageMs = 0,
    metadata?: { messageId?: string; continuation?: boolean }
  ): void {
    const createdAt = Date.now() - ageMs;
    // Omitting `metadata.messageId` leaves the field out of the stream
    // metadata, simulating a stream row written before message-id tracking.
    const streamMetadata: Record<string, unknown> = { cfChat: 1 };
    if (metadata?.messageId) streamMetadata.messageId = metadata.messageId;
    if (metadata?.continuation) streamMetadata.isContinuation = 1;
    this.sql`
      insert into cf_agents_streams
        (stream_id, state, tag, metadata, chunk_count, created_at, updated_at)
      values (${streamId}, 'streaming', ${requestId}, ${JSON.stringify(streamMetadata)},
              ${chunks.length}, ${createdAt}, ${createdAt})
    `;
    if (chunks.length > 0) {
      const body = chunks.map((c) => JSON.stringify(c.body)).join(",");
      this.sql`
        insert into cf_agents_stream_blocks
          (stream_id, block, seq_from, seq_to, body, created_at, updated_at)
        values (${streamId}, 0, ${chunks[0].index}, ${chunks[chunks.length - 1].index + 1},
                ${body}, ${createdAt}, ${createdAt})
      `;
    }
    this["_releasedStreams"].restore();
  }

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT run_id AS id, json_extract(input, '$.name') AS name FROM cf_agents_task_runs
      WHERE definition = '__cf_fiber' AND status IN ('pending', 'running')
      ` || []
    );
  }

  /**
   * Seed an in-flight (running) `cf_ai_chat_agent_tool_runs` row, as if this
   * facet were running as an agent-tool child whose turn was interrupted before
   * completing. Used to assert the recovery continuation re-binds the row's
   * `request_id` so the parent's re-attach tail keeps attributing frames.
   */
  async seedAgentToolChildRunForTest(
    runId: string,
    requestId: string,
    startedAt: number = Date.now()
  ): Promise<void> {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${startedAt})
    `;
  }

  /**
   * Seed a SETTLED (terminal) child-run row — `completed` with `completed_at`
   * set — to assert the rebind is a no-op for already-finished runs.
   */
  async seedSettledAgentToolChildRunForTest(
    runId: string,
    requestId: string
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at, completed_at)
      values (${runId}, ${requestId}, 'completed', '{}', ${now}, ${now})
    `;
  }

  /** Directly invoke the rebind helper (bypassing the full recovery flow). */
  async rebindAgentToolChildRunRequestIdForTest(
    requestId: string,
    rootRequestId: string
  ): Promise<void> {
    this["_agentToolRuns"].rebind(requestId, rootRequestId);
  }

  /** The `request_id` currently bound to an agent-tool child run row. */
  async getAgentToolChildRunRequestIdForTest(
    runId: string
  ): Promise<string | null> {
    const rows = this.sql<{ request_id: string | null }>`
      select request_id from cf_ai_chat_agent_tool_runs where run_id = ${runId}
    `;
    return rows[0]?.request_id ?? null;
  }

  /** Resolve which agent-tool run a request id is attributed to (frame routing). */
  async resolveAgentToolRunForRequestForTest(
    requestId: string
  ): Promise<string | null> {
    return this["_agentToolRuns"].runForRequest(requestId);
  }
}

// ── NonChatRecoveryTestAgent (legacy runtime false compatibility) ──

export class NonChatRecoveryTestAgent extends AIChatAgent<Env> {
  // @ts-expect-error `false` is no longer accepted, but stale JavaScript must
  // still take the always-on durable recovery path.
  override chatRecovery: ChatRecoveryConfig = false;
  recoveryContexts: ChatRecoveryContext[] = [];
  onChatMessageCallCount = 0;
  private _stashSucceeded = false;

  async onChatMessage() {
    this.onChatMessageCallCount++;
    this.stash({ source: "legacy-false-config" });
    this._stashSucceeded = true;
    return makeSSEChunkResponse([
      { type: "text-start" },
      { type: "text-delta", delta: "Continued response." },
      { type: "text-end" },
      { type: "finish" }
    ]);
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.recoveryContexts.push(ctx);
    return {};
  }

  getRecoveryContexts(): ChatRecoveryContext[] {
    return this.recoveryContexts;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getStashSucceeded(): boolean {
    return this._stashSucceeded;
  }

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT run_id AS id, json_extract(input, '$.name') AS name FROM cf_agents_task_runs
      WHERE definition = '__cf_fiber' AND status IN ('pending', 'running')
      ` || []
    );
  }

  async callContinueLastTurn(
    body?: Record<string, unknown>
  ): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn(body);
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }
}

// ── RecoveryThrowingAgent (chatRecovery=true, onChatMessage can throw) ──

export class RecoveryThrowingAgent extends AIChatAgent<Env> {
  override chatRecovery: ChatRecoveryConfig = true;
  private _shouldThrow = false;
  onChatMessageCallCount = 0;

  async onChatMessage() {
    this.onChatMessageCallCount++;
    if (this._shouldThrow) {
      throw new Error("Simulated onChatMessage error");
    }
    return makeSSEChunkResponse([
      { type: "text-start" },
      { type: "text-delta", delta: "Success response." },
      { type: "text-end" },
      { type: "finish" }
    ]);
  }

  setShouldThrow(value: boolean): void {
    this._shouldThrow = value;
  }

  private _onErrorSeen: string[] = [];

  override onError(connectionOrError: unknown, error?: unknown): void {
    const cause = error ?? connectionOrError;
    const message = cause instanceof Error ? cause.message : String(cause);
    this._onErrorSeen.push(message);
    throw new Error(`onError(${message})`);
  }

  async callContinueLastTurn(): Promise<{ requestId: string; status: string }> {
    return this.continueLastTurn();
  }

  /**
   * Drive `continueLastTurn` while `onChatMessage` throws, and report what
   * the caller sees and what the turn left behind.
   */
  async testContinueLastTurnWhileThrowing(): Promise<{
    thrown: string | null;
    onErrorSeen: string[];
    liveRecoveryTurns: number;
    checkpointEntries: number;
    fibers: number;
    abortControllers: number;
    queueIdle: boolean;
  }> {
    await this.persistMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi" }] }
    ]);
    this._shouldThrow = true;
    this._onErrorSeen = [];
    let thrown: string | null = null;
    try {
      await this.continueLastTurn();
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    } finally {
      this._shouldThrow = false;
    }
    // The chat module's state once the turn ended: no open turn, no run
    // holding a checkpoint.
    const open = (
      this as unknown as {
        _openChatTurns(): readonly { status: string }[];
      }
    )._openChatTurns();
    return {
      thrown,
      onErrorSeen: [...this._onErrorSeen],
      liveRecoveryTurns: open.length,
      checkpointEntries: this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM cf_agents_task_runs WHERE checkpoint IS NOT NULL
      `[0].n,
      fibers: this.getActiveFibers().length,
      abortControllers: open.filter((run) => run.status === "running").length,
      queueIdle: open.length === 0
    };
  }

  getOnChatMessageCallCount(): number {
    return this.onChatMessageCallCount;
  }

  getPersistedMessages(): Promise<ChatMessage[]> {
    return persistedMessages(this);
  }

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT run_id AS id, json_extract(input, '$.name') AS name FROM cf_agents_task_runs
      WHERE definition = '__cf_fiber' AND status IN ('pending', 'running')
      ` || []
    );
  }

  getAbortControllerCount(): number {
    return this._openChatTurns().filter((run) => run.status === "running")
      .length;
  }

  async waitForIdleForTest(): Promise<void> {
    await this.waitUntilStable({ pendingInteraction: () => false });
  }
}

/** An app whose `onStart` waits for a turn of its own. */
export class OnStartTurnAgent extends TestChatAgent {
  override async onStart(): Promise<void> {
    if (this.messages.length > 0) return;
    await this.saveMessages([
      { id: "on-start", role: "user", parts: [{ type: "text", text: "hi" }] }
    ]);
  }

  rolesForTest(): string[] {
    return this.messages.map((message) => message.role);
  }
}

/**
 * An app whose `onStart` takes a while and whose turns need it done: a
 * request replayed after a reset must not run before the app has started.
 */
export class AsyncStartAdmissionAgent extends SlowStreamAgent {
  private _ready = false;

  override async onStart(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    this._ready = true;
    // Opted in by a test: onStart waits for a turn of its own.
    if (this.ctx.storage.kv.get("onStartTurn") === true) {
      this.ctx.storage.kv.delete("onStartTurn");
      await this.saveMessages((messages) => [
        ...messages,
        { id: "on-start", role: "user", parts: [{ type: "text", text: "hi" }] }
      ]);
    }
  }

  /** The next start's onStart waits for a turn of its own. */
  turnInNextOnStartForTest(): void {
    this.ctx.storage.kv.put("onStartTurn", true);
  }

  override async onChatMessage(
    onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    if (!this._ready) {
      return new Response("not started", {
        headers: { "Content-Type": "text/plain" }
      });
    }
    return super.onChatMessage(onFinish, options);
  }

  /**
   * Store a user message and the record of the request that stored it, as
   * a reset leaves them when it lands before the request's turn started.
   */
  async seedQueuedRequestForTest(requestId: string): Promise<void> {
    const id = `u-${requestId}`;
    await this.tasks.get(requestId);
    // A request waiting on the chat's lane, as a reset leaves it before it
    // started: its turn run, with the question it stores when it starts.
    const input: ChatTurnInput = {
      trigger: "submit-message",
      questionId: id,
      messages: [
        { id, role: "user", parts: [{ type: "text", text: requestId }] }
      ],
      body: { format: "sse", chunkCount: 3, chunkDelayMs: 10 }
    };
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_task_runs
        (run_id, definition, input, status, metadata, idempotency_key, retain,
         attempt, next_at, cancel_requested, created_at, updated_at, lane, seq)
      VALUES
        (${requestId}, ${CHAT_TURN_DEFINITION},
         ${JSON.stringify(input)}, 'pending', NULL,
         NULL, 0, 0, ${now}, 0, ${now}, ${now}, 'chat',
         (SELECT coalesce(MAX(seq), 0) + 1 FROM cf_agents_task_runs
          WHERE lane = 'chat'))
    `;
  }
}

// ── RecoverySlowStreamAgent (SlowStreamAgent with chatRecovery=true) ──

export class RecoverySlowStreamAgent extends SlowStreamAgent {
  override chatRecovery: ChatRecoveryConfig = true;

  getActiveFibers(): Array<{ id: string; name: string }> {
    return (
      this.sql<{ id: string; name: string }>`
        SELECT run_id AS id, json_extract(input, '$.name') AS name FROM cf_agents_task_runs
      WHERE definition = '__cf_fiber' AND status IN ('pending', 'running')
      ` || []
    );
  }

  /**
   * Regression seam for issue #1406: simulates the internal chat fiber
   * wrapper throwing before it invokes its callback (e.g. SQLite error
   * inserting the fiber row). Verifies that the external-signal listener
   * attached by `linkExternal` is still detached and the registry entry is
   * still removed even when the fiber start path fails.
   */
  async testSaveMessagesWithRunFiberFailure(text: string): Promise<{
    threw: boolean;
    abortRegistrySize: number;
    listenerRemovedFromExternal: boolean;
  }> {
    const controller = new AbortController();
    const signal = controller.signal;

    let attached = 0;
    let removed = 0;
    type AddListener = typeof signal.addEventListener;
    type RemoveListener = typeof signal.removeEventListener;
    const originalAdd = signal.addEventListener.bind(signal) as AddListener;
    const originalRemove = signal.removeEventListener.bind(
      signal
    ) as RemoveListener;
    signal.addEventListener = ((
      type: Parameters<AddListener>[0],
      listener: Parameters<AddListener>[1],
      options?: Parameters<AddListener>[2]
    ) => {
      if (type === "abort") attached++;
      (originalAdd as (...args: unknown[]) => void)(type, listener, options);
    }) as AddListener;
    signal.removeEventListener = ((
      type: Parameters<RemoveListener>[0],
      listener: Parameters<RemoveListener>[1],
      options?: Parameters<RemoveListener>[2]
    ) => {
      if (type === "abort") removed++;
      (originalRemove as (...args: unknown[]) => void)(type, listener, options);
    }) as RemoveListener;

    type RunFiberWithStashWrapper = (
      name: string,
      fn: unknown,
      options: unknown
    ) => Promise<unknown>;
    const fiberMethods = this as unknown as {
      _runFiberWithStashWrapper: RunFiberWithStashWrapper;
    };
    const originalRunFiberWithStashWrapper =
      fiberMethods._runFiberWithStashWrapper.bind(
        this
      ) as RunFiberWithStashWrapper;
    fiberMethods._runFiberWithStashWrapper = (() => {
      throw new Error("simulated runFiber failure");
    }) as RunFiberWithStashWrapper;

    // Root turns now start on the tasks capability; stub its internal start
    // path the same way so the simulated failure covers the migrated engine.
    type Run = (...args: unknown[]) => Promise<unknown>;
    const tasksInternal = this.tasks as unknown as { run: Run };
    const originalRun = tasksInternal.run.bind(this.tasks) as Run;
    tasksInternal.run = (() => {
      throw new Error("simulated runFiber failure");
    }) as Run;

    let threw = false;
    try {
      await this.saveMessages(
        [
          ...this.messages,
          {
            id: `runfiber-fail-${crypto.randomUUID()}`,
            role: "user",
            parts: [{ type: "text", text }]
          }
        ],
        { signal }
      );
    } catch {
      threw = true;
    } finally {
      fiberMethods._runFiberWithStashWrapper = originalRunFiberWithStashWrapper;
      tasksInternal.run = originalRun;
    }

    return {
      threw,
      abortRegistrySize: this.getAbortControllerCount(),
      listenerRemovedFromExternal: attached > 0 && attached === removed
    };
  }
}

function delayWithAbort(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeDelayedSSEChunkResponse(
  chunks: ReadonlyArray<Record<string, unknown>>,
  delayMs: number,
  signal?: AbortSignal,
  /** Held before the stream ends, so it stays live until released. */
  beforeEnd?: TestGate | null
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          await delayWithAbort(delayMs, signal);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
          );
        }
        if (beforeEnd) await beforeEnd.pass();
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        if (signal?.aborted) {
          controller.close();
        } else {
          controller.error(error);
        }
      }
    },
    cancel() {}
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

type AgentToolInput = {
  prompt: string;
  delayMs?: number;
  chunkDelayMs?: number;
  structured?: boolean;
  /** Echoed by `getAgentToolOutput` as whether it is still a `Date`. */
  probeDate?: Date;
  /** `getAgentToolOutput` returns a value JSON cannot hold. */
  circularOutput?: boolean;
  streamError?: string;
  /** Text streamed (and persisted) before `streamError`'s error chunk. */
  streamErrorText?: string;
};

const FACET_OOM_TEST_TASK_NAME = "__cf_test_facetRecoveryOom";
const FACET_SLOW_OOM_TEST_TASK_NAME = "__cf_test_facetRecoverySlowOom";

export class AIChatAgentToolChild extends AIChatAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Test-only routed Task definition that deterministically reaches the
    // root alarm's memory-limit breaker, mirroring the exact reset error
    // text `isDurableObjectMemoryLimitReset` matches on. Sleeps first: a
    // freshly accepted run is due immediately, and its first (uncontrolled-
    // timing) natural dispatch must not race the test's own explicit
    // strike-seeding — the sleep parks it safely regardless of when that
    // dispatch happens. Only a caller that forces the run due a second time
    // (past the journaled sleep) reaches the throw.
    this.tasks.register(FACET_OOM_TEST_TASK_NAME, async (_input, step) => {
      await step.sleep("armed", "1 hour");
      throw new Error(
        "Durable Object's isolate exceeded its memory limit and was reset."
      );
    });
    // Twin of the above, but genuinely slow (not suspended) past the
    // dispatch budget once armed, so the routed dispatch budget race on
    // the root actually detaches before this throws — exercising root's
    // own tracking of the still-pending call, not just the local path.
    this.tasks.register(FACET_SLOW_OOM_TEST_TASK_NAME, async (_input, step) => {
      await step.sleep("armed", "1 hour");
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      throw new Error(
        "Durable Object's isolate exceeded its memory limit and was reset."
      );
    });
  }

  /** Reset this agent's isolate, as an eviction does. */
  async resetIsolateForTest(): Promise<void> {
    this.ctx.abort("test: forced reset");
  }

  /** Create the pre-capability chat stream tables with one stream in them. */
  /** Old request-context rows, as an earlier release kept them, and no session value. */
  async seedLegacyRequestContextForTest(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cf_ai_chat_request_context (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    sql.exec(
      "INSERT OR REPLACE INTO cf_ai_chat_request_context (key, value) VALUES ('lastBody', ?)",
      JSON.stringify({ theme: "dark" })
    );
    await this.sessions
      .session()
      .internal_setConfig("transcript:chat:request", null);
  }

  /** Whether the old request-context table is left, the rows in it, and the stored value. */
  async legacyRequestContextForTest(): Promise<{
    tableLeft: boolean;
    rowsLeft: number;
    stored: string | null;
  }> {
    await untilRequestContextCarried(this.ctx.storage.sql);
    const sql = this.ctx.storage.sql;
    const tableLeft =
      sql
        .exec(
          "SELECT name FROM sqlite_master WHERE name = 'cf_ai_chat_request_context'"
        )
        .toArray().length > 0;
    return {
      tableLeft,
      rowsLeft: tableLeft
        ? sql.exec("SELECT 1 FROM cf_ai_chat_request_context").toArray().length
        : 0,
      stored: await this.sessions
        .session()
        .internal_config("transcript:chat:request")
    };
  }

  seedLegacyChatTablesForTest(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE cf_ai_chat_stream_metadata (id TEXT PRIMARY KEY, request_id TEXT, status TEXT, created_at INTEGER, completed_at INTEGER)"
    );
    sql.exec(
      "CREATE TABLE cf_ai_chat_stream_chunks (id TEXT PRIMARY KEY, stream_id TEXT, body TEXT, chunk_index INTEGER, created_at INTEGER)"
    );
    sql.exec(
      "CREATE INDEX idx_legacy_chat_chunks ON cf_ai_chat_stream_chunks(stream_id, chunk_index)"
    );
    sql.exec(
      "INSERT INTO cf_ai_chat_stream_metadata VALUES ('legacy-stream', 'legacy-req', 'completed', ?, ?)",
      Date.now(),
      Date.now()
    );
    sql.exec(
      "INSERT INTO cf_ai_chat_stream_chunks VALUES ('c1', 'legacy-stream', '{\"type\":\"text\"}', 0, ?)",
      Date.now()
    );
  }

  /**
   * The pre-capability chat stream tables that still exist, the rows left
   * in them, and the chunks of the seeded stream now in Streams.
   */
  legacyChatTablesForTest(): {
    tables: string[];
    rowsLeft: number;
    importedChunks: number;
  } {
    const sql = this.ctx.storage.sql;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cf_ai_chat_stream_%' ORDER BY name"
      )
      .toArray()
      .map((row) => row.name);
    let rowsLeft = 0;
    for (const table of tables) {
      rowsLeft += sql.exec(`SELECT 1 FROM ${table}`).toArray().length;
    }
    return {
      tables,
      rowsLeft,
      importedChunks:
        this["_releasedStreams"].getStreamChunks("legacy-stream").length
    };
  }

  /**
   * Seed one active incident and its routed recovery Task run, mirrored as
   * one wake job on the root's queue, and wait for its natural first
   * dispatch to safely park it (`waiting`, per the definitions above).
   * Returns the run ID so the caller can locate that mirror on the root's
   * own queue and force it due again to arm the OOM throw.
   */
  async seedFacetRecoveryOomForTest(
    incidentId: string,
    definition: string = FACET_OOM_TEST_TASK_NAME
  ): Promise<string> {
    const now = Date.now();
    await this.ctx.storage.put(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`,
      {
        incidentId,
        requestId: incidentId,
        recoveryRootRequestId: incidentId,
        recoveryKind: "continue",
        attempt: 1,
        maxAttempts: 10,
        status: "scheduled",
        firstSeenAt: now,
        lastAttemptAt: now
      }
    );
    const receipt = await this.tasks.run(
      definition,
      { incidentId },
      { retain: false, start: "alarm" }
    );
    for (let i = 0; i < 50; i++) {
      const run = await this.tasks.get(receipt.runId);
      if (run?.status === "pending" && run.waitReason !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return receipt.runId;
  }

  /** Force this facet's own run row due now, past its journaled sleep. */
  /**
   * Move one Task run's wake in this sub-agent's own queue (due now by
   * default), optionally with banked memory-limit strikes, and tell the
   * root, as any queue change does.
   */
  async dueTaskForTest(
    runId: string,
    time = Date.now() - 1_000,
    strikes?: number
  ): Promise<void> {
    this.sql`
      UPDATE cf_agents_jobs SET time = ${time}
      WHERE capability = 'tasks' AND json_extract(payload, '$.runId') = ${runId}
    `;
    if (strikes !== undefined) {
      await this.ctx.storage.put("cf_agents:oom_alarm_strikes", strikes);
    }
    await this.lifecycle.rearmAlarm();
  }

  taskWakeTimeForTest(runId: string): number | null {
    return (
      this.sql<{ time: number }>`
        SELECT time FROM cf_agents_jobs
        WHERE capability = 'tasks' AND json_extract(payload, '$.runId') = ${runId}
      `[0]?.time ?? null
    );
  }

  async oomStrikesForTest(): Promise<number | null> {
    return (
      (await this.ctx.storage.get<number>("cf_agents:oom_alarm_strikes")) ??
      null
    );
  }

  async armFacetRecoveryOomForTest(runId: string): Promise<void> {
    const now = Date.now();
    // The run row's own deadline AND its journaled sleep step's deadline
    // both gate replay: forcing only the run row due replays straight into
    // the still-not-due sleep step, which just re-suspends for another
    // hour unchanged.
    this.sql`
      UPDATE cf_agents_task_runs SET next_at = ${now} WHERE run_id = ${runId}
    `;
    this.sql`
      UPDATE cf_agents_task_steps SET next_at = ${now}
      WHERE run_id = ${runId} AND step_name = 'armed'
    `;
  }

  /** This facet's own run row state, to check a routed strike reached it. */
  getFacetRecoveryOomRunStateForTest(runId: string): {
    status: string;
    generation: string | null;
    next_at: number | null;
  } | null {
    const rows = this.sql<{
      status: string;
      generation: string | null;
      next_at: number | null;
    }>`
      SELECT status, generation, next_at FROM cf_agents_task_runs
      WHERE run_id = ${runId}
    `;
    return rows[0] ?? null;
  }

  /** Read the persisted status of a test recovery incident. */
  async facetRecoveryIncidentStatusForTest(
    incidentId: string
  ): Promise<string | null> {
    const incident = await this.ctx.storage.get<{ status: string }>(
      `cf:chat-recovery:incident:${encodeURIComponent(incidentId)}`
    );
    return incident?.status ?? null;
  }

  /** Leave an interrupted turn on this facet (see `insertInterruptedTurnForTest`). */
  async insertInterruptedFiber(
    name: string,
    snapshot?: unknown
  ): Promise<void> {
    await insertInterruptedTurnForTest(this, this.ctx.storage, name, snapshot);
  }

  /** Replay this facet's interrupted turns, as a wake does. */
  async triggerFiberRecovery(): Promise<void> {
    await recoverInterruptedTurnsForTest(this);
  }

  /**
   * Once this facet's chat lane has no open run: the stored transcript and
   * how many chat-turn runs an earlier version's definitions still hold.
   */
  async carriedTurnForTest(): Promise<{
    roles: string[];
    lastText: string;
    releasedRuns: number;
  }> {
    const open = () =>
      this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM cf_agents_task_runs
        WHERE lane = 'chat' AND status IN ('pending', 'running')
      `[0]?.count ?? 0;
    const deadline = Date.now() + 10_000;
    while (open() > 0) {
      if (Date.now() > deadline)
        throw new Error("the carried turn never ended");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const last = this.messages.at(-1);
    return {
      roles: this.messages.map((message) => message.role),
      lastText: (last?.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
      releasedRuns:
        this.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM cf_agents_task_runs
          WHERE definition IN ('__cf_internal_chat_turn', '__cf_internal_chat_recovery')
            AND status IN ('pending', 'running')
        `[0]?.count ?? 0
    };
  }

  /** Count this facet's own non-terminal recovery Task runs for `callback`. */
  getChatRecoveryTaskRunCountForTest(callback: string): number {
    const rows = [
      { count: pendingRecoveryRunIds(this.ctx.storage.sql, callback).length }
    ];
    return rows[0]?.count ?? 0;
  }

  override formatAgentToolInput(
    input: AgentToolInput,
    request: { runId: string }
  ): ChatMessage {
    return {
      id: `tool-input-${request.runId}`,
      role: "user",
      parts: [{ type: "text", text: input.prompt }]
    };
  }

  protected override getAgentToolOutput(
    request: { runId: string; input: AgentToolInput },
    messagesAfterStart: readonly ChatMessage[]
  ): unknown {
    if (request.input.circularOutput) {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return circular;
    }
    if (request.input.probeDate !== undefined) {
      return { inputIsDate: request.input.probeDate instanceof Date };
    }
    if (request.input.structured) {
      return {
        handledPrompt: request.input.prompt,
        messageCount: messagesAfterStart.length
      };
    }
    return super.getAgentToolOutput(request, messagesAfterStart);
  }

  protected override getAgentToolSummary(
    request: { runId: string; input: AgentToolInput },
    output: unknown,
    messagesAfterStart: readonly ChatMessage[]
  ): string {
    if (request.input.structured) {
      return `structured:${request.input.prompt}`;
    }
    return super.getAgentToolSummary(request, output, messagesAfterStart);
  }

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const input = options?.body?.agentToolInput as AgentToolInput | undefined;
    const lastUser = [...this.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt =
      lastUser?.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("") ?? "";

    this._chatCallsForTest.push(prompt);
    this._turnStoresForTest.push(this._turnStoreCountsForTest());
    const bodyText = `AIChat child handled: ${prompt}`;
    await delayWithAbort(Number(input?.delayMs ?? 0), options?.abortSignal);
    if (input?.streamError) {
      return makeDelayedSSEChunkResponse(
        [
          ...(input.streamErrorText
            ? [
                { type: "text-start" },
                { type: "text-delta", delta: input.streamErrorText },
                { type: "text-end" }
              ]
            : []),
          { type: "error", errorText: input.streamError }
        ],
        Number(input?.chunkDelayMs ?? 0),
        options?.abortSignal
      );
    }

    return makeDelayedSSEChunkResponse(
      [
        { type: "text-start" },
        { type: "text-delta", delta: bodyText.slice(0, 22) },
        { type: "text-delta", delta: bodyText.slice(22) },
        { type: "text-end" },
        { type: "finish" }
      ],
      Number(input?.chunkDelayMs ?? 0),
      options?.abortSignal,
      this._injectionHold
    );
  }

  listMessagesForTest(): ChatMessage[] {
    return this.messages;
  }

  /** The prompt of every `onChatMessage` call, in order. */
  private _chatCallsForTest: string[] = [];

  /** Where each running turn was stored, read inside `onChatMessage`. */
  private _turnStoresForTest: Array<{ taskRuns: number; fibers: number }> = [];

  private _turnStoreCountsForTest(): { taskRuns: number; fibers: number } {
    const taskRuns = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition = ${CHAT_TURN_DEFINITION}
        AND status IN ('pending', 'running')
    `;
    const fibers = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_task_runs
      WHERE definition IN ('__cf_fiber', '__cf_managed_fiber')
        AND status IN ('pending', 'running')
    `;
    return {
      taskRuns: taskRuns[0]?.count ?? 0,
      fibers: fibers[0]?.count ?? 0
    };
  }

  /** Chat-turn recoveries this facet ran, by request id. */
  private _turnRecoveriesForTest: string[] = [];

  /** Leave a chat-turn Task run whose isolate died (no live closure). */
  async seedOrphanChatTurnRunForTest(requestId: string): Promise<string> {
    const self = this as unknown as {
      _recoverChatTurn(turn: { requestId: string }): Promise<void>;
    };
    const original = self._recoverChatTurn.bind(this);
    self._recoverChatTurn = async (turn) => {
      this._turnRecoveriesForTest.push(turn.requestId);
      return original(turn);
    };
    const receipt = await this.tasks.run(
      AIChatAgent.CHAT_FIBER_NAME,
      { requestId, continuation: false, nonce: `gone-${requestId}` },
      { metadata: { requestId }, start: "alarm" }
    );
    return receipt.runId;
  }

  getTurnRecoveriesForTest(): string[] {
    return this._turnRecoveriesForTest;
  }

  /**
   * Turn a seeded chat-turn run into one whose attempt was running when the
   * isolate died: claimed under a generation no isolate holds, with its claim
   * deadline (the only durable wake) a full claim window out.
   */
  markRunInterruptedForTest(runId: string, deadline: number): void {
    this.sql`
      UPDATE cf_agents_task_runs
      SET status = 'running', generation = 'dead-isolate', attempt = 1,
          next_at = ${deadline}
      WHERE run_id = ${runId}
    `;
  }

  getTaskRunStateForTest(runId: string): string | null {
    return (
      this.sql<{ status: string }>`
        SELECT status FROM cf_agents_task_runs WHERE run_id = ${runId}
      `[0]?.status ?? null
    );
  }

  getTurnStoresForTest(): Array<{ taskRuns: number; fibers: number }> {
    return this._turnStoresForTest;
  }

  private async _waitForRunTerminalForTest(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const inspection = await this.inspectAgentToolRun(runId);
      if (
        (inspection && inspection.status !== "running") ||
        Date.now() > deadline
      ) {
        return inspection;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Resolve once no run's lifecycle is left in this isolate. */
  private async _waitForRunsSettledForTest(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (
      this["_agentToolRuns"].controllers.size > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.waitUntilStable({ pendingInteraction: () => false });
  }

  private _userTextsForTest(): string[] {
    return this.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        message.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
      );
  }

  /** The output hook of a run started here gets the input as it was passed. */
  async runWithDateInputForTest(): Promise<unknown> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "typed input", probeDate: new Date(0) },
      { runId }
    );
    return (await this._waitForRunTerminalForTest(runId))?.output;
  }

  /** A run whose output hook returns a value JSON cannot hold. */
  async runWithCircularOutputForTest(): Promise<{
    status: string | undefined;
    output: unknown;
  }> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "circular output", circularOutput: true },
      { runId }
    );
    const inspection = await this._waitForRunTerminalForTest(runId);
    return { status: inspection?.status, output: inspection?.output };
  }

  /** A chat reset lands while the run's reply streams. */
  async resetWhileRunStreamsForTest(): Promise<AgentToolRunInspection | null> {
    const runId = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "reset probe", chunkDelayMs: 60 },
      { runId }
    );
    await this._waitForLiveTurnForTest(runId);
    this.resetTurnState();
    return this._waitForRunTerminalForTest(runId);
  }

  /**
   * A run is cancelled while its turn waits in the queue behind another
   * run's turn, optionally followed by a chat reset.
   */
  async cancelQueuedRunForTest(thenReset: boolean): Promise<{
    queued: AgentToolRunInspection | null;
    userTexts: string[];
    chatCalls: string[];
  }> {
    const first = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "first run", delayMs: 150 },
      { runId: first }
    );
    const deadline = Date.now() + 2000;
    while (!this._chatCallsForTest.includes("first run")) {
      if (Date.now() > deadline) throw new Error("first run never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.startAgentToolRun({ prompt: "queued run" }, { runId: queued });
    await this.cancelAgentToolRun(queued, "stop");
    if (thenReset) this.resetTurnState();
    await this._waitForRunsSettledForTest();
    return {
      queued: await this.inspectAgentToolRun(queued),
      userTexts: this._userTextsForTest(),
      chatCalls: [...this._chatCallsForTest]
    };
  }

  /**
   * A run started with the parent's signal is stopped through that signal
   * while its turn waits in the queue behind another run's turn.
   */
  async signalCancelsQueuedRunForTest(): Promise<{
    atAbort: AgentToolRunInspection | null;
    userTexts: string[];
    chatCalls: string[];
  }> {
    const first = crypto.randomUUID();
    const queued = crypto.randomUUID();
    await this.startAgentToolRun(
      { prompt: "first run", delayMs: 150 },
      { runId: first }
    );
    const deadline = Date.now() + 2000;
    while (!this._chatCallsForTest.includes("first run")) {
      if (Date.now() > deadline) throw new Error("first run never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const parent = new AbortController();
    await this.startAgentToolRun(
      { prompt: "queued run" },
      { runId: queued, signal: parent.signal }
    );
    parent.abort(new Error("parent stopped"));
    // Read while the first run still holds the queue.
    const atAbort = await this.inspectAgentToolRun(queued);
    await this._waitForRunsSettledForTest();
    return {
      atAbort,
      userTexts: this._userTextsForTest(),
      chatCalls: [...this._chatCallsForTest]
    };
  }

  /**
   * Three runs started together on one agent. Each turn must run with its
   * own run's input as body, and a run still waiting in the queue must not
   * change the stored request context of the turn that is running.
   */
  async queuedRunsKeepTheirOwnBodyForTest(): Promise<{
    storedWhileQueued: unknown;
    second: { status: string | undefined; error: string | undefined };
  }> {
    await this.startAgentToolRun(
      { prompt: "a", delayMs: 150 },
      { runId: "body-a" }
    );
    const deadline = Date.now() + 2000;
    while (!this._chatCallsForTest.includes("a")) {
      if (Date.now() > deadline) throw new Error("first run never started");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.startAgentToolRun(
      { prompt: "b", streamError: "boom" },
      { runId: "body-b" }
    );
    await this.startAgentToolRun({ prompt: "c" }, { runId: "body-c" });
    // Both runs are queued by now; the first is still running.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const storedWhileQueued = (
      this._lastBody as { agentToolInput?: { prompt?: string } } | undefined
    )?.agentToolInput?.prompt;
    await this._waitForRunsSettledForTest();
    const second = await this.inspectAgentToolRun("body-b");
    return {
      storedWhileQueued,
      second: { status: second?.status, error: second?.error }
    };
  }

  /** `starting` is an open status too: a cancel settles such a row. */
  async cancelStartingRunForTest(): Promise<string | null> {
    const runId = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_ai_chat_agent_tool_runs (run_id, status, started_at)
      VALUES (${runId}, 'starting', ${Date.now()})
    `;
    await this.cancelAgentToolRun(runId, "stop");
    return this._readChildRunStatusForTest(runId);
  }

  private _attachRaceInjection: { runId: string; body: string } | null = null;

  /**
   * #1589: arm a one-shot chunk injection that fires from inside
   * `getAgentToolChunks` — i.e. AFTER the stored snapshot is read but (in the
   * buggy ordering) BEFORE `tailAgentToolRun` attaches its live forwarder. This
   * deterministically reproduces the drain↔register window a network-paced
   * proxied remote stream hits constantly.
   */
  armAttachRaceInjectionForTest(runId: string, body: string): void {
    this._attachRaceInjection = { runId, body };
    this._injectionHold = new TestGate();
  }

  /**
   * Keeps the child's reply live (before its end) until an armed injection
   * has landed: a reply that ended first would have closed the parent's
   * tail, and the injected frames would reach no one.
   */
  private _injectionHold: TestGate | null = null;

  private _releaseInjectionHold(): void {
    this._injectionHold?.release();
    this._injectionHold = null;
  }

  /** From the test, however it ends: an injection that never landed. */
  releaseInjectionHoldForTest(): void {
    this._releaseInjectionHold();
  }

  private _progressInjection: {
    runId: string;
    progressBody: string;
    milestoneBody: string;
  } | null = null;

  /**
   * Arm a one-shot injection of NON-stored progress + milestone frames (the
   * `reportProgress` wire shape) that fire from inside `getAgentToolChunks`,
   * i.e. while the parent is still in the stored-replay → live-forwarding
   * handoff. Unlike a streamed chunk these are broadcast-only — they carry no
   * stored `chunk_index`, so they rely on the in-memory live sequence counter
   * to be forwarded. Guards that they survive the handoff and reach the parent.
   */
  armProgressInjectionForTest(
    runId: string,
    progressBody: string,
    milestoneBody: string
  ): void {
    this._progressInjection = { runId, progressBody, milestoneBody };
    this._injectionHold = new TestGate();
  }

  /**
   * Bounded-poll until the live child turn has registered its request id and
   * resumable stream id, so a test injection attributes (and, for a stored
   * chunk, persists) exactly like a real streamed chunk. Returns null if the
   * turn never came up within the window.
   */
  private async _waitForLiveTurnForTest(
    runId: string
  ): Promise<{ requestId: string; streamId: string }> {
    // A bound for a slow machine, not an ordering: the turn comes up once
    // the child's model call starts.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const requestId =
        this["_agentToolRuns"].store.read(runId)?.requestId ?? undefined;
      if (requestId) {
        // The chat module's stream of the run's turn, once it is open.
        const streamId = chatTurnStreamId(requestId);
        if (this.streams.__DO_NOT_USE_WILL_BREAK__sync().getStream(streamId)) {
          return { requestId, streamId };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Injecting nothing would let the test pass without its race.
    throw new Error(`The live child turn of ${runId} never came up`);
  }

  override async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    const chunks = await super.getAgentToolChunks(runId, options);

    const race = this._attachRaceInjection;
    if (race && race.runId === runId) {
      this._attachRaceInjection = null;
      // Land a STORED + broadcast chunk in the drain↔register window. This runs
      // INSIDE getAgentToolChunks, i.e. before tailAgentToolRun's post-drain
      // forwarder registration in the buggy ordering, so it faithfully lands in
      // the attach window. With the #1589 fix the forwarder is already attached,
      // so the chunk is buffered and replayed in order instead of being dropped.
      const live = await this._waitForLiveTurnForTest(runId);
      await storeTurnStreamChunk(this, live.streamId, race.body);
      this["_frames"].broadcast({
        body: race.body,
        done: false,
        id: live.requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
      this._releaseInjectionHold();
    }

    const progress = this._progressInjection;
    if (progress && progress.runId === runId) {
      this._progressInjection = null;
      // Land NON-stored progress + milestone frames in the same window. These
      // are broadcast-only (exactly like `reportProgress`): they carry no
      // stored chunk_index, so they depend on the in-memory live sequence to be
      // forwarded. Sourcing the forward sequence from the stored chunk count
      // would collide them with the last stored chunk and the tail's high-water
      // dedupe would silently drop them — the regression this guards against.
      const live = await this._waitForLiveTurnForTest(runId);
      this["_frames"].broadcast({
        body: progress.progressBody,
        done: false,
        id: live.requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
      this["_frames"].broadcast({
        body: progress.milestoneBody,
        done: false,
        id: live.requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
      this._releaseInjectionHold();
    }

    return chunks;
  }

  /**
   * Reproduce the post-restart cold-counter realign (Devin review on #1827,
   * the hibernation / chat-recovery re-attach path). Seeds a RUNNING run with a
   * stored backlog 0..N, wipes the in-memory live sequence (as a child DO
   * restart / hibernation wake would), then tails it directly. After the drain
   * the live counter must realign to N+1 so a NEW broadcast — the recovered
   * turn's next chunk — forwards at N+1 instead of restarting at 0 and being
   * silently dropped by `emit`'s high-water dedupe.
   *
   * Returns the drained backlog sequences, the live counter after the drain,
   * and the forwarded post-restart chunk (null if it was dropped — the pre-fix
   * behaviour).
   */
  async coldCounterReattachForwardsForTest(afterSequence = -1): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }> {
    const runId = "cold-realign-run";
    const requestId = "cold-realign-req";
    const streamId = startTurnStreamForTest(this, requestId);
    const backlog = [
      JSON.stringify({ type: "text-start" }),
      JSON.stringify({ type: "text-delta", delta: "a" }),
      JSON.stringify({ type: "text-delta", delta: "b" })
    ];
    for (const body of backlog) {
      await storeTurnStreamChunk(this, streamId, body);
    }
    this.streams.__DO_NOT_USE_WILL_BREAK__sync().flush();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // Simulate a restart / hibernation wake: the in-memory live sequence map is
    // cold; only the durable stored backlog survives.
    this["_agentToolRuns"].liveSequences.delete(runId);

    const stream = (await this.tailAgentToolRun(runId, {
      afterSequence
    })) as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readLine = async (timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line) return line;
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const next = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), remaining)
          )
        ]);
        if (next === "timeout" || next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
    };

    const drained: number[] = [];
    for (let i = afterSequence + 1; i < backlog.length; i++) {
      const line = await readLine(2000);
      if (line === null) break;
      drained.push((JSON.parse(line) as { sequence: number }).sequence);
    }

    // Wait (bounded) for the post-drain realign to run.
    const deadline = Date.now() + 2000;
    while (
      this["_agentToolRuns"].liveSequences.get(runId) !== backlog.length &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const liveSequenceAfterDrain =
      this["_agentToolRuns"].liveSequences.get(runId);

    // The recovered turn now broadcasts a NEW chunk (not in the backlog).
    const postBody = JSON.stringify({
      type: "tool-output-available",
      toolCallId: "post-restart",
      output: "ok"
    });
    this["_frames"].broadcast({
      body: postBody,
      done: false,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });

    const postLine = await readLine(2000);
    const postRestart =
      postLine === null
        ? null
        : (JSON.parse(postLine) as { sequence: number; body: string });
    await reader.cancel();
    return { drained, liveSequenceAfterDrain, postRestart };
  }

  /**
   * A warm run that already broadcast a progress frame, then a tail attaching
   * while a progress frame and a chunk (stored before the attach) are
   * broadcast during its drain. Returns every body the tail forwarded.
   */
  async progressDuringDrainForTest(): Promise<string[]> {
    const runId = "progress-drain-run";
    const requestId = "progress-drain-req";
    const streamId = startTurnStreamForTest(this, requestId);
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    this["_agentToolRuns"].runsByRequestId.set(requestId, runId);
    this["_agentToolRuns"].liveSequences.set(runId, 0);
    const broadcast = (body: string) =>
      this["_frames"].broadcast({
        body,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
    const progress = (message: string) =>
      JSON.stringify({
        type: "data-agent-progress",
        transient: true,
        data: { message }
      });

    const stored = [
      JSON.stringify({ type: "text-start", id: "t" }),
      JSON.stringify({ type: "text-delta", id: "t", delta: "a" }),
      JSON.stringify({ type: "text-delta", id: "t", delta: "b" })
    ];
    for (const body of stored.slice(0, 2)) {
      await storeTurnStreamChunk(this, streamId, body);
      broadcast(body);
    }
    broadcast(progress("before-attach"));
    await storeTurnStreamChunk(this, streamId, stored[2]);
    this.streams.__DO_NOT_USE_WILL_BREAK__sync().flush();

    const tail = this.tailAgentToolRun(runId, { afterSequence: -1 });
    broadcast(progress("during-drain"));
    broadcast(stored[2]);
    const reader = (
      (await tail) as unknown as ReadableStream<Uint8Array>
    ).getReader();

    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    this["_agentToolRuns"].runsByRequestId.delete(requestId);
    this["_agentToolRuns"].liveSequences.delete(runId);
    return buffer
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { body: string }).body);
  }

  /**
   * A warm run that streamed a chunk too large to store, then a tail
   * re-attaching while a stored chunk is broadcast during its drain, followed
   * by another oversized chunk and a stored one. Returns what the tail
   * forwarded (oversized deltas summarized).
   */
  async skippedChunkReattachForTest(): Promise<
    Array<{ sequence: number; delta?: string; unstored: boolean }>
  > {
    const runId = "skipped-chunk-run";
    const requestId = "skipped-chunk-req";
    const streamId = startTurnStreamForTest(this, requestId);
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    this["_agentToolRuns"].runsByRequestId.set(requestId, runId);
    this["_agentToolRuns"].liveSequences.set(runId, 0);
    const broadcast = (body: string) =>
      this["_frames"].broadcast({
        body,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
    const send = async (body: string) => {
      await storeTurnStreamChunk(this, streamId, body);
      broadcast(body);
    };
    const delta = (value: string) =>
      JSON.stringify({ type: "text-delta", id: "t", delta: value });
    const oversized = delta("x".repeat(REPLAY_CHUNK_BYTES + 100_000));

    await send(JSON.stringify({ type: "text-start", id: "t" }));
    await send(delta("a"));
    await send(oversized);
    await storeTurnStreamChunk(this, streamId, delta("c"));
    this.streams.__DO_NOT_USE_WILL_BREAK__sync().flush();

    const tail = this.tailAgentToolRun(runId, { afterSequence: -1 });
    broadcast(delta("c"));
    const reader = (
      (await tail) as unknown as ReadableStream<Uint8Array>
    ).getReader();
    await send(oversized);
    await send(delta("d"));

    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    this["_agentToolRuns"].runsByRequestId.delete(requestId);
    this["_agentToolRuns"].liveSequences.delete(runId);
    return buffer
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const chunk = JSON.parse(line) as AgentToolStoredChunk;
        const body = JSON.parse(chunk.body) as { delta?: string };
        return {
          sequence: chunk.sequence,
          ...(body.delta !== undefined
            ? { delta: body.delta.length > 10 ? "<oversized>" : body.delta }
            : {}),
          unstored: chunk.unstoredId !== undefined
        };
      });
  }

  /**
   * A running run with a cold live counter (as after a restart) and a stored
   * backlog 0..2, tailed while the recovered turn broadcasts a new chunk during
   * the tail's post-drain inspection. Returns the forwarded sequences and the
   * new chunk (null if dropped).
   */
  async broadcastDuringInspectionForTest(): Promise<{
    drained: number[];
    postRestart: { sequence: number; body: string } | null;
  }> {
    const runId = "inspect-pending-run";
    const requestId = "inspect-pending-req";
    const streamId = startTurnStreamForTest(this, requestId);
    const backlog = ["a", "b", "c"].map((delta) =>
      JSON.stringify({ type: "text-delta", id: "t", delta })
    );
    for (const body of backlog) {
      await storeTurnStreamChunk(this, streamId, body);
    }
    this.streams.__DO_NOT_USE_WILL_BREAK__sync().flush();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    this["_agentToolRuns"].liveSequences.delete(runId);

    const self = this as unknown as {
      inspectAgentToolRun: (runId: string) => Promise<unknown>;
    };
    const original = self.inspectAgentToolRun;
    let reached!: () => void;
    const atInspection = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    self.inspectAgentToolRun = async (id: string) => {
      reached();
      await gate;
      return original.call(this, id);
    };

    try {
      const reader = (
        (await this.tailAgentToolRun(runId, {
          afterSequence: -1
        })) as unknown as ReadableStream<Uint8Array>
      ).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readLine = async (timeoutMs: number): Promise<string | null> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line) return line;
            continue;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) return null;
          const next = await Promise.race([
            reader.read(),
            new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), remaining)
            )
          ]);
          if (next === "timeout" || next.done) return null;
          buffer += decoder.decode(next.value, { stream: true });
        }
      };

      const drained: number[] = [];
      for (let i = 0; i < backlog.length; i++) {
        const line = await readLine(2000);
        if (line === null) break;
        drained.push((JSON.parse(line) as { sequence: number }).sequence);
      }
      await atInspection;
      const postBody = JSON.stringify({
        type: "text-delta",
        id: "t",
        delta: "post-restart"
      });
      await storeTurnStreamChunk(this, streamId, postBody);
      this["_frames"].broadcast({
        body: postBody,
        done: false,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
      });
      release();
      const postLine = await readLine(500);
      await reader.cancel();
      return {
        drained,
        postRestart:
          postLine === null
            ? null
            : (JSON.parse(postLine) as { sequence: number; body: string })
      };
    } finally {
      release();
      self.inspectAgentToolRun = original;
      this["_agentToolRuns"].liveSequences.delete(runId);
    }
  }

  /**
   * Inspect a stale `running` run row (no live run, no recovery) with
   * `reconcile: false`. Returns the reported and the stored status afterwards.
   */
  async inspectStaleRunReadOnlyForTest(): Promise<{
    reported: string | undefined;
    stored: string | undefined;
  }> {
    const runId = crypto.randomUUID();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, status, input_json, started_at)
      values (${runId}, 'running', '{}', ${Date.now()})
    `;
    const inspection = await this.inspectAgentToolRun(runId, {
      reconcile: false
    });
    return {
      reported: inspection?.status,
      stored: this["_agentToolRuns"].store.read(runId)?.status
    };
  }

  /**
   * A child turn that streams error text, then an error chunk, and persists its
   * assistant reply — but is "evicted" before `startAgentToolRun`'s finalizer
   * seals the row `error`. Holds the finalizer at the point the turn returns,
   * drops the run's in-memory state as an eviction would, then inspects
   * (reconciling the stale `running` row).
   */
  async reconcileEvictedErroredRunForTest(): Promise<{
    before: string | null;
    assistantText: string;
    inspection: AgentToolRunInspection | null;
  }> {
    const runId = crypto.randomUUID();
    let reached!: () => void;
    let release!: () => void;
    const reachedGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the run's lifecycle at the point its turn hands back.
    // The run's turn is a chat-module server turn (`_serverTurn`).
    const self = this as unknown as {
      _serverTurn: (...args: unknown[]) => Promise<SaveMessagesResult>;
    };
    const runTurn = self._serverTurn.bind(this);
    self._serverTurn = async (...args) => {
      const result = await runTurn(...args);
      self._serverTurn = runTurn;
      reached();
      await released;
      return result;
    };
    await this.startAgentToolRun(
      {
        prompt: "fail midway",
        streamError: "model exploded",
        streamErrorText: "Sorry, something went wrong."
      },
      { runId }
    );
    await reachedGate;
    try {
      this["_agentToolRuns"].controllers.delete(runId);
      this["_agentToolRuns"].lastErrors.delete(runId);
      this["_agentToolRuns"].liveSequences.delete(runId);
      this["_agentToolRuns"].preTurnAssistantIds.delete(runId);
      this["_agentToolRuns"].runsByRequestId.clear();
      const before = this._readChildRunStatusForTest(runId);
      const assistantText = this.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const inspection = await this.inspectAgentToolRun(runId);
      return { before, assistantText, inspection };
    } finally {
      release();
    }
  }

  /**
   * Rebind an in-flight `eventDelivery: "terminal"` run the way a recovered
   * turn does, then close its tailers the way a settled recovered turn does.
   * Returns whether the run is still in the terminal-only set.
   */
  terminalOnlyRunAfterRecoveredTurnForTest(): {
    afterRebind: boolean;
    afterClose: boolean;
  } {
    const runId = "terminal-only-recovered-run";
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at, event_delivery)
      values (${runId}, 'old-req', 'running', '{}', ${Date.now()}, 'terminal')
    `;
    this["_agentToolRuns"].rebind("recovery-req", "old-req");
    const afterRebind = this["_agentToolRuns"].terminalOnlyRuns.has(runId);
    this["_agentToolRuns"].closeTailers(runId);
    return {
      afterRebind,
      afterClose: this["_agentToolRuns"].terminalOnlyRuns.has(runId)
    };
  }

  /**
   * Reproduce the cancelled-tailer-starves-siblings bug (Devin review on #1827).
   * Two parents tail the SAME run; tailer A's consumer cancels its reader. With
   * an empty `cancel` handler and an unguarded `controller.close()`, A's stale
   * forwarder stays registered, and the next broadcast throws while emitting to
   * A (enqueue on a cancelled stream → `close()` → `controller.close()` throws),
   * which propagates out of `interceptAgentToolBroadcast`'s forward loop and
   * starves sibling tailer B of that chunk. With the fix A is detached on cancel
   * and `controller.close()` is guarded, so B still receives the chunk.
   */
  async cancelledTailerStarvationForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
  }> {
    const runId = "starve-run";
    const requestId = "starve-req";
    const streamId = startTurnStreamForTest(this, requestId);
    await storeTurnStreamChunk(
      this,
      streamId,
      JSON.stringify({ type: "text-start" })
    );
    this.streams.__DO_NOT_USE_WILL_BREAK__sync().flush();
    this.sql`
      insert into cf_ai_chat_agent_tool_runs (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // One stored chunk (index 0) ⇒ live counter sits at 1, in lockstep.
    this["_agentToolRuns"].liveSequences.set(runId, 1);

    // afterSequence: 0 ⇒ the drain skips the stored backlog, so both tailers go
    // live immediately. A is registered first (iterated first in the broadcast).
    const a = (await this.tailAgentToolRun(runId, {
      afterSequence: 0
    })) as unknown as ReadableStream<Uint8Array>;
    const b = (await this.tailAgentToolRun(runId, {
      afterSequence: 0
    })) as unknown as ReadableStream<Uint8Array>;
    const readerA = a.getReader();
    const readerB = b.getReader();

    // Wait until both forwarders are registered and live (drain complete).
    const regDeadline = Date.now() + 2000;
    while (
      (this["_agentToolRuns"].forwarders.get(runId)?.size ?? 0) < 2 &&
      Date.now() < regDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A's consumer detaches.
    await readerA.cancel();

    // A new chunk is broadcast for the run.
    const body = JSON.stringify({
      type: "tool-output-available",
      toolCallId: "sibling",
      output: "ok"
    });
    this["_frames"].broadcast({
      body,
      done: false,
      id: requestId,
      type: MessageType.CF_AGENT_USE_CHAT_RESPONSE
    });

    // B must still receive it.
    const decoder = new TextDecoder();
    let buf = "";
    let siblingBodyAfterCancel: string | null = null;
    const deadline = Date.now() + 2000;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) {
          siblingBodyAfterCancel = (JSON.parse(line) as { body: string }).body;
          break;
        }
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        readerB.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), remaining)
        )
      ]);
      if (next === "timeout" || next.done) break;
      buf += decoder.decode(next.value, { stream: true });
    }
    await readerB.cancel();
    return { siblingBodyAfterCancel };
  }

  /**
   * #1575: broadcast a chat error frame whose request id belongs to no
   * agent-tool run, simulating an unrelated turn failing on this agent
   * while a run is being tailed.
   */
  broadcastUnrelatedErrorForTest(requestId: string): void {
    this.broadcast(
      JSON.stringify({
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
        id: requestId,
        error: true,
        done: false,
        body: "unrelated turn failure"
      })
    );
  }

  /**
   * #1575: number of live request-id → run-id cache entries. Used to assert
   * the negative cache (null entries for unrelated turns) does not leak past
   * a run's lifetime.
   */
  agentToolRunsByRequestIdSizeForTest(): number {
    // Bracket access: the field is private on the base AIChatAgent, and this
    // test-only subclass deliberately peeks at it without widening the
    // published API.
    return this["_agentToolRuns"].runsByRequestId.size;
  }

  /**
   * #1575: simulate a DO restart mid-run — the in-memory request-id map is
   * empty (wiped by the restart), but the run row persisted its `request_id`
   * at turn start. `AgentToolRuns.runForRequest` must still attribute a frame to
   * the run via the SQL fallback, and an unknown request resolves to null.
   */
  resolveAgentToolRunAfterRestartForTest(
    runId: string,
    requestId: string
  ): { running: string | null; unknown: string | null } {
    this.sql`
      insert into cf_ai_chat_agent_tool_runs
        (run_id, request_id, status, input_json, started_at)
      values (${runId}, ${requestId}, 'running', '{}', ${Date.now()})
    `;
    // Cold in-memory map, as after a restart.
    this["_agentToolRuns"].runsByRequestId.clear();
    return {
      running: this["_agentToolRuns"].runForRequest(requestId),
      unknown: this["_agentToolRuns"].runForRequest("no-such-request")
    };
  }

  private _readChildRunStatusForTest(runId: string): string | null {
    const rows = this.sql<{ status: string }>`
      SELECT status FROM cf_ai_chat_agent_tool_runs WHERE run_id = ${runId}
    `;
    return rows[0]?.status ?? null;
  }
}

export class StuckAgentToolChild extends Agent<Env> {
  override async _cf_initAsFacet(
    _name: string,
    _parentPath: ReadonlyArray<{ className: string; name: string }> = [],
    _identityName = _name
  ): Promise<void> {
    await new Promise<void>(() => {
      // Intentionally never resolves: simulates a child facet wedged in startup.
    });
  }

  async startAgentToolRun(): Promise<AgentToolRunInspection> {
    throw new Error("stuck child should never start");
  }

  async cancelAgentToolRun(): Promise<void> {}

  async inspectAgentToolRun(): Promise<AgentToolRunInspection | null> {
    throw new Error("stuck child should never be inspected");
  }

  async getAgentToolChunks(): Promise<AgentToolStoredChunk[]> {
    return [];
  }
}

type AgentToolFinishForTest = {
  run: AgentToolRunInfo;
  result: AgentToolLifecycleResult;
};

export class AIChatAgentToolParent extends Agent<Env> {
  async seedChildLegacyRequestContextForTest(childName: string): Promise<void> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    await child.seedLegacyRequestContextForTest();
  }

  async childLegacyRequestContextForTest(childName: string): Promise<{
    tableLeft: boolean;
    rowsLeft: number;
    stored: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.legacyRequestContextForTest();
  }

  async seedChildLegacyChatTablesForTest(childName: string): Promise<void> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    await child.seedLegacyChatTablesForTest();
  }

  async childLegacyChatTablesForTest(
    childName: string
  ): Promise<{ tables: string[]; rowsLeft: number; importedChunks: number }> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.legacyChatTablesForTest();
  }

  /** Reset one sub-agent's isolate, as its root's reset does. */
  async resetChildForTest(childName: string): Promise<void> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    await child.resetIsolateForTest().catch(() => {});
  }

  private events: AgentToolEventMessage[] = [];
  private finishes: AgentToolFinishForTest[] = [];
  private finishRunIdsToThrow = new Set<string>();
  private lifecycleOrder: string[] = [];

  /**
   * Drive the root alarm straight to sealing for one routed child recovery
   * row. The root is deliberately a plain Agent: only the child owns the
   * active chat-recovery incident and terminal policy.
   */
  async driveFacetRecoveryOomSealForTest(
    executing: { childName: string; incidentId: string },
    pending: { childName: string; incidentId: string }
  ): Promise<string[]> {
    const pendingChild = await this.subAgent(
      AIChatAgentToolChild,
      pending.childName
    );
    const pendingRunId = await pendingChild.seedFacetRecoveryOomForTest(
      pending.incidentId
    );
    const executingChild = await this.subAgent(
      AIChatAgentToolChild,
      executing.childName
    );
    const executingRunId = await executingChild.seedFacetRecoveryOomForTest(
      executing.incidentId
    );
    // Both runs safely parked themselves (waiting, ~1h out) on their own
    // uncontrolled first dispatch; force only the executing one due again,
    // past its journaled sleep, so this alarm cycle drives it and leaves
    // the pending one untouched.
    await executingChild.armFacetRecoveryOomForTest(executingRunId);
    // The run and its breaker live in the sub-agent; two strikes banked.
    await executingChild.dueTaskForTest(executingRunId, undefined, 2);
    await this.alarm();
    return [executingRunId, pendingRunId];
  }

  /**
   * Drive the root alarm to a single (non-sealing) memory-limit strike on
   * one routed child recovery run. Returns the run ID; the breaker's
   * deferred isolate reset means the caller should read the resulting
   * claim state through a fresh stub, not this same invocation.
   */
  async driveFacetRecoveryOomBackoffForTest(executing: {
    childName: string;
    incidentId: string;
  }): Promise<string> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      executing.childName
    );
    const runId = await child.seedFacetRecoveryOomForTest(executing.incidentId);
    await child.armFacetRecoveryOomForTest(runId);
    // One strike under the 3-strike seal threshold (#1825): the breaker
    // backs off without sealing.
    await child.dueTaskForTest(runId, undefined, 0);
    await this.alarm();
    return runId;
  }

  /**
   * Drive the root alarm to dispatch a routed run whose failure takes
   * longer than the five-second dispatch budget, sealing on it. Root's
   * own budget wins the race well before the facet throws, so this
   * returns once root has detached — the caller must wait out the
   * remaining delay (through a fresh stub) before checking the seal
   * actually landed.
   */
  async driveFacetRecoverySlowOomSealForTest(executing: {
    childName: string;
    incidentId: string;
  }): Promise<string> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      executing.childName
    );
    const runId = await child.seedFacetRecoveryOomForTest(
      executing.incidentId,
      "__cf_test_facetRecoverySlowOom"
    );
    await child.armFacetRecoveryOomForTest(runId);
    // Two strikes already banked: the slow run's eventual (delayed)
    // failure is the third, sealing strike (#1825).
    await child.dueTaskForTest(runId, undefined, 2);
    await this.alarm();
    return runId;
  }

  /** This facet's own run row state, read through the parent by name. */
  async facetRecoveryOomRunStateForTest(
    childName: string,
    runId: string
  ): Promise<{
    status: string;
    generation: string | null;
    next_at: number | null;
  } | null> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.getFacetRecoveryOomRunStateForTest(runId);
  }

  /** Whether a routed Task run still has a wake job mirrored on this root. */
  /** Whether a sub-agent still holds a wake for one of its Task runs. */
  async childHasTaskWakeForTest(
    childName: string,
    runId: string
  ): Promise<boolean> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return (await child.taskWakeTimeForTest(runId)) !== null;
  }

  /** Read a child facet's durable recovery incident after root sealing. */
  async facetRecoveryIncidentStatusForTest(
    childName: string,
    incidentId: string
  ): Promise<string | null> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.facetRecoveryIncidentStatusForTest(incidentId);
  }

  /** Whether a root-owned schedule row still exists. */
  rootHasScheduleForTest(scheduleId: string): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM cf_agents_jobs WHERE id = ${scheduleId}
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  /**
   * A sub-agent holds a chat turn an earlier version left cut off (its
   * fiber row). Replay it, as a wake does, and report the turn once its
   * lane is empty.
   */
  async carryReleasedTurnInFacetForTest(childName: string): Promise<{
    roles: string[];
    lastText: string;
    releasedRuns: number;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    // A reply to continue: the carried turn continues the latest reply.
    await child.persistMessages([
      { id: "u-facet", role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: "a-facet",
        role: "assistant",
        parts: [{ type: "text", text: "Partial" }]
      }
    ]);
    await child.insertInterruptedFiber("__cf_internal_chat_turn:req-facet");
    await child.triggerFiberRecovery();
    return child.carriedTurnForTest();
  }

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as AgentToolEventMessage;
        if (parsed.type === "agent-tool-event") {
          this.events.push(parsed);
        }
      } catch {
        // Ignore non-agent-tool frames.
      }
    }
    super.broadcast(msg, without);
  }

  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    this.finishes.push({ run, result });
    this.lifecycleOrder.push(`finish:${run.runId}`);
    if (this.finishRunIdsToThrow.has(run.runId)) {
      throw new Error(`finish failed for ${run.runId}`);
    }
  }

  /**
   * Leave a facet chat turn interrupted the way a root reset leaves it: the
   * run claimed on the facet, and this root's mirror of its wake a full
   * claim window out. Returns the run id.
   */
  async seedInterruptedFacetTurnForTest(childName: string): Promise<string> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    const runId = await child.seedOrphanChatTurnRunForTest("req-root-reset");
    const deadline = Date.now() + 330_000;
    await child.markRunInterruptedForTest(runId, deadline);
    await child.dueTaskForTest(runId, deadline);
    // Let a drive the child's report started finish first: a drive cut off
    // by the reset would hold the wake back as a crashed one.
    await this.facetDrivesSettledForTest();
    // A root reset takes its facets down with it.
    await child.resetIsolateForTest().catch(() => {});
    return runId;
  }

  /** Wait until no drive of a sub-agent from this root is unreplied. */
  async facetDrivesSettledForTest(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const open = [
        ...this.ctx.storage.kv.list({ prefix: "cf_agents:facet_drives:" })
      ];
      if (open.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("A drive of a sub-agent is still unreplied after 2 s");
  }

  /** A sub-agent's alarm memory-limit strike count, or null when none. */
  async childOomStrikesForTest(childName: string): Promise<number | null> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.oomStrikesForTest();
  }

  /**
   * The root's wake for one sub-agent, read from the root alone (a call to
   * the sub-agent would start it).
   */
  facetWakeTimeForTest(childName: string): number | null {
    return (
      this.sql<{ time: number }>`
        SELECT time FROM cf_agents_jobs
        WHERE substr(id, 1, 6) = 'facet:'
          AND substr(id, -length(${`/AIChatAgentToolChild:${encodeURIComponent(childName)}`})) = ${`/AIChatAgentToolChild:${encodeURIComponent(childName)}`}
      `[0]?.time ?? null
    );
  }

  async facetRunStateForTest(
    childName: string,
    runId: string
  ): Promise<string | null> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    return child.getTaskRunStateForTest(runId);
  }

  /** Replay an interrupted facet chat turn from the root's alarm. */
  async facetOrphanTurnReplayForTest(childName: string): Promise<{
    mirrored: number;
    recoveries: string[];
    state: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, childName);
    const runId = await child.seedOrphanChatTurnRunForTest("req-orphan");
    const mirrored = this.facetWakeTimeForTest(childName) === null ? 0 : 1;
    await child.dueTaskForTest(runId);
    await this.alarm();
    for (let i = 0; i < 100; i++) {
      const state = await child.getTaskRunStateForTest(runId);
      if (state === "completed" || state === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      mirrored,
      recoveries: await child.getTurnRecoveriesForTest(),
      state: await child.getTaskRunStateForTest(runId)
    };
  }

  /** Run a child, and say where the child stored its running turn. */
  async runChildTurnStoresForTest(): Promise<{
    status: string;
    stores: Array<{ taskRuns: number; fibers: number }>;
  }> {
    const runId = crypto.randomUUID();
    const result = await this.runChild({ prompt: "where" }, runId);
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return {
      status: result.status,
      stores: await child.getTurnStoresForTest()
    };
  }

  async runChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    return this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
  }

  /**
   * The parent forwards five chunks of the run's first turn, then its tail
   * breaks. The recovered turn has a stream of its own, which holds two
   * chunks when the parent re-attaches and gets two more. Returns the
   * sequence the parent broadcast each chunk under.
   */
  async runChildRecoveredOnAShorterStreamForTest(): Promise<{
    status: string;
    sequences: number[];
  }> {
    const runId = crypto.randomUUID();
    const running: AgentToolRunInspection = {
      runId,
      status: "running",
      startedAt: Date.now()
    };
    const line = (sequence: number, body: string) =>
      new TextEncoder().encode(`${JSON.stringify({ sequence, body })}\n`);
    const chunk = (text: string) =>
      JSON.stringify({ type: "text-delta", id: "t", delta: text });
    const self = agentToolsOf(this) as {
      _asAgentToolChildAdapter(child: unknown): unknown;
    };
    const asAdapter = self._asAgentToolChildAdapter;
    let tails = 0;
    let done = false;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => running,
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () =>
        done ? { ...running, status: "completed", summary: "ok" } : running,
      // The run's current stream: the recovered turn's, two chunks so far.
      getAgentToolChunks: async () => [
        { sequence: 0, body: chunk("r0") },
        { sequence: 1, body: chunk("r1") }
      ],
      tailAgentToolRun: async () => {
        const first = ++tails === 1;
        let sent = 0;
        return new ReadableStream<Uint8Array>({
          // One chunk per read: an errored stream drops what is queued.
          pull(controller) {
            if (first) {
              if (sent < 5) {
                controller.enqueue(line(sent, chunk(`a${sent}`)));
                sent++;
                return;
              }
              controller.error(
                new Error(
                  "ReadableStream received over RPC disconnected prematurely."
                )
              );
              return;
            }
            if (sent < 2) {
              controller.enqueue(line(2 + sent, chunk(`r${2 + sent}`)));
              sent++;
              return;
            }
            done = true;
            controller.close();
          }
        });
      }
    });
    this.events = [];
    try {
      const result = await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input: { prompt: "recovers on a shorter stream" },
        inputPreview: "recovers on a shorter stream"
      });
      return {
        status: result.status,
        sequences: this.events
          .filter((message) => message.event.kind === "chunk")
          .map((message) => message.sequence)
      };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
    }
  }

  /**
   * The child never closes the parent's tail and never sends anything
   * through it. Its run is over by the second time the parent asks.
   */
  async runChildWhoseTailNeverClosesForTest(): Promise<{
    status: string;
    inspections: number;
    parentRow: string | null;
  }> {
    const runId = crypto.randomUUID();
    const running: AgentToolRunInspection = {
      runId,
      status: "running",
      startedAt: Date.now()
    };
    const self = agentToolsOf(this) as {
      _asAgentToolChildAdapter(child: unknown): unknown;
    };
    const { _resolvedOptions: options } = this as unknown as {
      _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
    };
    const asAdapter = self._asAgentToolChildAdapter;
    const budget = options.agentToolReattachNoProgressTimeoutMs;
    let inspections = 0;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => running,
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () =>
        ++inspections < 2
          ? running
          : { ...running, status: "aborted", error: "stopped on the child" },
      getAgentToolChunks: async () => [],
      tailAgentToolRun: async () => new ReadableStream({})
    });
    options.agentToolReattachNoProgressTimeoutMs = 50;
    try {
      const result = await Promise.race([
        this.runAgentTool(AIChatAgentToolChild, {
          runId,
          parentToolCallId: "test-tool-call",
          input: { prompt: "never closes" },
          inputPreview: "never closes"
        }),
        new Promise<{ status: string }>((resolve) =>
          setTimeout(() => resolve({ status: "still waiting" }), 3000)
        )
      ]);
      return {
        status: result.status,
        inspections,
        parentRow: this.getParentAgentToolStatusForTest(runId)
      };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
      options.agentToolReattachNoProgressTimeoutMs = budget;
    }
  }

  /**
   * The parent's tail breaks and the child keeps reporting the run as
   * running without ever producing anything: the parent's no-progress
   * budget runs out.
   */
  async runChildThatNeverRecoversForTest(): Promise<{
    status: string;
    reason?: string;
    childStillRunning?: boolean;
    parentRow: string | null;
  }> {
    const runId = crypto.randomUUID();
    const running: AgentToolRunInspection = {
      runId,
      status: "running",
      startedAt: Date.now()
    };
    const self = agentToolsOf(this) as {
      _asAgentToolChildAdapter(child: unknown): unknown;
    };
    const { _resolvedOptions: options } = this as unknown as {
      _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
    };
    const asAdapter = self._asAgentToolChildAdapter;
    const budget = options.agentToolReattachNoProgressTimeoutMs;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => running,
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () => running,
      getAgentToolChunks: async () => [],
      tailAgentToolRun: async () => {
        throw new Error(
          "ReadableStream received over RPC disconnected prematurely."
        );
      }
    });
    options.agentToolReattachNoProgressTimeoutMs = 50;
    try {
      const result = await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input: { prompt: "never recovers" },
        inputPreview: "never recovers"
      });
      return {
        status: result.status,
        reason: result.reason,
        childStillRunning: result.childStillRunning,
        parentRow: this.getParentAgentToolStatusForTest(runId)
      };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
      options.agentToolReattachNoProgressTimeoutMs = budget;
    }
  }

  /**
   * The child's isolate goes away under the `startAgentToolRun` call, so
   * the call fails. With `childHasRun`, the child had inserted the run
   * before it went and finishes it afterwards. Without, it never heard of
   * the run.
   */
  async runChildWhoseStartCallFailsForTest(childHasRun: boolean): Promise<{
    result: { status: string; error?: string } | { threw: string };
    parentRow: string | null;
  }> {
    const runId = crypto.randomUUID();
    const self = agentToolsOf(this) as {
      _asAgentToolChildAdapter(child: unknown): unknown;
    };
    const asAdapter = self._asAgentToolChildAdapter;
    let inspections = 0;
    self._asAgentToolChildAdapter = () => ({
      startAgentToolRun: async () => {
        throw new Error("test: forced reset");
      },
      cancelAgentToolRun: async () => {},
      inspectAgentToolRun: async () => {
        if (!childHasRun) return null;
        return {
          runId,
          status: ++inspections < 2 ? "running" : "completed",
          summary: "done after all",
          startedAt: 1
        };
      },
      getAgentToolChunks: async () => [],
      tailAgentToolRun: async () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.close()
        })
    });
    try {
      const result = await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input: { prompt: "start call fails" },
        inputPreview: "start call fails"
      }).then(
        (value) => ({ status: value.status, error: value.error }),
        (error) => ({
          threw: error instanceof Error ? error.message : String(error)
        })
      );
      return { result, parentRow: this.getParentAgentToolStatusForTest(runId) };
    } finally {
      self._asAgentToolChildAdapter = asAdapter;
    }
  }

  /**
   * The child's isolate resets while the parent waits on its run. Returns
   * what the parent's `runAgentTool` handed back and what the child's row
   * says once its chat recovery has finished the turn.
   */
  async runChildThroughResetForTest(): Promise<{
    result: { status: string; error?: string };
    parentRow: string | null;
    child: { status: string; error?: string } | null;
  }> {
    const runId = crypto.randomUUID();
    const running = this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input: { prompt: "work through a reset", chunkDelayMs: 100 },
      inputPreview: "work through a reset"
    });
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    // Reset once the run's reply is streaming: a turn that had not
    // started cannot be recovered.
    const streaming = Date.now() + 5000;
    while (
      (await child.getAgentToolChunks(runId)).length === 0 &&
      Date.now() < streaming
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await child.resetIsolateForTest().catch(() => {});
    const result = await running;
    const deadline = Date.now() + 10_000;
    let inspection: { status: string; error?: string } | null = null;
    while (Date.now() < deadline) {
      const fresh = await this.subAgent(AIChatAgentToolChild, runId);
      inspection = await fresh.inspectAgentToolRun(runId);
      if (
        inspection &&
        inspection.status !== "running" &&
        inspection.status !== "starting"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      result: { status: result.status, error: result.error },
      parentRow: this.getParentAgentToolStatusForTest(runId),
      child: inspection
        ? { status: inspection.status, error: inspection.error }
        : null
    };
  }

  /** Release the tool child's reply if its injection never landed. */
  async releaseChildInjectionHoldForTest(runId: string): Promise<void> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    await child.releaseInjectionHoldForTest();
  }

  /**
   * #1589: run a child that injects a chunk into the tail attach window and
   * return the forwarded agent-tool events so the test can assert the chunk
   * survives the stored-replay → live-forwarding handoff.
   */
  async runChildWithAttachRaceForTest(
    input: AgentToolInput,
    raceBody: string,
    runId = crypto.randomUUID()
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    await child.armAttachRaceInjectionForTest(runId, raceBody);
    const result = await this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
    return { result, events: this.events };
  }

  /**
   * Run a child that injects NON-stored progress + milestone frames into the
   * tail attach window and return the forwarded events, so the test can assert
   * broadcast-only `reportProgress` frames survive the stored-replay →
   * live-forwarding handoff (they have no stored chunk_index, so the in-memory
   * live sequence counter is load-bearing for forwarding them).
   */
  async runChildWithProgressInjectionForTest(
    input: AgentToolInput,
    progressBody: string,
    milestoneBody: string,
    runId = crypto.randomUUID()
  ): Promise<{ result: RunAgentToolResult; events: AgentToolEventMessage[] }> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    await child.armProgressInjectionForTest(runId, progressBody, milestoneBody);
    const result = await this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      inputPreview: input.prompt
    });
    return { result, events: this.events };
  }

  /**
   * Drive the child's post-restart cold-counter realign probe (Devin review on
   * #1827). Routed through `subAgent` so the child runs in its SQL-enabled DO.
   */
  async coldCounterChildReattachForTest(afterSequence?: number): Promise<{
    drained: number[];
    liveSequenceAfterDrain: number | undefined;
    postRestart: { sequence: number; body: string } | null;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.coldCounterReattachForwardsForTest(afterSequence);
  }

  async progressDuringChildDrainForTest(): Promise<string[]> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.progressDuringDrainForTest();
  }

  async skippedChunkChildReattachForTest(): Promise<
    Array<{ sequence: number; delta?: string; unstored: boolean }>
  > {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.skippedChunkReattachForTest();
  }

  async broadcastDuringChildInspectionForTest(): Promise<{
    drained: number[];
    postRestart: { sequence: number; body: string } | null;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.broadcastDuringInspectionForTest();
  }

  async inspectStaleChildRunReadOnlyForTest(): Promise<{
    reported: string | undefined;
    stored: string | undefined;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.inspectStaleRunReadOnlyForTest();
  }

  async reconcileEvictedErroredChildForTest(): Promise<{
    before: string | null;
    assistantText: string;
    inspection: AgentToolRunInspection | null;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.reconcileEvictedErroredRunForTest();
  }

  async terminalOnlyChildAfterRecoveredTurnForTest(): Promise<{
    afterRebind: boolean;
    afterClose: boolean;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.terminalOnlyRunAfterRecoveredTurnForTest();
  }

  /**
   * Drive the cancelled-tailer-starves-siblings probe (Devin review on #1827).
   * Routed through `subAgent` so the child runs in its SQL-enabled DO.
   */
  async cancelledTailerStarvationChildForTest(): Promise<{
    siblingBodyAfterCancel: string | null;
  }> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    return child.cancelledTailerStarvationForTest();
  }

  async runChildWithDelayedAbort(
    input: AgentToolInput,
    abortAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    const controller = new AbortController();
    const timeout =
      abortAfterMs > 0
        ? setTimeout(() => controller.abort("test abort"), abortAfterMs)
        : undefined;
    if (abortAfterMs <= 0) controller.abort("test abort");
    try {
      return await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input,
        signal: controller.signal
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  getEventsForTest(): AgentToolEventMessage[] {
    return this.events;
  }

  getFinishesForTest(): AgentToolFinishForTest[] {
    return this.finishes;
  }

  /**
   * #1575: run a child while injecting a chat error frame from an UNRELATED
   * turn (a request id that belongs to no agent-tool run) into the child's
   * broadcast stream mid-run. The run's terminal status must not be
   * contaminated by it.
   */
  async runChildWithInjectedUnrelatedError(
    input: AgentToolInput,
    injectAfterMs: number,
    runId = crypto.randomUUID()
  ): Promise<RunAgentToolResult> {
    this.events = [];
    this.finishes = [];
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    const timer = setTimeout(() => {
      void child.broadcastUnrelatedErrorForTest(`unrelated-turn-${runId}`);
    }, injectAfterMs);
    try {
      return await this.runAgentTool(AIChatAgentToolChild, {
        runId,
        parentToolCallId: "test-tool-call",
        input,
        inputPreview: input.prompt
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * #1575: read the child's live request-id cache size after a run, to assert
   * negatively-cached entries for unrelated turns were swept on completion.
   */
  async childAgentToolRunsMapSizeForTest(runId: string): Promise<number> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.agentToolRunsByRequestIdSizeForTest();
  }

  /**
   * #1575: resolve a run via the child's request-id SQL fallback after the
   * in-memory map is cleared (post-restart attribution).
   */
  async childResolveAfterRestartForTest(
    runId: string,
    requestId: string
  ): Promise<{ running: string | null; unknown: string | null }> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.resolveAgentToolRunAfterRestartForTest(runId, requestId);
  }

  /**
   * #1575: start a child run directly — no tailer/forwarder is ever
   * attached — and wait for its terminal inspection. Terminal status must
   * come from the child turn's own result, not from tailing side effects.
   */
  /**
   * Three runs on one child, started together: a slow one, one whose input
   * asks for a stream error, and a third. Returns the second run's outcome.
   */
  async startThreeChildRunsForTest(): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(
      AIChatAgentToolChild,
      crypto.randomUUID()
    );
    const errorRunId = crypto.randomUUID();
    await child.startAgentToolRun(
      { prompt: "first", delayMs: 200 },
      { runId: crypto.randomUUID() }
    );
    await child.startAgentToolRun(
      { prompt: "second", streamError: "boom" },
      { runId: errorRunId }
    );
    await child.startAgentToolRun(
      { prompt: "third" },
      { runId: crypto.randomUUID() }
    );
    return this.waitForTerminalInspectionForTest(child, errorRunId);
  }

  async startChildWithoutTailForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    await child.startAgentToolRun(input, { runId });
    return this.waitForTerminalInspectionForTest(child, runId);
  }

  private insertRecoverableParentRunForTest(
    runId: string,
    agentType: string,
    inputPreview: string,
    startedAt: number,
    status: "starting" | "running" = "running"
  ): void {
    ensureReleasedAgentToolTable(this.ctx.storage.sql);

    this.sql`
      INSERT INTO cf_agent_tool_runs (
        run_id, parent_tool_call_id, agent_type, input_preview,
        input_redacted, status, display_metadata, display_order, started_at
      ) VALUES (
        ${runId}, 'test-tool-call', ${agentType},
        ${JSON.stringify(inputPreview)}, 1, ${status},
        ${JSON.stringify({ name: "test child" })}, 0, ${startedAt}
      )
    `;
  }

  private async waitForTerminalInspectionForTest(
    child: {
      inspectAgentToolRun(
        runId: string
      ): Promise<AgentToolRunInspection | null>;
    },
    runId: string
  ): Promise<AgentToolRunInspection> {
    let inspection = await child.inspectAgentToolRun(runId);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        inspection &&
        inspection.status !== "running" &&
        inspection.status !== "starting"
      ) {
        return inspection;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      inspection = await child.inspectAgentToolRun(runId);
    }
    throw new Error("Timed out waiting for child agent-tool completion");
  }

  private async prepareCompletedChildForRecoveryTest(
    input: AgentToolInput,
    runId: string
  ): Promise<AgentToolRunInspection> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    const started = await child.startAgentToolRun(input, { runId });
    this.insertRecoverableParentRunForTest(
      runId,
      "AIChatAgentToolChild",
      input.prompt,
      started.startedAt
    );
    return this.waitForTerminalInspectionForTest(child, runId);
  }

  /**
   * What a restart does with the parent rows a released version left: carry
   * them into their tasks (startup), then run the interrupted attempts (here
   * at once, instead of from their wake) and wait for each to settle.
   * `options` stand in for the agent's re-attach budget meanwhile.
   */
  private async reconcileAgentToolRunsForTest(options?: {
    reattachTimeoutMs?: number;
    afterStartup?: () => void;
  }): Promise<void> {
    const self = this as unknown as {
      _resolvedOptions: { agentToolReattachNoProgressTimeoutMs: number };
    };
    const before = self._resolvedOptions.agentToolReattachNoProgressTimeoutMs;
    if (options?.reattachTimeoutMs !== undefined) {
      self._resolvedOptions.agentToolReattachNoProgressTimeoutMs =
        options.reattachTimeoutMs;
    }
    try {
      await (
        agentToolsOf(this) as { _carryForwardAgentToolRuns(): Promise<void> }
      )._carryForwardAgentToolRuns();
      options?.afterStartup?.();
      await runAgentToolChecksForTest(this);
    } finally {
      self._resolvedOptions.agentToolReattachNoProgressTimeoutMs = before;
    }
  }

  async reconcileCompletedChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    inspection: AgentToolRunInspection;
  }> {
    const inspection = await this.prepareCompletedChildForRecoveryTest(
      input,
      runId
    );
    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();

    return { events: this.events, finishes: this.finishes, inspection };
  }

  /**
   * A still-running child that reaches terminal *during* the parent's bounded
   * re-attach window: reconciliation should tail it to terminal and finalize
   * the parent row `completed` instead of abandoning it `interrupted` (#1630).
   */
  async reconcileRunningChildForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    // Short delay: still running when reconciliation starts, then terminal a
    // moment later — within the generous re-attach budget.
    const started = await child.startAgentToolRun(
      { ...input, delayMs: input.delayMs ?? 200 },
      { runId }
    );
    this.insertRecoverableParentRunForTest(
      runId,
      "AIChatAgentToolChild",
      input.prompt,
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest({ reattachTimeoutMs: 30_000 });

    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  /**
   * A tail-able child whose turn never reaches terminal: reconciliation must
   * re-attach, tail until the bounded re-attach budget is spent, then seal the
   * parent row `interrupted` so a genuinely hung child can never block recovery
   * forever (#1630). A small budget threaded through the seam keeps it fast.
   */
  async reattachStuckTailableChildForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    const started = await child.startAgentToolRun(
      { prompt: "stuck tailable child", delayMs: 60_000 },
      { runId }
    );
    this.insertRecoverableParentRunForTest(
      runId,
      "AIChatAgentToolChild",
      "stuck tailable child",
      started.startedAt
    );

    this.events = [];
    this.finishes = [];
    const startedAt = Date.now();
    try {
      await this.reconcileAgentToolRunsForTest({ reattachTimeoutMs: 200 });
    } finally {
      await child.cancelAgentToolRun(runId, "test cleanup");
    }
    return {
      events: this.events,
      finishes: this.finishes,
      elapsedMs: Date.now() - startedAt,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  async reconcileMissingChildForTest(runId = crypto.randomUUID()): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "MissingAgentToolChild",
      "missing child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();

    return { events: this.events, finishes: this.finishes };
  }

  async reconcileStuckChildWithTimeoutForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    elapsedMs: number;
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckAgentToolChild",
      "stuck child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    const startedAt = Date.now();
    await this.reconcileAgentToolRunsForTest();
    return {
      events: this.events,
      finishes: this.finishes,
      elapsedMs: Date.now() - startedAt,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  async scheduleStuckChildRecoveryForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckAgentToolChild",
      "scheduled stuck child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    await this.reconcileAgentToolRunsForTest();
    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  async scheduleStuckChildRecoveryTwiceForTest(
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    status: string | null;
  }> {
    this.insertRecoverableParentRunForTest(
      runId,
      "StuckAgentToolChild",
      "single flight stuck child",
      Date.now()
    );

    this.events = [];
    this.finishes = [];
    const first = this.reconcileAgentToolRunsForTest();
    const second = this.reconcileAgentToolRunsForTest();
    await Promise.all([first, second]);
    return {
      events: this.events,
      finishes: this.finishes,
      status: this.getParentAgentToolStatusForTest(runId)
    };
  }

  getParentAgentToolStatusForTest(runId: string): string | null {
    return (
      (
        agentToolsOf(this) as {
          _readAgentToolRun(runId: string): { status: string } | null;
        }
      )._readAgentToolRun(runId)?.status ?? null
    );
  }

  async reconcileCompletedChildWithDeferredFinishForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    finishesBeforeDrain: number;
    lifecycleOrder: string[];
  }> {
    await this.prepareCompletedChildForRecoveryTest(input, runId);
    this.events = [];
    this.finishes = [];
    this.lifecycleOrder = [];

    // The recovered attempt runs from its wake, after startup.
    let finishesBeforeDrain = -1;
    await this.reconcileAgentToolRunsForTest({
      afterStartup: () => {
        finishesBeforeDrain = this.finishes.length;
        this.lifecycleOrder.push("after-on-start");
      }
    });

    return {
      events: this.events,
      finishes: this.finishes,
      finishesBeforeDrain,
      lifecycleOrder: this.lifecycleOrder
    };
  }

  async reconcileCompletedChildWithFailedStartupForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
    lifecycleOrder: string[];
    statusAfterFailedStart: string | null;
    finishesAfterFailedStart: number;
  }> {
    await this.prepareCompletedChildForRecoveryTest(input, runId);
    this.events = [];
    this.finishes = [];
    this.lifecycleOrder = [];

    // Startup carried the row into its task, then the user's onStart
    // threw. The job driver dispatches no job of an object whose start
    // failed, so the run's wake does not run: nothing settles, no hook.
    await (
      agentToolsOf(this) as { _carryForwardAgentToolRuns(): Promise<void> }
    )._carryForwardAgentToolRuns();
    this.lifecycleOrder.push("on-start-error");
    const statusAfterFailedStart = this.getParentAgentToolStatusForTest(runId);
    const finishesAfterFailedStart = this.finishes.length;
    // The next start that succeeds runs the wake.
    await this.reconcileAgentToolRunsForTest();

    return {
      events: this.events,
      finishes: this.finishes,
      lifecycleOrder: this.lifecycleOrder,
      statusAfterFailedStart,
      finishesAfterFailedStart
    };
  }

  async reconcileCompletedChildWithReplayFailureForTest(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    events: AgentToolEventMessage[];
    finishes: AgentToolFinishForTest[];
  }> {
    await this.prepareCompletedChildForRecoveryTest(input, runId);
    this.events = [];
    this.finishes = [];

    type BroadcastStoredChunksFromAdapter = (
      adapter: unknown,
      row: unknown,
      sequence: number,
      replay?: true,
      connection?: unknown
    ) => Promise<number>;
    const self = agentToolsOf(this) as {
      _broadcastAgentToolStoredChunksFromAdapter: BroadcastStoredChunksFromAdapter;
    };
    const original = self._broadcastAgentToolStoredChunksFromAdapter.bind(
      self
    ) as BroadcastStoredChunksFromAdapter;
    self._broadcastAgentToolStoredChunksFromAdapter = async () => {
      throw new Error("test replay failure");
    };
    try {
      await this.reconcileAgentToolRunsForTest();
    } finally {
      self._broadcastAgentToolStoredChunksFromAdapter = original;
    }

    return { events: this.events, finishes: this.finishes };
  }

  async reconcileTwoCompletedChildrenWithThrowingFinishForTest(): Promise<{
    finishes: AgentToolFinishForTest[];
    lifecycleOrder: string[];
  }> {
    const firstRunId = crypto.randomUUID();
    const secondRunId = crypto.randomUUID();
    await this.prepareCompletedChildForRecoveryTest(
      { prompt: "first recovered child" },
      firstRunId
    );
    await this.prepareCompletedChildForRecoveryTest(
      { prompt: "second recovered child" },
      secondRunId
    );

    this.events = [];
    this.finishes = [];
    this.lifecycleOrder = [];
    this.finishRunIdsToThrow = new Set([firstRunId]);
    await this.reconcileAgentToolRunsForTest();
    this.finishRunIdsToThrow.clear();

    return { finishes: this.finishes, lifecycleOrder: this.lifecycleOrder };
  }

  async inspectChild(runId: string): Promise<AgentToolRunInspection | null> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.inspectAgentToolRun(runId);
  }

  async getChildChunks(
    runId: string,
    afterSequence?: number
  ): Promise<AgentToolStoredChunk[]> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.getAgentToolChunks(runId, { afterSequence });
  }

  async getChildMessages(runId: string): Promise<ChatMessage[]> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    return child.listMessagesForTest();
  }

  async startAndCancelChild(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<AgentToolRunInspection | null> {
    const child = await this.subAgent(AIChatAgentToolChild, runId);
    await child.startAgentToolRun(input, { runId });
    await child.cancelAgentToolRun(runId, "test abort");
    return child.inspectAgentToolRun(runId);
  }

  private async _freshChildForTest() {
    return this.subAgent(AIChatAgentToolChild, crypto.randomUUID());
  }

  async childRunWithDateInputForTest() {
    return (await this._freshChildForTest()).runWithDateInputForTest();
  }

  async childRunWithCircularOutputForTest() {
    return (await this._freshChildForTest()).runWithCircularOutputForTest();
  }

  async childResetWhileRunStreamsForTest() {
    return (await this._freshChildForTest()).resetWhileRunStreamsForTest();
  }

  async childCancelQueuedRunForTest(thenReset: boolean) {
    return (await this._freshChildForTest()).cancelQueuedRunForTest(thenReset);
  }

  async childSignalCancelsQueuedRunForTest() {
    return (await this._freshChildForTest()).signalCancelsQueuedRunForTest();
  }

  async childQueuedRunsKeepTheirOwnBodyForTest() {
    return (
      await this._freshChildForTest()
    ).queuedRunsKeepTheirOwnBodyForTest();
  }

  async childCancelStartingRunForTest() {
    return (await this._freshChildForTest()).cancelStartingRunForTest();
  }

  async runChildWithTrackedAbortListener(
    input: AgentToolInput,
    runId = crypto.randomUUID()
  ): Promise<{
    result: RunAgentToolResult;
    abortListenerAdded: number;
    abortListenerRemoved: number;
  }> {
    const controller = new AbortController();
    const signal = controller.signal;

    let abortListenerAdded = 0;
    let abortListenerRemoved = 0;
    type AddListener = typeof signal.addEventListener;
    type RemoveListener = typeof signal.removeEventListener;
    const originalAdd = signal.addEventListener.bind(signal) as AddListener;
    const originalRemove = signal.removeEventListener.bind(
      signal
    ) as RemoveListener;

    signal.addEventListener = ((
      type: Parameters<AddListener>[0],
      listener: Parameters<AddListener>[1],
      options?: Parameters<AddListener>[2]
    ) => {
      if (type === "abort") abortListenerAdded++;
      (originalAdd as (...args: unknown[]) => void)(type, listener, options);
    }) as AddListener;
    signal.removeEventListener = ((
      type: Parameters<RemoveListener>[0],
      listener: Parameters<RemoveListener>[1],
      options?: Parameters<RemoveListener>[2]
    ) => {
      if (type === "abort") abortListenerRemoved++;
      (originalRemove as (...args: unknown[]) => void)(type, listener, options);
    }) as RemoveListener;

    const result = await this.runAgentTool(AIChatAgentToolChild, {
      runId,
      parentToolCallId: "test-tool-call",
      input,
      signal
    });

    return { result, abortListenerAdded, abortListenerRemoved };
  }

  async testPreAbortedForwardStreamReleasesReaderLock(): Promise<boolean> {
    type ForwardAgentToolStream = (
      stream: ReadableStream<AgentToolStoredChunk>,
      parentToolCallId: string | undefined,
      runId: string,
      sequence: number,
      signal?: AbortSignal
    ) => Promise<number>;
    const stream = new ReadableStream<AgentToolStoredChunk>();
    const controller = new AbortController();
    controller.abort("already aborted");

    await (
      agentToolsOf(this) as { _forwardAgentToolStream: ForwardAgentToolStream }
    )._forwardAgentToolStream(
      stream,
      "test-tool-call",
      crypto.randomUUID(),
      1,
      controller.signal
    );

    const reader = stream.getReader();
    reader.releaseLock();
    return true;
  }

  async forwardMalformedAgentToolStreamForTest(): Promise<
    AgentToolEventMessage[]
  > {
    type ForwardAgentToolStream = (
      stream: ReadableStream<AgentToolStoredChunk>,
      parentToolCallId: string | undefined,
      runId: string,
      sequence: number,
      signal?: AbortSignal
    ) => Promise<number>;
    this.events = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              JSON.stringify({ sequence: 0, body: "first good frame" }),
              "{malformed json}",
              JSON.stringify({ sequence: 1, body: 42 }),
              JSON.stringify({ sequence: 2, body: "second good frame" })
            ].join("\n")
          )
        );
        controller.close();
      }
    });

    await (
      agentToolsOf(this) as { _forwardAgentToolStream: ForwardAgentToolStream }
    )._forwardAgentToolStream(
      stream as unknown as ReadableStream<AgentToolStoredChunk>,
      "test-tool-call",
      crypto.randomUUID(),
      1
    );

    return this.events;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
