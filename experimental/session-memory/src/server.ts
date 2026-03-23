/**
 * Session Memory Example
 *
 * Demonstrates the Session API with:
 * - Context blocks (memory, todos) with frozen system prompt
 * - update_context AI tool (replace + append)
 * - Non-destructive compaction (summarize → overlay, old messages stay)
 * - Read-time tool output truncation
 * - FTS search
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  AgentSessionProvider,
  SqliteBlockProvider,
} from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  buildSummaryPrompt,
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

export class ChatAgent extends Agent<Env> {
  session = new Session(new AgentSessionProvider(this), {
    context: [
      {
        label: "soul",
        description: "Agent identity",
        defaultContent: "You are a helpful assistant with persistent memory.",
        readonly: true,
      },
      {
        label: "memory",
        description: "Learned facts — save important things here",
        maxTokens: 1100,
        provider: new SqliteBlockProvider(this, "memory"),
      },
      {
        label: "todos",
        description: "Task list",
        maxTokens: 2000,
        provider: new SqliteBlockProvider(this, "todos"),
      },
    ],
  });

  async onStart() {
    await this.session.init();
  }

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  @callable()
  async chat(message: string): Promise<string> {
    this.session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }],
    });

    // Auto-compact if conversation is long
    if (this.session.needsCompaction(50)) {
      await this.compact();
    }

    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);

    const { text } = await generateText({
      model: this.getAI(),
      system: this.session.toSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: this.session.tools(),
      maxSteps: 5,
    });

    this.session.appendMessage({
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts: [{ type: "text", text }],
    });

    return text;
  }

  /**
   * Compact the conversation: summarize older messages with an LLM,
   * then overlay the summary. Old messages stay in storage but
   * getHistory() returns the summary instead.
   */
  @callable()
  async compact(): Promise<{ success: boolean; summary?: string }> {
    const history = this.session.getHistory();
    if (history.length < 6) return { success: false };

    // Keep first 2 and last 4, summarize the middle
    const fromMsg = history[2];
    const toMsg = history[history.length - 5];
    const middle = history.slice(2, -4);

    if (middle.length === 0) return { success: false };

    const prompt = buildSummaryPrompt(middle, null, 2000);
    const { text: summary } = await generateText({
      model: this.getAI(),
      prompt,
    });

    // Add overlay — old messages stay, getHistory() shows summary instead
    this.session.addCompaction(summary, fromMsg.id, toMsg.id);

    return { success: true, summary };
  }

  @callable()
  getHistory(): UIMessage[] {
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
  },
};
