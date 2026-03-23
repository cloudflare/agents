/**
 * Session — unified API for conversation history with branching,
 * compaction, context blocks, and search.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import type { SessionProvider, StoredCompaction } from "./provider";
import type {
  MessageQueryOptions,
  SessionOptions,
  CompactResult
} from "./types";
import { ContextBlocks, type ContextBlockConfig, type ContextBlock } from "./context";
import {
  parseMicroCompactionRules,
  microCompact,
  type ResolvedMicroCompactionRules
} from "../utils/compaction";
import { estimateMessageTokens } from "../utils/tokens";

export class Session {
  private storage: SessionProvider;
  private microCompactionRules: ResolvedMicroCompactionRules | null;
  private compactionConfig: SessionOptions["compaction"] | null;
  private contextBlocks: ContextBlocks | null;

  constructor(storage: SessionProvider, options?: SessionOptions) {
    this.storage = storage;

    const mc = options?.microCompaction ?? true;
    this.microCompactionRules = parseMicroCompactionRules(mc);
    this.compactionConfig = options?.compaction ?? null;
    this.contextBlocks = options?.context
      ? new ContextBlocks(options.context)
      : null;
  }

  // ── Init ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.contextBlocks) {
      await this.contextBlocks.load();
    }
  }

  // ── Messages (read) ───────────────────────────────────────────

  getMessages(options?: MessageQueryOptions): UIMessage[] {
    return this.storage.getMessages(options);
  }

  getMessage(id: string): UIMessage | null {
    return this.storage.getMessage(id);
  }

  getLastMessages(n: number): UIMessage[] {
    return this.storage.getLastMessages(n);
  }

  // ── Branching ─────────────────────────────────────────────────

  /**
   * Get conversation history as a path from root to leaf.
   * If leafId is null, returns path to the most recent leaf.
   * Compactions are applied — summarized ranges replaced with summaries.
   */
  getHistory(leafId?: string | null): UIMessage[] {
    return this.storage.getHistory(leafId);
  }

  /**
   * Get the most recent leaf message (no children).
   */
  getLatestLeaf(): UIMessage | null {
    return this.storage.getLatestLeaf();
  }

  /**
   * Get children of a message (branches from that point).
   */
  getBranches(messageId: string): UIMessage[] {
    return this.storage.getBranches(messageId);
  }

  /**
   * Get the message count on the current branch path.
   */
  getPathLength(leafId?: string | null): number {
    return this.storage.getPathLength(leafId);
  }

  // ── Messages (write + compaction) ─────────────────────────────

  /**
   * Append a single message with optional parent.
   */
  appendMessage(message: UIMessage, parentId?: string | null): void {
    this.storage.appendMessage(message, parentId);
  }

  /**
   * Append one or more messages (each parented to the previous).
   * Runs microCompaction and auto-compaction if configured.
   */
  async append(messages: UIMessage | UIMessage[]): Promise<void> {
    await this.storage.appendMessages(messages);

    if (this.shouldAutoCompact()) {
      const result = await this.compact();
      if (result.success) return;
    }

    if (this.microCompactionRules) {
      const rules = this.microCompactionRules;
      const older = this.storage.getOlderMessages(rules.keepRecent);
      if (older.length > 0) {
        const compacted = microCompact(older, rules);
        for (let i = 0; i < older.length; i++) {
          if (compacted[i] !== older[i]) {
            this.storage.updateMessage(compacted[i]);
          }
        }
      }
    }
  }

  updateMessage(message: UIMessage): void {
    this.storage.updateMessage(message);
  }

  deleteMessages(messageIds: string[]): void {
    this.storage.deleteMessages(messageIds);
  }

  clearMessages(): void {
    this.storage.clearMessages();
  }

  // ── Compaction ────────────────────────────────────────────────

  /**
   * Run the user-supplied compaction function.
   */
  async compact(): Promise<CompactResult> {
    const messages = this.storage.getMessages();
    if (messages.length === 0) return { success: true };

    try {
      let result = messages;
      if (this.compactionConfig?.fn) {
        result = await this.compactionConfig.fn(result);
      }
      await this.storage.replaceMessages(result);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Add a compaction record (summary overlaying a range of messages).
   * Messages are not deleted — the summary is applied at read time.
   */
  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    return this.storage.addCompaction(summary, fromMessageId, toMessageId);
  }

  /**
   * Get all compaction records.
   */
  getCompactions(): StoredCompaction[] {
    return this.storage.getCompactions();
  }

  /**
   * Check if context needs compaction based on path length or token count.
   */
  needsCompaction(maxMessages?: number): boolean {
    const threshold = maxMessages ?? 100;
    return this.storage.getPathLength() > threshold;
  }

  private shouldAutoCompact(): boolean {
    if (!this.compactionConfig?.tokenThreshold) return false;
    const messages = this.storage.getMessages();
    return estimateMessageTokens(messages) > this.compactionConfig.tokenThreshold;
  }

  // ── Context Blocks ────────────────────────────────────────────

  getBlock(label: string): ContextBlock | null {
    return this.contextBlocks?.getBlock(label) ?? null;
  }

  getBlocks(): ContextBlock[] {
    return this.contextBlocks?.getBlocks() ?? [];
  }

  async setBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this.contextBlocks) throw new Error("No context blocks configured");
    return this.contextBlocks.setBlock(label, content);
  }

  async appendToBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this.contextBlocks) throw new Error("No context blocks configured");
    return this.contextBlocks.appendToBlock(label, content);
  }

  // ── System Prompt ─────────────────────────────────────────────

  toSystemPrompt(): string {
    return this.contextBlocks?.toSystemPrompt() ?? "";
  }

  refreshSystemPrompt(): string {
    return this.contextBlocks?.refreshSnapshot() ?? "";
  }

  // ── AI Tool ───────────────────────────────────────────────────

  tools(): ToolSet {
    if (!this.contextBlocks) return {};
    const writable = this.contextBlocks.getWritableBlocks();
    if (writable.length === 0) return {};

    const blockDescriptions = writable
      .map((b) => {
        const usage = b.maxTokens
          ? ` [${Math.round((b.tokens / b.maxTokens) * 100)}% full]`
          : "";
        return `- "${b.label}": ${b.description ?? "no description"}${usage}`;
      })
      .join("\n");

    const session = this;

    return {
      update_context: {
        description: `Update a context block. Available blocks:\n${blockDescriptions}\n\nWrites are durable and persist across sessions. Content replaces the entire block.`,
        parameters: jsonSchema({
          type: "object" as const,
          properties: {
            label: { type: "string" as const, description: "Block label to update" },
            content: { type: "string" as const, description: "New content (replaces existing)" }
          },
          required: ["label", "content"]
        }),
        execute: async ({ label, content }: { label: string; content: string }) => {
          try {
            const block = await session.setBlock(label, content);
            return `Updated "${label}" (${block.tokens} tokens)`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    };
  }

  // ── Search ────────────────────────────────────────────────────

  search(query: string, options?: { limit?: number }): Array<{
    id: string; role: string; content: string; createdAt: string;
  }> {
    if (!this.storage.searchMessages) {
      throw new Error("Session provider does not support search");
    }
    return this.storage.searchMessages(query, options?.limit ?? 20);
  }
}
