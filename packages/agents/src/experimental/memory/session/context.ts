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

import { estimateStringTokens } from "../utils/tokens";

/**
 * Pure storage interface for a single context block.
 * Each block can have its own backing store (R2, SQLite, KV, in-memory, etc.)
 */
export interface ContextBlockProvider {
  get(): Promise<string | null>;
  set(content: string): Promise<void>;
}

/**
 * Configuration for a context block.
 */
export interface ContextBlockConfig {
  /** Block label — used as key and in tool descriptions */
  label: string;
  /** Human-readable description (shown to AI in tool) */
  description?: string;
  /** Default content if provider returns null */
  defaultContent?: string;
  /** Maximum tokens allowed. Enforced on set. */
  maxTokens?: number;
  /** If true, AI cannot modify this block via tools */
  readonly?: boolean;
  /** Storage provider. If omitted, block is in-memory only (initialized from defaultContent) */
  provider?: ContextBlockProvider;
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
  private configs: ContextBlockConfig[];
  private blocks = new Map<string, ContextBlock>();
  private snapshot: string | null = null;
  private loaded = false;

  constructor(configs: ContextBlockConfig[]) {
    this.configs = configs;
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

      content = content ?? config.defaultContent ?? "";

      this.blocks.set(config.label, {
        label: config.label,
        description: config.description,
        content,
        tokens: estimateStringTokens(content),
        maxTokens: config.maxTokens,
        readonly: config.readonly,
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
      readonly: false,
    };

    this.blocks.set(label, block);

    // Write to provider immediately (durable)
    if (config?.provider) {
      await config.provider.set(content);
    }

    // Snapshot is NOT updated — frozen until next toSystemPrompt() call

    return block;
  }

  /**
   * Append content to a block.
   */
  async appendToBlock(label: string, content: string): Promise<ContextBlock> {
    const existing = this.blocks.get(label);
    if (!existing) {
      throw new Error(`Block "${label}" not found`);
    }
    return this.setBlock(label, existing.content + content);
  }

  /**
   * Render blocks as structured text for system prompt injection.
   * Captures a frozen snapshot — subsequent setBlock() calls won't change it.
   * Call again to re-snapshot (e.g., at start of next session).
   */
  toSystemPrompt(): string {
    if (!this.loaded) {
      throw new Error("Context blocks not loaded. Call load() first.");
    }

    const parts: string[] = [];

    for (const block of this.blocks.values()) {
      if (!block.content) continue;

      const attrs = [`label="${block.label}"`];
      if (block.description) attrs.push(`description="${block.description}"`);
      if (block.readonly) attrs.push('readonly="true"');
      if (block.maxTokens) {
        const pct = Math.round((block.tokens / block.maxTokens) * 100);
        attrs.push(`usage="${pct}% (${block.tokens}/${block.maxTokens} tokens)"`);
      }

      parts.push(
        `<context_block ${attrs.join(" ")}>\n${block.content}\n</context_block>`
      );
    }

    this.snapshot = parts.join("\n\n");
    return this.snapshot;
  }

  /**
   * Get the last frozen snapshot without re-rendering.
   * Returns null if toSystemPrompt() hasn't been called yet.
   */
  getSnapshot(): string | null {
    return this.snapshot;
  }

  /**
   * Get writable blocks (for tool description).
   */
  getWritableBlocks(): ContextBlock[] {
    return Array.from(this.blocks.values()).filter((b) => !b.readonly);
  }
}
