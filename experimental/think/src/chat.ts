import { AgentFacet } from "./agent-facet";
import type { BaseMessage, ThinkMessage } from "./shared";

/** Typed facet stub — all methods become async over RPC. */
export interface ChatFacet<M extends BaseMessage = ThinkMessage> {
  addMessage(message: M): Promise<M[]>;
  deleteMessage(id: string): Promise<M[]>;
  clearMessages(): Promise<void>;
  getMessages(): Promise<M[]>;
  persistMessages(messages: M[]): Promise<M[]>;
  setMaxPersistedMessages(limit: number | undefined): Promise<void>;
  applyToolResult(toolCallId: string, output: unknown): Promise<boolean>;
  applyToolApproval(toolCallId: string, approved: boolean): Promise<boolean>;
  cancelRequest(requestId: string): Promise<void>;
}

const textEncoder = new TextEncoder();

/**
 * Chat thread — a single conversation with message persistence,
 * tool state tracking, and streaming support.
 *
 * Extends AgentFacet for sql, scheduling, abort, retry infrastructure.
 * The parent (ThinkAgent) calls these methods via facet RPC.
 *
 * Generic over message type — only requires `{ id: string }`.
 */
export class Chat<M extends BaseMessage = ThinkMessage> extends AgentFacet {
  private _persistedCache = new Map<string, string>();
  private _messages: M[] = [];

  /** 1.8MB with headroom below SQLite's 2MB row limit. */
  static ROW_MAX_BYTES = 1_800_000;

  /**
   * Maximum messages to keep in storage. When exceeded, oldest are
   * deleted after each persist. Undefined = no limit.
   */
  maxPersistedMessages: number | undefined = undefined;

