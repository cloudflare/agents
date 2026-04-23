/**
 * Postgres Session Provider
 *
 * Postgres-backed provider with tree-structured messages,
 * compaction overlays, and full-text search.
 *
 * Accepts either a raw `pg.Client` (recommended for Hyperdrive) or any
 * object implementing the internal `PostgresConnection` interface.
 *
 * ```ts
 * import { Client } from "pg";
 * const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
 * await client.connect();
 * new PostgresSessionProvider(client, sessionId);
 * ```
 *
 * Tables must be created by the customer via migration — see docs for the schema.
 */

import type {
  SessionProvider,
  SearchResult,
  StoredCompaction
} from "../provider";
import type { SessionMessage } from "../types";
import {
  toPostgresConnection,
  type PostgresClient,
  type PostgresConnection
} from "./postgres-adapter";

export type {
  PostgresClient,
  PostgresConnection,
  PgClientLike
} from "./postgres-adapter";

export class PostgresSessionProvider implements SessionProvider {
  private conn: PostgresConnection;
  private sessionId: string;

  /**
   * @param client A raw `pg.Client` (recommended) or any `PostgresConnection`.
   *   Must already be connected — this provider never opens or closes the
   *   underlying client.
   * @param sessionId Session identifier. Different ids are fully isolated
   *   rows within the shared tables. Defaults to `""`.
   */
  constructor(client: PostgresClient, sessionId?: string) {
    this.conn = toPostgresConnection(client);
    this.sessionId = sessionId ?? "";
  }

  // ── Read ───────────────────────────────────────────────────────

  async getMessage(id: string): Promise<SessionMessage | null> {
    const { rows } = await this.conn.execute(
      "SELECT content FROM assistant_messages WHERE id = ? AND session_id = ?",
      [id, this.sessionId]
    );
    return rows.length > 0 ? this.parse(rows[0].content as string) : null;
  }

  async getHistory(leafId?: string | null): Promise<SessionMessage[]> {
    const leaf = leafId
      ? (
          await this.conn.execute(
            "SELECT id FROM assistant_messages WHERE id = ? AND session_id = ?",
            [leafId, this.sessionId]
          )
        ).rows[0]
      : await this.latestLeafRow();

    if (!leaf) return [];

    const { rows } = await this.conn.execute(
      `WITH RECURSIVE path AS (
        SELECT id, parent_id, content, 0 as depth FROM assistant_messages WHERE id = ? AND session_id = ?
        UNION ALL
        SELECT m.id, m.parent_id, m.content, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ? AND p.depth < 10000
      )
      SELECT content FROM path ORDER BY depth DESC`,
      [leaf.id as string, this.sessionId, this.sessionId]
    );

    const messages = this.parseRows(rows);
    const compactions = await this.getCompactions();
    if (compactions.length === 0) return messages;
    return this.applyCompactions(messages, compactions);
  }

  async getLatestLeaf(): Promise<SessionMessage | null> {
    const row = await this.latestLeafRow();
    return row ? this.parse(row.content as string) : null;
  }

  async getBranches(messageId: string): Promise<SessionMessage[]> {
    const { rows } = await this.conn.execute(
      "SELECT content FROM assistant_messages WHERE parent_id = ? AND session_id = ? ORDER BY created_at ASC",
      [messageId, this.sessionId]
    );
    return this.parseRows(rows);
  }

