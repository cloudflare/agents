/**
 * Session — unified API for conversation history + persistent context blocks.
 *
 * Orchestrates:
 * - Message storage with microCompaction (cheap, no LLM) and full compaction (user-supplied fn)
 * - Context blocks (MEMORY, USER, SOUL, etc.) with frozen snapshot for prompt caching
 * - AI tool generation for block updates
 * - Full-text search across messages
 */

import { jsonSchema, type ToolSet } from "ai";
import type { UIMessage } from "ai";
import type { SessionProvider } from "./provider";
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

  // ── Init ──────────────────────────────────────────────────────────

  /**
   * Initialize context blocks from their providers.
   * Call once before using context features.
   * No-op if no context blocks configured.
   */
  async init(): Promise<void> {
    if (this.contextBlocks) {
      await this.contextBlocks.load();
    }
  }

  // ── Messages (read) ───────────────────────────────────────────────

  getMessages(options?: MessageQueryOptions): UIMessage[] {
    return this.storage.getMessages(options);
  }

  getMessage(id: string): UIMessage | null {
    return this.storage.getMessage(id);
  }

  getLastMessages(n: number): UIMessage[] {
    return this.storage.getLastMessages(n);
  }

  // ── Messages (write + compaction) ─────────────────────────────────

  async append(messages: UIMessage | UIMessage[]): Promise<void> {
    await this.storage.appendMessages(messages);

    // Full compaction if token threshold exceeded
    if (this.shouldAutoCompact()) {
      const result = await this.compact();
      if (result.success) return;
    }

    // MicroCompaction on older messages
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

  // ── Compaction ────────────────────────────────────────────────────

  async compact(): Promise<CompactResult> {
    const messages = this.storage.getMessages();

    if (messages.length === 0) {
      return { success: true };
    }

    try {
      let result = messages;

      if (this.compactionConfig?.fn) {
        result = await this.compactionConfig.fn(result);
      }

      await this.storage.replaceMessages(result);

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private shouldAutoCompact(): boolean {
    if (!this.compactionConfig?.tokenThreshold) return false;

    const messages = this.storage.getMessages();
    const approxTokens = estimateMessageTokens(messages);
    return approxTokens > this.compactionConfig.tokenThreshold;
  }

  // ── Context Blocks ────────────────────────────────────────────────

  /**
   * Get a context block by label.
   */
  getBlock(label: string): ContextBlock | null {
    return this.contextBlocks?.getBlock(label) ?? null;
  }

  /**
   * Get all context blocks.
   */
  getBlocks(): ContextBlock[] {
    return this.contextBlocks?.getBlocks() ?? [];
  }

  /**
   * Set block content. Writes to provider immediately.
   * Does NOT update the system prompt snapshot (preserves prefix cache).
   */
  async setBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this.contextBlocks) {
      throw new Error("No context blocks configured");
    }
    return this.contextBlocks.setBlock(label, content);
  }

  /**
   * Append content to a block.
   */
  async appendToBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this.contextBlocks) {
      throw new Error("No context blocks configured");
    }
    return this.contextBlocks.appendToBlock(label, content);
  }

  // ── System Prompt ─────────────────────────────────────────────────

  /**
   * Get the system prompt with context blocks.
   *
   * Returns a frozen snapshot: first call renders and caches,
   * subsequent calls return the same string without re-rendering.
   * This preserves the LLM prefix cache across turns.
   *
   * Call refreshSystemPrompt() to re-render (e.g., at start of a new session).
   */
  toSystemPrompt(): string {
    return this.contextBlocks?.toSystemPrompt() ?? "";
  }

  /**
   * Force re-render the system prompt from current block state.
   * Call at session boundaries to pick up changes made during the previous session.
   */
  refreshSystemPrompt(): string {
    return this.contextBlocks?.refreshSnapshot() ?? "";
  }

  // ── AI Tool ───────────────────────────────────────────────────────

  /**
   * Returns an AI SDK ToolSet with an `update_context` tool.
   * The tool lets the AI update writable context blocks.
   * Readonly blocks are visible in the prompt but excluded from the tool.
   */
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
            label: {
              type: "string" as const,
              description: "Block label to update"
            },
            content: {
              type: "string" as const,
              description: "New content for the block (replaces existing)"
            }
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

  // ── Search ────────────────────────────────────────────────────────

  /**
   * Full-text search across messages (if provider supports it).
   */
  search(query: string, options?: { limit?: number }): Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
  }> {
    if (!this.storage.searchMessages) {
      throw new Error("Session provider does not support search");
    }
    return this.storage.searchMessages(query, options?.limit ?? 20);
  }
}
