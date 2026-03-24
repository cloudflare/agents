/**
 * SessionManager — registry of named sessions.
 *
 * Lifecycle: create, get, list, delete, rename.
 * Convenience methods for message ops by session ID.
 * Cross-session search and tools.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import { Session, type SessionContextOptions } from "./session";
import type { SqlProvider } from "./providers/agent";
import type { ContextBlockProvider } from "./context";
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

// Pending context entry — resolved per-session with namespaced providers
interface PendingManagerContext {
  label: string;
  options: SessionContextOptions;
}

export interface SessionManagerOptions {
  maxContextMessages?: number;
}

export class SessionManager {
  private agent!: SqlProvider;
  private _maxContextMessages = 100;
  private _pending: PendingManagerContext[] = [];
  private _cachedPrompt?: ContextBlockProvider | true;
  private _sessions = new Map<string, Session>();
  private _tableReady = false;
  private _ready = false;

  constructor(agent: SqlProvider, options: SessionManagerOptions = {}) {
    this.agent = agent;
    this._maxContextMessages = options.maxContextMessages ?? 100;
    this._ready = true;
    this._ensureTable();
  }

  /**
   * Chainable SessionManager creation with auto-wired context for all sessions.
   *
   * @example
   * ```ts
   * const manager = SessionManager.create(this)
   *   .withContext("soul", { defaultContent: "You are helpful.", readonly: true })
   *   .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
   *   .withCachedPrompt()
   *   .maxContextMessages(50);
   *
   * // Each getSession(id) auto-creates namespaced providers:
   * //   memory key: "memory_<sessionId>"
   * //   prompt key: "_system_prompt_<sessionId>"
   * const session = manager.getSession("chat-123");
   * ```
   */
  static create(agent: SqlProvider): SessionManager {
    const mgr: SessionManager = Object.create(SessionManager.prototype);
    mgr.agent = agent;
    mgr._maxContextMessages = 100;
    mgr._pending = [];
    mgr._sessions = new Map();
    mgr._tableReady = false;
    mgr._ready = false;
    return mgr;
  }

  // ── Builder methods ─────────────────────────────────────────────

  withContext(label: string, options?: SessionContextOptions): this {
    this._pending.push({ label, options: options ?? {} });
    return this;
  }

  withCachedPrompt(provider?: ContextBlockProvider): this {
    this._cachedPrompt = provider ?? true;
    return this;
  }

  maxContextMessages(count: number): this {
    this._maxContextMessages = count;
    return this;
  }

  // ── Lazy init ───────────────────────────────────────────────────

  private _ensureReady(): void {
    if (this._ready) return;
    this._ready = true;
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
    this._ensureReady();
    let session = this._sessions.get(sessionId);
    if (!session) {
      const s = Session.create(this.agent).forSession(sessionId);
      for (const { label, options } of this._pending) {
        s.withContext(label, options);
      }
      if (this._cachedPrompt === true) {
        s.withCachedPrompt();
      } else if (this._cachedPrompt) {
        s.withCachedPrompt(this._cachedPrompt);
      }
      session = s;
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  create(
    name: string,
    opts?: { parentSessionId?: string; model?: string; source?: string }
  ): SessionInfo {
    this._ensureReady();
    const id = crypto.randomUUID();
    this.agent.sql`
      INSERT INTO assistant_sessions (id, name, parent_session_id, model, source)
      VALUES (${id}, ${name}, ${opts?.parentSessionId ?? null}, ${opts?.model ?? null}, ${opts?.source ?? null})
    `;
    return this.get(id)!;
  }

  get(sessionId: string): SessionInfo | null {
    this._ensureReady();
    const rows = this.agent.sql`
      SELECT * FROM assistant_sessions WHERE id = ${sessionId}
    ` as unknown as SessionInfo[];
    return rows[0] ?? null;
  }

  list(): SessionInfo[] {
    this._ensureReady();
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
    this._ensureReady();
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

  appendAll(
    sessionId: string,
    messages: UIMessage[],
    parentId?: string
  ): string | null {
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

  // ── Branching ──────────────────────────────────────────────────

  getBranches(sessionId: string, messageId: string): UIMessage[] {
    return this.getSession(sessionId).getBranches(messageId);
  }

  /**
   * Fork a session at a specific message, creating a new session
   * with the history up to that point copied over.
   */
  fork(sessionId: string, atMessageId: string, newName: string): SessionInfo {
    const info = this.create(newName);
    const history = this.getSession(sessionId).getHistory(atMessageId);
    const newSession = this.getSession(info.id);

    let parentId: string | null = null;
    for (const msg of history) {
      const newId = crypto.randomUUID();
      const copy: UIMessage = { ...msg, id: newId };
      newSession.appendMessage(copy, parentId);
      parentId = newId;
    }

    return info;
  }

  // ── Compaction ────────────────────────────────────────────────

  needsCompaction(sessionId: string): boolean {
    return this.getSession(sessionId).needsCompaction(this._maxContextMessages);
  }

  addCompaction(
    sessionId: string,
    summary: string,
    fromId: string,
    toId: string
  ): StoredCompaction {
    return this.getSession(sessionId).addCompaction(summary, fromId, toId);
  }

  getCompactions(sessionId: string): StoredCompaction[] {
    return this.getSession(sessionId).getCompactions();
  }

  compactAndSplit(
    sessionId: string,
    summary: string,
    newName?: string
  ): SessionInfo {
    const old = this.get(sessionId);
    this.agent.sql`
      UPDATE assistant_sessions SET end_reason = 'compaction', updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;

    const info = this.create(newName ?? old?.name ?? "Compacted", {
      parentSessionId: sessionId,
      model: old?.model ?? undefined,
      source: old?.source ?? undefined
    });

    this.append(info.id, {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [
        { type: "text", text: `[Context from previous session]\n\n${summary}` }
      ]
    });

    return info;
  }

  // ── Usage tracking ────────────────────────────────────────────

  addUsage(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    cost: number
  ): void {
    this._ensureReady();
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
    this._ensureReady();
    const limit = options?.limit ?? 20;
    return this.agent.sql<{ id: string; role: string; content: string }>`
      SELECT id, role, content FROM assistant_fts
      WHERE assistant_fts MATCH ${query}
      ORDER BY rank LIMIT ${limit}
    `.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: ""
    }));
  }

  // ── Tools ─────────────────────────────────────────────────────

  tools(): ToolSet {
    const mgr = this;
    return {
      session_search: {
        description:
          "Search past conversations for relevant context. Searches across all sessions.",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            query: { type: "string" as const, description: "Search query" }
          },
          required: ["query"]
        }),
        execute: async ({ query }: { query: string }) => {
          try {
            const results = mgr.search(query, { limit: 10 });
            if (results.length === 0) return "No results found.";
            return results
              .map((r) => `[${r.role}] ${r.content}`)
              .join("\n---\n");
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
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
