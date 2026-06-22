/**
 * E2E test worker for chat recovery after process eviction.
 *
 * ChatRecoveryTestAgent:
 * - chatRecovery = true (chat turns wrapped in runFiber)
 * - onChatMessage streams slow SSE chunks (1 chunk/second)
 * - onChatRecovery records recovery context and uses defaults
 * - Callable methods for test inspection
 */
import {
  AIChatAgent,
  type ChatRecoveryConfig,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import { Agent, callable, routeAgentRequest } from "agents";
import type { UIMessage as ChatMessage } from "ai";

type Env = {
  ChatRecoveryTestAgent: DurableObjectNamespace<ChatRecoveryTestAgent>;
  ChatNoProgressExhaustAgent: DurableObjectNamespace<ChatNoProgressExhaustAgent>;
  ChatAbortedExhaustAgent: DurableObjectNamespace<ChatAbortedExhaustAgent>;
  ChatWorkBudgetExhaustAgent: DurableObjectNamespace<ChatWorkBudgetExhaustAgent>;
  ChatNoContinueAgent: DurableObjectNamespace<ChatNoContinueAgent>;
  ChatNoPersistNoContinueAgent: DurableObjectNamespace<ChatNoPersistNoContinueAgent>;
  ChatBufferCleanupAgent: DurableObjectNamespace<ChatBufferCleanupAgent>;
  ChatHangingRecoveryAgent: DurableObjectNamespace<ChatHangingRecoveryAgent>;
  ChatRecoveryHelperChild: DurableObjectNamespace<ChatRecoveryHelperChild>;
  ChatRecoveryHelperParent: DurableObjectNamespace<ChatRecoveryHelperParent>;
};

const EXHAUSTED_LOG_KEY = "test:exhausted-log";

type ExhaustedLogEntry = {
  reason: string;
  terminalMessage: string;
  attempt: number;
};

/**
 * Shared base for recovery-budget exhaustion e2e agents.
 *
 * `onChatMessage` returns a stream that emits nothing and never closes: the
 * turn is therefore always in-flight (a SIGKILL interrupts it and triggers
 * fiber recovery) and makes ZERO recovery progress (the progress marker is only
 * bumped by produced content). That lets the test drive recovery budgets
 * DETERMINISTICALLY via process kills, instead of racing real streamed content
 * that would reset the no-progress clock. Each subclass sets a `chatRecovery`
 * config that exhausts via a specific reason; `onExhausted` records it.
 */
abstract class ExhaustionBaseAgent extends AIChatAgent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };

  override async onChatMessage(
    _onFinish: unknown,
    _options?: OnChatMessageOptions
  ): Promise<Response> {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Hang forever: never enqueue, never close. Keeps the turn in-flight
        // and produces no recovery progress.
      }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  protected async _recordExhausted(
    ctx: ChatRecoveryExhaustedContext
  ): Promise<void> {
    const log =
      (await this.ctx.storage.get<ExhaustedLogEntry[]>(EXHAUSTED_LOG_KEY)) ??
      [];
    log.push({
      reason: ctx.reason,
      terminalMessage: ctx.terminalMessage,
      attempt: ctx.attempt
    });
    await this.ctx.storage.put(EXHAUSTED_LOG_KEY, log);
  }

  @callable()
  async getExhaustedLog(): Promise<ExhaustedLogEntry[]> {
    return (
      (await this.ctx.storage.get<ExhaustedLogEntry[]>(EXHAUSTED_LOG_KEY)) ?? []
    );
  }

  @callable()
  hasFiberRows(): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count > 0;
  }

  @callable()
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Read the durable terminal record (#1645) the framework persists when a turn
   * is sealed, so the test can assert the user-facing banner survives for a
   * client that reconnects after recovery gave up. Keyed by the framework's
   * internal storage key.
   */
  @callable()
  async getTerminalRecord(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return (
      (await this.ctx.storage.get<{ requestId: string; body: string }>(
        "cf:chat:last-terminal"
      )) ?? null
    );
  }
}

/**
 * Exhausts recovery via `no_progress_timeout`: a tiny no-progress window means
 * the SECOND interruption of a turn that produced nothing seals the incident.
 */
export class ChatNoProgressExhaustAgent extends ExhaustionBaseAgent {
  override chatRecovery: ChatRecoveryConfig = {
    noProgressTimeoutMs: 2_000,
    terminalMessage: "TERMINAL-NO-PROGRESS",
    onExhausted: (ctx) => this._recordExhausted(ctx)
  };
}

