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
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import { callable, routeAgentRequest } from "agents";
import type { UIMessage as ChatMessage } from "ai";

type Env = {
  ChatRecoveryTestAgent: DurableObjectNamespace<ChatRecoveryTestAgent>;
};

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
