/**
 * Context Block Management
 *
 * Persistent key-value blocks (MEMORY, USER, SOUL, etc.) that are:
 * - Loaded from their providers at init
 * - Frozen into a snapshot when toSystemPrompt() is called
 * - Updated via setBlock() which writes to the provider immediately
 *   but does NOT update the frozen snapshot (preserves LLM prefix cache)
 * - Re-snapshotted on next toSystemPrompt() call
 *
 * Provider type determines behavior:
 * - ContextProvider (get only)        → readonly block in system prompt
 * - WritableContextProvider (get+set) → writable via set_context tool
 * - SkillProvider (get+load+set?)     → metadata in prompt, load_context tool
 * - SearchProvider (get+search+set?)  → searchable via search_context tool
 */

import { jsonSchema, type ToolSet } from "ai";
import { estimateStringTokens } from "../utils/tokens";
import { isSearchProvider, type SearchProvider } from "./search";
import { isSkillProvider, type SkillProvider } from "./skills";

/**
 * Base storage interface for a context block.
 * A provider with only `get()` is readonly.
 */
export interface ContextProvider {
  get(): Promise<string | null>;
  /** Called by the context system to provide the block label before first use. */
  init?(label: string): void;
}

/**
 * Writable context provider — extends ContextProvider with `set()`.
 * Blocks backed by this provider are writable via the `set_context` tool.
 */
export interface WritableContextProvider extends ContextProvider {
  set(content: string): Promise<void>;
}

/**
 * Check if a provider is writable (has a `set` method).
 */
export function isWritableProvider(
  provider: unknown
): provider is WritableContextProvider {
  return (
    typeof provider === "object" &&
    provider !== null &&
    "set" in provider &&
    typeof (provider as WritableContextProvider).set === "function"
  );
}

/**
 * Configuration for a context block.
 */
export interface ContextConfig {
  /** Block label — used as key and in tool descriptions */
  label: string;
  /** Human-readable description (shown to AI in tool) */
  description?: string;
  /** Maximum tokens allowed. Enforced on set. */
  maxTokens?: number;
  /** Storage provider. Determines block behavior:
   *  - ContextProvider (get only) → readonly
   *  - WritableContextProvider (get+set) → writable via set_context
   *  - SkillProvider (get+load+set?) → on-demand via load_context
   *  - SearchProvider (get+search+set?) → searchable via search_context
   *  If omitted, auto-wired to writable SQLite when using builder. */
  provider?:
    | ContextProvider
    | WritableContextProvider
    | SkillProvider
    | SearchProvider;
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
  /** True if provider is writable (has set) */
  writable: boolean;
  /** True if backed by a SkillProvider */
  isSkill: boolean;
  /** True if backed by a SearchProvider */
  isSearchable: boolean;
}

/**
 * Manages context blocks with frozen snapshot support.
 */
export class ContextBlocks {
  private configs: ContextConfig[];
  private blocks = new Map<string, ContextBlock>();
  private snapshot: string | null = null;
  private loaded = false;
  private promptStore: WritableContextProvider | null;

