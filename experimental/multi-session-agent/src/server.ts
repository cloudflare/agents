/**
 * Multi-Session Agent
 *
 * Single Agent managing multiple independent chat sessions via the Session API.
 * Each session has its own messages, context blocks (memory), and compaction.
 * Cross-session FTS search.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import {
  Session,
  AgentSessionProvider,
  AgentContextProvider,
} from "agents/experimental/memory/session";
import {
  truncateOlderMessages,
  createCompactFunction,
} from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, convertToModelMessages } from "ai";

export class MultiSessionAgent extends Agent<Env> {
  private sessions = new Map<string, Session>();
  private _tableReady = false;

  private ensureTable() {
    if (this._tableReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this._tableReady = true;
  }

  private getAI() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.5",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  private async getSession(chatId: string): Promise<Session> {
    let session = this.sessions.get(chatId);
    if (session) return session;

    session = new Session(new AgentSessionProvider(this, chatId), {
      context: [
        {
          label: "soul",
          description: "Agent identity",
          defaultContent: "You are a helpful assistant with persistent memory. Use the update_context tool to save important facts.",
          readonly: true,
        },
        {
          label: "memory",
          description: "Learned facts — save important things here",
          maxTokens: 1100,
          provider: new AgentContextProvider(this, `memory_${chatId}`),
        },
      ],
      promptStore: new AgentContextProvider(this, `_prompt_${chatId}`),
    });
    this.sessions.set(chatId, session);
    return session;
  }

  private compactFn = createCompactFunction({
    summarize: (prompt) =>
      generateText({ model: this.getAI(), prompt }).then((r) => r.text),
    protectHead: 1,
    minTailMessages: 2,
    tailTokenBudget: 100,
  });

  // ── Registry ──────────────────────────────────────────────────

  @callable()
  createChat(name: string): { id: string; name: string } {
    this.ensureTable();
    const id = `chat-${crypto.randomUUID().slice(0, 8)}`;
    this.sql`INSERT INTO chat_registry (id, name) VALUES (${id}, ${name})`;
    return { id, name };
  }

  @callable()
  listChats(): Array<{ id: string; name: string; created_at: string }> {
    this.ensureTable();
    return this.sql<{ id: string; name: string; created_at: string }>`
      SELECT * FROM chat_registry ORDER BY created_at DESC
    `;
  }

  @callable()
  deleteChat(chatId: string): void {
    this.ensureTable();
    this.sql`DELETE FROM chat_registry WHERE id = ${chatId}`;
    const session = this.sessions.get(chatId);
    if (session) {
      session.clearMessages();
      this.sessions.delete(chatId);
    }
  }

  // ── Chat ──────────────────────────────────────────────────────

  @callable()
  async chat(chatId: string, message: string): Promise<UIMessage> {
    this.ensureTable();
    const session = await this.getSession(chatId);

    session.appendMessage({
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      parts: [{ type: "text", text: message }],
    });

    if (session.needsCompaction(6)) {
      await this.compact(chatId);
    }

    const history = session.getHistory();
    const truncated = truncateOlderMessages(history);

    const result = await generateText({
      model: this.getAI(),
      system: await session.context.freezeSystemPrompt(),
      messages: await convertToModelMessages(truncated),
      tools: await session.context.tools(),
      maxSteps: 5,
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
          ...(tr ? { output: tr.output } : {}),
        } as unknown as UIMessage["parts"][number]);
      }
    }
    if (result.text) {
      parts.push({ type: "text", text: result.text });
    }

    const assistantMsg: UIMessage = {
      id: `assistant-${crypto.randomUUID()}`,
      role: "assistant",
      parts,
    };
    session.appendMessage(assistantMsg);
    return assistantMsg;
  }

  @callable()
  async getHistory(chatId: string): Promise<UIMessage[]> {
    const session = await this.getSession(chatId);
    return session.getHistory();
  }

  @callable()
  async compact(chatId: string): Promise<{ success: boolean; removed?: number }> {
    const session = await this.getSession(chatId);
    const history = session.getHistory();
    if (history.length < 4) return { success: false };

    try {
      const compacted = await this.compactFn(history);
      const keptIds = new Set(compacted.map((m) => m.id));
      const removed = history.filter((m) => !keptIds.has(m.id));

      if (removed.length > 0) {
        const summaryMsg = compacted.find((m) => m.id.startsWith("compaction-summary-"));
        if (summaryMsg) {
          const summaryText = summaryMsg.parts
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");
          session.addCompaction(summaryText, removed[0].id, removed[removed.length - 1].id);
        }

        await session.context.refreshSystemPrompt();
      }
      return { success: true, removed: removed.length };
    } catch {
      return { success: false };
    }
  }

  @callable()
  async searchAll(query: string) {
    this.ensureTable();
    const chats = this.sql<{ id: string; name: string }>`SELECT id, name FROM chat_registry`;
    const results = [];

    for (const chat of chats) {
      try {
        const session = await this.getSession(chat.id);
        const hits = session.search(query);
        if (hits.length > 0) {
          results.push({
            chatId: chat.id,
            chatName: chat.name,
            results: hits.map((h) => ({ role: h.role, content: h.content })),
          });
        }
      } catch { /* skip */ }
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
