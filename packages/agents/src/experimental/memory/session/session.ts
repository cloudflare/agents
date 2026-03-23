/**
 * Session — conversation history with branching, compaction overlays,
 * context blocks, and search.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import type { SessionProvider, StoredCompaction } from "./provider";
import type { SessionOptions } from "./types";
import { ContextBlocks } from "./context";

export class Session {
  private storage: SessionProvider;

  /** Context block management — get/set blocks, freeze system prompt, tools. */
  readonly context: ContextBlocks;

  constructor(storage: SessionProvider, options?: SessionOptions) {
    this.storage = storage;
    this.context = new ContextBlocks(options?.context ?? [], options?.promptStore);
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

  // ── Search ────────────────────────────────────────────────────

  search(query: string, options?: { limit?: number }): Array<{
    id: string; role: string; content: string; createdAt: string;
  }> {
    if (!this.storage.searchMessages) {
      throw new Error("Session provider does not support search");
    }
    return this.storage.searchMessages(query, options?.limit ?? 20);
  }

  // ── Tools ─────────────────────────────────────────────────────

  /**
   * Returns AI tools: update_context (from context blocks) + session_search (FTS).
   * Both are combined into a single toolset for the LLM.
   */
  async tools(): Promise<ToolSet> {
    const contextTools = await this.context.tools();
    const searchTool = this.storage.searchMessages
      ? this.buildSearchTool()
      : {};
    return { ...contextTools, ...searchTool };
  }

  private buildSearchTool(): ToolSet {
    const storage = this.storage;
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
            const results = storage.searchMessages!(query, 10);
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
