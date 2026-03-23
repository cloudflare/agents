/**
 * Agent Session Provider
 *
 * SQLite-backed provider with tree-structured messages (branching),
 * compaction records, and FTS5 search.
 */

import type { UIMessage } from "ai";
import type { SessionProvider, SearchResult, StoredCompaction } from "../provider";
import type { MessageQueryOptions } from "../types";

export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;

  constructor(agent: SqlProvider) {
    this.agent = agent;
  }

  private ensureTable(): void {
    if (this.initialized) return;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_session_messages (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.agent.sql`
      CREATE INDEX IF NOT EXISTS idx_cf_agents_session_messages_parent
      ON cf_agents_session_messages(parent_id)
    `;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_session_compactions (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.agent.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS cf_agents_session_messages_fts
      USING fts5(id UNINDEXED, role UNINDEXED, content, tokenize='porter unicode61')
    `;

    this.initialized = true;
  }

  // ── Read (flat) ────────────────────────────────────────────────

  getMessages(options?: MessageQueryOptions): UIMessage[] {
    this.ensureTable();

    const role = options?.role ?? null;
    const before = options?.before?.toISOString() ?? null;
    const after = options?.after?.toISOString() ?? null;
    const limit = options?.limit ?? -1;
    const offset = options?.offset ?? 0;

    type Row = { message: string };
    const rows = this.agent.sql<Row>`
      SELECT message FROM cf_agents_session_messages
      WHERE (${role} IS NULL OR role = ${role})
        AND (${before} IS NULL OR created_at < ${before})
        AND (${after} IS NULL OR created_at > ${after})
      ORDER BY created_at ASC, rowid ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return this.parseRows(rows);
  }

  getMessage(id: string): UIMessage | null {
    this.ensureTable();
    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    try {
      const parsed = JSON.parse(rows[0].message);
      return this.isValidMessage(parsed) ? parsed : null;
    } catch { return null; }
  }

  getLastMessages(n: number): UIMessage[] {
    this.ensureTable();
    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages
      ORDER BY created_at DESC, rowid DESC LIMIT ${n}
    `;
    return this.parseRows([...rows].reverse());
  }

  getOlderMessages(keepRecent: number): UIMessage[] {
    this.ensureTable();
    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages
      WHERE rowid NOT IN (
        SELECT rowid FROM cf_agents_session_messages
        ORDER BY created_at DESC, rowid DESC LIMIT ${keepRecent}
      )
    `;
    return this.parseRows(rows);
  }

  // ── Branching ──────────────────────────────────────────────────

  getHistory(leafId?: string | null): UIMessage[] {
    this.ensureTable();

    // Find the leaf
    const leaf = leafId
      ? this.agent.sql<{ id: string }>`
          SELECT id FROM cf_agents_session_messages WHERE id = ${leafId}
        `[0]
      : this.getLatestLeafRow();

    if (!leaf) return [];

    // Walk from leaf to root via recursive CTE
    type PathRow = { message: string };
    const path = this.agent.sql<PathRow>`
      WITH RECURSIVE path AS (
        SELECT *, 0 as depth FROM cf_agents_session_messages WHERE id = ${leaf.id}
        UNION ALL
        SELECT m.*, p.depth + 1 FROM cf_agents_session_messages m
        JOIN path p ON m.id = p.parent_id
      )
      SELECT message FROM path ORDER BY depth DESC
    `;

    const messages = this.parseRows(path);

    // Apply compactions
    const compactions = this.getCompactions();
    if (compactions.length === 0) return messages;

    return this.applyCompactions(messages, compactions);
  }

  getLatestLeaf(): UIMessage | null {
    this.ensureTable();
    const row = this.getLatestLeafRow();
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.message);
      return this.isValidMessage(parsed) ? parsed : null;
    } catch { return null; }
  }

  getBranches(messageId: string): UIMessage[] {
    this.ensureTable();
    const rows = this.agent.sql<{ message: string }>`
      SELECT message FROM cf_agents_session_messages
      WHERE parent_id = ${messageId}
      ORDER BY created_at ASC
    `;
    return this.parseRows(rows);
  }

  getPathLength(leafId?: string | null): number {
    this.ensureTable();
    const leaf = leafId
      ? { id: leafId }
      : this.getLatestLeafRow();
    if (!leaf) return 0;

    const rows = this.agent.sql<{ count: number }>`
      WITH RECURSIVE path AS (
        SELECT id, parent_id FROM cf_agents_session_messages WHERE id = ${leaf.id}
        UNION ALL
        SELECT m.id, m.parent_id FROM cf_agents_session_messages m
        JOIN path p ON m.id = p.parent_id
      )
      SELECT COUNT(*) as count FROM path
    `;
    return rows[0]?.count ?? 0;
  }

  // ── Write ──────────────────────────────────────────────────────

  appendMessage(message: UIMessage, parentId?: string | null): void {
    this.ensureTable();
    const resolvedParent = parentId ?? this.getLatestLeafRow()?.id ?? null;
    const json = JSON.stringify(message);

    this.agent.sql`
      INSERT OR IGNORE INTO cf_agents_session_messages (id, parent_id, role, message)
      VALUES (${message.id}, ${resolvedParent}, ${message.role}, ${json})
    `;

    this.indexFTS(message);
  }

  async appendMessages(messages: UIMessage | UIMessage[]): Promise<void> {
    this.ensureTable();
    const arr = Array.isArray(messages) ? messages : [messages];
    let lastParent = this.getLatestLeafRow()?.id ?? null;

    for (const message of arr) {
      const json = JSON.stringify(message);
      this.agent.sql`
        INSERT OR IGNORE INTO cf_agents_session_messages (id, parent_id, role, message)
        VALUES (${message.id}, ${lastParent}, ${message.role}, ${json})
      `;
      this.indexFTS(message);
      lastParent = message.id;
    }
  }

  upsertMessage(message: UIMessage, parentId?: string | null): void {
    this.ensureTable();
    const resolvedParent = parentId ?? this.getLatestLeafRow()?.id ?? null;
    const json = JSON.stringify(message);

    this.agent.sql`
      INSERT INTO cf_agents_session_messages (id, parent_id, role, message)
      VALUES (${message.id}, ${resolvedParent}, ${message.role}, ${json})
      ON CONFLICT(id) DO UPDATE SET message = ${json}
    `;

    this.indexFTS(message);
  }

  updateMessage(message: UIMessage): void {
    this.ensureTable();
    const json = JSON.stringify(message);
    this.agent.sql`
      UPDATE cf_agents_session_messages SET message = ${json} WHERE id = ${message.id}
    `;
  }

  deleteMessages(messageIds: string[]): void {
    this.ensureTable();
    for (const id of messageIds) {
      this.agent.sql`DELETE FROM cf_agents_session_messages WHERE id = ${id}`;
    }
  }

  clearMessages(): void {
    this.ensureTable();
    this.agent.sql`DELETE FROM cf_agents_session_messages`;
    this.agent.sql`DELETE FROM cf_agents_session_compactions`;
    this.agent.sql`DELETE FROM cf_agents_session_messages_fts`;
  }

  async replaceMessages(messages: UIMessage[]): Promise<void> {
    this.ensureTable();

    // Build timestamp map before clearing
    type Row = { id: string; created_at: string };
    const existing = this.agent.sql<Row>`
      SELECT id, created_at FROM cf_agents_session_messages
    `;
    const tsMap = new Map(existing.map((r) => [r.id, r.created_at]));

    this.agent.sql`DELETE FROM cf_agents_session_messages`;
    this.agent.sql`DELETE FROM cf_agents_session_messages_fts`;

    const now = new Date().toISOString();
    let prevId: string | null = null;
    for (const message of messages) {
      const json = JSON.stringify(message);
      const created = tsMap.get(message.id) ?? now;
      this.agent.sql`
        INSERT INTO cf_agents_session_messages (id, parent_id, role, message, created_at)
        VALUES (${message.id}, ${prevId}, ${message.role}, ${json}, ${created})
      `;
      this.indexFTS(message);
      prevId = message.id;
    }
  }

  // ── Compaction ─────────────────────────────────────────────────

  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    const id = crypto.randomUUID();
    this.agent.sql`
      INSERT INTO cf_agents_session_compactions (id, summary, from_message_id, to_message_id)
      VALUES (${id}, ${summary}, ${fromMessageId}, ${toMessageId})
    `;
    const rows = this.agent.sql<{ id: string; summary: string; from_message_id: string; to_message_id: string; created_at: string }>`
      SELECT * FROM cf_agents_session_compactions WHERE id = ${id}
    `;
    return {
      id: rows[0].id,
      summary: rows[0].summary,
      fromMessageId: rows[0].from_message_id,
      toMessageId: rows[0].to_message_id,
      createdAt: rows[0].created_at,
    };
  }

  getCompactions(): StoredCompaction[] {
    this.ensureTable();
    type Row = { id: string; summary: string; from_message_id: string; to_message_id: string; created_at: string };
    const rows = this.agent.sql<Row>`
      SELECT * FROM cf_agents_session_compactions ORDER BY created_at ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      fromMessageId: r.from_message_id,
      toMessageId: r.to_message_id,
      createdAt: r.created_at,
    }));
  }

  // ── Search ─────────────────────────────────────────────────────

  searchMessages(query: string, limit = 20): SearchResult[] {
    this.ensureTable();
    type Row = { id: string; role: string; content: string };
    const rows = this.agent.sql<Row>`
      SELECT id, role, content FROM cf_agents_session_messages_fts
      WHERE cf_agents_session_messages_fts MATCH ${query}
      ORDER BY rank LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: "" }));
  }

  // ── Internal ───────────────────────────────────────────────────

  private getLatestLeafRow(): { id: string; message: string } | null {
    const rows = this.agent.sql<{ id: string; message: string }>`
      SELECT m.id, m.message FROM cf_agents_session_messages m
      LEFT JOIN cf_agents_session_messages c ON c.parent_id = m.id
      WHERE c.id IS NULL
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private indexFTS(message: UIMessage): void {
    const text = this.extractText(message);
    if (text) {
      this.agent.sql`
        INSERT OR REPLACE INTO cf_agents_session_messages_fts (id, role, content)
        VALUES (${message.id}, ${message.role}, ${text})
      `;
    }
  }

  private extractText(message: UIMessage): string {
    return message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join(" ");
  }

  private applyCompactions(
    messages: UIMessage[],
    compactions: StoredCompaction[]
  ): UIMessage[] {
    const ids = messages.map((m) => m.id);
    const result: UIMessage[] = [];
    let i = 0;

    while (i < messages.length) {
      const comp = compactions.find((c) => c.fromMessageId === ids[i]);
      if (comp) {
        const endIdx = ids.indexOf(comp.toMessageId);
        if (endIdx >= i) {
          result.push({
            id: `compaction_${comp.id}`,
            role: "assistant",
            parts: [{ type: "text", text: `[Previous conversation summary]\n${comp.summary}` }],
            createdAt: new Date(),
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

  private isValidMessage(msg: unknown): msg is UIMessage {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) return false;
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return false;
    if (!Array.isArray(m.parts)) return false;
    return true;
  }

  private parseRows(rows: { message: string }[]): UIMessage[] {
    const messages: UIMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message);
        if (this.isValidMessage(parsed)) messages.push(parsed);
      } catch { /* skip malformed */ }
    }
    return messages;
  }
}
