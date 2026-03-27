/**
 * Session Context Example
 *
 * Demonstrates the Session API with AI Search context provider:
 * - Searchable context block backed by Cloudflare AI Search
 * - search_context tool auto-wired for the AI to query knowledge
 * - update_context tool for memory and todos
 * - Streaming chat with tool use
 */

import {
  Agent,
  callable,
  routeAgentRequest,
  type StreamingResponse
} from "agents";
import { Session } from "agents/experimental/memory/session";
import { AiSearchContextProvider } from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";

export class ChatAgent extends Agent<Env> {
  session = Session.create(this)
    .withContext("soul", {
      initialContent:
        "You are a helpful assistant with access to a knowledge base. Use search_context to find information from the knowledge base. Use update_context to save important facts to memory.",
      readonly: true
    })
    .withContext("memory", {
      description: "Learned facts — save important things here",
      maxTokens: 2000
    })
    .withContext("knowledge", {
      description: "Searchable knowledge base powered by AI Search",
      provider: new AiSearchContextProvider(this.env.KNOWLEDGE)
    })
    .withCachedPrompt();

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5"
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

    const result = streamText({
      model: this.getAI(),
      system: await this.session.freezeSystemPrompt(),
      messages: await convertToModelMessages(history),
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
    return this.session.getHistory();
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
