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
import { callable, routeAgentRequest } from "agents";
import type { UIMessage as ChatMessage } from "ai";

type Env = {
  ChatRecoveryTestAgent: DurableObjectNamespace<ChatRecoveryTestAgent>;
  ChatNoProgressExhaustAgent: DurableObjectNamespace<ChatNoProgressExhaustAgent>;
  ChatAbortedExhaustAgent: DurableObjectNamespace<ChatAbortedExhaustAgent>;
  ChatWorkBudgetExhaustAgent: DurableObjectNamespace<ChatWorkBudgetExhaustAgent>;
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
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
