/**
 * Agent Session Provider
 *
 * Session provider that uses the Agent's DO SQLite storage.
 */

import type { UIMessage } from "ai";
import type { SessionProvider } from "../provider";
import type {
  MessageQueryOptions,
  MicroCompactionRules,
  CompactionConfig,
  CompactResult,
  SessionProviderOptions
} from "../types";
import { CHARS_PER_TOKEN } from "../../utils/tokens";

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

/** Default thresholds for microCompaction rules (in chars) */
const DEFAULTS = {
  truncateToolOutputs: 30000,
  truncateText: 10000,
  keepRecent: 4
};

/** Resolved microCompaction rules with actual numeric thresholds */
interface ResolvedMicroCompactionRules {
  truncateToolOutputs: number | false;
  truncateText: number | false;
  keepRecent: number;
}

/**
 * Session provider that wraps an Agent's SQLite storage.
 * Provides AI SDK compatible message storage and retrieval.
 *
 * @example
 * ```typescript
 * // Default: microCompaction enabled with default rules
 * session = new AgentSessionProvider(this);
 *
 * // Disable microCompaction
 * session = new AgentSessionProvider(this, { microCompaction: false });
 *
 * // Custom microCompaction rules
 * session = new AgentSessionProvider(this, {
 *   microCompaction: { truncateToolOutputs: 2000, keepRecent: 10 }
 * });
 *
 * // With full LLM compaction
 * session = new AgentSessionProvider(this, {
 *   compaction: { tokenThreshold: 20000, fn: summarize }
 * });
 * ```
 */
export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;
  private microCompactionRules: ResolvedMicroCompactionRules | null;
  private compactionConfig: CompactionConfig | null = null;

  /**
   * Create a new session provider
   * @param agent An Agent instance (or any object with a sql method)
   * @param options Optional configuration (microCompaction defaults to true)
   */
  constructor(agent: SqlProvider, options?: SessionProviderOptions) {
    this.agent = agent;

    // Parse microCompaction config (defaults to true)
    const microCompaction = options?.microCompaction ?? true;
    this.microCompactionRules = this.parseMicroCompactionRules(microCompaction);

    if (options?.compaction) {
      this.compactionConfig = options.compaction;
    }
  }

  /**
   * Parse microCompaction config into resolved rules
   */
  private parseMicroCompactionRules(
    config: boolean | MicroCompactionRules
  ): ResolvedMicroCompactionRules | null {
    if (config === false) return null;

    if (config === true) {
      return {
        truncateToolOutputs: DEFAULTS.truncateToolOutputs,
        truncateText: DEFAULTS.truncateText,
        keepRecent: DEFAULTS.keepRecent
      };
    }

    // Custom rules object
    return {
      truncateToolOutputs:
        config.truncateToolOutputs === false
          ? false
          : config.truncateToolOutputs === true ||
              config.truncateToolOutputs === undefined
            ? DEFAULTS.truncateToolOutputs
            : config.truncateToolOutputs,
      truncateText:
        config.truncateText === false
          ? false
          : config.truncateText === true || config.truncateText === undefined
            ? DEFAULTS.truncateText
            : config.truncateText,
      keepRecent: config.keepRecent ?? DEFAULTS.keepRecent
    };
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
   * Fast pre-check for auto-compaction using SUM(LENGTH) to avoid
   * parsing all messages. This is a heuristic gate only.
   */
  private shouldAutoCompactFast(): boolean {
    if (!this.compactionConfig?.tokenThreshold) return false;

    const result = this.agent.sql<{ total_chars: number }>`
      SELECT COALESCE(SUM(LENGTH(message)), 0) as total_chars
      FROM cf_agents_session_messages
    `;
    const approxTokens = (result[0]?.total_chars ?? 0) / CHARS_PER_TOKEN;
    return approxTokens > this.compactionConfig.tokenThreshold;
  }

  /**
   * Lightweight compaction that doesn't require LLM calls.
   * Truncates tool outputs and long text parts in older messages.
   */
  private applyMicroCompaction(messages: UIMessage[]): UIMessage[] {
    if (!this.microCompactionRules) return messages;

    const rules = this.microCompactionRules;

    return messages.map((msg, i) => {
      const isRecent = i >= messages.length - rules.keepRecent;
      if (isRecent) return msg;

      const compactedParts = msg.parts.map((part) => {
        // Truncate tool outputs
        if (
          rules.truncateToolOutputs !== false &&
          (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
          "output" in part
        ) {
          const toolPart = part as { output?: unknown };
          if (toolPart.output !== undefined) {
            const outputJson = JSON.stringify(toolPart.output);
            if (outputJson.length > rules.truncateToolOutputs) {
              return {
                ...part,
                output: `[Truncated ${outputJson.length} bytes] ${outputJson.slice(0, 500)}...`
              };
            }
          }
        }

        // Truncate long text parts
        if (
          rules.truncateText !== false &&
          part.type === "text" &&
          "text" in part
        ) {
          const textPart = part as { type: "text"; text: string };
          if (textPart.text.length > rules.truncateText) {
            return {
              ...part,
              text: `${textPart.text.slice(0, rules.truncateText)}... [truncated ${textPart.text.length} chars]`
            };
          }
        }

        return part;
      });

      return { ...msg, parts: compactedParts } as UIMessage;
    });
  }

  /**
   * Get all messages in AI SDK format
   * @param options Query options for filtering/pagination
   */
  getMessages(options?: MessageQueryOptions): UIMessage[] {
    this.ensureTable();

    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new Error("limit must be a non-negative integer");
    }
    if (options?.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) {
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
   * Append one or more messages to the session.
   * Automatically triggers compaction if token threshold is exceeded.
   * @param messages Single message or array of messages
   */
  async append(messages: UIMessage | UIMessage[]): Promise<void> {
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

    // Fast pre-check: use SUM(LENGTH) to avoid parsing all messages
    if (this.shouldAutoCompactFast()) {
      await this.compact();
    }
  }

  /**
   * Update an existing message
   * @param message The message to update (matched by id)
   */
  update(message: UIMessage): void {
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
   * @param n Number of messages to retrieve
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

  /**
   * Get messages with their created_at timestamps (for compaction).
   */
  private getMessagesWithTimestamps(): Array<{ message: UIMessage; created_at: string }> {
    type Row = { id: string; message: string; created_at: string };
    const rows = this.agent.sql<Row>`
      SELECT id, message, created_at FROM cf_agents_session_messages
      ORDER BY created_at ASC, rowid ASC
    `;

    const results: Array<{ message: UIMessage; created_at: string }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message);
        if (this.isValidMessage(parsed)) {
          results.push({ message: parsed, created_at: row.created_at });
        }
      } catch {
        // Skip malformed
      }
    }
    return results;
  }

  /**
   * Manually trigger compaction.
   * Runs microCompaction first, then custom fn if provided.
   * Preserves original created_at timestamps for surviving messages.
   */
  async compact(): Promise<CompactResult> {
    const withTimestamps = this.getMessagesWithTimestamps();

    if (withTimestamps.length === 0) {
      return { success: true };
    }

    // Build a map of original timestamps by message ID
    const timestampMap = new Map<string, string>();
    for (const { message, created_at } of withTimestamps) {
      timestampMap.set(message.id, created_at);
    }

    try {
      let messages = withTimestamps.map((r) => r.message);

      // Run microCompaction first (if enabled)
      messages = this.applyMicroCompaction(messages);

      // Then run custom fn if provided
      if (this.compactionConfig?.fn) {
        messages = await this.compactionConfig.fn(messages);
      }

      // Replace all messages with compacted result, preserving timestamps
      this.clear();
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

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
