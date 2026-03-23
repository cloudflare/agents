/**
 * SessionManager — multi-session manager backed by the agents Session API.
 *
 * Wraps the experimental memory Session to provide:
 *   - Multiple named sessions (conversations)
 *   - Session lifecycle (create, list, get, delete, rename)
 *   - Delegates message ops to Session (branching, compaction, search)
 *
 * Usage:
 *   const sessions = new SessionManager(agent);
 *   const info = sessions.create("my-chat");
 *   sessions.append(info.id, { id: "msg1", role: "user", parts: [...] });
 *   const history = sessions.getHistory(info.id);
 */
import type { UIMessage } from "ai";
import {
  Session,
  AgentSessionProvider,
  type SessionOptions,
  type StoredCompaction,
} from "agents/experimental/memory/session";

// ── Session info type ─────────────────────────────────────────────

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

// Keep backward compat
export type { SessionInfo as Session };
export type { StoredCompaction as Compaction };

// ── Truncation utilities (kept from original) ─────────────────────

const DEFAULT_MAX_CHARS = 30_000;
const ELLIPSIS = "\n\n... [truncated] ...\n\n";

export function truncateHead(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(-maxChars);
  return ELLIPSIS + text.slice(-keep);
}

export function truncateTail(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(0, maxChars);
  return text.slice(0, keep) + ELLIPSIS;
}

export function truncateLines(text: string, maxLines = 200): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join("\n");
  return kept + `\n\n... [${lines.length - maxLines} more lines truncated] ...`;
}

export function truncateMiddle(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const halfKeep = Math.floor((maxChars - ELLIPSIS.length) / 2);
  if (halfKeep <= 0) return text.slice(0, maxChars);
  return text.slice(0, halfKeep) + ELLIPSIS + text.slice(-halfKeep);
}

export function truncateToolOutput(
  output: string,
  options: { maxChars?: number; maxLines?: number; strategy?: "head" | "tail" | "middle" } = {}
): string {
  const { maxChars = DEFAULT_MAX_CHARS, maxLines = 500, strategy = "tail" } = options;
  let result = truncateLines(output, maxLines);
  if (result.length > maxChars) {
    switch (strategy) {
      case "head": result = truncateHead(result, maxChars); break;
      case "middle": result = truncateMiddle(result, maxChars); break;
      default: result = truncateTail(result, maxChars); break;
    }
  }
  return result;
}

// ── SQL interface ─────────────────────────────────────────────────

interface AgentLike {
  sql: (
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => Array<Record<string, unknown>>;
}

export interface SessionManagerOptions {
  maxContextMessages?: number;
  sessionOptions?: Omit<SessionOptions, never>;
  exec?: (query: string, ...values: (string | number | boolean | null)[]) => void;
}

// ── SessionManager ────────────────────────────────────────────────

export class SessionManager {
  private _agent: AgentLike;
  private _options: SessionManagerOptions;
  private _sessions = new Map<string, Session>();
  private _sessionsTableReady = false;

  constructor(agent: AgentLike, options: SessionManagerOptions = {}) {
    this._agent = agent;
    this._options = { maxContextMessages: 100, ...options };
    this._ensureSessionsTable();
  }

