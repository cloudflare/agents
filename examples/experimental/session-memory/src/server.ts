/**
 * Session Memory Example
 *
 * Demonstrates using AgentSessionProvider for conversation history
 * with automatic compaction via LLM summarization.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { AgentSessionProvider } from "agents/experimental/memory/session";
import type { CompactResult } from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

/**
 * Compact function - summarizes entire conversation into a single system message
 */
async function compactMessages(messages: UIMessage[]): Promise<UIMessage[]> {
  if (messages.length === 0) {
    return [];
  }

  // Summarize with Workers AI using the conversation history
  const workersai = createWorkersAI({ binding: env.AI });
  const { text } = await generateText({
    model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    system: "Summarize this conversation concisely, preserving key decisions, facts, and context.",
    messages: convertToModelMessages(messages)
  });

  // Return single summary message
  return [
    {
      id: `summary-${Date.now()}`,
      role: "system",
      parts: [{ type: "text", text: `[Conversation Summary]\n${text}` }]
    }
  ];
}

/**
 * Chat Agent with session memory and compaction
 */
export class ChatAgent extends Agent<Env> {
  session = new AgentSessionProvider(this, {
    compaction: {
      tokenThreshold: 10000,
      fn: compactMessages
    }
  });

  @callable({ description: "Send a chat message and get a response" })
  async chat(message: string): Promise<{ response: string; messageCount: number }> {
    const userMessage: UIMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    };
    await this.session.append(userMessage);

    const messages = this.session.getMessages();

    const workersai = createWorkersAI({ binding: this.env.AI });
    const { text } = await generateText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      messages: convertToModelMessages(messages)
    });

    const assistantMessage: UIMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      parts: [{ type: "text", text }]
    };
    await this.session.append(assistantMessage);

    return { response: text, messageCount: this.session.count() };
  }

  @callable({ description: "Get all messages in the session" })
  getMessages(): { messages: UIMessage[]; count: number } {
    const messages = this.session.getMessages();
    return { messages, count: messages.length };
  }

  @callable({ description: "Manually trigger compaction" })
  async compact(): Promise<CompactResult> {
    return this.session.compact();
  }

  @callable({ description: "Clear all messages" })
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
