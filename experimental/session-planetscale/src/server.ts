/**
 * PlanetScale Session Example
 *
 * Demonstrates using PlanetScale (MySQL) as the session backend instead of
 * Durable Object SQLite. This means session data lives in a shared MySQL
 * database — useful when you need cross-DO queries, analytics, or want to
 * decouple session storage from the DO lifecycle.
 *
 * ## Setup
 *
 * 1. Create a PlanetScale database at https://planetscale.com
 * 2. Get connection credentials from the PlanetScale dashboard
 * 3. Set secrets:
 *      wrangler secret put PLANETSCALE_HOST
 *      wrangler secret put PLANETSCALE_USERNAME
 *      wrangler secret put PLANETSCALE_PASSWORD
 * 4. Deploy: wrangler deploy
 *
 * Tables are auto-created on first request — no migration step needed.
 *
 * ## How it works
 *
 * Instead of `Session.create(this)` (which auto-wires to DO SQLite), you
 * pass a `PlanetScaleSessionProvider` directly. The Session class detects
 * it's not a SqlProvider and skips SQLite auto-wiring. Context blocks also
 * need explicit providers since there's no DO storage to auto-wire to.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  PlanetScaleSessionProvider,
  PlanetScaleContextProvider,
  type PlanetScaleConnection
} from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages, stepCountIs } from "ai";
import { connect } from "@planetscale/database";

/**
 * Create a PlanetScale connection from environment variables.
 */
function createConnection(env: Env): PlanetScaleConnection {
  return connect({
    host: env.PLANETSCALE_HOST,
    username: env.PLANETSCALE_USERNAME,
    password: env.PLANETSCALE_PASSWORD
  });
}

export class ChatAgent extends Agent<Env> {
  /**
   * Build the session lazily — we need `this.env` which isn't available
   * at class field initialization time.
   */
  private _session?: Session;

  private getSession(): Session {
    if (this._session) return this._session;

    const conn = createConnection(this.env);
    // Use the DO id as the session scope — each DO instance gets its own
    // conversation thread in PlanetScale.
    const sessionId = this.ctx.id.toString();

    this._session = Session.create(
      new PlanetScaleSessionProvider(conn, sessionId)
    )
      .withContext("memory", {
        description: "Persistent facts learned during conversation",
        maxTokens: 1100,
        // Context blocks also need explicit PlanetScale-backed providers
        provider: new PlanetScaleContextProvider(conn, `memory_${sessionId}`)
      })
      .withCachedPrompt(
        // System prompt cache also goes to PlanetScale
        new PlanetScaleContextProvider(conn, `_prompt_${sessionId}`)
      );

    return this._session;
  }

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/meta/llama-4-scout-17b-16e-instruct"
    );
  }

  @callable()
  async chat(message: string, messageId?: string): Promise<UIMessage> {
    const session = this.getSession();

    await session.appendMessage({
      id: messageId ?? `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const history = await session.getHistory();

    const result = await generateText({
      model: this.getAI(),
      system: await session.freezeSystemPrompt(),
      messages: await convertToModelMessages(history as UIMessage[]),
      tools: await session.tools(),
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

    await session.appendMessage(assistantMsg);
    return assistantMsg;
  }

  @callable()
  async getMessages(): Promise<UIMessage[]> {
    return (await this.getSession().getHistory()) as UIMessage[];
  }

  @callable()
  async search(query: string) {
    return this.getSession().search(query);
  }

  @callable()
  async clearMessages(): Promise<void> {
    await this.getSession().clearMessages();
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
