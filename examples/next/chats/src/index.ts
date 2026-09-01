import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";

/**
 * The recommended shape for "many chats per user": one top-level
 * Durable Object per chat, plus one per-user index DO the chats push
 * their metadata into.
 *
 * Contrast with dynamic agents (facets): a chat needs no isolation
 * boundary from its parent, does need its own alarms and placement,
 * and a user accumulates an unbounded number of them — every axis on
 * which an independent DO beats a colocated facet. See
 * docs/agents/sub-agents.md for the decision rule.
 */

type ChatMeta = {
  chatId: string;
  title: string | null;
  lastMessage: string | null;
  updatedAt: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

/**
 * One Durable Object per conversation. The chat's name embeds its
 * owner (`{userId}:{chatId}`) so it can push index updates without any
 * init handshake, and deleting the chat is one `destroy()` — no manual
 * multi-table sweeps.
 */
export class ChatAgent extends Agent<Env> {
  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
  }

  #ids(): { userId: string; chatId: string } {
    const separator = this.name.lastIndexOf(":");
    if (separator === -1) {
      throw new Error(
        `ChatAgent name "${this.name}" must be "{userId}:{chatId}"`
      );
    }
    return {
      userId: this.name.slice(0, separator),
      chatId: this.name.slice(separator + 1)
    };
  }

  @callable()
  async addMessage(role: "user" | "assistant", text: string): Promise<number> {
    const at = Date.now();
    this.sql`
      INSERT INTO messages (role, text, at) VALUES (${role}, ${text}, ${at})
    `;
    const [{ n }] = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM messages
    `;

    // Push metadata to the per-user index so listing and search never
    // wake this DO. The index is derived data: it can always be
    // rebuilt from the chats themselves.
    const { userId, chatId } = this.#ids();
    const [first] = this.sql<{ text: string }>`
      SELECT text FROM messages WHERE role = 'user' ORDER BY id ASC LIMIT 1
    `;
    try {
      const user = await getAgentByName(this.env.UserAgent, userId);
      await user.recordChatActivity({
        chatId,
        title: first ? first.text.slice(0, 80) : null,
        lastMessage: text.slice(0, 120),
        updatedAt: at
      });
    } catch (error) {
      console.warn("[ChatAgent] User index update failed", error);
    }

    return n;
  }

  @callable()
  getMessages(): ChatMessage[] {
    return this.sql<ChatMessage>`
      SELECT role, text, at FROM messages ORDER BY id ASC
    `;
  }
}

/**
 * The per-user index: a push-based mirror of every chat's metadata.
 * Listing, ordering, and cross-chat search read only this DO — no
 * fan-out to the chat DOs.
 */
export class UserAgent extends Agent<Env> {
  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT,
        last_message TEXT,
        updated_at INTEGER NOT NULL,
        activity_sequence INTEGER NOT NULL DEFAULT 0
      )
    `;
    const columns = this.sql<{ name: string }>`PRAGMA table_info(chats)`;
    if (!columns.some((column) => column.name === "activity_sequence")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE chats ADD COLUMN activity_sequence INTEGER NOT NULL DEFAULT 0"
      );
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_activity_sequence INTEGER NOT NULL
      )
    `;
    this.sql`
      INSERT OR IGNORE INTO chat_index_state (id, next_activity_sequence)
      SELECT 1, COALESCE(MAX(activity_sequence), 0) FROM chats
    `;
  }

  #nextActivitySequence(): number {
    const [row] = this.sql<{ value: number }>`
      UPDATE chat_index_state
      SET next_activity_sequence = next_activity_sequence + 1
      WHERE id = 1
      RETURNING next_activity_sequence AS value
    `;
    if (!row) throw new Error("Chat index sequence row is missing.");
    return row.value;
  }

  @callable()
  async createChat(): Promise<string> {
    const chatId = crypto.randomUUID();
    this.sql`
      INSERT INTO chats (
        chat_id,
        title,
        last_message,
        updated_at,
        activity_sequence
      )
      VALUES (
        ${chatId},
        NULL,
        NULL,
        ${Date.now()},
        ${this.#nextActivitySequence()}
      )
    `;
    return chatId;
  }

  /** Internal DO-RPC target for ChatAgent metadata updates. */
  recordChatActivity(meta: ChatMeta): boolean {
    const activitySequence = this.#nextActivitySequence();
    const rows = this.sql<{ chatId: string }>`
      UPDATE chats SET
        title = ${meta.title},
        last_message = ${meta.lastMessage},
        updated_at = ${meta.updatedAt},
        activity_sequence = ${activitySequence}
      WHERE chat_id = ${meta.chatId}
      RETURNING chat_id AS chatId
    `;
    return rows.length > 0;
  }

  @callable()
  listChats(): ChatMeta[] {
    return this.sql<ChatMeta>`
      SELECT chat_id AS chatId, title, last_message AS lastMessage,
             updated_at AS updatedAt
      FROM chats
      ORDER BY activity_sequence DESC, updated_at DESC, chat_id ASC
    `;
  }

  /**
   * Cross-chat search over the pushed metadata. No chat DO wakes up
   * for this — the cost of search is one read of the user's own index.
   */
  @callable()
  searchChats(query: string): ChatMeta[] {
    const like = `%${query}%`;
    return this.sql<ChatMeta>`
      SELECT chat_id AS chatId, title, last_message AS lastMessage,
             updated_at AS updatedAt
      FROM chats
      WHERE title LIKE ${like} OR last_message LIKE ${like}
      ORDER BY activity_sequence DESC, updated_at DESC, chat_id ASC
    `;
  }

  /**
   * Deleting a chat is the whole payoff of per-chat DOs: destroy the
   * chat's own storage in one call, remove one index row, done.
   */
  @callable()
  async deleteChat(chatId: string): Promise<void> {
    const chat = await getAgentByName(
      this.env.ChatAgent,
      `${this.name}:${chatId}`
    );
    await chat.destroy();
    this.sql`DELETE FROM chats WHERE chat_id = ${chatId}`;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
