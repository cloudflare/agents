/**
 * SessionManager — registry of named sessions.
 *
 * Lifecycle: create, get, list, delete, rename.
 * Convenience methods for message ops by session ID.
 * Cross-session search and tools.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import { Session } from "./session";
import { AgentSessionProvider, type SqlProvider } from "./providers/agent";
import type { SessionOptions } from "./types";
import type { StoredCompaction } from "./provider";

export interface SessionInfo {
  id: string;
  name: string;
  parent_session_id: string | null;
  model: string | null;
  source: string | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionManagerOptions {
  maxContextMessages?: number;
  sessionOptions?: SessionOptions;
}

export class SessionManager {
  private agent: SqlProvider;
  private _options: SessionManagerOptions;
  private _sessions = new Map<string, Session>();
  private _tableReady = false;

  constructor(agent: SqlProvider, options: SessionManagerOptions = {}) {
    this.agent = agent;
    this._options = { maxContextMessages: 100, ...options };
    this._ensureTable();
  }

  private _ensureTable(): void {
    if (this._tableReady) return;
    this.agent.sql`
      CREATE TABLE IF NOT EXISTS assistant_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_session_id TEXT,
        model TEXT,
        source TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        end_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this._tableReady = true;
  }

  // ── Session access ────────────────────────────────────────────

  /** Get or create the Session instance for a session ID. */
  getSession(sessionId: string): Session {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = new Session(
        new AgentSessionProvider(this.agent, sessionId),
        this._options.sessionOptions,
      );
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  create(
    name: string,
    opts?: { parentSessionId?: string; model?: string; source?: string }
  ): SessionInfo {
    const id = crypto.randomUUID();
    this.agent.sql`
      INSERT INTO assistant_sessions (id, name, parent_session_id, model, source)
      VALUES (${id}, ${name}, ${opts?.parentSessionId ?? null}, ${opts?.model ?? null}, ${opts?.source ?? null})
    `;
    return this.get(id)!;
  }

  get(sessionId: string): SessionInfo | null {
    const rows = this.agent.sql`
      SELECT * FROM assistant_sessions WHERE id = ${sessionId}
    ` as unknown as SessionInfo[];
    return rows[0] ?? null;
  }

  list(): SessionInfo[] {
    return this.agent.sql`
      SELECT * FROM assistant_sessions ORDER BY updated_at DESC
    ` as unknown as SessionInfo[];
  }

  delete(sessionId: string): void {
    this.getSession(sessionId).clearMessages();
    this.agent.sql`DELETE FROM assistant_sessions WHERE id = ${sessionId}`;
    this._sessions.delete(sessionId);
  }

  rename(sessionId: string, name: string): void {
    this.agent.sql`
      UPDATE assistant_sessions SET name = ${name}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;
  }

  // ── Message convenience methods ───────────────────────────────

  append(sessionId: string, message: UIMessage, parentId?: string): string {
    this.getSession(sessionId).appendMessage(message, parentId);
    this._touch(sessionId);
    return message.id;
  }

  upsert(sessionId: string, message: UIMessage, parentId?: string): string {
    return this.append(sessionId, message, parentId);
  }

  appendAll(sessionId: string, messages: UIMessage[], parentId?: string): string | null {
    const session = this.getSession(sessionId);
    let lastParent = parentId ?? null;
    for (const msg of messages) {
      session.appendMessage(msg, lastParent);
      lastParent = msg.id;
    }
    this._touch(sessionId);
    return lastParent;
  }

  getHistory(sessionId: string, leafId?: string): UIMessage[] {
    return this.getSession(sessionId).getHistory(leafId);
  }

  getMessageCount(sessionId: string): number {
    return this.getSession(sessionId).getPathLength();
  }

  clearMessages(sessionId: string): void {
    this.getSession(sessionId).clearMessages();
    this._touch(sessionId);
  }

  deleteMessages(messageIds: string[]): void {
    for (const session of this._sessions.values()) {
      session.deleteMessages(messageIds);
    }
  }

  // ── Compaction ────────────────────────────────────────────────

  needsCompaction(sessionId: string): boolean {
    return this.getSession(sessionId).needsCompaction(this._options.maxContextMessages);
  }

  addCompaction(sessionId: string, summary: string, fromId: string, toId: string): StoredCompaction {
    return this.getSession(sessionId).addCompaction(summary, fromId, toId);
  }

  getCompactions(sessionId: string): StoredCompaction[] {
    return this.getSession(sessionId).getCompactions();
  }

  compactAndSplit(sessionId: string, summary: string, newName?: string): SessionInfo {
    const old = this.get(sessionId);
    this.agent.sql`
      UPDATE assistant_sessions SET end_reason = 'compaction', updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;

    const info = this.create(newName ?? old?.name ?? "Compacted", {
      parentSessionId: sessionId,
      model: old?.model ?? undefined,
      source: old?.source ?? undefined,
    });

    this.append(info.id, {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: `[Context from previous session]\n\n${summary}` }],
    });

    return info;
  }

  // ── Usage tracking ────────────────────────────────────────────

  addUsage(sessionId: string, inputTokens: number, outputTokens: number, cost: number): void {
    this.agent.sql`
      UPDATE assistant_sessions SET
        input_tokens = input_tokens + ${inputTokens},
        output_tokens = output_tokens + ${outputTokens},
        estimated_cost = estimated_cost + ${cost},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;
  }

  // ── Search ────────────────────────────────────────────────────

  search(query: string, options?: { limit?: number }) {
    const limit = options?.limit ?? 20;
    return this.agent.sql<{ id: string; role: string; content: string }>`
      SELECT id, role, content FROM assistant_fts
      WHERE assistant_fts MATCH ${query}
      ORDER BY rank LIMIT ${limit}
    `.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: "" }));
  }

  // ── Tools ─────────────────────────────────────────────────────

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

  // ── Internal ──────────────────────────────────────────────────

  private _touch(sessionId: string): void {
    this.agent.sql`
      UPDATE assistant_sessions SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;
  }
}
