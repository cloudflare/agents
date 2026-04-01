/**
 * Session Memory Example
 *
 * Demonstrates the Session API with:
 * - Context blocks (memory, todos) with frozen system prompt
 * - update_context AI tool (replace + append)
 * - Non-destructive compaction via onCompaction() builder
 * - Read-time tool output truncation
 */

import {
  Agent,
  callable,
  routeAgentRequest,
  type StreamingResponse
} from "agents";
import { Session } from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  createCompactFunction
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  generateText,
  streamText,
  convertToModelMessages,
  stepCountIs
} from "ai";

export class ChatAgent extends Agent<Env> {
  session = Session.create(this)
    .withContext("soul", {
      provider: {
        get: async () =>
          "You are a helpful assistant with persistent memory. Use the set_context tool to save important facts to memory and manage your todo list."
      }
    })
    .withContext("memory", {
      description: "Learned facts — save important things here",
      maxTokens: 1100
    })
    .withContext("todos", {
      description: "Task list",
      maxTokens: 2000
    })
    .onCompaction(
      createCompactFunction({
        summarize: (prompt) =>
          generateText({
            model: createWorkersAI({ binding: this.env.AI })(
              "@cf/zai-org/glm-4.7-flash"
            ),
            prompt
          }).then((r) => r.text),
        tailTokenBudget: 150, // ~15% of 1000 token context window
        minTailMessages: 1
      })
    )
    .compactAfter(1000) // auto-compact when history exceeds ~1000 tokens
    .withCachedPrompt();

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  @callable({ streaming: true })
  async chat(
    stream: StreamingResponse,
    message: string,
    messageId?: string
  ): Promise<void> {
    await this.session.appendMessage({
      id: messageId ?? `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);

    const result = streamText({
      model: this.getAI(),
      system: await this.session.freezeSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: await this.session.tools(),
      stopWhen: stepCountIs(5)
    });

    // Stream text chunks to the client
    for await (const chunk of result.textStream) {
      stream.send({ type: "text-delta", text: chunk });
    }

    // After streaming completes, build and persist the full message
    const parts: UIMessage["parts"] = [];
    const steps = await result.steps;

    for (const step of steps) {
      for (const tc of step.toolCalls) {
        const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
        parts.push({
          type: "dynamic-tool",
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          state: tr ? "output-available" : "input-available",
          input: tc.input,
          ...(tr ? { output: tr.output } : {})
        } as unknown as UIMessage["parts"][number]);
      }
    }

    const text = await result.text;
    if (text) {
      parts.push({ type: "text", text });
    }

    const assistantMsg: UIMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts
    };

    await this.session.appendMessage(assistantMsg);
    stream.end({ message: assistantMsg });
  }

  @callable()
  async compact(): Promise<{ success: boolean }> {
    try {
      await this.session.compact();
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  @callable()
  getMessages(): UIMessage[] {
    return this.session.getHistory();
  }

  @callable()
  search(query: string) {
    return this.session.search(query);
  }

  @callable()
  clearMessages(): void {
    this.session.clearMessages();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
