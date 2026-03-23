/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, and search.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import type { SessionProvider, StoredCompaction } from "./provider";
import type { SessionOptions } from "./types";
import { ContextBlocks, type ContextBlock } from "./context";

export class Session {
  private storage: SessionProvider;
  private contextBlocks: ContextBlocks | null;

  constructor(storage: SessionProvider, options?: SessionOptions) {
    this.storage = storage;
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

  // ── History (tree-structured) ─────────────────────────────────

  /**
   * Get conversation as a path from root to leaf.
   * Compaction overlays are applied — summarized ranges replaced with summaries.
   */
  getHistory(leafId?: string | null): UIMessage[] {
    return this.storage.getHistory(leafId);
  }

  getMessage(id: string): UIMessage | null {
    return this.storage.getMessage(id);
  }

  getLatestLeaf(): UIMessage | null {
    return this.storage.getLatestLeaf();
  }

  getBranches(messageId: string): UIMessage[] {
    return this.storage.getBranches(messageId);
  }

  getPathLength(leafId?: string | null): number {
    return this.storage.getPathLength(leafId);
  }

  // ── Write ─────────────────────────────────────────────────────

  /**
   * Append a message. Parented to the latest leaf unless parentId is provided.
   */
  appendMessage(message: UIMessage, parentId?: string | null): void {
    this.storage.appendMessage(message, parentId);
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

  // ── Compaction (non-destructive overlays) ──────────────────────

  /**
   * Add a compaction overlay. The summary replaces messages from
   * fromMessageId to toMessageId when getHistory() is called.
   * Original messages are not deleted.
   */
  addCompaction(
    summary: string,
    fromMessageId: string,
    toMessageId: string
  ): StoredCompaction {
    return this.storage.addCompaction(summary, fromMessageId, toMessageId);
  }

  getCompactions(): StoredCompaction[] {
    return this.storage.getCompactions();
  }

  needsCompaction(maxMessages?: number): boolean {
    return this.storage.getPathLength() > (maxMessages ?? 100);
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

  /**
   * Frozen snapshot of context blocks. First call renders and caches,
   * subsequent calls return the same string (preserves prefix cache).
   */
  toSystemPrompt(): string {
    return this.contextBlocks?.toSystemPrompt() ?? "";
  }

  /**
   * Re-render the snapshot. Call at session boundaries.
   */
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
        description: `Update a context block. Available blocks:\n${blockDescriptions}\n\nWrites are durable and persist across sessions.`,
        parameters: jsonSchema({
          type: "object" as const,
          properties: {
            label: { type: "string" as const, description: "Block label to update" },
            content: { type: "string" as const, description: "Content to write" },
            action: { type: "string" as const, enum: ["replace", "append"], description: "replace (default) or append" }
          },
          required: ["label", "content"]
        }),
        execute: async ({ label, content, action }: { label: string; content: string; action?: string }) => {
          try {
            if (action === "append") {
              await session.appendToBlock(label, content);
            } else {
              await session.setBlock(label, content);
            }
            return "Context successfully written";
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