  private _ensureSessionsTable(): void {
    if (this._sessionsTableReady) return;
    this._agent.sql`
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
    this._sessionsTableReady = true;
  }

  /**
   * Get or create the Session instance for a session ID.
   * Each session gets its own AgentSessionProvider (same SQLite, namespaced by session tables).
   */
  private _getSession(sessionId: string): Session {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = new Session(new AgentSessionProvider(this._agent), this._options.sessionOptions);
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  // ── Session lifecycle ──────────────────────────────────────────

  create(
    name: string,
    opts?: { parentSessionId?: string; model?: string; source?: string }
  ): SessionInfo {
    const id = crypto.randomUUID();
    this._agent.sql`
      INSERT INTO assistant_sessions (id, name, parent_session_id, model, source)
      VALUES (${id}, ${name}, ${opts?.parentSessionId ?? null}, ${opts?.model ?? null}, ${opts?.source ?? null})
    `;
    return this._getSessionInfo(id)!;
  }

  get(sessionId: string): SessionInfo | null {
    return this._getSessionInfo(sessionId);
  }

  list(): SessionInfo[] {
    return this._agent.sql`
      SELECT * FROM assistant_sessions ORDER BY updated_at DESC
    ` as unknown as SessionInfo[];
  }

  delete(sessionId: string): void {
    const session = this._getSession(sessionId);
    session.clearMessages();
    this._agent.sql`DELETE FROM assistant_sessions WHERE id = ${sessionId}`;
    this._sessions.delete(sessionId);
  }

  clearMessages(sessionId: string): void {
    this._getSession(sessionId).clearMessages();
    this._updateTimestamp(sessionId);
  }

  rename(sessionId: string, name: string): void {
    this._agent.sql`
      UPDATE assistant_sessions SET name = ${name}, updated_at = CURRENT_TIMESTAMP WHERE id = ${sessionId}
    `;
  }

  // ── Messages ───────────────────────────────────────────────────

  append(sessionId: string, message: UIMessage, parentId?: string): string {
    const session = this._getSession(sessionId);
    session.appendMessage(message, parentId);
    this._updateTimestamp(sessionId);
    return message.id;
  }

  upsert(sessionId: string, message: UIMessage, parentId?: string): string {
    const session = this._getSession(sessionId);
    session.appendMessage(message, parentId);
    this._updateTimestamp(sessionId);
    return message.id;
  }

  appendAll(sessionId: string, messages: UIMessage[], parentId?: string): string | null {
    const session = this._getSession(sessionId);
    let lastParent = parentId ?? null;
    for (const msg of messages) {
      session.appendMessage(msg, lastParent);
      lastParent = msg.id;
    }
    this._updateTimestamp(sessionId);
    return lastParent;
  }

  deleteMessage(messageId: string): void {
    // Delete across all sessions — messages table is shared
    for (const session of this._sessions.values()) {
      session.deleteMessages([messageId]);
    }
  }

  deleteMessages(messageIds: string[]): void {
    for (const session of this._sessions.values()) {
      session.deleteMessages(messageIds);
    }
  }

  getHistory(sessionId: string, leafId?: string): UIMessage[] {
    return this._getSession(sessionId).getHistory(leafId);
  }

  getMessageCount(sessionId: string): number {
    return this._getSession(sessionId).getPathLength();
  }

  needsCompaction(sessionId: string): boolean {
    return this._getSession(sessionId).needsCompaction(this._options.maxContextMessages);
  }

  // ── Branching ──────────────────────────────────────────────────

  getBranches(messageId: string): UIMessage[] {
    // Use first session provider (all share the same table)
    const session = this._sessions.values().next().value;
    if (!session) return [];
    return session.getBranches(messageId);
  }

  fork(atMessageId: string, newName: string): SessionInfo {
    // Get path to the fork point from any session
    const anySession = this._sessions.values().next().value;
    if (!anySession) throw new Error("No sessions available");

    const path = anySession.getHistory(atMessageId);
    const newInfo = this.create(newName);

    let parentId: string | null = null;
    for (const msg of path) {
      const newId = crypto.randomUUID();
      const newMsg = { ...msg, id: newId };
      this.append(newInfo.id, newMsg, parentId ?? undefined);
      parentId = newId;
    }
    return newInfo;
  }

  // ── Compaction ─────────────────────────────────────────────────

  addCompaction(
    sessionId: string,
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    return this._getSession(sessionId).addCompaction(summary, fromMessageId, toMessageId);
  }

  getCompactions(sessionId: string): StoredCompaction[] {
    return this._getSession(sessionId).getCompactions();
  }

  /**
   * Compact and split: end current session, create a new one seeded
   * with the summary, linked via parent_session_id.
   */
  compactAndSplit(sessionId: string, summary: string, newName?: string): SessionInfo {
    this._agent.sql`
      UPDATE assistant_sessions SET end_reason = 'compaction', updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;

    const old = this._getSessionInfo(sessionId);
    const newInfo = this.create(newName ?? old?.name ?? "Compacted", {
      parentSessionId: sessionId,
      model: old?.model ?? undefined,
      source: old?.source ?? undefined,
    });

    const summaryMsg: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text: `[Context from previous session]\n\n${summary}` }],
    };
    this.append(newInfo.id, summaryMsg);
    return newInfo;
  }

  // ── Search ─────────────────────────────────────────────────────

  search(
    query: string,
    opts?: { limit?: number }
  ) {
    // Use first session's provider for search (all share the same FTS table)
    const session = this._sessions.values().next().value;
    if (!session) return [];
    return session.search(query, opts);
  }

  // ── Usage tracking ─────────────────────────────────────────────

  addUsage(sessionId: string, inputTokens: number, outputTokens: number, cost: number): void {
    this._agent.sql`
      UPDATE assistant_sessions SET
        input_tokens = input_tokens + ${inputTokens},
        output_tokens = output_tokens + ${outputTokens},
        estimated_cost = estimated_cost + ${cost},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${sessionId}
    `;
  }

  // ── Internal ───────────────────────────────────────────────────

  private _getSessionInfo(id: string): SessionInfo | null {
    const rows = this._agent.sql`
      SELECT * FROM assistant_sessions WHERE id = ${id}
    ` as unknown as SessionInfo[];
    return rows[0] ?? null;
  }

  private _updateTimestamp(sessionId: string): void {
    this._agent.sql`
      UPDATE assistant_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ${sessionId}
    `;
  }
}
