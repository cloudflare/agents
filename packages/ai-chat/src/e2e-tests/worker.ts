/**
 * E2E test worker for chat recovery after process eviction.
 *
 * ChatRecoveryTestAgent:
 * - unstable_chatRecovery = true (chat turns wrapped in runFiber)
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
      controller.enqueue(encoder.encode(`0:${JSON.stringify(chunk)}\n`));
    }
  });
}

export class ChatRecoveryTestAgent extends AIChatAgent<Env> {
  static options = { keepAliveIntervalMs: 2_000 };
  override unstable_chatRecovery = true;

  recoveryContexts: Array<{
    streamId: string;
    requestId: string;
    partialText: string;
    recoveryData: unknown;
  }> = [];

  override async onChatMessage(
    _onFinish: unknown,
    _options?: OnChatMessageOptions
  ) {
    const chunks = [
      { type: "start", messageId: `asst-${Date.now()}` },
      { type: "text-start" },
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "world, " },
      { type: "text-delta", delta: "this " },
      { type: "text-delta", delta: "is " },
      { type: "text-delta", delta: "a " },
      { type: "text-delta", delta: "slow " },
      { type: "text-delta", delta: "response." },
      { type: "text-end" },
      { type: "finish" }
    ];

    return new Response(makeSSEStream(chunks, 1000), {
      headers: { "Content-Type": "text/event-stream" }
    });
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    this.recoveryContexts.push({
      streamId: ctx.streamId,
      requestId: ctx.requestId,
      partialText: ctx.partialText,
      recoveryData: ctx.recoveryData
    });
    return {};
  }

  @callable()
  getRecoveryStatus(): {
    recoveryCount: number;
    contexts: Array<{
      streamId: string;
      requestId: string;
      partialText: string;
      recoveryData: unknown;
    }>;
    messageCount: number;
    assistantMessages: number;
  } {
    const assistantMsgs = this.messages.filter(
      (m: ChatMessage) => m.role === "assistant"
    );
    return {
      recoveryCount: this.recoveryContexts.length,
      contexts: this.recoveryContexts,
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
