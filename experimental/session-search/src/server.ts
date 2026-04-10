/**
 * Session Search Example
 *
 * Demonstrates the SearchProvider with:
 * - Searchable knowledge block backed by DO SQLite FTS5
 * - The model indexes information via set_context and retrieves via search_context
 * - Session memory with context blocks (soul, memory)
 */

import {
  Agent,
  callable,
  routeAgentRequest,
  type StreamingResponse
} from "agents";
import {
  AgentSearchProvider,
  Session
} from "agents/experimental/memory/session";
import {
  createCompactFunction,
  truncateOlderMessages
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  streamText
} from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class SearchAgent extends Agent<Env> {
  session = Session.create(this)
    .withContext("soul", {
      provider: {
        get: async () =>
          [
            "You are a helpful assistant with searchable knowledge.",
            "When the user gives you information, use set_context to index it in the knowledge block with a descriptive key.",
            "When the user asks a question, use search_context to find relevant information before answering.",
            "Use set_context to save important facts to memory."
          ].join("\n")
      }
    })
    .withContext("memory", {
      description: "Learned facts",
      maxTokens: 1100
    })
    .withContext("knowledge", {
      description: "Searchable knowledge base",
      provider: new AgentSearchProvider(this)
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
        tailTokenBudget: 150,
        minTailMessages: 1
      })
    )
    .compactAfter(1000)
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
      messages: await convertToModelMessages(truncated as UIMessage[]),
      tools: await this.session.tools(),
      stopWhen: stepCountIs(5)
    });

    for await (const chunk of result.textStream) {
      stream.send({ type: "text-delta", text: chunk });
    }

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
  getMessages(): UIMessage[] {
    return this.session.getHistory() as UIMessage[];
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
