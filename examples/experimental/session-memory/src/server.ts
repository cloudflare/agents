/**
 * Session Memory Example
 *
 * Demonstrates using AgentSessionProvider for conversation history
 * with automatic compaction via LLM summarization.
 */

import { Agent, routeAgentRequest } from "agents";
import {
  AgentSessionProvider,
  estimateMessageTokens
} from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { env } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";

/**
 * Compact function - summarizes entire conversation into a single system message
 */
async function compactMessages(messages: UIMessage[]): Promise<UIMessage[]> {
  if (messages.length === 0) {
    return [];
  }

  // Build conversation text for summarization
  const conversationText = messages
    .map((m) => {
      const textParts = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text);
      return `${m.role}: ${textParts.join(" ")}`;
    })
    .join("\n");

  // Summarize with Workers AI
  const workersai = createWorkersAI({ binding: env.AI });
  const { text } = await generateText({
    model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    prompt: `Summarize this conversation concisely, preserving key decisions, facts, and context:\n\n${conversationText}`
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

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      const messages = this.session.getMessages();
      return Response.json({
        messages,
        count: messages.length,
        estimatedTokens: estimateMessageTokens(messages)
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/chat")) {
      const body = (await request.json()) as { message: string };

      const userMessage: UIMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: body.message }]
      };
      await this.session.append(userMessage);

      const messages = this.session.getMessages();
      const aiMessages = messages.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n")
      }));

      const workersai = createWorkersAI({ binding: this.env.AI });
      const { text } = await generateText({
        model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        messages: aiMessages
      });

      const assistantMessage: UIMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text }]
      };
      await this.session.append(assistantMessage);

      return Response.json({
        response: text,
        messageCount: this.session.count()
      });
    }

    if (request.method === "POST" && url.pathname.endsWith("/compact")) {
      const result = await this.session.compact();
      return Response.json(result);
    }

    if (request.method === "DELETE" && url.pathname.endsWith("/messages")) {
      this.session.clear();
      return Response.json({ success: true, message: "Session cleared" });
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route agent requests (handled by run_worker_first in wrangler.jsonc)
    const response = await routeAgentRequest(request, env);
    if (response) return response;

    // All other requests fall through to static assets (SPA)
    return new Response("Not found", { status: 404 });
  }
};
