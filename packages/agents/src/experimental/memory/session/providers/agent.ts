/**
 * Agent Session Provider
 *
 * SQLite-backed provider with tree-structured messages (branching),
 * compaction overlays, and FTS5 search.
 */

import type { SessionMessage } from "../types";
import type {
  SessionProvider,
  SearchResult,
  StoredCompaction,
  HistoryRowStat,
  RecentHistoryResult
} from "../provider";
import { COMPACTION_PREFIX } from "../../utils/compaction-helpers";

export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/**
 * Bounds for each content-hydration query on a history path.
 *
 * Message rows can be up to ~1.8MB each (see ROW_MAX_BYTES in agents/chat),
 * so content is fetched in bounded batches rather than one statement to keep
 * any per-statement buffering in the SQLite layer small. In workerd the
 * SQLite allocator shares the isolate's memory budget with the JS heap —
 * oversized transient result sets surface as SQLITE_NOMEM (#1710).
 *
 * Chunks are bounded by BOTH row count and cumulative stored bytes (sizes
 * come from the path row stats, so no content is read to compute them).
 * Without the byte bound, 50 near-cap rows could still materialize ~90MB
 * in a single statement.
 */
const HISTORY_CONTENT_CHUNK_SIZE = 50;
const HISTORY_CONTENT_CHUNK_BYTES = 4 * 1024 * 1024;

export class AgentSessionProvider implements SessionProvider {
  private agent: SqlProvider;
  private initialized = false;
  private sessionId: string;

  /**
   * Cached id of the active branch tip (latest leaf). `undefined` means "not
   * cached" (cold, or last lookup found the session empty).
   *
   * Finding the tip from scratch is an anti-join over every row in the
   * session (`latestLeafRow`), which is O(rows). It runs on every hydration
   * AND every auto-parent append, so on a long transcript it dominates the
   * read cost of a wake. The tip is maintained in place on append/delete/
   * clear, and a cached id is re-validated on read with an O(1) existence +
   * still-childless check before it's trusted — so the cache self-heals if
   * something else mutates the cached tip: a deleted tip or a tip that gained
   * a child fails the check and triggers a single recompute. Direct SQL or a
   * second provider instance that creates a newer leaf without touching the
   * cached tip is outside the supported writer model and will be observed on
   * the next cold lookup. The full scan therefore never runs more often than
   * the original unconditional version did. Reads are synchronous and the DO
   * is single-threaded, so no locking is needed.
   */
  private activeLeafId: string | undefined = undefined;

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

  getMessage(id: string): SessionMessage | null {
    this.ensureTable();
    const rows = this.agent.sql<{ content: string }>`
      SELECT content FROM assistant_messages WHERE id = ${id} AND session_id = ${this.sessionId}
    `;
    return rows.length > 0 ? this.parse(rows[0].content) : null;
  }

  getHistory(leafId?: string | null): SessionMessage[] {
    this.ensureTable();

    const leaf = leafId ? this.leafRowById(leafId) : this.latestLeafRow();

    if (!leaf) return [];

    const messages = this.messagesByPathStats(this.pathRowStats(leaf.id));
    const compactions = this.getCompactions();
    if (compactions.length === 0) return messages;
    return this.applyCompactions(messages, compactions);
  }

  getRecentHistory(
    leafId: string | null | undefined,
    maxContentBytes: number,
    minRecentMessages = 1
  ): RecentHistoryResult {
    this.ensureTable();

    const leaf = leafId ? this.leafRowById(leafId) : this.latestLeafRow();
    if (!leaf) {
      return { messages: [], truncated: false, totalContentBytes: 0 };
    }

    const stats = this.pathRowStats(leaf.id);
    const totalContentBytes = stats.reduce((sum, row) => sum + row.bytes, 0);

    // Take the longest suffix (most recent messages) that fits the budget.
    // The window floor (`minRecentMessages`, ≥ 1) is honored even when those
    // rows exceed the budget: rows are individually capped at write time, so
    // the floor keeps memory bounded while guaranteeing hosts a minimum
    // recent span (e.g. the model-facing truncation window).
    const minRecent = Math.max(1, Math.floor(minRecentMessages));
    let start = stats.length - 1;
    let used = stats[start]?.bytes ?? 0;
    while (
      start > 0 &&
      (stats.length - start < minRecent ||
        used + stats[start - 1].bytes <= maxContentBytes)
    ) {
      start--;
      used += stats[start].bytes;
    }

    const messages = this.messagesByPathStats(stats.slice(start));
    // Compactions whose anchors fall outside the window are skipped by
    // applyCompactions (no matching fromMessageId) — the window then shows
    // the raw recent messages, which is the intended degraded view.
    const compactions = this.getCompactions();
    return {
      messages:
        compactions.length === 0
          ? messages
          : this.applyCompactions(messages, compactions),
      truncated: start > 0,
      totalContentBytes
    };
  }

  getHistoryRowStats(leafId?: string | null): HistoryRowStat[] {
    this.ensureTable();
    const leaf = leafId ? this.leafRowById(leafId) : this.latestLeafRow();
    return leaf ? this.pathRowStats(leaf.id) : [];
  }

  getLatestLeaf(): SessionMessage | null {
    this.ensureTable();
    const row = this.latestLeafRow();
    return row ? this.getMessage(row.id) : null;
  }

