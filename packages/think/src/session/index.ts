/**
 * SessionManager — persistent conversation state with branching and compaction.
 *
 * Provides:
 *   - Multiple named sessions (conversations)
 *   - Tree-structured messages (parent_id for branching)
 *   - History retrieval following a branch path
 *   - Compaction (summarize old messages to save context)
 *   - Compatible with AI SDK's UIMessage type
 *
 * Usage:
 *   const sessions = new SessionManager(agent);
 *   const session = sessions.create("my-chat");
 *   sessions.append(session.id, { id: "msg1", role: "user", parts: [...] });
 *   const history = sessions.getHistory(session.id); // UIMessage[]
 */
import type { UIMessage } from "ai";
import { SessionStorage } from "./storage";
import type { Session, Compaction } from "./storage";

export type { Session, Compaction } from "./storage";

// ── Truncation utilities ──────────────────────────────────────────

const DEFAULT_MAX_CHARS = 30_000;
const ELLIPSIS = "\n\n... [truncated] ...\n\n";

/**
 * Truncate from the head (keep the end of the content).
 */
export function truncateHead(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(-maxChars);
  return ELLIPSIS + text.slice(-keep);
}

/**
 * Truncate from the tail (keep the start of the content).
 */
export function truncateTail(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - ELLIPSIS.length;
  if (keep <= 0) return text.slice(0, maxChars);
  return text.slice(0, keep) + ELLIPSIS;
}

/**
 * Truncate by line count (keep the first N lines).
 */
export function truncateLines(text: string, maxLines: number = 200): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines).join("\n");
  const omitted = lines.length - maxLines;
  return kept + `\n\n... [${omitted} more lines truncated] ...`;
}

/**
 * Truncate from both ends, keeping the start and end.
 */
export function truncateMiddle(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (text.length <= maxChars) return text;
  const halfKeep = Math.floor((maxChars - ELLIPSIS.length) / 2);
  if (halfKeep <= 0) return text.slice(0, maxChars);
  return text.slice(0, halfKeep) + ELLIPSIS + text.slice(-halfKeep);
}

/**
 * Smart truncation for tool output.
 */
export function truncateToolOutput(
  output: string,
  options: {
    maxChars?: number;
    maxLines?: number;
    strategy?: "head" | "tail" | "middle";
  } = {}
): string {
  const {
    maxChars = DEFAULT_MAX_CHARS,
    maxLines = 500,
    strategy = "tail"
  } = options;

  let result = truncateLines(output, maxLines);

  if (result.length > maxChars) {
    switch (strategy) {
      case "head":
        result = truncateHead(result, maxChars);
        break;
      case "middle":
        result = truncateMiddle(result, maxChars);
        break;
      case "tail":
      default:
        result = truncateTail(result, maxChars);
        break;
    }
  }

  return result;
}

// Mirrors Agent.sql — kept structural to avoid importing the 4k-line Agent class.
interface AgentLike {
  sql: (
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => Array<Record<string, unknown>>;
}

export interface SessionManagerOptions {
  /**
   * Maximum number of messages on the current branch before
   * needsCompaction() returns true. Default: 100.
   */
  maxContextMessages?: number;
}

export class SessionManager {
  private _storage: SessionStorage;
  private _options: SessionManagerOptions;

  constructor(agent: AgentLike, options: SessionManagerOptions = {}) {
    this._storage = new SessionStorage(agent.sql.bind(agent));
    this._options = {
      maxContextMessages: 100,
      ...options
    };
  }

  // ── Session lifecycle ──────────────────────────────────────────

  /**
   * Create a new session with a name.
   */
  create(name: string): Session {
    return this._storage.createSession(crypto.randomUUID(), name);
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): Session | null {
    return this._storage.getSession(sessionId);
  }

  /**
   * List all sessions, most recently updated first.
   */
  list(): Session[] {
    return this._storage.listSessions();
  }

  /**
   * Delete a session and all its messages and compactions.
   */
  delete(sessionId: string): void {
    this._storage.deleteSession(sessionId);
  }

  /**
   * Clear all messages and compactions for a session without
   * deleting the session itself.
   */
  clearMessages(sessionId: string): void {
    this._storage.clearSessionMessages(sessionId);
  }

  /**
   * Rename a session.
   */
  rename(sessionId: string, name: string): void {
    this._storage.renameSession(sessionId, name);
  }

  // ── Messages ───────────────────────────────────────────────────

  /**
   * Append a message to a session. If parentId is not provided,
   * the message is appended after the latest leaf.
   *
   * Idempotent — appending the same message.id twice is a no-op.
   *
   * Returns the stored message ID.
   */
  append(sessionId: string, message: UIMessage, parentId?: string): string {
    const resolvedParent =
      parentId ?? this._storage.getLatestLeaf(sessionId)?.id ?? null;

    const id = message.id || crypto.randomUUID();
    this._storage.appendMessage(id, sessionId, resolvedParent, message);
    return id;
  }

  /**
   * Insert or update a message. First call inserts, subsequent calls
   * update the content. Enables incremental persistence.
   *
   * Idempotent on insert, content-updating on subsequent calls.
   */
  upsert(sessionId: string, message: UIMessage, parentId?: string): string {
    const resolvedParent =
      parentId ?? this._storage.getLatestLeaf(sessionId)?.id ?? null;
    const id = message.id || crypto.randomUUID();
    this._storage.upsertMessage(id, sessionId, resolvedParent, message);
    return id;
  }

