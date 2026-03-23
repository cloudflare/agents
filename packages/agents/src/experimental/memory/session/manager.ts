/**
 * SessionManager — multi-session lifecycle manager.
 *
 * Registry of named sessions backed by a shared SQLite table.
 * Each session gets its own message history, context blocks, and compaction
 * via AgentSessionProvider's sessionId scoping.
 *
 * Usage:
 *   const manager = new SessionManager(agent, { context: [...] });
 *   const info = manager.create("my-chat");
 *   manager.append(info.id, userMsg);
 *   const history = manager.getHistory(info.id);
 *   const results = manager.search("query"); // searches all sessions
 */

import type { UIMessage } from "ai";
import { Session } from "./session";
import { AgentSessionProvider, type SqlProvider } from "./providers/agent";
import type { SessionOptions } from "./types";
import type { StoredCompaction } from "./provider";

export interface SessionInfo {
  id: string;
  name: string;
  parent_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionManagerOptions {
  /** Max messages before needsCompaction returns true (default: 100) */
  maxContextMessages?: number;
  /** Options passed to each Session (context blocks, promptStore, etc.) */
  sessionOptions?: SessionOptions;
}

export class SessionManager {
  private agent: SqlProvider;
  private options: SessionManagerOptions;
  private sessions = new Map<string, Session>();
  private tableReady = false;

  constructor(agent: SqlProvider, options: SessionManagerOptions = {}) {
    this.agent = agent;
    this.options = { maxContextMessages: 100, ...options };
    this.ensureTable();
  }

  private ensureTable(): void {
    if (this.tableReady) return;
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.tableReady = true;
  }

  // ── Session access ────────────────────────────────────────────

  getSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Session(
        new AgentSessionProvider(this.agent, sessionId),
        this.options.sessionOptions
      );
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  create(name: string, opts?: { parentSessionId?: string }): SessionInfo {
    const id = crypto.randomUUID();
    this.agent.sql`
      INSERT INTO cf_agents_sessions (id, name, parent_session_id)
      VALUES (${id}, ${name}, ${opts?.parentSessionId ?? null})
    `;
    return this.get(id)!;
  }

  get(sessionId: string): SessionInfo | null {
    const rows = this.agent.sql<SessionInfo>`
      SELECT * FROM cf_agents_sessions WHERE id = ${sessionId}
    `;
    return (rows[0] as SessionInfo | undefined) ?? null;
  }

  list(): SessionInfo[] {
    return this.agent.sql<SessionInfo>`
      SELECT * FROM cf_agents_sessions ORDER BY updated_at DESC
    ` as SessionInfo[];
  }

  delete(sessionId: string): void {
    this.getSession(sessionId).clearMessages();
    this.agent.sql`DELETE FROM cf_agents_sessions WHERE id = ${sessionId}`;
    this.sessions.delete(sessionId);
  }

  rename(sessionId: string, name: string): void {
    this.agent.sql`
      UPDATE cf_agents_sessions SET name = ${name}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;
  }

  // ── Messages (delegates to Session) ───────────────────────────

  append(sessionId: string, message: UIMessage, parentId?: string): void {
    this.getSession(sessionId).appendMessage(message, parentId);
    this.touch(sessionId);
  }

  getHistory(sessionId: string, leafId?: string): UIMessage[] {
    return this.getSession(sessionId).getHistory(leafId);
  }

  clearMessages(sessionId: string): void {
    this.getSession(sessionId).clearMessages();
    this.touch(sessionId);
  }

  // ── Compaction ────────────────────────────────────────────────

  needsCompaction(sessionId: string): boolean {
    return this.getSession(sessionId).needsCompaction(this.options.maxContextMessages);
  }

  addCompaction(sessionId: string, summary: string, fromId: string, toId: string): StoredCompaction {
    return this.getSession(sessionId).addCompaction(summary, fromId, toId);
  }

  /**
   * End current session and create a new one seeded with a summary.
   * Links via parent_session_id for history traversal.
   */
  compactAndSplit(sessionId: string, summary: string, newName?: string): SessionInfo {
    const old = this.get(sessionId);
    const newInfo = this.create(newName ?? old?.name ?? "Compacted", {
      parentSessionId: sessionId,
    });

    const summaryMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: `[Context from previous session]\n\n${summary}` }],
    };
    this.append(newInfo.id, summaryMsg);
    return newInfo;
  }

  // ── Search (all sessions) ─────────────────────────────────────

  search(query: string, opts?: { limit?: number }) {
    // All sessions share the same FTS table — any session can search all
    const session = this.sessions.values().next().value ?? this.getSession("_search");
    return session.search(query, opts);
  }

  // ── Internal ──────────────────────────────────────────────────

  private touch(sessionId: string): void {
    this.agent.sql`
      UPDATE cf_agents_sessions SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;
  }
}
