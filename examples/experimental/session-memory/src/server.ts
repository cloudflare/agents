/**
 * Session Memory Example
 *
 * Demonstrates Agent with Session-managed messages and compaction.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  AgentSessionProvider
} from "agents/experimental/memory/session";
import type { CompactResult } from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

async function compactMessages(messages: UIMessage[]): Promise<UIMessage[]> {
  if (messages.length === 0) return [];

  const workersai = createWorkersAI({ binding: env.AI });
  const { text } = await generateText({
    model: workersai("@cf/zai-org/glm-4.7-flash"),
    system:
      "Summarize this conversation concisely, preserving key decisions, facts, and context.",
    messages: await convertToModelMessages(messages)
  });

  return [
    {
      id: `summary-${crypto.randomUUID()}`,
      role: "assistant",
      parts: [{ type: "text", text: `[Conversation Summary]\n${text}` }]
    }
  ];
}

export class ChatAgent extends Agent<Env> {
  session = new Session(new AgentSessionProvider(this), {
    compaction: { tokenThreshold: 10000, fn: compactMessages }
  });

  @callable()
  async chat(message: string): Promise<string> {
    await this.session.append({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const workersai = createWorkersAI({ binding: this.env.AI });
    const { text } = await generateText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: "You are a helpful assistant.",
      messages: await convertToModelMessages(this.session.getMessages())
    });

    await this.session.append({
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts: [{ type: "text", text }]
    });

    return text;
  }

  @callable()
  getMessages(): UIMessage[] {
    return this.session.getMessages();
  }

  @callable()
  async compact(): Promise<CompactResult> {
    return this.session.compact();
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
