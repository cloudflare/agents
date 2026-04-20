/**
 * Session Multichat
 *
 * Single Agent with SessionManager for multiple independent chat sessions.
 * Each session has its own messages, context blocks (memory), and compaction.
 * Cross-session FTS search.
 */

import {
  Agent,
  callable,
  routeAgentRequest,
  type StreamingResponse
} from "agents";
import { SessionManager } from "agents/experimental/memory/session";
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

export class MultiSessionAgent extends Agent<Env> {
  manager = SessionManager.create(this)
    .withContext("soul", {
      description: "Agent identity",
      provider: {
        get: async () =>
          [
            "You are a helpful assistant with persistent memory.",
            "Use set_context to save important facts to memory.",
            "Use search_context to search conversation history across all sessions."
          ].join("\n")
      }
    })
    .withContext("memory", {
      description: "Learned facts — save important things here",
      maxTokens: 1100
    })
    .withSearchableHistory("history")
    .onCompaction(
      createCompactFunction({
        summarize: (prompt) =>
          generateText({
            model: createWorkersAI({ binding: this.env.AI })(
              "@cf/moonshotai/kimi-k2.6"
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
      "@cf/moonshotai/kimi-k2.6",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  @callable()
  createChat(name: string) {
    return this.manager.create(name);
  }

  @callable()
  listChats() {
    return this.manager.list();
  }

  @callable()
  deleteChat(chatId: string) {
    this.manager.delete(chatId);
  }

  // ── Chat ──────────────────────────────────────────────────────

  @callable({ streaming: true })
  async chat(
    stream: StreamingResponse,
    chatId: string,
    message: string
  ): Promise<void> {
    const session = this.manager.getSession(chatId);

    await session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const history = session.getHistory();
    const truncated = truncateOlderMessages(history);

    const result = streamText({
      model: this.getAI(),
      system: await session.freezeSystemPrompt(),
      messages: await convertToModelMessages(truncated as UIMessage[]),
      tools: { ...(await session.tools()), ...this.manager.tools() },
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

    await session.appendMessage(assistantMsg);
    stream.end({ message: assistantMsg });
  }

  @callable()
  getHistory(chatId: string): UIMessage[] {
    return this.manager.getSession(chatId).getHistory() as UIMessage[];
  }

  @callable()
  searchAll(query: string) {
    return this.manager.search(query);
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
