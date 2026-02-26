/**
 * Session Memory Example
 *
 * Demonstrates Agent with Session-managed messages and compaction.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { Session, AgentSessionProvider } from "agents/experimental/memory/session";
import type { CompactResult } from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

async function compactMessages(messages: UIMessage[]): Promise<UIMessage[]> {
  if (messages.length === 0) return [];

  const workersai = createWorkersAI({ binding: env.AI });
  const { text } = await generateText({
    model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    system: "Summarize this conversation concisely, preserving key decisions, facts, and context.",
    messages: await convertToModelMessages(messages)
  });

  return [
    {
      id: `summary-${Date.now()}`,
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
    console.log("[chat] called with:", message);
    console.log("[chat] message count before append:", this.session.count());

    await this.session.append({
      id: `user-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });
    console.log("[chat] message count after user append:", this.session.count());

    const workersai = createWorkersAI({ binding: this.env.AI });
    const { text } = await generateText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: "You are a helpful assistant.",
      messages: await convertToModelMessages(this.session.getMessages())
    });
    console.log("[chat] AI response length:", text.length);

    await this.session.append({
      id: `assistant-${Date.now()}`,
      role: "assistant",
      parts: [{ type: "text", text }]
    });
    console.log("[chat] message count after assistant append:", this.session.count());

    return text;
  }

  @callable()
  getMessages(): UIMessage[] {
    const msgs = this.session.getMessages();
    console.log("[getMessages] returning", msgs.length, "messages");
    return msgs;
  }

  @callable()
  async compact(): Promise<CompactResult> {
    return this.session.compact();
  }

  @callable()
  clearMessages(): void {
    this.session.clear();
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