  async getPathLength(leafId?: string | null): Promise<number> {
    const leaf = leafId
      ? (
          await this.conn.execute(
            "SELECT id FROM assistant_messages WHERE id = ? AND session_id = ?",
            [leafId, this.sessionId]
          )
        ).rows[0]
      : await this.latestLeafRow();
    if (!leaf) return 0;

    const { rows } = await this.conn.execute(
      `WITH RECURSIVE path AS (
        SELECT id, parent_id, 0 as depth FROM assistant_messages WHERE id = ? AND session_id = ?
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ? AND p.depth < 10000
      )
      SELECT COUNT(*) as count FROM path`,
      [leaf.id as string, this.sessionId, this.sessionId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ── Write ──────────────────────────────────────────────────────

  async appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<void> {
    // Honour the `SessionProvider` contract:
    //   - `undefined` / omitted → auto-detect (attach to latest leaf)
    //   - explicit `null`       → create a root message with no parent
    // Using `??` here would collapse those two cases; `parentId !== undefined`
    // preserves the distinction.
    const parent =
      parentId !== undefined
        ? parentId
        : (((await this.latestLeafRow())?.id as string | undefined) ?? null);
    const json = JSON.stringify(message);
    const text = this.extractSearchableText(json);

    await this.conn.execute(
      `INSERT INTO assistant_messages (id, session_id, parent_id, role, content, text_content)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [message.id, this.sessionId, parent, message.role, json, text]
    );
  }

  async updateMessage(message: SessionMessage): Promise<void> {
    const json = JSON.stringify(message);
    await this.conn.execute(
      "UPDATE assistant_messages SET content = ?, text_content = ? WHERE id = ? AND session_id = ?",
      [json, this.extractSearchableText(json), message.id, this.sessionId]
    );
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      await this.conn.execute(
        "DELETE FROM assistant_messages WHERE id = ? AND session_id = ?",
        [id, this.sessionId]
      );
    }
  }

  async clearMessages(): Promise<void> {
    await this.conn.execute(
      "DELETE FROM assistant_messages WHERE session_id = ?",
      [this.sessionId]
    );
    await this.conn.execute(
      "DELETE FROM assistant_compactions WHERE session_id = ?",
      [this.sessionId]
    );
  }

  // ── Compaction ─────────────────────────────────────────────────

  async addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Promise<StoredCompaction> {
    const id = crypto.randomUUID();
    await this.conn.execute(
      "INSERT INTO assistant_compactions (id, session_id, summary, from_message_id, to_message_id) VALUES (?, ?, ?, ?, ?)",
      [id, this.sessionId, summary, fromMessageId, toMessageId]
    );
    return {
      id,
      summary,
      fromMessageId,
      toMessageId,
      createdAt: new Date().toISOString()
    };
  }

  async getCompactions(): Promise<StoredCompaction[]> {
    const { rows } = await this.conn.execute(
      "SELECT * FROM assistant_compactions WHERE session_id = ? ORDER BY created_at ASC",
      [this.sessionId]
    );
    return rows.map((r) => ({
      id: r.id as string,
      summary: r.summary as string,
      fromMessageId: r.from_message_id as string,
      toMessageId: r.to_message_id as string,
      createdAt: r.created_at as string
    }));
  }

  // ── Search ─────────────────────────────────────────────────────

  async searchMessages(query: string, limit = 20): Promise<SearchResult[]> {
    const { rows } = await this.conn.execute(
      `SELECT id, role, text_content FROM assistant_messages
       WHERE session_id = ? AND content_tsv @@ plainto_tsquery('english', ?)
       ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ?)) DESC
       LIMIT ?`,
      [this.sessionId, query, query, limit]
    );
    return rows.map((r) => ({
      id: r.id as string,
      role: r.role as string,
      content: (r.text_content as string) ?? "",
      createdAt: ""
    }));
  }

  // ── Internal ───────────────────────────────────────────────────

  private async latestLeafRow(): Promise<Record<string, unknown> | null> {
    const { rows } = await this.conn.execute(
      `SELECT m.id, m.content FROM assistant_messages m
       LEFT JOIN assistant_messages c ON c.parent_id = m.id AND c.session_id = ?
       WHERE c.id IS NULL AND m.session_id = ?
       ORDER BY m.created_at DESC LIMIT 1`,
      [this.sessionId, this.sessionId]
    );
    return rows[0] ?? null;
  }

  private applyCompactions(
    messages: SessionMessage[],
    compactions: StoredCompaction[]
  ): SessionMessage[] {
    const ids = messages.map((m) => m.id);
    const result: SessionMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      const matching = compactions.filter((c) => c.fromMessageId === ids[i]);
      const comp =
        matching.length > 1 ? matching[matching.length - 1] : matching[0];
      if (comp) {
        const endIdx = ids.indexOf(comp.toMessageId);
        if (endIdx >= i) {
          result.push({
            id: `compaction_${comp.id}`,
            role: "assistant",
            parts: [
              {
                type: "text",
                text: comp.summary
              }
            ],
            createdAt: new Date()
          });
          i = endIdx + 1;
          continue;
        }
      }
      result.push(messages[i]);
      i++;
    }
    return result;
  }

  private parse(json: string): SessionMessage | null {
    try {
      const msg = JSON.parse(json);
      if (
        typeof msg?.id === "string" &&
        typeof msg?.role === "string" &&
        Array.isArray(msg?.parts)
      ) {
        return msg;
      }
    } catch {
      /* skip */
    }
    return null;
  }

  private parseRows(rows: Record<string, unknown>[]): SessionMessage[] {
    const result: SessionMessage[] = [];
    for (const row of rows) {
      const msg = this.parse(row.content as string);
      if (msg) result.push(msg);
    }
    return result;
  }

  /**
   * Extract just the human-readable text from a message's JSON blob
   * and store it in `text_content`, which feeds the generated `content_tsv`
   * column used for FTS. The full structured message (parts, tool calls,
   * metadata) is still stored verbatim in `content` — this is the source
   * of truth. Indexing the raw JSON would return FTS hits on keys like
   * `"role"`, `"parts"`, `"dynamic-tool"`, etc.
   */
  private extractSearchableText(json: string): string {
    const msg = this.parse(json);
    if (!msg) return json;
    return msg.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
}