  /**
   * The message currently being built from a streaming response.
   * Tool results can update this in-place before it's persisted.
   */
  private _streamingMessage: M | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    this._messages = this._loadMessages();
  }

  // ── Public API: message CRUD ───────────────────────────────────────

  setMaxPersistedMessages(limit: number | undefined): void {
    this.maxPersistedMessages = limit;
  }

  addMessage(message: M): M[] {
    return this.persistMessages([...this._messages, message]);
  }

  deleteMessage(id: string): M[] {
    this.sql`DELETE FROM messages WHERE id = ${id}`;
    this._persistedCache.delete(id);
    this._messages = this._loadMessages();
    return this._messages;
  }

  clearMessages(): void {
    this.sql`DELETE FROM messages`;
    this._persistedCache.clear();
    this._messages = [];
    this._streamingMessage = null;
  }

  getMessages(): M[] {
    return this._messages;
  }

  persistMessages(messages: M[]): M[] {
    const incomingIds = new Set(messages.map((m) => m.id));

    for (const id of this._persistedCache.keys()) {
      if (!incomingIds.has(id)) {
        this.sql`DELETE FROM messages WHERE id = ${id}`;
        this._persistedCache.delete(id);
      }
    }

    for (const message of messages) {
      const sanitized = this._sanitizeMessage(message);
      const safe = this._enforceRowSizeLimit(sanitized);
      const json = JSON.stringify(safe);

      if (this._persistedCache.get(safe.id) === json) continue;

      this.sql`
        INSERT INTO messages (id, message) VALUES (${safe.id}, ${json})
        ON CONFLICT(id) DO UPDATE SET message = excluded.message
      `;
      this._persistedCache.set(safe.id, json);
    }

    if (this.maxPersistedMessages != null) {
      this._enforceMaxPersistedMessages();
    }

    this._messages = this._loadMessages();
    return this._messages;
  }

  // ── Streaming message management ───────────────────────────────────

  startStreamingMessage(message: M): void {
    this._streamingMessage = message;
  }

  getStreamingMessage(): M | null {
    return this._streamingMessage;
  }

  completeStreamingMessage(): M[] {
    if (!this._streamingMessage) return this._messages;

    const message = this._streamingMessage;
    this._streamingMessage = null;

    const parts = (message as Record<string, unknown>).parts;
    if (Array.isArray(parts) && parts.length === 0) {
      return this._messages;
    }

    return this.persistMessages([...this._messages, message]);
  }

  // ── Tool state tracking ────────────────────────────────────────────

  findMessageByToolCallId(toolCallId: string): M | undefined {
    if (this._streamingMessage) {
      if (this._messageHasToolCall(this._streamingMessage, toolCallId)) {
        return this._streamingMessage;
      }
    }
    for (let i = this._messages.length - 1; i >= 0; i--) {
      if (this._messageHasToolCall(this._messages[i], toolCallId)) {
        return this._messages[i];
      }
    }
    return undefined;
  }

  applyToolResult(toolCallId: string, output: unknown): boolean {
    return this._updateToolPart(toolCallId, ["input-available"], (part) => ({
      ...part,
      state: "output-available",
      output
    }));
  }

  applyToolApproval(toolCallId: string, approved: boolean): boolean {
    return this._updateToolPart(
      toolCallId,
      ["input-available", "approval-requested"],
      (part) => ({
        ...part,
        state: "approval-responded",
        approval: {
          ...(part.approval as Record<string, unknown> | undefined),
          approved
        }
      })
    );
  }

  private _messageHasToolCall(message: M, toolCallId: string): boolean {
    const parts = (message as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) return false;
    return parts.some(
      (p: Record<string, unknown>) =>
        "toolCallId" in p && p.toolCallId === toolCallId
    );
  }

  private _updateToolPart(
    toolCallId: string,
    matchStates: string[],
    applyUpdate: (part: Record<string, unknown>) => Record<string, unknown>
  ): boolean {
    const message = this.findMessageByToolCallId(toolCallId);
    if (!message) return false;

    const isStreaming = message === this._streamingMessage;
    const parts = (message as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) return false;

    let updated = false;

    if (isStreaming) {
      for (const part of parts) {
        if (
          part.toolCallId === toolCallId &&
          matchStates.includes(part.state as string)
        ) {
          Object.assign(part, applyUpdate(part as Record<string, unknown>));
          updated = true;
          break;
        }
      }
    } else {
      const updatedParts = parts.map((part: Record<string, unknown>) => {
        if (
          part.toolCallId === toolCallId &&
          matchStates.includes(part.state as string)
        ) {
          updated = true;
          return applyUpdate(part);
        }
        return part;
      });

      if (updated) {
        const updatedMessage = { ...message, parts: updatedParts } as M;
        const idx = this._messages.findIndex((m) => m.id === message.id);
        if (idx >= 0) {
          const newMessages = [...this._messages];
          newMessages[idx] = updatedMessage;
          this.persistMessages(newMessages);
        }
      }
    }

    return updated;
  }

  // ── Row size enforcement ───────────────────────────────────────────

  private static _byteLength(s: string): number {
    return textEncoder.encode(s).byteLength;
  }

  private _enforceRowSizeLimit(message: M): M {
    const json = JSON.stringify(message);
    if (Chat._byteLength(json) <= Chat.ROW_MAX_BYTES) return message;

    console.warn(
      `[Chat] Message ${message.id} is ${Chat._byteLength(json)} bytes, truncating to fit SQLite row limit`
    );

    const clone = JSON.parse(json) as Record<string, unknown>;
    this._truncateLargestStrings(clone);
    return clone as M;
  }

  private _truncateLargestStrings(obj: Record<string, unknown>) {
    const strings: Array<{
      parent: Record<string, unknown>;
      key: string;
      length: number;
    }> = [];
    this._collectStrings(obj, strings);
    strings.sort((a, b) => b.length - a.length);

    for (const entry of strings) {
      const val = entry.parent[entry.key] as string;
      if (val.length <= 500) break;
      entry.parent[entry.key] =
        `[Truncated for storage (${val.length} chars). ` +
        `Preview: ${val.slice(0, 500)}...]`;
      if (Chat._byteLength(JSON.stringify(obj)) <= Chat.ROW_MAX_BYTES) {
        return;
      }
    }
  }

  private _collectStrings(
    obj: unknown,
    results: Array<{
      parent: Record<string, unknown>;
      key: string;
      length: number;
    }>
  ) {
    if (typeof obj !== "object" || obj === null) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (typeof obj[i] === "string") {
          results.push({
            parent: obj as unknown as Record<string, unknown>,
            key: String(i),
            length: (obj[i] as string).length
          });
        } else {
          this._collectStrings(obj[i], results);
        }
      }
      return;
    }
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "id") continue;
      if (typeof record[key] === "string") {
        results.push({
          parent: record,
          key,
          length: (record[key] as string).length
        });
      } else {
        this._collectStrings(record[key], results);
      }
    }
  }

  // ── Max persisted messages ─────────────────────────────────────────

  private _enforceMaxPersistedMessages() {
    if (this.maxPersistedMessages == null) return;
    const countResult = this.sql<{ cnt: number }>`
      SELECT COUNT(*) AS cnt FROM messages
    `;
    const count = countResult[0]?.cnt ?? 0;
    if (count <= this.maxPersistedMessages) return;

    const excess = count - this.maxPersistedMessages;
    const toDelete = this.sql<{ id: string }>`
      SELECT id FROM messages ORDER BY created_at ASC LIMIT ${excess}
    `;
    for (const row of toDelete) {
      this.sql`DELETE FROM messages WHERE id = ${row.id}`;
      this._persistedCache.delete(row.id);
    }
  }

  // ── Message sanitization ───────────────────────────────────────────

  private _sanitizeMessage(message: M): M {
    const json = JSON.stringify(message);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    if (Array.isArray(parsed.parts)) {
      parsed.parts = (parsed.parts as Array<Record<string, unknown>>)
        .filter((part) => {
          if (
            part.type === "reasoning" &&
            typeof part.text === "string" &&
            part.text.trim() === ""
          ) {
            return false;
          }
          return true;
        })
        .map((part) => {
          this._stripProviderMetadata(part, "providerMetadata");
          this._stripProviderMetadata(part, "callProviderMetadata");
          return part;
        });
    }

    return parsed as M;
  }

  private _stripProviderMetadata(obj: Record<string, unknown>, key: string) {
    const meta = obj[key] as
      | { openai?: Record<string, unknown>; [k: string]: unknown }
      | undefined;
    if (!meta || typeof meta !== "object" || !meta.openai) return;

    const {
      itemId: _itemId,
      reasoningEncryptedContent: _rec,
      ...restOpenai
    } = meta.openai;
    const { openai: _openai, ...restMeta } = meta;

    const hasOtherOpenai = Object.keys(restOpenai).length > 0;
    const hasOtherMeta = Object.keys(restMeta).length > 0;

    if (hasOtherOpenai) {
      obj[key] = { ...restMeta, openai: restOpenai };
    } else if (hasOtherMeta) {
      obj[key] = restMeta;
    } else {
      delete obj[key];
    }
  }

  // ── Persistence (private) ──────────────────────────────────────────

  private _loadMessages(): M[] {
    this._persistedCache.clear();
    const messages: M[] = [];

    for (const row of this.sql<{ id: string; message: string }>`
      SELECT id, message FROM messages ORDER BY created_at
    `) {
      try {
        const parsed = JSON.parse(row.message) as M;
        if (typeof parsed.id !== "string" || parsed.id.length === 0) {
          continue;
        }
        this._persistedCache.set(parsed.id, row.message);
        messages.push(parsed);
      } catch {
        // skip corrupted rows
      }
    }

    return messages;
  }
}