/**
 * Exhausts recovery via `recovery_aborted`: a huge no-progress window keeps the
 * other budgets from firing, and `shouldKeepRecovering` returns false from the
 * second attempt onward.
 */
export class ChatAbortedExhaustAgent extends ExhaustionBaseAgent {
  override chatRecovery: ChatRecoveryConfig = {
    noProgressTimeoutMs: 3_600_000,
    terminalMessage: "TERMINAL-ABORTED",
    shouldKeepRecovering: () => false,
    onExhausted: (ctx) => this._recordExhausted(ctx)
  };
}

/**
 * Exhausts recovery via `work_budget_exceeded`: `maxRecoveryWork: 0` seals the
 * incident as soon as the turn produces ANY recovery work. Unlike the base
 * agent, this one emits enough chunks to bump the durable progress/work meter
 * (a `text-start` past the flush threshold) BEFORE hanging, so each detection
 * sees work accrue beyond the baseline.
 */
export class ChatWorkBudgetExhaustAgent extends ExhaustionBaseAgent {
  override chatRecovery: ChatRecoveryConfig = {
    maxRecoveryWork: 0,
    noProgressTimeoutMs: 3_600_000,
    terminalMessage: "TERMINAL-WORK",
    onExhausted: (ctx) => this._recordExhausted(ctx)
  };

  override async onChatMessage(
    _onFinish: unknown,
    _options?: OnChatMessageOptions
  ): Promise<Response> {
    // Emit a single `text-start` then hang. `text-start` bumps the durable
    // recovery work/progress meter at production time (independent of flush),
    // so each interruption banks one unit of work. Staying below the 10-chunk
    // flush threshold keeps the recoverable partial empty (the retry path),
    // which avoids the continuation suppression that would swallow a re-emitted
    // text-start on the continue path.
    const chunks: Array<{ type: string; [k: string]: unknown }> = [
      { type: "start", messageId: `asst-${Date.now()}` },
      { type: "text-start" }
    ];
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) {
          await new Promise((r) => setTimeout(r, 100));
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`)
          );
          return;
        }
        // Progress banked: hang so the turn stays in-flight and interruptible.
        await new Promise(() => {});
      }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }
}

type RecoveryContextLogEntry = {
  streamId: string;
  requestId: string;
  partialText: string;
  recoveryData: unknown;
};

const RECOVERY_CONTEXTS_KEY = "test:recovery-contexts";
const ONCHATMESSAGE_COUNT_KEY = "test:onchatmessage-count";

function makeSSEStream(
  chunks: Array<{ type: string; [k: string]: unknown }>,
  delayMs: number
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      const chunk = chunks[index++];
      // AIChatAgent parses the AI SDK UI-message data-stream protocol, i.e.
      // `data: {json}` SSE frames (it skips anything not prefixed `data: `).
      // The legacy `0:{json}` framing was silently dropped, so no chunk was
      // ever persisted — which is why recovery only ever saw an empty partial.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
  });
}

export class ChatRecoveryTestAgent extends AIChatAgent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override chatRecovery = true;

  override async onChatMessage(
    _onFinish: unknown,
    _options?: OnChatMessageOptions
  ) {
    // Count invocations so a test can distinguish "persisted the partial but
    // did NOT re-run" (continue:false → 1) from a continuation (→ 2).
    const count =
      (await this.ctx.storage.get<number>(ONCHATMESSAGE_COUNT_KEY)) ?? 0;
    await this.ctx.storage.put(ONCHATMESSAGE_COUNT_KEY, count + 1);

    // Stream many small deltas at 500ms each so the turn takes long enough to be
    // interrupted by SIGKILL. The chunk count matters for recovery semantics:
    // ResumableStream flushes to SQLite in batches of CHUNK_BUFFER_SIZE (10), so
    // an interruption BEFORE that threshold leaves an empty (unflushed) partial
    // — the RETRY path (test kills at ~3s, ~6 chunks) — while an interruption
    // AFTER it leaves a non-empty partial — the CONTINUE path (test kills at
    // ~6s, ~12 chunks).
    const chunks: Array<{ type: string; [k: string]: unknown }> = [
      { type: "start", messageId: `asst-${Date.now()}` },
      { type: "text-start" }
    ];
    for (let i = 0; i < 20; i++) {
      chunks.push({ type: "text-delta", delta: `chunk${i + 1} ` });
    }
    chunks.push({ type: "text-end" }, { type: "finish" });

    return new Response(makeSSEStream(chunks, 500), {
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    const contexts =
      (await this.ctx.storage.get<RecoveryContextLogEntry[]>(
        RECOVERY_CONTEXTS_KEY
      )) ?? [];
    contexts.push({
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      partialText: ctx.partialText,
      recoveryData: ctx.recoveryData
    });
    await this.ctx.storage.put(RECOVERY_CONTEXTS_KEY, contexts);
    return {};
  }

  @callable()
  async getRecoveryStatus(): Promise<{
    recoveryCount: number;
    contexts: Array<{
      streamId: string;
      requestId: string;
      partialText: string;
      recoveryData: unknown;
    }>;
    messageCount: number;
    assistantMessages: number;
  }> {
    const assistantMsgs = this.messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    const contexts =
      (await this.ctx.storage.get<RecoveryContextLogEntry[]>(
        RECOVERY_CONTEXTS_KEY
      )) ?? [];
    return {
      recoveryCount: contexts.length,
      contexts,
      messageCount: this.messages.length,
      assistantMessages: assistantMsgs.length
    };
  }

  @callable()
  getMessages(): ChatMessage[] {
    return this.messages;
  }

  @callable()
  hasFiberRows(): boolean {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_runs
    `;
    return rows[0].count > 0;
  }

