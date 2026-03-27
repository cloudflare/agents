/**
 * Context Block Management
 *
 * Persistent key-value blocks (MEMORY, USER, SOUL, etc.) that are:
 * - Loaded from their providers at init
 * - Frozen into a snapshot when toSystemPrompt() is called
 * - Updated via setBlock() which writes to the provider immediately
 *   but does NOT update the frozen snapshot (preserves LLM prefix cache)
 * - Re-snapshotted on next toSystemPrompt() call
 */

import { jsonSchema, type ToolSet } from "ai";
import { estimateStringTokens } from "../utils/tokens";

/**
 * Storage interface for a single context block.
 * Each block can have its own backing store (R2, SQLite, KV, in-memory, etc.)
 * If `set` is omitted, the block is readonly.
 */
export interface ContextProvider {
  get(): Promise<string | null>;
  set?(content: string): Promise<void>;
}

/**
 * Configuration for a context block.
 */
export interface ContextConfig {
  /** Block label — used as key and in tool descriptions */
  label: string;
  /** Human-readable description (shown to AI in tool) */
  description?: string;
  /** Initial content — used when provider returns null or is absent */
  initialContent?: string;
  /** Maximum tokens allowed. Enforced on set. */
  maxTokens?: number;
  /** If true, AI cannot modify this block via tools */
  readonly?: boolean;
  /** Storage provider. If omitted, auto-wired to SQLite when using builder. */
  provider?: ContextProvider;
}

/**
 * A loaded context block with computed token count.
 */
export interface ContextBlock {
  label: string;
  description?: string;
  content: string;
  tokens: number;
  maxTokens?: number;
  readonly?: boolean;
}

/**
 * Manages context blocks with frozen snapshot support.
 */
export class ContextBlocks {
  private configs: ContextConfig[];
  private blocks = new Map<string, ContextBlock>();
  private snapshot: string | null = null;
  private loaded = false;
  private promptStore: ContextProvider | null;

  constructor(configs: ContextConfig[], promptStore?: ContextProvider) {
    this.configs = configs;
    this.promptStore = promptStore ?? null;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Load all blocks from their providers.
   * Called once at session init.
   */
  async load(): Promise<void> {
    for (const config of this.configs) {
      let content: string | null = null;

      if (config.provider) {
        content = await config.provider.get();
      }

      content = content ?? config.initialContent ?? "";

      this.blocks.set(config.label, {
        label: config.label,
        description: config.description,
        content,
        tokens: estimateStringTokens(content),
        maxTokens: config.maxTokens,
        readonly: config.readonly
      });
    }
    this.loaded = true;
  }

  /**
   * Get a block by label.
   */
  getBlock(label: string): ContextBlock | null {
    return this.blocks.get(label) ?? null;
  }

  /**
   * Get all blocks.
   */
  getBlocks(): ContextBlock[] {
    return Array.from(this.blocks.values());
  }

  /**
   * Set block content. Writes to provider immediately.
   * Does NOT update the frozen snapshot.
   */
  async setBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this.loaded) await this.load();
    const config = this.configs.find((c) => c.label === label);
    const existing = this.blocks.get(label);

    if (existing?.readonly || config?.readonly) {
      throw new Error(`Block "${label}" is readonly`);
    }

    const tokens = estimateStringTokens(content);
    const maxTokens = config?.maxTokens ?? existing?.maxTokens;

    if (maxTokens !== undefined && tokens > maxTokens) {
      throw new Error(
        `Block "${label}" exceeds maxTokens: ${tokens} > ${maxTokens}`
      );
    }

    const block: ContextBlock = {
      label,
      description: config?.description ?? existing?.description,
      content,
      tokens,
      maxTokens,
      readonly: false
    };

    this.blocks.set(label, block);

    // Write to provider immediately (durable)
    if (config?.provider?.set) {
      await config.provider.set(content);
    }

    // Snapshot is NOT updated — frozen until next toSystemPrompt() call

