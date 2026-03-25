/**
 * Hyperdrive + Postgres Session Example
 *
 * Uses Cloudflare Hyperdrive to connect to Postgres with connection pooling.
 * Session data lives in the external database instead of DO SQLite.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  PostgresSessionProvider,
  PostgresContextProvider,
  PostgresSearchProvider,
  type PostgresConnection
} from "agents/experimental/memory/session";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages, stepCountIs } from "ai";
import { Client } from "pg";

/**
 * Wrap a pg Client to match the PostgresConnection interface.
 * Converts `?` placeholders to `$1, $2, ...` for pg.
 */
function wrapPgClient(client: Client): PostgresConnection {
  return {
    async execute(query, args) {
      let idx = 0;
      const pgQuery = query.replace(/\?/g, () => `$${++idx}`);
      const result = await client.query(pgQuery, args ?? []);
      return { rows: result.rows };
    }
  };
}

export class ChatAgent extends Agent<Env> {
  private _session?: Session;
  private _pgClient?: Client;

  private async getPgConnection(): Promise<PostgresConnection> {
    if (!this._pgClient) {
      this._pgClient = new Client({
        connectionString: this.env.HYPERDRIVE.connectionString
      });
      await this._pgClient.connect();
    }
    return wrapPgClient(this._pgClient);
  }

  private async getSession(): Promise<Session> {
    if (this._session) return this._session;

    const conn = await this.getPgConnection();
    const sessionId = this.ctx.id.toString();

    this._session = Session.create(new PostgresSessionProvider(conn, sessionId))
      .withContext("soul", {
        provider: {
          get: async () =>
            "You are a helpful assistant with persistent memory and a searchable knowledge base."
        }
      })
      .withContext("memory", {
        description:
          "Short facts — append one-liners like preferences, names, key details",
        maxTokens: 1100,
        provider: new PostgresContextProvider(conn, `memory_${sessionId}`)
      })
      .withContext("knowledge", {
        description: "Searchable store for longer content",
        provider: new PostgresSearchProvider(conn)
      })
      .withCachedPrompt(
        new PostgresContextProvider(conn, `_prompt_${sessionId}`)
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
    const session = await this.getSession();

    await session.appendMessage({
      id: messageId ?? `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });

    const history = await session.getHistory();

    const result = await generateText({
      model: this.getAI(),
      system: await session.freezeSystemPrompt(),
      messages: await convertToModelMessages(history as UIMessage[], {
        ignoreIncompleteToolCalls: true
      }),
      tools: await session.tools(),
      stopWhen: stepCountIs(5)
    });

    const parts: UIMessage["parts"] = [];

    for (const step of result.steps) {
      for (const tc of step.toolCalls) {
        const tr = step.toolResults.find((r) => r.toolCallId === tc.toolCallId);
        if (!tr) continue;
        parts.push({
          type: "dynamic-tool",
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          state: "output-available",
          input: tc.input,
          output: tr.output
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
    return (await (await this.getSession()).getHistory()) as UIMessage[];
  }

  @callable()
  async search(query: string) {
    return (await this.getSession()).search(query);
  }

  @callable()
  async getSystemPrompt(): Promise<string> {
    return (await this.getSession()).freezeSystemPrompt();
  }

  @callable()
  async refreshSystemPrompt(): Promise<string> {
    return (await this.getSession()).refreshSystemPrompt();
  }

  @callable()
  async clearMessages(): Promise<void> {
    await (await this.getSession()).clearMessages();
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