  getBranches(messageId: string): SessionMessage[] {
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

  appendMessage(message: SessionMessage, parentId?: string | null): void {
    this.ensureTable();
    // Skip if message already exists (INSERT OR IGNORE idempotency)
    const existing = this.agent.sql<{ id: string }>`
      SELECT id FROM assistant_messages WHERE id = ${message.id} AND session_id = ${this.sessionId}
    `;
    if (existing.length > 0) return;

    // Honour the `SessionProvider` contract:
    //   - `undefined` / omitted → auto-detect (attach to latest leaf)
    //   - explicit `null`       → create a root message with no parent
    // Using `??` here would collapse those two cases; `parentId !== undefined`
    // preserves the distinction.
    let parent =
      parentId !== undefined ? parentId : (this.latestLeafRow()?.id ?? null);

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

    // The freshly inserted row is the most recent childless node, so it is
    // now the latest leaf — true even for an explicit-parent branch append.
    // Keeping the cache current here is what lets appends skip the anti-join.
    this.activeLeafId = message.id;
  }

  updateMessage(message: SessionMessage): void {
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
    // Deleting an interior node never changes the tip; deleting the tip does.
    // Drop the cache so the next lookup recomputes (deletes are rare relative
    // to reads/appends, so the occasional rescan is fine).
    if (
      typeof this.activeLeafId === "string" &&
      messageIds.includes(this.activeLeafId)
    ) {
      this.activeLeafId = undefined;
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
    this.activeLeafId = undefined;
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

  private latestLeafRow(): { id: string } | null {
    // Trust a cached tip only after an O(1) check that it still exists and is
    // still childless. This catches a cached tip that was deleted or given a
    // child by another writer without re-scanning the whole session.
    if (this.activeLeafId !== undefined) {
      const stillTip = this.agent.sql<{ id: string }>`
        SELECT m.id FROM assistant_messages m
        WHERE m.id = ${this.activeLeafId} AND m.session_id = ${this.sessionId}
          AND NOT EXISTS (
            SELECT 1 FROM assistant_messages c
            WHERE c.parent_id = ${this.activeLeafId}
              AND c.session_id = ${this.sessionId}
          )
      `;
      if (stillTip.length > 0) return { id: this.activeLeafId };
      this.activeLeafId = undefined;
    }

    // id-only on purpose: the ORDER BY sorter would otherwise carry every
    // leaf candidate's full content blob while ranking rows.
    const rows = this.agent.sql<{ id: string }>`
      SELECT m.id FROM assistant_messages m
      LEFT JOIN assistant_messages c ON c.parent_id = m.id AND c.session_id = ${this.sessionId}
      WHERE c.id IS NULL AND m.session_id = ${this.sessionId}
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
    `;
    this.activeLeafId = rows[0]?.id;
    return rows[0] ?? null;
  }

  private leafRowById(leafId: string): { id: string } | null {
    const rows = this.agent.sql<{ id: string }>`
      SELECT id FROM assistant_messages WHERE id = ${leafId} AND session_id = ${this.sessionId}
    `;
    return rows[0] ?? null;
  }

  /**
   * The active branch path as (id, role, content size) rows, root → leaf.
   *
   * Recurses over (id, parent_id) only. Carrying `content` through the
   * recursive queue AND the ORDER BY sorter materializes the entire
   * transcript several times over inside SQLite's allocator, which in
   * workerd shares the isolate's memory budget with the JS heap — large
   * media-heavy sessions then fail with SQLITE_NOMEM on wake (#1710).
   * Content is fetched separately in bounded chunks (`messagesByPathStats`).
   */
  private pathRowStats(leafId: string): HistoryRowStat[] {
    return this.agent.sql<{ id: string; role: string; bytes: number }>`
      WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM assistant_messages WHERE id = ${leafId}
        UNION ALL
        SELECT m.id, m.parent_id, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
        WHERE m.session_id = ${this.sessionId} AND p.depth < 10000
      )
      SELECT path.id AS id, am.role AS role, LENGTH(CAST(am.content AS BLOB)) AS bytes
      FROM path JOIN assistant_messages am ON am.id = path.id
      ORDER BY path.depth DESC
    `;
  }

  /**
   * Fetch and parse message content for an ordered list of path rows.
   *
   * Content is read in chunks bounded by both row count and cumulative
   * stored bytes (no ORDER BY — SQLite streams rows without materializing
   * the result set) and reassembled in path order. Rows that fail to parse
   * are skipped, matching previous behavior.
   */
  private messagesByPathStats(rows: HistoryRowStat[]): SessionMessage[] {
    const contentById = new Map<string, string>();
    const fetchChunk = (ids: string[]) => {
      const fetched = this.agent.sql<{ id: string; content: string }>`
        SELECT id, content FROM assistant_messages
        WHERE session_id = ${this.sessionId}
          AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      `;
      for (const row of fetched) {
        contentById.set(row.id, row.content);
      }
    };

    let chunk: string[] = [];
    let chunkBytes = 0;
    for (const row of rows) {
      if (
        chunk.length > 0 &&
        (chunk.length >= HISTORY_CONTENT_CHUNK_SIZE ||
          chunkBytes + row.bytes > HISTORY_CONTENT_CHUNK_BYTES)
      ) {
        fetchChunk(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(row.id);
      chunkBytes += row.bytes;
    }
    if (chunk.length > 0) fetchChunk(chunk);

    const result: SessionMessage[] = [];
    for (const row of rows) {
      const content = contentById.get(row.id);
      if (content === undefined) continue;
      const msg = this.parse(content);
      if (msg) result.push(msg);
    }
    return result;
  }

  private indexFTS(message: SessionMessage): void {
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
    messages: SessionMessage[],
    compactions: StoredCompaction[]
  ): SessionMessage[] {
    const ids = messages.map((m) => m.id);
    const result: SessionMessage[] = [];
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
          } as SessionMessage);
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

  private parseRows(rows: { content: string }[]): SessionMessage[] {
    const result: SessionMessage[] = [];
    for (const row of rows) {
      const msg = this.parse(row.content);
      if (msg) result.push(msg);
    }
    return result;
  }
}