    return block;
  }

  /**
   * Append content to a block.
   */
  async appendToBlock(label: string, content: string): Promise<ContextBlock> {
    if (!this.loaded) await this.load();
    const existing = this.blocks.get(label);
    if (!existing) {
      throw new Error(`Block "${label}" not found`);
    }
    return this.setBlock(label, existing.content + content);
  }

  /**
   * Get the system prompt string with context blocks.
   *
   * Returns a frozen snapshot: first call renders and caches,
   * subsequent calls return the same string (preserves LLM prefix cache).
   * Call refreshSnapshot() to re-render after block changes take effect.
   */
  toSystemPrompt(): string {
    if (!this.loaded) {
      throw new Error("Context blocks not loaded. Call load() first.");
    }

    // Return frozen snapshot if already captured
    if (this.snapshot !== null) {
      return this.snapshot;
    }

    return this.captureSnapshot();
  }

  /**
   * Force re-render the snapshot from current block state.
   * Call this at the start of a new session to pick up changes
   * made by setBlock() during the previous session.
   */
  refreshSnapshot(): string {
    return this.captureSnapshot();
  }

  private captureSnapshot(): string {
    const parts: string[] = [];
    const sep = "═".repeat(46);

    for (const block of this.blocks.values()) {
      if (!block.content) continue;

      let header = block.label.toUpperCase();
      if (block.description) header += ` (${block.description})`;
      if (block.maxTokens) {
        const pct = Math.round((block.tokens / block.maxTokens) * 100);
        header += ` [${pct}% — ${block.tokens}/${block.maxTokens} tokens]`;
      }
      if (block.readonly) header += " [readonly]";

      parts.push(`${sep}\n${header}\n${sep}\n${block.content}`);
    }

    this.snapshot = parts.join("\n\n");
    return this.snapshot;
  }

  /**
   * Get writable blocks (for tool description).
   */
  getWritableBlocks(): ContextBlock[] {
    return Array.from(this.blocks.values()).filter((b) => !b.readonly);
  }

  /**
   * Get writable block configs — doesn't require blocks to be loaded.
   */
  getWritableConfigs(): ContextConfig[] {
    return this.configs.filter((c) => !c.readonly);
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Frozen system prompt. On first call:
   * 1. Checks store for a persisted prompt (survives DO eviction)
   * 2. If none, loads blocks from providers, renders, and persists
   *
   * Subsequent calls return the stored version — true prefix cache stability.
   */
  async freezeSystemPrompt(): Promise<string> {
    if (this.promptStore) {
      const stored = await this.promptStore.get();
      if (stored !== null) return stored;
    }

    if (!this.loaded) await this.load();
    const prompt = this.toSystemPrompt();

    if (this.promptStore?.set) {
      await this.promptStore.set(prompt);
    }

    return prompt;
  }

  /**
   * Re-render the system prompt from current block state and persist.
   * Call after compaction or at session boundaries to pick up writes.
   */
  async refreshSystemPrompt(): Promise<string> {
    if (!this.loaded) await this.load();
    const prompt = this.refreshSnapshot();

    if (this.promptStore?.set) {
      await this.promptStore.set(prompt);
    }

    return prompt;
  }

  /**
   * AI tool for updating context blocks. Loads blocks lazily on first execute.
   */
  async tools(): Promise<ToolSet> {
    if (!this.loaded) await this.load();

    const writable = this.getWritableBlocks();
    if (writable.length === 0) return {};

    const blockDescriptions = writable
      .map((b) => `- "${b.label}": ${b.description ?? "no description"}`)
      .join("\n");

    const ctx = this;

    return {
      update_context: {
        description: `Update a context block. Available blocks:\n${blockDescriptions}\n\nWrites are durable and persist across sessions.`,
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            label: {
              type: "string" as const,
              enum: writable.map((b) => b.label),
              description: "Block label to update"
            },
            content: {
              type: "string" as const,
              description: "Content to write"
            },
            action: {
              type: "string" as const,
              enum: ["replace", "append"],
              description: "replace (default) or append"
            }
          },
          required: ["label", "content"]
        }),
        execute: async ({
          label,
          content,
          action
        }: {
          label: string;
          content: string;
          action?: string;
        }) => {
          try {
            const block =
              action === "append"
                ? await ctx.appendToBlock(label, content)
                : await ctx.setBlock(label, content);
            const usage = block.maxTokens
              ? `${Math.round((block.tokens / block.maxTokens) * 100)}% (${block.tokens}/${block.maxTokens} tokens)`
              : `${block.tokens} tokens`;
            return `Written to ${label}. Usage: ${usage}`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    };
  }
}