  constructor(configs: ContextConfig[], promptStore?: WritableContextProvider) {
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
      // Pass the label to the provider before first use
      if (config.provider?.init) {
        config.provider.init(config.label);
      }

      const content = config.provider
        ? ((await config.provider.get()) ?? "")
        : "";

      const skill = config.provider ? isSkillProvider(config.provider) : false;
      const searchable = config.provider
        ? isSearchProvider(config.provider)
        : false;
      const writable = config.provider
        ? isWritableProvider(config.provider) ||
          (skill && !!(config.provider as SkillProvider).set) ||
          (searchable && !!(config.provider as SearchProvider).set)
        : false;

      this.blocks.set(config.label, {
        label: config.label,
        description: config.description,
        content,
        tokens: estimateStringTokens(content),
        maxTokens: config.maxTokens,
        writable,
        isSkill: skill,
        isSearchable: searchable
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

    if (!existing?.writable) {
      throw new Error(`Block "${label}" is readonly`);
    }

    if (existing.isSkill || existing.isSearchable) {
      throw new Error(
        `Block "${label}" is a keyed provider. Use setSkill() or setSearchEntry() instead.`
      );
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
      writable: true,
      isSkill: false,
      isSearchable: false
    };

    this.blocks.set(label, block);

    // Write to provider immediately (durable)
    if (config?.provider && isWritableProvider(config.provider)) {
      await config.provider.set(content);
    }

    return block;
  }

  /**
   * Set a skill entry within a skill block.
   */
  async setSkill(
    label: string,
    key: string,
    content: string,
    description?: string
  ): Promise<void> {
    if (!this.loaded) await this.load();
    const config = this.configs.find((c) => c.label === label);
    const existing = this.blocks.get(label);

    if (!existing?.isSkill) {
      throw new Error(`Block "${label}" is not a skill provider`);
    }

    const provider = config?.provider;
    if (!provider || !isSkillProvider(provider) || !provider.set) {
      throw new Error(`Block "${label}" does not support writes`);
    }

    await provider.set(key, content, description);

    // Refresh metadata
    const metadata = await provider.get();
    if (metadata) {
      existing.content = metadata;
      existing.tokens = estimateStringTokens(metadata);
    }
  }

  /**
   * Load a skill's full content from a skill block.
   */
  async loadSkill(label: string, key: string): Promise<string | null> {
    if (!this.loaded) await this.load();
    const config = this.configs.find((c) => c.label === label);

    if (!config?.provider || !isSkillProvider(config.provider)) {
      throw new Error(`Block "${label}" is not a skill provider`);
    }

    return config.provider.load(key);
  }

  /**
   * Index a search entry within a searchable block.
   */
  async setSearchEntry(
    label: string,
    key: string,
    content: string
  ): Promise<void> {
    if (!this.loaded) await this.load();
    const config = this.configs.find((c) => c.label === label);
    const existing = this.blocks.get(label);

    if (!existing?.isSearchable) {
      throw new Error(`Block "${label}" is not a search provider`);
    }

    const provider = config?.provider;
    if (!provider || !isSearchProvider(provider) || !provider.set) {
      throw new Error(`Block "${label}" does not support writes`);
    }

    await provider.set(key, content);

    // Refresh summary
    const summary = await provider.get();
    existing.content = summary ?? "";
    existing.tokens = estimateStringTokens(existing.content);
  }

  /**
   * Search a searchable block.
   */
  async searchContext(label: string, query: string): Promise<string | null> {
    if (!this.loaded) await this.load();
    const config = this.configs.find((c) => c.label === label);

    if (!config?.provider || !isSearchProvider(config.provider)) {
      throw new Error(`Block "${label}" is not a search provider`);
    }

    return config.provider.search(query);
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

    if (this.snapshot !== null) {
      return this.snapshot;
    }

    return this.captureSnapshot();
  }

  /**
   * Force re-render the snapshot from current block state.
   */
  refreshSnapshot(): string {
    return this.captureSnapshot();
  }

  private captureSnapshot(): string {
    const parts: string[] = [];
    const sep = "═".repeat(46);

    for (const block of this.blocks.values()) {
      // Searchable blocks render even when empty so the model knows they exist
      if (!block.content && !block.isSearchable) continue;

      let header = block.label.toUpperCase();
      const hints: string[] = [];
      if (block.description) hints.push(block.description);
      if (block.isSkill) hints.push("use load_context to load");
      if (block.isSearchable) hints.push("use search_context to search");
      if (hints.length > 0) header += ` (${hints.join(" — ")})`;
      if (block.maxTokens) {
        const pct = Math.round((block.tokens / block.maxTokens) * 100);
        header += ` [${pct}% — ${block.tokens}/${block.maxTokens} tokens]`;
      }
      if (!block.writable) header += " [readonly]";

      parts.push(`${sep}\n${header}\n${sep}\n${block.content}`);
    }

    this.snapshot = parts.join("\n\n");
    return this.snapshot;
  }

  /**
   * Get writable blocks (for tool description).
   */
  getWritableBlocks(): ContextBlock[] {
    return Array.from(this.blocks.values()).filter((b) => b.writable);
  }

  /**
   * Check if any skill providers are registered.
   */
  hasSkillBlocks(): boolean {
    return Array.from(this.blocks.values()).some((b) => b.isSkill);
  }

  /**
   * Get skill block labels.
   */
  getSkillLabels(): string[] {
    return Array.from(this.blocks.values())
      .filter((b) => b.isSkill)
      .map((b) => b.label);
  }

  /**
   * Check if any search providers are registered.
   */
  hasSearchBlocks(): boolean {
    return Array.from(this.blocks.values()).some((b) => b.isSearchable);
  }

  /**
   * Get searchable block labels.
   */
  getSearchLabels(): string[] {
    return Array.from(this.blocks.values())
      .filter((b) => b.isSearchable)
      .map((b) => b.label);
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Frozen system prompt. On first call:
   * 1. Checks store for a persisted prompt (survives DO eviction)
   * 2. If none, loads blocks from providers, renders, and persists
   */
  async freezeSystemPrompt(): Promise<string> {
    if (this.promptStore) {
      const stored = await this.promptStore.get();
      if (stored !== null) return stored;
    }

    if (!this.loaded) await this.load();
    const prompt = this.toSystemPrompt();

    if (this.promptStore) {
      await this.promptStore.set(prompt);
    }

    return prompt;
  }

  /**
   * Re-render the system prompt from current block state and persist.
   */
  async refreshSystemPrompt(): Promise<string> {
    if (!this.loaded) await this.load();
    const prompt = this.refreshSnapshot();

    if (this.promptStore) {
      await this.promptStore.set(prompt);
    }

    return prompt;
  }

  /**
   * AI tools for context blocks.
   *
   * Auto-wired based on provider capabilities:
   * - `set_context` — when any block is writable
   * - `load_context` — when any block is a skill provider
   * - `search_context` — when any block is a search provider
   */
  async tools(): Promise<ToolSet> {
    if (!this.loaded) await this.load();

    const writable = this.getWritableBlocks();
    const hasSkills = this.hasSkillBlocks();
    const hasSearch = this.hasSearchBlocks();
    const toolSet: ToolSet = {};

    // ── set_context ──────────────────────────────────────────────

    if (writable.length > 0) {
      const regularBlocks = writable.filter(
        (b) => !b.isSkill && !b.isSearchable
      );
      const keyedBlocks = writable.filter((b) => b.isSkill || b.isSearchable);

      const blockDescriptions: string[] = [];
      for (const b of regularBlocks) {
        blockDescriptions.push(
          `- "${b.label}": ${b.description ?? "no description"}`
        );
      }
      for (const b of keyedBlocks) {
        const kind = b.isSkill
          ? "skill collection (requires key and optional description)"
          : "searchable (requires key)";
        blockDescriptions.push(`- "${b.label}": ${kind}`);
      }

      const properties: Record<string, unknown> = {
        label: {
          type: "string" as const,
          enum: writable.map((b) => b.label),
          description: "Block label to write to"
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
      };

      const required = ["label", "content"];

      if (keyedBlocks.length > 0) {
        properties.key = {
          type: "string" as const,
          description:
            "Entry key (required for keyed blocks: " +
            keyedBlocks.map((b) => `"${b.label}"`).join(", ") +
            ")"
        };
      }

      if (keyedBlocks.some((b) => b.isSkill)) {
        properties.description = {
          type: "string" as const,
          description: "Short description for the skill entry"
        };
      }

      toolSet.set_context = {
        description: `Write to a context block. Available blocks:\n${blockDescriptions.join("\n")}\n\nWrites are durable and persist across sessions.`,
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: properties as Record<string, object>,
          required
        }),
        execute: async ({
          label,
          content,
          key,
          description,
          action
        }: {
          label: string;
          content: string;
          key?: string;
          description?: string;
          action?: string;
        }) => {
          try {
            const block = this.blocks.get(label);
            if (!block) return `Error: block "${label}" not found`;

            if (block.isSkill) {
              if (!key)
                return `Error: key is required for skill block "${label}"`;
              await this.setSkill(label, key, content, description);
              return `Written skill "${key}" to ${label}.`;
            }

            if (block.isSearchable) {
              if (!key)
                return `Error: key is required for searchable block "${label}"`;
              await this.setSearchEntry(label, key, content);
              return `Indexed "${key}" in ${label}.`;
            }

            const updated =
              action === "append"
                ? await this.appendToBlock(label, content)
                : await this.setBlock(label, content);
            const usage = updated.maxTokens
              ? `${Math.round((updated.tokens / updated.maxTokens) * 100)}% (${updated.tokens}/${updated.maxTokens} tokens)`
              : `${updated.tokens} tokens`;
            return `Written to ${label}. Usage: ${usage}`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      };
    }

    // ── load_context ─────────────────────────────────────────────

    if (hasSkills) {
      const skillLabels = this.getSkillLabels();

      toolSet.load_context = {
        description:
          "Load a document from a skill block by key. " +
          "Available skill blocks: " +
          skillLabels.map((l) => `"${l}"`).join(", ") +
          ". Check the system prompt for available keys.",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            label: {
              type: "string" as const,
              enum: skillLabels,
              description: "Skill block label"
            },
            key: {
              type: "string" as const,
              description: "Skill key to load"
            }
          },
          required: ["label", "key"]
        }),
        execute: async ({ label, key }: { label: string; key: string }) => {
          try {
            const content = await this.loadSkill(label, key);
            return content ?? `Not found: ${key}`;
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      };
    }

    // ── search_context ────────────────────────────────────────────

    if (hasSearch) {
      const searchLabels = this.getSearchLabels();

      toolSet.search_context = {
        description:
          "Search for information in a searchable context block. " +
          "Available searchable blocks: " +
          searchLabels.map((l) => `"${l}"`).join(", ") +
          ".",
        inputSchema: jsonSchema({
          type: "object" as const,
          properties: {
            label: {
              type: "string" as const,
              enum: searchLabels,
              description: "Searchable block label"
            },
            query: {
              type: "string" as const,
              description: "Search query"
            }
          },
          required: ["label", "query"]
        }),
        execute: async ({ label, query }: { label: string; query: string }) => {
          try {
            const results = await this.searchContext(label, query);
            return results ?? "No results found.";
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      };
    }

    return toolSet;
  }
}
