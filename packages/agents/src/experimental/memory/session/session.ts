/**
 * Session — conversation history, context blocks, compaction, search, and tools.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import type { SessionProvider, StoredCompaction } from "./provider";
import type { SessionOptions } from "./types";
import { ContextBlocks, type ContextBlock } from "./context";

export class Session {
  private storage: SessionProvider;
  private context: ContextBlocks;

  constructor(storage: SessionProvider, options?: SessionOptions) {
    this.storage = storage;
    this.context = new ContextBlocks(options?.context ?? [], options?.promptStore);
  }

  // ── History (tree-structured) ─────────────────────────────────

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

  // ── Compaction ────────────────────────────────────────────────

  addCompaction(summary: string, fromMessageId: string, toMessageId: string): StoredCompaction {
    return this.storage.addCompaction(summary, fromMessageId, toMessageId);
  }

  getCompactions(): StoredCompaction[] {
    return this.storage.getCompactions();
  }

  needsCompaction(maxMessages?: number): boolean {
    return this.storage.getPathLength() > (maxMessages ?? 100);
  }

  // ── Context Blocks ────────────────────────────────────────────

  getContextBlock(label: string): ContextBlock | null {
    return this.context.getBlock(label);
  }

  getContextBlocks(): ContextBlock[] {
    return this.context.getBlocks();
  }

  async replaceContextBlock(label: string, content: string): Promise<ContextBlock> {
    return this.context.setBlock(label, content);
  }

  async appendContextBlock(label: string, content: string): Promise<ContextBlock> {
    return this.context.appendToBlock(label, content);
  }

  // ── System Prompt ─────────────────────────────────────────────

  async freezeSystemPrompt(): Promise<string> {
    return this.context.freezeSystemPrompt();
  }

  async refreshSystemPrompt(): Promise<string> {
    return this.context.refreshSystemPrompt();
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
