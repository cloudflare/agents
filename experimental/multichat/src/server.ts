/**
 * Multichat — one orchestrator, multiple Think chat sessions
 *
 * Architecture:
 *   Orchestrator (parent Agent, one per user)
 *     ├── ChatSession facet "chat-general"    (Think, own SQLite, own memory)
 *     ├── ChatSession facet "chat-research"   (Think, own SQLite, own memory)
 *     └── ChatSession facet "chat-code"       (Think, own SQLite, own memory)
 *
 * Each ChatSession is a Think facet with:
 *   - Its own context blocks (soul + memory, persisted in facet SQLite)
 *   - update_context tool (AI saves facts to memory)
 *   - Compaction via onCompact()
 *   - Independent conversation history
 *
 * The orchestrator manages the registry and routes messages.
 * Cross-chat search queries each facet's FTS index.
 */

import { Agent, routeAgentRequest, callable } from "agents";
import { Think } from "@cloudflare/think";
import type { StreamCallback } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import type { LanguageModel, UIMessage } from "ai";
import { buildSummaryPrompt } from "agents/experimental/memory/utils";
import { RpcTarget } from "cloudflare:workers";

// ── ChatSession — Think facet per conversation ────────────────────────────────

export class ChatSession extends Think<Env> {
  override getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  override getContextBlocks() {
    return [
      {
        label: "soul",
        description: "Agent identity",
        defaultContent: "You are a helpful assistant. Remember important facts using the update_context tool.",
        readonly: true,
      },
      {
        label: "memory",
        description: "Learned facts — save user preferences, project details, conventions",
        maxTokens: 1100,
      },
    ];
  }

  override getMaxSteps() {
    return 10;
  }

  override async onCompact() {
    if (!this._sessionId) return;
    const history = this.sessions.getHistory(this._sessionId);
    if (history.length < 6) return;

    const middle = history.slice(2, -4);
    if (middle.length === 0) return;

    const { text } = await generateText({
      model: this.getModel(),
      prompt: buildSummaryPrompt(middle, null, 2000),
    });

    const newSession = this.sessions.compactAndSplit(this._sessionId, text);
    this._sessionId = newSession.id;
  }
}

// ── Callback bridge ───────────────────────────────────────────────────────────

class NoopCallback extends RpcTarget implements StreamCallback {
  onEvent() {}
  onDone() {}
  onError() {}
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class Orchestrator extends Agent<Env> {
  private _ready = false;

  private ensureTable() {
    if (this._ready) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this._ready = true;
  }

  @callable()
  createChat(name: string): { id: string; name: string } {
    this.ensureTable();
    const id = `chat-${crypto.randomUUID().slice(0, 8)}`;
    this.sql`INSERT INTO chats (id, name) VALUES (${id}, ${name})`;
    return { id, name };
  }

  @callable()
  listChats(): Array<{ id: string; name: string; created_at: string }> {
    this.ensureTable();
    return this.sql<{ id: string; name: string; created_at: string }>`
      SELECT * FROM chats ORDER BY created_at DESC
    `;
  }

  @callable()
  deleteChat(chatId: string): void {
    this.ensureTable();
    this.sql`DELETE FROM chats WHERE id = ${chatId}`;
    this.deleteSubAgent(ChatSession, chatId);
  }

  @callable()
  async chat(chatId: string, message: string): Promise<string> {
    this.ensureTable();

    const rows = this.sql`SELECT id FROM chats WHERE id = ${chatId}`;
    if (rows.length === 0) throw new Error(`Chat not found: ${chatId}`);

    const session = await this.subAgent(ChatSession, chatId);
    await session.chat(message, new NoopCallback());

    const history = session.getHistory();
    const last = [...history].reverse().find((m) => m.role === "assistant");
    if (!last) return "(no response)";

    return last.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
  }

  @callable()
  async getHistory(chatId: string): Promise<UIMessage[]> {
    const session = await this.subAgent(ChatSession, chatId);
    return session.getHistory();
  }

  @callable()
  async searchAll(query: string) {
    this.ensureTable();
    const chats = this.sql<{ id: string; name: string }>`SELECT id, name FROM chats`;
    const results = [];

    for (const chat of chats) {
      try {
        const session = await this.subAgent(ChatSession, chat.id);
        const hits = session.sessions.search(query, { limit: 5 });
        if (hits.length > 0) {
          results.push({
            chatId: chat.id,
            chatName: chat.name,
            results: hits.map((h) => ({ role: h.role, content: h.content })),
          });
        }
      } catch { /* skip uninitialized */ }
    }

    return results;
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