  @callable()
  async getChatMessageInvocations(): Promise<number> {
    return (await this.ctx.storage.get<number>(ONCHATMESSAGE_COUNT_KEY)) ?? 0;
  }

  @callable()
  getAssistantText(): string {
    const assistant = this.messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    return assistant
      .flatMap((m) =>
        m.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
      )
      .join("");
  }

  /**
   * Read the framework's durable "recovering…" flag (#1620), keyed by its
   * internal storage key `cf:chat:recovering`. The flag is written when a
   * recovery continuation is scheduled and deleted on the terminal outcome, so
   * the e2e test can assert the active→cleared transition DETERMINISTICALLY —
   * the live `cf_agent_chat_recovering` broadcast is NOT replayed on connect
   * (only the terminal outcome is), so the durable flag is the reliable source
   * of truth across the SIGKILL/restart boundary.
   */
  @callable()
  async getRecoveringFlag(): Promise<{
    requestId?: string;
    at?: number;
  } | null> {
    return (
      (await this.ctx.storage.get<{ requestId?: string; at?: number }>(
        "cf:chat:recovering"
      )) ?? null
    );
  }
}

/**
 * #1706 stream-buffer cleanup agent. Streams a SHORT turn that completes
 * quickly so a resumable-stream buffer (a `cf_ai_chat_stream_metadata` row plus
 * its packed `cf_ai_chat_stream_chunks` rows) and a `_cleanupStreamBuffers`
 * cleanup alarm both exist after a single turn. Exposes @callable inspectors so
 * the test can drive a DETERMINISTIC sweep with an injected far-future "now"
 * instead of waiting out the real 10-minute/1-hour retention windows.
 */
