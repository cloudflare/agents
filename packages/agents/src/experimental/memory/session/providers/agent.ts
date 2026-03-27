/**
 * Agent Session Provider
 *
 * SQLite-backed provider with tree-structured messages (branching),
 * compaction overlays, and FTS5 search.
 */

import type { UIMessage } from "ai";
import type {
  SessionProvider,
  SearchResult,
  StoredCompaction
} from "../provider";
import { COMPACTION_PREFIX } from "../../utils/compaction-helpers";

export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;
  private sessionId: string;

  /**
   * @param agent - Agent or any object with a `sql` tagged template method
   * @param sessionId - Optional session ID to isolate multiple sessions in the same DO.
   *                    Messages are filtered by session_id within shared tables.
   */
  constructor(agent: SqlProvider, sessionId?: string) {
    this.agent = agent;
    this.sessionId = sessionId ?? "";
  }

  private ensureTable(): void {
    if (this.initialized) return;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.agent.sql`
      CREATE INDEX IF NOT EXISTS idx_assistant_msg_parent
      ON assistant_messages(parent_id)
    `;

    this.agent.sql`
      CREATE INDEX IF NOT EXISTS idx_assistant_msg_session
      ON assistant_messages(session_id)
    `;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS assistant_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.agent.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS assistant_fts
      USING fts5(id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')
    `;

    // Reserved for SessionManager metadata (PR #1167) and Think integration (PR #1169)
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS assistant_config (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      )
    `;

    this.initialized = true;
  }

  // ── Read ───────────────────────────────────────────────────────

  getMessage(id: string): UIMessage | null {
    this.ensureTable();
    const rows = this.agent.sql<{ content: string }>`
      SELECT content FROM assistant_messages WHERE id = ${id} AND session_id = ${this.sessionId}
    `;
    return rows.length > 0 ? this.parse(rows[0].content) : null;
  }

  getHistory(leafId?: string | null): UIMessage[] {
    this.ensureTable();

    const leaf = leafId
      ? this.agent.sql<{ id: string }>`
          SELECT id FROM assistant_messages WHERE id = ${leafId} AND session_id = ${this.sessionId}
        `[0]
      : this.latestLeafRow();

    if (!leaf) return [];

    const path = this.agent.sql<{ content: string }>`
      WITH RECURSIVE path AS (
        SELECT *, 0 as depth FROM assistant_messages WHERE id = ${leaf.id}
        UNION ALL
        SELECT m.*, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ${this.sessionId} AND p.depth < 10000
      )
      SELECT content FROM path ORDER BY depth DESC
    `;

    const messages = this.parseRows(path);
    const compactions = this.getCompactions();
    if (compactions.length === 0) return messages;
    return this.applyCompactions(messages, compactions);
  }

  getLatestLeaf(): UIMessage | null {
    this.ensureTable();
    const row = this.latestLeafRow();
    return row ? this.parse(row.content) : null;
  }

  getBranches(messageId: string): UIMessage[] {
    this.ensureTable();
    const rows = this.agent.sql<{ content: string }>`
      SELECT content FROM assistant_messages
      WHERE parent_id = ${messageId} AND session_id = ${this.sessionId} ORDER BY created_at ASC
    `;
    return this.parseRows(rows);
  }

  getPathLength(leafId?: string | null): number {
    this.ensureTable();
    const leaf = leafId
      ? this.agent.sql<{ id: string }>`
          SELECT id FROM assistant_messages WHERE id = ${leafId} AND session_id = ${this.sessionId}
        `[0]
      : this.latestLeafRow();
    if (!leaf) return 0;

    const rows = this.agent.sql<{ count: number }>`
      WITH RECURSIVE path AS (
        SELECT id, parent_id, 0 as depth FROM assistant_messages WHERE id = ${leaf.id}
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ${this.sessionId} AND p.depth < 10000
      )
      SELECT COUNT(*) as count FROM path
    `;
    return rows[0]?.count ?? 0;
  }

  // ── Write ──────────────────────────────────────────────────────

  appendMessage(message: UIMessage, parentId?: string | null): void {
    this.ensureTable();
    // Skip if message already exists (INSERT OR IGNORE idempotency)
    const existing = this.agent.sql<{ id: string }>`
      SELECT id FROM assistant_messages WHERE id = ${message.id} AND session_id = ${this.sessionId}
    `;
    if (existing.length > 0) return;

    let parent = parentId ?? this.latestLeafRow()?.id ?? null;

    // Validate parentId belongs to this session
    if (parent) {
      const valid = this.agent.sql<{ id: string }>`
        SELECT id FROM assistant_messages WHERE id = ${parent} AND session_id = ${this.sessionId}
      `;
      if (valid.length === 0) parent = null;
    }

    const json = JSON.stringify(message);

    this.agent.sql`
      INSERT INTO assistant_messages (id, session_id, parent_id, role, content)
      VALUES (${message.id}, ${this.sessionId}, ${parent}, ${message.role}, ${json})
    `;
    this.indexFTS(message);
  }

  updateMessage(message: UIMessage): void {
    this.ensureTable();
    this.agent.sql`
      UPDATE assistant_messages SET content = ${JSON.stringify(message)}
      WHERE id = ${message.id} AND session_id = ${this.sessionId}
    `;
    this.indexFTS(message);
  }

  deleteMessages(messageIds: string[]): void {
    this.ensureTable();
    for (const id of messageIds) {
      this.agent
        .sql`DELETE FROM assistant_messages WHERE id = ${id} AND session_id = ${this.sessionId}`;
      this.deleteFTS(id);
    }
  }

  clearMessages(): void {
    this.ensureTable();
    this.agent
      .sql`DELETE FROM assistant_messages WHERE session_id = ${this.sessionId}`;
    this.agent
      .sql`DELETE FROM assistant_compactions WHERE session_id = ${this.sessionId}`;
    // FTS5 requires delete by rowid
    const ftsRows = this.agent.sql<{ rowid: number }>`
      SELECT rowid FROM assistant_fts WHERE session_id = ${this.sessionId}
    `;
    for (const row of ftsRows) {
      this.agent.sql`DELETE FROM assistant_fts WHERE rowid = ${row.rowid}`;
    }
  }

  // ── Compaction ─────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    this.ensureTable();
    const id = crypto.randomUUID();
    this.agent.sql`
      INSERT INTO assistant_compactions (id, session_id, summary, from_message_id, to_message_id)
      VALUES (${id}, ${this.sessionId}, ${summary}, ${fromMessageId}, ${toMessageId})
    `;
    return {
      id,
      summary,
      fromMessageId,
      toMessageId,
      createdAt: new Date().toISOString()
    };
  }

  getCompactions(): StoredCompaction[] {
    this.ensureTable();
    type Row = {
      id: string;
      summary: string;
      from_message_id: string;
      to_message_id: string;
      created_at: string;
    };
    return this.agent.sql<Row>`
      SELECT * FROM assistant_compactions WHERE session_id = ${this.sessionId} ORDER BY created_at ASC
    `.map((r) => ({
      id: r.id,
      summary: r.summary,
      fromMessageId: r.from_message_id,
      toMessageId: r.to_message_id,
      createdAt: r.created_at
    }));
  }

  // ── Search ─────────────────────────────────────────────────────

  searchMessages(query: string, limit = 20): SearchResult[] {
    this.ensureTable();
    // Sanitize query: wrap in double quotes to treat as literal phrase,
    // escaping any existing double quotes to prevent FTS5 syntax injection
    const sanitized = `"${query.replace(/"/g, '""')}"`;
    try {
      return this.agent.sql<{ id: string; role: string; content: string }>`
        SELECT f.id, f.role, f.content FROM assistant_fts f
        INNER JOIN assistant_messages m ON m.id = f.id AND m.session_id = f.session_id
        WHERE assistant_fts MATCH ${sanitized} AND f.session_id = ${this.sessionId}
        ORDER BY rank LIMIT ${limit}
      `.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content
      }));
    } catch {
      // Malformed FTS query — return empty results
      return [];
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private latestLeafRow(): { id: string; content: string } | null {
    const rows = this.agent.sql<{ id: string; content: string }>`
      SELECT m.id, m.content FROM assistant_messages m
      LEFT JOIN assistant_messages c ON c.parent_id = m.id AND c.session_id = ${this.sessionId}
      WHERE c.id IS NULL AND m.session_id = ${this.sessionId}
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private indexFTS(message: UIMessage): void {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join(" ");
    // Always delete old entry first — handles text→no-text transitions
    this.deleteFTS(message.id);
    if (text) {
      this.agent.sql`
        INSERT INTO assistant_fts (id, session_id, role, content)
        VALUES (${message.id}, ${this.sessionId}, ${message.role}, ${text})
      `;
    }
  }

  private deleteFTS(id: string): void {
    const rows = this.agent.sql<{ rowid: number }>`
      SELECT rowid FROM assistant_fts WHERE id = ${id} AND session_id = ${this.sessionId}
    `;
    for (const row of rows) {
      this.agent.sql`DELETE FROM assistant_fts WHERE rowid = ${row.rowid}`;
    }
  }

  private applyCompactions(
    messages: UIMessage[],
    compactions: StoredCompaction[]
  ): UIMessage[] {
    const ids = messages.map((m) => m.id);
    const result: UIMessage[] = [];
    let i = 0;
    while (i < messages.length) {
      // Find all compactions starting at this message, pick the latest
      // (widest range) so newer compactions supersede older ones
      const matching = compactions.filter((c) => c.fromMessageId === ids[i]);
      const comp =
        matching.length > 1 ? matching[matching.length - 1] : matching[0];
      if (comp) {
        const endIdx = ids.indexOf(comp.toMessageId);
        if (endIdx >= i) {
          result.push({
            id: `${COMPACTION_PREFIX}${comp.id}`,
            role: "assistant",
            parts: [
              {
                type: "text",
                text: comp.summary
              }
            ],
            createdAt: new Date()
          } as UIMessage);
          i = endIdx + 1;
          continue;
        }
      }
      result.push(messages[i]);
      i++;
    }
    return result;
  }

  private parse(json: string): UIMessage | null {
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

  private parseRows(rows: { content: string }[]): UIMessage[] {
    const result: UIMessage[] = [];
    for (const row of rows) {
      const msg = this.parse(row.content);
      if (msg) result.push(msg);
    }
    return result;
  }
}