  /**
   * Delete a single message by ID.
   * Children of the deleted message naturally become path roots
   * (their parent_id points to a missing row, truncating the CTE walk).
   */
  deleteMessage(messageId: string): void {
    this._storage.deleteMessage(messageId);
  }

  /**
   * Delete multiple messages by ID.
   */
  deleteMessages(messageIds: string[]): void {
    this._storage.deleteMessages(messageIds);
  }

  /**
   * Append multiple messages in sequence (each parented to the previous).
   * Returns the ID of the last appended message.
   */
  appendAll(
    sessionId: string,
    messages: UIMessage[],
    parentId?: string
  ): string | null {
    let lastId = parentId ?? null;
    for (const msg of messages) {
      const resolvedParent =
        lastId ?? this._storage.getLatestLeaf(sessionId)?.id ?? null;
      const id = msg.id || crypto.randomUUID();
      this._storage.appendMessage(id, sessionId, resolvedParent, msg);
      lastId = id;
    }
    return lastId;
  }

  /**
   * Get the conversation history for a session as UIMessage[].
   *
   * If leafId is provided, returns the path from root to that leaf
   * (a specific branch). Otherwise returns the path to the most
   * recent leaf (the "current" branch).
   *
   * If compactions exist, older messages covered by a compaction
   * are replaced with a system message containing the summary.
   */
  getHistory(sessionId: string, leafId?: string): UIMessage[] {
    const leaf = leafId
      ? this._storage.getMessage(leafId)
      : this._storage.getLatestLeaf(sessionId);

    if (!leaf) return [];

    const storedPath = this._storage.getMessagePath(leaf.id);
    const compactions = this._storage.getCompactions(sessionId);

    if (compactions.length === 0) {
      return storedPath.map((m) => this._storage.parseMessage(m));
    }

    return this._applyCompactions(storedPath, compactions);
  }

  /**
   * Get the total message count for a session (across all branches).
   */
  getMessageCount(sessionId: string): number {
    return this._storage.getMessageCount(sessionId);
  }

  /**
   * Check if the session's current branch needs compaction.
   * Uses a count-only query — does not load message content.
   */
  needsCompaction(sessionId: string): boolean {
    const leaf = this._storage.getLatestLeaf(sessionId);
    if (!leaf) return false;
    const pathLen = this._storage.getPathLength(leaf.id);
    return pathLen > (this._options.maxContextMessages ?? 100);
  }

  // ── Branching ──────────────────────────────────────────────────

  /**
   * Get the children of a message (branches from that point).
   */
  getBranches(messageId: string): UIMessage[] {
    const children = this._storage.getChildren(messageId);
    return children.map((m) => this._storage.parseMessage(m));
  }

  /**
   * Fork a session at a specific message, creating a new session
   * with the history up to that point copied over.
   */
  fork(atMessageId: string, newName: string): Session {
    const newSession = this.create(newName);
    const path = this._storage.getMessagePath(atMessageId);

    let parentId: string | null = null;
    for (const stored of path) {
      const msg = this._storage.parseMessage(stored);
      const newId = crypto.randomUUID();
      this._storage.appendMessage(newId, newSession.id, parentId, msg);
      parentId = newId;
    }

    return newSession;
  }

  // ── Compaction ─────────────────────────────────────────────────

  /**
   * Add a compaction record. The summary replaces messages from
   * fromMessageId to toMessageId in context assembly.
   *
   * Typically called after using an LLM to summarize older messages.
   */
  addCompaction(
    sessionId: string,
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): Compaction {
    return this._storage.addCompaction(
      crypto.randomUUID(),
      sessionId,
      summary,
      fromMessageId,
      toMessageId
    );
  }

  /**
   * Get all compaction records for a session.
   */
  getCompactions(sessionId: string): Compaction[] {
    return this._storage.getCompactions(sessionId);
  }

  // ── Internal ───────────────────────────────────────────────────

  private _applyCompactions(
    path: Array<{ id: string; content: string }>,
    compactions: Compaction[]
  ): UIMessage[] {
    const pathIds = path.map((m) => m.id);
    const result: UIMessage[] = [];
    let i = 0;

    while (i < path.length) {
      // Check if any compaction starts at this message
      const compaction = compactions.find(
        (c) => c.from_message_id === pathIds[i]
      );

      if (compaction) {
        // Only apply if the compaction's end is also on this path
        const endIdx = pathIds.indexOf(compaction.to_message_id);
        if (endIdx >= i) {
          result.push({
            id: `compaction_${compaction.id}`,
            role: "system",
            parts: [
              {
                type: "text",
                text: `[Previous conversation summary]\n${compaction.summary}`
              }
            ]
          });
          i = endIdx + 1;
        } else {
          // Compaction doesn't span this path — skip it, emit message as-is
          result.push(JSON.parse(path[i].content) as UIMessage);
          i++;
        }
      } else {
        result.push(JSON.parse(path[i].content) as UIMessage);
        i++;
      }
    }

    return result;
  }
}