export class ChatBufferCleanupAgent extends AIChatAgent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };

  override async onChatMessage(
    _onFinish: unknown,
    _options?: OnChatMessageOptions
  ): Promise<Response> {
    // A handful of fast deltas: enough to flush a buffer row, quick enough to
    // complete well within the test's polling window.
    const chunks: Array<{ type: string; [k: string]: unknown }> = [
      { type: "start", messageId: `asst-${Date.now()}` },
      { type: "text-start" },
      { type: "text-delta", delta: "hello " },
      { type: "text-delta", delta: "world" },
      { type: "text-end" },
      { type: "finish" }
    ];
    return new Response(makeSSEStream(chunks, 50), {
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  /** Number of resumable-stream buffer rows (one per stream). */
  @callable()
  bufferRowCount(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_ai_chat_stream_metadata
    `;
    return rows[0].count;
  }

  /** Number of stored chunk (segment) rows across all streams. */
  @callable()
  chunkRowCount(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_ai_chat_stream_chunks
    `;
    return rows[0].count;
  }

  /**
   * Number of pending `_cleanupStreamBuffers` cleanup alarms in the framework's
   * schedule table. Used to assert a single armed schedule and that re-arming
   * is idempotent (a second completed turn must not stack a duplicate).
   */
  @callable()
  cleanupScheduleCount(): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM cf_agents_schedules
      WHERE callback = '_cleanupStreamBuffers'
    `;
    return rows[0].count;
  }

  /**
   * Force a stream-buffer sweep with an injected "now" so the test does not
   * have to wait out the real retention windows (10 min completed / 1 h
   * abandoned). Delegates to the same `cleanup(now)` the cleanup alarm uses.
   */
  @callable()
  forceSweep(nowMs: number): void {
    this._resumableStream.cleanup(nowMs);
  }

  /** Whether any stream rows remain — what the alarm uses to decide re-arming. */
  @callable()
  hasReclaimableStreams(): boolean {
    return this._resumableStream.hasReclaimableStreams();
  }
}

/**
 * Recovery returns `{ continue: false }`: the interrupted partial is persisted
 * as a durable assistant message, but the turn is NOT re-run.
 */
export class ChatNoContinueAgent extends ChatRecoveryTestAgent {
  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    await super.onChatRecovery(ctx);
    return { continue: false };
  }
}

/**
 * Recovery returns `{ persist: false, continue: false }`: a plain-text partial
 * (no settled tool results) is dropped and the turn is not re-run.
 */
export class ChatNoPersistNoContinueAgent extends ChatRecoveryTestAgent {
  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    await super.onChatRecovery(ctx);
    return { persist: false, continue: false };
  }
}

/**
 * Deployed-e2e recovery agent. Identical inspection surface to
 * `ChatRecoveryTestAgent` (records `onChatRecovery` contexts, exposes
 * `getRecoveryStatus` / `getRecoveringFlag`), but its turn HANGS forever instead
 * of streaming a finite mock response.
 *
 * On the real edge a `wrangler deploy` takes ~15-20s to make the new version
 * live, far longer than a finite mock turn — so a finite turn would complete
 * before the redeploy evicts the DO, leaving nothing to recover. A turn that
 * never completes is guaranteed to still be in-flight when the eviction lands,
 * which removes that timing race and deterministically produces an orphaned
 * fiber for restart detection to recover. It inherits `chatRecovery = true` and
 * the recovery-context recording from `ChatRecoveryTestAgent`.
 */
export class ChatHangingRecoveryAgent extends ChatRecoveryTestAgent {
  override async onChatMessage(
    _onFinish: unknown,
    _options?: OnChatMessageOptions
  ): Promise<Response> {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Hang forever: never enqueue, never close. The turn stays in-flight so
        // a redeploy mid-turn always finds an interruptible fiber.
      }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }
}

/**
 * Sub-agent SIGKILL parity (Think has this, ai-chat didn't): an `AIChatAgent`
 * run as an agent-tool CHILD. It inherits `ChatRecoveryTestAgent`'s slow finite
 * stream (~10s) + `chatRecovery = true` + default `onChatRecovery` (continue),
 * so a SIGKILL mid agent-tool run leaves the child's turn interrupted, and on
 * restart the child self-heals via continue recovery while the parent
 * re-attaches to its still-running run and collects the real terminal (#1630).
 */
export class ChatRecoveryHelperChild extends ChatRecoveryTestAgent {
  override formatAgentToolInput(
    input: { prompt: string },
    request: { runId: string }
  ): ChatMessage {
    return {
      id: `tool-input-${request.runId}`,
      role: "user",
      parts: [{ type: "text", text: input.prompt }]
    };
  }
}

type AgentToolRunStatus = {
  runId: string;
  status: string;
  error: string | null;
};

/**
 * Plain `Agent` parent that drives a child agent-tool run and exposes the
 * parent-side `cf_agent_tool_runs` ledger, mirroring Think's
 * `ThinkRecoveryHelperParent`. The faithful ai-chat path is `runAgentTool`
 * re-attach (not Think's `chat()` RPC), so the parent starts the run, lets it
 * stream, and the test kills/restarts wrangler mid-run.
 */
export class ChatRecoveryHelperParent extends Agent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };

  @callable()
  async startHelperAgentToolRun(
    runId: string,
    prompt: string
  ): Promise<string> {
    // The child facet is named by `runId` (runAgentTool resolves it via
    // subAgent(cls, runId)) and self-heals on recovery by default
    // (ChatRecoveryTestAgent.onChatRecovery returns {} = continue), so a
    // re-attached parent collects the child's REAL terminal after a restart
    // instead of abandoning it as interrupted.
    void this.runAgentTool(ChatRecoveryHelperChild, {
      runId,
      input: { prompt }
    }).catch((error) => {
      console.error("[test] helper agent-tool run failed:", error);
    });

    for (let i = 0; i < 20; i++) {
      const rows = this.getAgentToolRuns();
      if (rows.some((row) => row.runId === runId)) return runId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error("Timed out waiting for helper agent-tool row");
  }

  @callable()
  getAgentToolRuns(): AgentToolRunStatus[] {
    return this.sql<AgentToolRunStatus>`
      SELECT run_id as runId, status, error_message as error
      FROM cf_agent_tool_runs
      ORDER BY started_at ASC
    `;
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
