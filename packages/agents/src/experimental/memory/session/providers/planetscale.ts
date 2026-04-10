/**
 * PlanetScale Session Provider
 *
 * MySQL/Postgres-backed provider with tree-structured messages,
 * compaction overlays, and FULLTEXT search.
 *
 * Works with @planetscale/database or any driver matching the Connection interface.
 */

import type {
  SessionProvider,
  SearchResult,
  StoredCompaction
} from "../provider";
import type { SessionMessage } from "../types";

/**
 * Minimal connection interface — works with @planetscale/database
 * or any compatible driver.
 */
export interface PlanetScaleConnection {
  execute(
    query: string,
    args?: (string | number | boolean | null)[]
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PlanetScaleSessionProvider implements SessionProvider {
  private conn: PlanetScaleConnection;
  private sessionId: string;
  private initialized = false;

  constructor(conn: PlanetScaleConnection, sessionId?: string) {
    this.conn = conn;
    this.sessionId = sessionId ?? "";
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;

    await this.conn.execute(`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL DEFAULT '',
        parent_id VARCHAR(255),
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_assistant_msg_parent (parent_id),
        INDEX idx_assistant_msg_session (session_id),
        FULLTEXT INDEX idx_assistant_fts (content)
      )
    `);

    await this.conn.execute(`
      CREATE TABLE IF NOT EXISTS assistant_compactions (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        from_message_id VARCHAR(255) NOT NULL,
        to_message_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.initialized = true;
  }

  // ── Read ───────────────────────────────────────────────────────

  async getMessage(id: string): Promise<SessionMessage | null> {
    await this.ensureTable();
    const { rows } = await this.conn.execute(
      "SELECT content FROM assistant_messages WHERE id = ? AND session_id = ?",
      [id, this.sessionId]
    );
    return rows.length > 0 ? this.parse(rows[0].content as string) : null;
  }

  async getHistory(leafId?: string | null): Promise<SessionMessage[]> {
    await this.ensureTable();

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
        SELECT id, parent_id, content, 0 as depth FROM assistant_messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.parent_id, m.content, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
      )
      SELECT content FROM path ORDER BY depth DESC`,
      [leaf.id as string]
    );

    const messages = this.parseRows(rows);
    const compactions = await this.getCompactions();
    if (compactions.length === 0) return messages;
    return this.applyCompactions(messages, compactions);
  }

  async getLatestLeaf(): Promise<SessionMessage | null> {
    await this.ensureTable();
    const row = await this.latestLeafRow();
    return row ? this.parse(row.content as string) : null;
  }

  async getBranches(messageId: string): Promise<SessionMessage[]> {
    await this.ensureTable();
    const { rows } = await this.conn.execute(
      "SELECT content FROM assistant_messages WHERE parent_id = ? AND session_id = ? ORDER BY created_at ASC",
      [messageId, this.sessionId]
    );
    return this.parseRows(rows);
  }

  async getPathLength(leafId?: string | null): Promise<number> {
    await this.ensureTable();
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
        SELECT id, parent_id FROM assistant_messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.parent_id FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
      )
      SELECT COUNT(*) as count FROM path`,
      [leaf.id as string]
    );
    return (rows[0]?.count as number) ?? 0;
  }

  // ── Write ──────────────────────────────────────────────────────

  async appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<void> {
    await this.ensureTable();
    // Idempotent — skip if message already exists
    const { rows: existing } = await this.conn.execute(
      "SELECT id FROM assistant_messages WHERE id = ? AND session_id = ?",
      [message.id, this.sessionId]
    );
    if (existing.length > 0) return;

    const parent = parentId ?? (await this.latestLeafRow())?.id ?? null;
    const json = JSON.stringify(message);

    await this.conn.execute(
      "INSERT INTO assistant_messages (id, session_id, parent_id, role, content) VALUES (?, ?, ?, ?, ?)",
      [message.id, this.sessionId, parent, message.role, json]
    );
  }

  async updateMessage(message: SessionMessage): Promise<void> {
    await this.ensureTable();
    await this.conn.execute(
      "UPDATE assistant_messages SET content = ? WHERE id = ? AND session_id = ?",
      [JSON.stringify(message), message.id, this.sessionId]
    );
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    await this.ensureTable();
    for (const id of messageIds) {
      await this.conn.execute(
        "DELETE FROM assistant_messages WHERE id = ? AND session_id = ?",
        [id, this.sessionId]
      );
    }
  }

  async clearMessages(): Promise<void> {
    await this.ensureTable();
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
    await this.ensureTable();
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
    await this.ensureTable();
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
    await this.ensureTable();
    const { rows } = await this.conn.execute(
      `SELECT id, role, content FROM assistant_messages
       WHERE session_id = ? AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
       LIMIT ?`,
      [this.sessionId, query, limit]
    );
    return rows.map((r) => ({
      id: r.id as string,
      role: r.role as string,
      content: r.content as string,
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
                text: `[Previous conversation summary]\n${comp.summary}`
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
}
