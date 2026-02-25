/**
 * Agent Session Provider
 *
 * Session provider that uses the Agent's DO SQLite storage.
 */

import type { SessionProvider } from "../provider";
import type { AIMessage, MessageQueryOptions } from "../types";

/**
 * Interface for objects that provide a sql tagged template method.
 * This matches the Agent class's sql method signature.
 */
export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/**
 * Session provider that wraps an Agent's SQLite storage.
 * Provides AI SDK compatible message storage and retrieval.
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent {
 *   session = new AgentSessionProvider(this);
 *
 *   async onChatMessage() {
 *     const messages = this.session.getMessages();
 *     // Use messages with AI SDK...
 *   }
 * }
 * ```
 */
export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;

  /**
   * Create a new session provider
   * @param agent An Agent instance (or any object with a sql method)
   */
  constructor(agent: SqlProvider) {
    this.agent = agent;
  }

  /**
   * Ensure the messages table exists
   */
  private ensureTable(): void {
    if (this.initialized) return;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_session_messages (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.initialized = true;
  }

  /**
   * Get all messages in AI SDK format
   * @param options Query options for filtering/pagination
   */
  getMessages(options?: MessageQueryOptions): AIMessage[] {
    this.ensureTable();

    // For complex queries with dynamic filters, we build the query parts
    // and use the sql executor with appropriate parameters
    type Row = { id: string; message: string; created_at: string };

    let rows: Row[];

    // Handle different query combinations
    if (options?.role && options?.before && options?.after) {
      if (options.limit && options.offset) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit} OFFSET ${options.offset}
        `;
      } else if (options.limit) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit}
        `;
      } else if (options.offset) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT -1 OFFSET ${options.offset}
        `;
      } else {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
        `;
      }
    } else if (options?.role && options?.before) {
      if (options.limit && options.offset) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit} OFFSET ${options.offset}
        `;
      } else if (options.limit) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit}
        `;
      } else {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at < ${options.before.toISOString()}
          ORDER BY created_at ASC, rowid ASC
        `;
      }
    } else if (options?.role && options?.after) {
      if (options.limit && options.offset) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit} OFFSET ${options.offset}
        `;
      } else if (options.limit) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit}
        `;
      } else {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
            AND created_at > ${options.after.toISOString()}
          ORDER BY created_at ASC, rowid ASC
        `;
      }
    } else if (options?.role) {
      if (options.limit && options.offset) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit} OFFSET ${options.offset}
        `;
      } else if (options.limit) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ${options.limit}
        `;
      } else if (options.offset) {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
          ORDER BY created_at ASC, rowid ASC
          LIMIT -1 OFFSET ${options.offset}
        `;
      } else {
        rows = this.agent.sql<Row>`
          SELECT id, message, created_at FROM cf_agents_session_messages
          WHERE json_extract(message, '$.role') = ${options.role}
          ORDER BY created_at ASC, rowid ASC
        `;
      }
    } else if (options?.limit && options?.offset) {
      rows = this.agent.sql<Row>`
        SELECT id, message, created_at FROM cf_agents_session_messages
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${options.limit} OFFSET ${options.offset}
      `;
    } else if (options?.limit) {
      rows = this.agent.sql<Row>`
        SELECT id, message, created_at FROM cf_agents_session_messages
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${options.limit}
      `;
    } else if (options?.offset) {
      rows = this.agent.sql<Row>`
        SELECT id, message, created_at FROM cf_agents_session_messages
        ORDER BY created_at ASC, rowid ASC
        LIMIT -1 OFFSET ${options.offset}
      `;
    } else {
      rows = this.agent.sql<Row>`
        SELECT id, message, created_at FROM cf_agents_session_messages
        ORDER BY created_at ASC, rowid ASC
      `;
    }

    const messages: AIMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message);
        if (this.isValidMessage(parsed)) {
          messages.push(parsed);
        }
      } catch {
        console.warn(
          `[AgentSessionProvider] Skipping malformed message ${row.id}`
        );
      }
    }

    return messages;
  }

  /**
   * Append one or more messages to the session
   * @param messages Single message or array of messages
   */
  append(messages: AIMessage | AIMessage[]): void {
    this.ensureTable();

    const messageArray = Array.isArray(messages) ? messages : [messages];

    for (const message of messageArray) {
      const json = JSON.stringify(message);
      this.agent.sql`
        INSERT INTO cf_agents_session_messages (id, message)
        VALUES (${message.id}, ${json})
        ON CONFLICT(id) DO UPDATE SET message = excluded.message
      `;
    }
  }

  /**
   * Update an existing message
   * @param message The message to update (matched by id)
   */
  update(message: AIMessage): void {
    this.ensureTable();

    const json = JSON.stringify(message);
    this.agent.sql`
      UPDATE cf_agents_session_messages
      SET message = ${json}
      WHERE id = ${message.id}
    `;
  }

  /**
   * Delete messages by their IDs
   * @param messageIds Array of message IDs to delete
   */
  delete(messageIds: string[]): void {
    this.ensureTable();

    for (const id of messageIds) {
      this.agent.sql`DELETE FROM cf_agents_session_messages WHERE id = ${id}`;
    }
  }

  /**
   * Clear all messages from the session
   */
  clear(): void {
    this.ensureTable();
    this.agent.sql`DELETE FROM cf_agents_session_messages`;
  }

  /**
   * Get the count of messages in the session
   */
  count(): number {
    this.ensureTable();

    const result = this.agent.sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM cf_agents_session_messages
    `;

    return result[0]?.cnt ?? 0;
  }

  /**
   * Get a single message by ID
   * @param id The message ID
   */
  getMessage(id: string): AIMessage | null {
    this.ensureTable();

    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages WHERE id = ${id}
    `;

    if (rows.length === 0) return null;

    try {
      const parsed = JSON.parse(rows[0].message);
      return this.isValidMessage(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Get the last N messages (most recent)
   * @param n Number of messages to retrieve
   */
  getLastMessages(n: number): AIMessage[] {
    this.ensureTable();

    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${n}
    `;

    const messages: AIMessage[] = [];
    // Reverse to get chronological order (oldest to newest)
    for (const row of [...rows].reverse()) {
      try {
        const parsed = JSON.parse(row.message);
        if (this.isValidMessage(parsed)) {
          messages.push(parsed);
        }
      } catch {
        // Skip malformed messages
      }
    }

    return messages;
  }

  /**
   * Validate message structure
   */
  private isValidMessage(msg: unknown): msg is AIMessage {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as Record<string, unknown>;

    if (typeof m.id !== "string" || m.id.length === 0) return false;
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
      return false;
    }
    if (!Array.isArray(m.parts)) return false;

    return true;
  }
}
