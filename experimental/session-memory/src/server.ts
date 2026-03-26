/**
 * Session Memory Example
 *
 * Demonstrates the Session API with:
 * - Context blocks (memory, todos) with frozen system prompt
 * - update_context AI tool (replace + append)
 * - Non-destructive compaction via onCompaction() builder
 * - Read-time tool output truncation
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { Session } from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  createCompactFunction
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages, stepCountIs } from "ai";

export class ChatAgent extends Agent<Env> {
  session = Session.create(this)
    .withContext("soul", {
      initialContent:
        "You are a helpful assistant with persistent memory. Use the update_context tool to save important facts to memory and manage your todo list.",
      readonly: true
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
          generateText({ model: this.getAI(), prompt }).then((r) => r.text),
        protectHead: 1,
        minTailMessages: 2,
        tailTokenBudget: 100
      })
    )
    .withCachedPrompt();

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  @callable()
  async chat(message: string, messageId?: string): Promise<UIMessage> {
    this.session.appendMessage({
      id: messageId ?? `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    // Auto-compact after 6 messages so it's easy to demo
    if (this.session.needsCompaction(6)) {
      await this.session.compact();
    }

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);

    const result = await generateText({
      model: this.getAI(),
      system: await this.session.freezeSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: await this.session.tools(),
      stopWhen: stepCountIs(5)
    });

    const parts: UIMessage["parts"] = [];

    for (const step of result.steps) {
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

    if (result.text) {
      parts.push({ type: "text", text: result.text });
    }

    const assistantMsg: UIMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts
    };

    this.session.appendMessage(assistantMsg);
    return assistantMsg;
  }

  @callable()
  async compact(): Promise<{ success: boolean; removed?: number }> {
    try {
      const removed = await this.session.compact();
      return { success: true, removed: removed ?? 0 };
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
