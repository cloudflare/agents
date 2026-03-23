/**
 * SessionManager — registry of named sessions.
 *
 * Lifecycle: create, get, list, delete, rename, search.
 * All message/context/compaction operations live on the Session itself.
 */

import { jsonSchema, type ToolSet } from "ai";
import { Session } from "./session";
import { AgentSessionProvider, type SqlProvider } from "./providers/agent";
import type { SessionOptions } from "./types";

export interface SessionInfo {
  id: string;
  name: string;
  created_at: string;
}

export interface SessionManagerOptions {
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
    this.options = options;
    this.ensureTable();
  }

  private ensureTable(): void {
    if (this.tableReady) return;
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this.tableReady = true;
  }

  private makeSession(id: string): Session {
    const session = new Session(
      new AgentSessionProvider(this.agent, id),
      this.options.sessionOptions,
    );
    this.sessions.set(id, session);
    return session;
  }

  /** Create a new session. */
  create(name: string): { info: SessionInfo; session: Session } {
    const id = crypto.randomUUID();
    this.agent.sql`INSERT INTO cf_agents_sessions (id, name) VALUES (${id}, ${name})`;
    const session = this.makeSession(id);
    const info = this.agent.sql<SessionInfo>`
      SELECT * FROM cf_agents_sessions WHERE id = ${id}
    `[0];
    return { info, session };
  }

  /** Get a session by ID. Returns null if not registered. */
  get(sessionId: string): Session | null {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const rows = this.agent.sql<{ id: string }>`
      SELECT id FROM cf_agents_sessions WHERE id = ${sessionId}
    `;
    if (rows.length === 0) return null;
    return this.makeSession(sessionId);
  }

  /** List all registered sessions. */
  list(): SessionInfo[] {
    return this.agent.sql<SessionInfo>`
      SELECT * FROM cf_agents_sessions ORDER BY created_at DESC
    `;
  }

  /** Delete a session and all its messages. */
  delete(sessionId: string): void {
    const session = this.get(sessionId);
    if (session) session.clearMessages();
    this.agent.sql`DELETE FROM cf_agents_sessions WHERE id = ${sessionId}`;
    this.sessions.delete(sessionId);
  }

  /** Rename a session. */
  rename(sessionId: string, name: string): void {
    this.agent.sql`
      UPDATE cf_agents_sessions SET name = ${name} WHERE id = ${sessionId}
    `;
  }

  /** Search across all sessions (shared FTS table). */
  search(query: string, options?: { limit?: number }) {
    const limit = options?.limit ?? 20;
    return this.agent.sql<{ id: string; role: string; content: string }>`
      SELECT id, role, content FROM cf_agents_session_fts
      WHERE cf_agents_session_fts MATCH ${query}
      ORDER BY rank LIMIT ${limit}
    `.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: "" }));
  }

  /** Returns all manager-level tools (session_search). */
  tools(): ToolSet {
    const mgr = this;
    return {
      session_search: {
        description: "Search past conversations for relevant context. Searches across all sessions.",
        parameters: jsonSchema({
          type: "object" as const,
          properties: {
            query: { type: "string" as const, description: "Search query" },
          },
          required: ["query"],
        }),
        execute: async ({ query }: { query: string }) => {
          try {
            const results = mgr.search(query, { limit: 10 });
            if (results.length === 0) return "No results found.";
            return results.map((r) => `[${r.role}] ${r.content}`).join("\n---\n");
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
    };
  }
}
