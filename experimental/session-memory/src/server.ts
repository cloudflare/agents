/**
 * Session Memory Example
 *
 * Demonstrates the Session API with:
 * - Tree-structured messages (branching)
 * - Context blocks (memory, soul) with frozen system prompt
 * - Non-destructive compaction overlays
 * - update_context AI tool
 * - FTS search
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  AgentSessionProvider,
  SqliteBlockProvider,
} from "agents/experimental/memory/session";
import { truncateOlderMessages } from "agents/experimental/memory/utils";
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

  @callable()
  async chat(message: string): Promise<string> {
    // Append user message
    this.session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }],
    });

    // Assemble context — truncate older tool outputs at read time
    const history = this.session.getHistory();
    const truncated = truncateOlderMessages(history);

    const workersai = createWorkersAI({ binding: this.env.AI });
    const { text } = await generateText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      // Frozen system prompt from context blocks
      system: this.session.toSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      // AI gets update_context tool to modify memory/todos blocks
      tools: this.session.tools(),
      maxSteps: 5,
    });

    // Append assistant response
    this.session.appendMessage({
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts: [{ type: "text", text }],
    });

    return text;
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
