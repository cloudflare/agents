/**
 * Multi-session AI Chat example.
 *
 * A parent `Inbox` agent (one DO per user) owns the chat list and a
 * per-user `memory` blob. Each chat is its own `Chat` DO — an
 * `AIChatAgent` subclass. The client talks directly to `Inbox` for
 * the sidebar, and directly to the active `Chat` for the conversation.
 *
 * Pattern being demonstrated (informally — this is the shape the
 * proposed `Chats` base class in `design/rfc-think-multi-session.md`
 * would codify):
 *
 *     Inbox (user-123)               ◄── you connect here for the sidebar
 *       ├─ Chat (chat-abc)           ◄── you connect here for the active chat
 *       ├─ Chat (chat-def)
 *       └─ Chat (chat-ghi)
 *
 * - `Inbox` is just an `Agent`. No special framework role — it holds
 *   state, exposes `@callable` methods, and calls `subAgent()` for
 *   utility work (not used here, but available).
 * - `Chat` is just an `AIChatAgent`. When it wants the shared
 *   `memory` block, it RPCs to Inbox via the DO namespace binding.
 * - Durable Objects are single-threaded, but each chat is its own DO —
 *   so two chats for the same user run in parallel. That's the whole
 *   point of per-chat DOs over a session map inside one DO.
 *
 * For a single-user demo we hardcode the Inbox name as "demo-user".
 * In a production app, authenticate the user first and use their id.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { nanoid } from "nanoid";

// The single-user Inbox name used by this demo. A real app would use
// the authenticated user's id.
export const DEMO_USER = "demo-user";

// ── Types shared between Inbox and Chat ─────────────────────────────

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface InboxState {
  chats: ChatSummary[];
}

// ── Inbox — the parent / directory ─────────────────────────────────

/**
 * One Inbox DO per user. Maintains:
 *   - `chats`: a sidebar index (broadcast via state)
 *   - `memory`: a per-user shared context blob (readable by any chat)
 */
export class Inbox extends Agent<Env, InboxState> {
  initialState: InboxState = { chats: [] };

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS inbox_chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS inbox_memory (
      label TEXT PRIMARY KEY,
      content TEXT NOT NULL
    )`;
    this._refreshState();
  }

  private _refreshState() {
    const rows = this.sql<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      last_message_preview: string | null;
    }>`
      SELECT id, title, created_at, updated_at, last_message_preview
      FROM inbox_chats
      ORDER BY updated_at DESC
    `;
    const chats: ChatSummary[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessagePreview: r.last_message_preview ?? undefined
    }));
    this.setState({ ...this.state, chats });
  }

  // ── Sidebar operations ────────────────────────────────────────────

  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const title =
      opts?.title ?? `Chat — ${new Date(now).toISOString().slice(0, 10)}`;
    this.sql`
      INSERT INTO inbox_chats (id, title, created_at, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, ${now}, NULL)
    `;
    this._refreshState();
    return { id, title, createdAt: now, updatedAt: now };
  }

  @callable()
  async renameChat(id: string, title: string): Promise<void> {
    this.sql`
      UPDATE inbox_chats
      SET title = ${title}, updated_at = ${Date.now()}
      WHERE id = ${id}
    `;
    this._refreshState();
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    this.sql`DELETE FROM inbox_chats WHERE id = ${id}`;
    this._refreshState();
    // Leave the child Chat DO to hibernate naturally. A production
    // implementation would also clear its messages via an RPC call —
    // the `Chats` RFC covers the lifecycle rules in more detail.
  }

  // ── Shared memory (RPC target for child chats + client) ──────────

  @callable()
  async getSharedMemory(label: string): Promise<string | null> {
    const rows = this.sql<{ content: string }>`
      SELECT content FROM inbox_memory WHERE label = ${label}
    `;
    return rows[0]?.content ?? null;
  }

  @callable()
  async setSharedMemory(label: string, content: string): Promise<void> {
    this.sql`
      INSERT INTO inbox_memory (label, content)
      VALUES (${label}, ${content})
      ON CONFLICT(label) DO UPDATE SET content = ${content}
    `;
  }

  // ── Called by a child Chat when a turn is committed ──────────────

  @callable()
  async recordChatTurn(chatId: string, preview: string): Promise<void> {
    this.sql`
      UPDATE inbox_chats
      SET updated_at = ${Date.now()}, last_message_preview = ${preview}
      WHERE id = ${chatId}
    `;
    this._refreshState();
  }
}

// ── Chat — a single conversation ────────────────────────────────────

export class Chat extends AIChatAgent {
  private getInbox(): DurableObjectStub<Inbox> {
    const id = this.env.Inbox.idFromName(DEMO_USER);
    return this.env.Inbox.get(id) as DurableObjectStub<Inbox>;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // Read shared user memory from the Inbox. Fails soft — if the
    // parent is unreachable for any reason, the chat still works.
    let sharedMemory = "";
    try {
      sharedMemory = (await this.getInbox().getSharedMemory("memory")) ?? "";
    } catch {
      // Best-effort.
    }

    const systemPrompt = [
      "You are a friendly assistant. Keep replies concise.",
      sharedMemory
        ? `Things you already know about this user:\n${sharedMemory}`
        : null
    ]
      .filter(Boolean)
      .join("\n\n");

    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemPrompt,
      messages: await convertToModelMessages([...this.messages])
    });

    return result.toUIMessageStreamResponse();
  }

  protected async onChatResponse(): Promise<void> {
    // Update the sidebar preview on the parent. Best-effort.
    const last = this.messages[this.messages.length - 1];
    if (!last) return;

    const preview = last.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .slice(0, 120);

    try {
      await this.getInbox().recordChatTurn(this.name, preview);
    } catch (err) {
      console.warn("[Chat] Failed to update inbox preview:", err);
    }
  }
}

// ── Entry worker ────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
