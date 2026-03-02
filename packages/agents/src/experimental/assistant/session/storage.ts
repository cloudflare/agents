/**
 * Session storage layer backed by DO SQLite.
 *
 * Schema:
 *   assistant_sessions    — named conversation roots
 *   assistant_messages    — append-only message log with parent_id for branching
 *   assistant_compactions — summaries that replace older messages in context assembly
 *
 * All queries use the Agent's `this.sql` tagged template.
 */
import type { UIMessage } from "ai";

// ── Types ──────────────────────────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: string;
  content: string; // JSON-serialized UIMessage
  created_at: string;
}

export interface Compaction {
  id: string;
  session_id: string;
  summary: string;
  from_message_id: string;
  to_message_id: string;
  created_at: string;
}

// Mirrors Agent.sql — kept structural to avoid importing the 4k-line Agent class.
type SqlFn = (
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => Array<Record<string, unknown>>;

// ── Storage class ──────────────────────────────────────────────────

export class SessionStorage {
  constructor(private sql: SqlFn) {
    this._initSchema();
  }

  private _initSchema() {
    this.sql`
      CREATE TABLE IF NOT EXISTS assistant_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS assistant_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES assistant_sessions(id)
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
      ON assistant_messages(session_id, created_at)
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_assistant_messages_parent
      ON assistant_messages(parent_id)
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS assistant_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES assistant_sessions(id)
      )
    `;
  }

  // ── Sessions ───────────────────────────────────────────────────

  createSession(id: string, name: string): Session {
    this.sql`
      INSERT INTO assistant_sessions (id, name)
      VALUES (${id}, ${name})
    `;
    const rows = this.sql`
      SELECT * FROM assistant_sessions WHERE id = ${id}
    ` as unknown as Session[];
    return rows[0];
  }

  getSession(id: string): Session | null {
    const rows = this.sql`
      SELECT * FROM assistant_sessions WHERE id = ${id}
    ` as unknown as Session[];
    return rows[0] ?? null;
  }

  listSessions(): Session[] {
    return this.sql`
      SELECT * FROM assistant_sessions ORDER BY updated_at DESC
    ` as unknown as Session[];
  }

  updateSessionTimestamp(id: string): void {
    this.sql`
      UPDATE assistant_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ${id}
    `;
  }

  deleteSession(id: string): void {
    this.sql`DELETE FROM assistant_compactions WHERE session_id = ${id}`;
    this.sql`DELETE FROM assistant_messages WHERE session_id = ${id}`;
    this.sql`DELETE FROM assistant_sessions WHERE id = ${id}`;
  }

  renameSession(id: string, name: string): void {
    this.sql`
      UPDATE assistant_sessions SET name = ${name}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `;
  }

  // ── Messages ───────────────────────────────────────────────────

  /**
   * Insert a message. Uses INSERT OR IGNORE so appending the same
   * message ID twice is a safe no-op (idempotent).
   */
  appendMessage(
    id: string,
    sessionId: string,
    parentId: string | null,
    message: UIMessage
  ): StoredMessage {
    const content = JSON.stringify(message);
    this.sql`
      INSERT OR IGNORE INTO assistant_messages (id, session_id, parent_id, role, content)
      VALUES (${id}, ${sessionId}, ${parentId}, ${message.role}, ${content})
    `;
    this.updateSessionTimestamp(sessionId);
    const rows = this.sql`
      SELECT * FROM assistant_messages WHERE id = ${id}
    ` as unknown as StoredMessage[];
    return rows[0];
  }

  getMessage(id: string): StoredMessage | null {
    const rows = this.sql`
      SELECT * FROM assistant_messages WHERE id = ${id}
    ` as unknown as StoredMessage[];
    return rows[0] ?? null;
  }

  /**
   * Get all messages for a session, ordered by creation time.
   * This returns the flat list — use getMessagePath for a branch path.
   */
  getSessionMessages(sessionId: string): StoredMessage[] {
    return this.sql`
      SELECT * FROM assistant_messages
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    ` as unknown as StoredMessage[];
  }

  /**
   * Walk from a leaf message back to the root via a recursive CTE,
   * returning messages in chronological order (root first).
   * Uses a depth counter for ordering since created_at may be
   * identical for messages inserted in quick succession.
   */
  getMessagePath(leafId: string): StoredMessage[] {
    return this.sql`
      WITH RECURSIVE path AS (
        SELECT *, 0 as depth FROM assistant_messages WHERE id = ${leafId}
        UNION ALL
        SELECT m.*, p.depth + 1 FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
      )
      SELECT id, session_id, parent_id, role, content, created_at
      FROM path ORDER BY depth DESC
    ` as unknown as StoredMessage[];
  }

  /**
   * Count the number of messages on the path from root to leaf.
   * Used by needsCompaction to avoid loading full message content.
   */
  getPathLength(leafId: string): number {
    const rows = this.sql`
      WITH RECURSIVE path AS (
        SELECT id, parent_id FROM assistant_messages WHERE id = ${leafId}
        UNION ALL
        SELECT m.id, m.parent_id FROM assistant_messages m
        JOIN path p ON m.id = p.parent_id
      )
      SELECT COUNT(*) as count FROM path
    ` as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  /**
   * Get children of a message (for branch exploration).
   */
  getChildren(parentId: string): StoredMessage[] {
    return this.sql`
      SELECT * FROM assistant_messages
      WHERE parent_id = ${parentId}
      ORDER BY created_at ASC
    ` as unknown as StoredMessage[];
  }

  /**
   * Get the latest leaf message in a session (most recent message
   * that has no children). Used to find the "current" position.
   */
  getLatestLeaf(sessionId: string): StoredMessage | null {
    const rows = this.sql`
      SELECT m.* FROM assistant_messages m
      LEFT JOIN assistant_messages c ON c.parent_id = m.id
      WHERE m.session_id = ${sessionId} AND c.id IS NULL
      ORDER BY m.created_at DESC
      LIMIT 1
    ` as unknown as StoredMessage[];
    return rows[0] ?? null;
  }

  /**
   * Count all messages in a session (across all branches).
   */
  getMessageCount(sessionId: string): number {
    const rows = this.sql`
      SELECT COUNT(*) as count FROM assistant_messages
      WHERE session_id = ${sessionId}
    ` as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  // ── Compactions ────────────────────────────────────────────────

  addCompaction(
    id: string,
    sessionId: string,
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Compaction {
    this.sql`
      INSERT INTO assistant_compactions (id, session_id, summary, from_message_id, to_message_id)
      VALUES (${id}, ${sessionId}, ${summary}, ${fromMessageId}, ${toMessageId})
    `;
    const rows = this.sql`
      SELECT * FROM assistant_compactions WHERE id = ${id}
    ` as unknown as Compaction[];
    return rows[0];
  }

  getCompactions(sessionId: string): Compaction[] {
    return this.sql`
      SELECT * FROM assistant_compactions
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    ` as unknown as Compaction[];
  }

  /**
   * Parse a stored message's content field back into a UIMessage.
   */
  parseMessage(stored: StoredMessage): UIMessage {
    return JSON.parse(stored.content) as UIMessage;
  }
}
