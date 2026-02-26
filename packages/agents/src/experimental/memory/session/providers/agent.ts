/**
 * Agent Session Provider
 *
 * Pure storage provider that uses the Agent's DO SQLite storage.
 * Compaction is orchestrated by the Session wrapper, not here.
 */

import type { UIMessage } from "ai";
import type { SessionProvider } from "../provider";
import type { MessageQueryOptions } from "../types";

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
 * Provides pure CRUD — compaction is handled by the Session wrapper.
 *
 * @example
 * ```typescript
 * import { Session, AgentSessionProvider } from "agents/experimental/memory/session";
 *
 * // In your Agent class:
 * session = new Session(new AgentSessionProvider(this));
 *
 * // With compaction options:
 * session = new Session(new AgentSessionProvider(this), {
 *   microCompaction: { truncateToolOutputs: 2000, keepRecent: 10 },
 *   compaction: { tokenThreshold: 20000, fn: summarize }
 * });
 * ```
 */
export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;

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
   */
  getMessages(options?: MessageQueryOptions): UIMessage[] {
    this.ensureTable();

    if (
      options?.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 0)
    ) {
      throw new Error("limit must be a non-negative integer");
    }
    if (
      options?.offset !== undefined &&
      (!Number.isInteger(options.offset) || options.offset < 0)
    ) {
      throw new Error("offset must be a non-negative integer");
    }

    type Row = { id: string; message: string; created_at: string };
    const role = options?.role ?? null;
    const before = options?.before?.toISOString() ?? null;
    const after = options?.after?.toISOString() ?? null;
    const limit = options?.limit ?? -1;
    const offset = options?.offset ?? 0;

    const rows = this.agent.sql<Row>`
      SELECT id, message, created_at FROM cf_agents_session_messages
      WHERE (${role} IS NULL OR json_extract(message, '$.role') = ${role})
        AND (${before} IS NULL OR created_at < ${before})
        AND (${after} IS NULL OR created_at > ${after})
      ORDER BY created_at ASC, rowid ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return this.parseRows(rows);
  }

  /**
   * Append one or more messages to storage.
   */
  async appendMessages(messages: UIMessage | UIMessage[]): Promise<void> {
    this.ensureTable();

    const messageArray = Array.isArray(messages) ? messages : [messages];
    const now = new Date().toISOString();

    for (const message of messageArray) {
      const json = JSON.stringify(message);
      this.agent.sql`
        INSERT INTO cf_agents_session_messages (id, message, created_at)
        VALUES (${message.id}, ${json}, ${now})
        ON CONFLICT(id) DO UPDATE SET message = excluded.message
      `;
    }
  }

  /**
   * Update an existing message
   */
  updateMessage(message: UIMessage): void {
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
   */
  deleteMessages(messageIds: string[]): void {
    this.ensureTable();

    for (const id of messageIds) {
      this.agent.sql`DELETE FROM cf_agents_session_messages WHERE id = ${id}`;
    }
  }

  /**
   * Clear all messages from the session
   */
  clearMessages(): void {
    this.ensureTable();
    this.agent.sql`DELETE FROM cf_agents_session_messages`;
  }

  /**
   * Get a single message by ID
   */
  getMessage(id: string): UIMessage | null {
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
   */
  getLastMessages(n: number): UIMessage[] {
    this.ensureTable();

    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${n}
    `;

    return this.parseRows([...rows].reverse());
  }

  /**
   * Fetch messages outside the recent window (for microCompaction).
   * Returns all messages except the most recent `keepRecent`.
   */
  getOlderMessages(keepRecent: number): UIMessage[] {
    this.ensureTable();

    type Row = { id: string; message: string };
    const rows = this.agent.sql<Row>`
      SELECT id, message FROM cf_agents_session_messages
      WHERE rowid NOT IN (
        SELECT rowid FROM cf_agents_session_messages
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${keepRecent}
      )
    `;

    return this.parseRows(rows);
  }

  /**
   * Bulk replace all messages.
   * Preserves original created_at timestamps for surviving messages.
   */
  async replaceMessages(messages: UIMessage[]): Promise<void> {
    this.ensureTable();

    // Build timestamp map from existing messages before clearing
    type Row = { id: string; created_at: string };
    const existingRows = this.agent.sql<Row>`
      SELECT id, created_at FROM cf_agents_session_messages
    `;
    const timestampMap = new Map<string, string>();
    for (const row of existingRows) {
      timestampMap.set(row.id, row.created_at);
    }

    // Atomic replace: transaction ensures no data loss on partial failure
    this.agent.sql`BEGIN TRANSACTION`;
    try {
      this.agent.sql`DELETE FROM cf_agents_session_messages`;

      const now = new Date().toISOString();
      for (const message of messages) {
        const json = JSON.stringify(message);
        const created_at = timestampMap.get(message.id) ?? now;
        this.agent.sql`
          INSERT INTO cf_agents_session_messages (id, message, created_at)
          VALUES (${message.id}, ${json}, ${created_at})
          ON CONFLICT(id) DO UPDATE SET message = excluded.message
        `;
      }

      this.agent.sql`COMMIT`;
    } catch (err) {
      this.agent.sql`ROLLBACK`;
      throw err;
    }
  }

  /**
   * Validate message structure
   */
  private isValidMessage(msg: unknown): msg is UIMessage {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as Record<string, unknown>;

    if (typeof m.id !== "string" || m.id.length === 0) return false;
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
      return false;
    }
    if (!Array.isArray(m.parts)) return false;

    return true;
  }

  /**
   * Parse message rows from SQL results into UIMessages.
   */
  private parseRows(rows: { id?: string; message: string }[]): UIMessage[] {
    const messages: UIMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message);
        if (this.isValidMessage(parsed)) {
          messages.push(parsed);
        }
      } catch {
        if (row.id) {
          console.warn(
            `[AgentSessionProvider] Skipping malformed message ${row.id}`
          );
        }
      }
    }
    return messages;
  }
}
