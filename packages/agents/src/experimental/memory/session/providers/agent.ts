/**
 * Agent Session Provider
 *
 * Session provider that uses the Agent's DO SQLite storage.
 */

import type { SessionProvider } from "../provider";
import type {
  AIMessage,
  MessageQueryOptions,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "../types";

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
 * Rough estimate of tokens per character (conservative)
 */
const CHARS_PER_TOKEN = 4;

/**
 * Session provider that wraps an Agent's SQLite storage.
 * Provides AI SDK compatible message storage and retrieval.
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent {
 *   session = new AgentSessionProvider(this, {
 *     compaction: {
 *       tokenThreshold: 20000,
 *       fn: async (messages) => {
 *         // Summarize entire conversation
 *         const summary = await llm.summarize(messages);
 *         return [{ id: 'summary', role: 'system', parts: [{ type: 'text', text: summary }] }];
 *       }
 *     }
 *   });
 * }
 * ```
 */
export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;
  private compactionConfig: CompactionConfig | null = null;

  /**
   * Create a new session provider
   * @param agent An Agent instance (or any object with a sql method)
   * @param options Optional configuration including compaction settings
   */
  constructor(agent: SqlProvider, options?: SessionProviderOptions) {
    this.agent = agent;
    if (options?.compaction) {
      this.compactionConfig = options.compaction;
    }
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
   * Estimate token count for messages (rough approximation)
   */
  private estimateTokens(messages: AIMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "text") {
          chars += (part as { type: "text"; text: string }).text.length;
        } else if (part.type === "tool-invocation") {
          const toolPart = part as {
            type: "tool-invocation";
            args: unknown;
            output?: unknown;
          };
          chars += JSON.stringify(toolPart.args).length;
          if (toolPart.output) {
            chars += JSON.stringify(toolPart.output).length;
          }
        }
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /**
   * Check if we should auto-compact based on token threshold.
   * Only auto-compacts if tokenThreshold is explicitly set.
   */
  private shouldAutoCompact(messages: AIMessage[]): boolean {
    if (!this.compactionConfig) return false;
    if (this.compactionConfig.tokenThreshold === undefined) return false;
    return this.estimateTokens(messages) > this.compactionConfig.tokenThreshold;
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
   * Append one or more messages to the session.
   * Automatically triggers compaction if token threshold is exceeded.
   * @param messages Single message or array of messages
   */
  async append(messages: AIMessage | AIMessage[]): Promise<void> {
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

    // Check for auto-compaction
    if (this.compactionConfig) {
      const allMessages = this.getMessages();
      if (this.shouldAutoCompact(allMessages)) {
        await this.compact();
      }
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

  /**
   * Manually trigger compaction.
   * Calls the user's compact function to transform messages.
   */
  async compact(): Promise<CompactResult> {
    if (!this.compactionConfig) {
      return {
        success: false,
        error:
          "Compaction requires a compact function. Pass compaction config in constructor options."
      };
    }

    const messages = this.getMessages();

    if (messages.length === 0) {
      return { success: true };
    }

    try {
      // Call user's compact function
      const newMessages = await this.compactionConfig.fn(messages);

      // Replace all messages with compacted result
      this.clear();
      for (const message of newMessages) {
        const json = JSON.stringify(message);
        this.agent.sql`
          INSERT INTO cf_agents_session_messages (id, message)
          VALUES (${message.id}, ${json})
          ON CONFLICT(id) DO UPDATE SET message = excluded.message
        `;
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
