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

type ChatIndexSnapshot = ChatMeta & {
  revision: number;
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
        message_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
  }

  #ids(): { userId: string; chatId: string } {
    const separator = this.name.indexOf(":");
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

  #indexSnapshot(): ChatIndexSnapshot | null {
    const [last] = this.sql<{ id: number; text: string; at: number }>`
      SELECT id, text, at FROM messages ORDER BY id DESC LIMIT 1
    `;
    if (!last) return null;

    const [first] = this.sql<{ text: string }>`
      SELECT text FROM messages WHERE role = 'user' ORDER BY id ASC LIMIT 1
    `;
    const { chatId } = this.#ids();
    return {
      chatId,
      revision: last.id,
      title: first ? first.text.slice(0, 80) : null,
      lastMessage: last.text.slice(0, 120),
      updatedAt: last.at
    };
  }

  @callable()
  async addMessage(
    messageId: string,
    role: "user" | "assistant",
    text: string
  ): Promise<number> {
    if (messageId.trim() === "") {
      throw new Error("messageId must not be empty");
    }

    const result = this.ctx.storage.transactionSync(() => {
      let messageRevision: number;
      const [existing] = this.sql<{
        id: number;
        role: string;
        text: string;
      }>`
        SELECT id, role, text FROM messages WHERE message_id = ${messageId}
      `;
      if (existing) {
        if (existing.role !== role || existing.text !== text) {
          throw new Error(
            `Message ${JSON.stringify(messageId)} was already used with different content`
          );
        }
        messageRevision = existing.id;
      } else {
        const [inserted] = this.sql<{ id: number }>`
          INSERT INTO messages (message_id, role, text, at)
          VALUES (${messageId}, ${role}, ${text}, ${Date.now()})
          RETURNING id
        `;
        if (!inserted) {
          throw new Error(
            `Message ${JSON.stringify(messageId)} was not stored`
          );
        }
        messageRevision = inserted.id;
      }

      const snapshot = this.#indexSnapshot();
      if (!snapshot) {
        throw new Error("Stored message did not produce an index snapshot");
      }
      return { messageRevision, snapshot };
    });

    // The message is authoritative and already committed. Updating the User
    // index is an idempotent projection: a temporary cross-DO failure may leave
    // the list stale, but it must not make the accepted message look failed.
    const { userId } = this.#ids();
    try {
      const user = await getAgentByName(this.env.UserAgent, userId);
      await user.applyChatSnapshot(result.snapshot);
    } catch (error) {
      console.warn(
        "[ChatAgent] User index update failed; repair is available",
        {
          chatId: result.snapshot.chatId,
          revision: result.snapshot.revision,
          error
        }
      );
    }

    return result.messageRevision;
  }

  /** Authoritative metadata projection used by UserAgent repair. */
  getIndexSnapshot(): ChatIndexSnapshot | null {
    return this.#indexSnapshot();
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
        activity_sequence INTEGER NOT NULL DEFAULT 0,
        indexed_revision INTEGER NOT NULL DEFAULT 0
      )
    `;
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
        activity_sequence,
        indexed_revision
      )
      VALUES (
        ${chatId},
        NULL,
        NULL,
        ${Date.now()},
        ${this.#nextActivitySequence()},
        0
      )
    `;
    return chatId;
  }

  /** Apply an idempotent, revision-fenced metadata snapshot from a ChatAgent. */
  applyChatSnapshot(snapshot: ChatIndexSnapshot): boolean {
    return this.ctx.storage.transactionSync(() => {
      const [current] = this.sql<{ indexedRevision: number }>`
        SELECT indexed_revision AS indexedRevision FROM chats
        WHERE chat_id = ${snapshot.chatId}
      `;
      if (!current) return false;
      if (current.indexedRevision >= snapshot.revision) return true;

      const activitySequence = this.#nextActivitySequence();
      const rows = this.sql<{ chatId: string }>`
        UPDATE chats SET
          title = ${snapshot.title},
          last_message = ${snapshot.lastMessage},
          updated_at = ${snapshot.updatedAt},
          activity_sequence = ${activitySequence},
          indexed_revision = ${snapshot.revision}
        WHERE chat_id = ${snapshot.chatId}
          AND indexed_revision < ${snapshot.revision}
        RETURNING chat_id AS chatId
      `;
      return rows.length > 0;
    });
  }

  /** Pull the authoritative metadata snapshot for one known chat. */
  async repairChat(chatId: string): Promise<boolean> {
    const [known] = this.sql<{ chatId: string }>`
      SELECT chat_id AS chatId FROM chats WHERE chat_id = ${chatId}
    `;
    if (!known) return false;

    const chat = await getAgentByName(
      this.env.ChatAgent,
      `${this.name}:${chatId}`
    );
    const snapshot = await chat.getIndexSnapshot();
    return snapshot ? this.applyChatSnapshot(snapshot) : true;
  }

  @callable()
  listChats(): ChatMeta[] {
    return this.sql<ChatMeta>`
      SELECT chat_id AS chatId, title, last_message AS lastMessage,
             updated_at AS updatedAt
      FROM chats
      ORDER BY updated_at DESC, activity_sequence DESC, chat_id ASC
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
      ORDER BY updated_at DESC, activity_sequence DESC, chat_id ASC
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
