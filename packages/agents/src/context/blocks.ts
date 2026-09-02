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
 * - SearchProvider (get+search+set?)  → searchable via search_context tool
 */

import type { ToolSet } from "ai";
import { z } from "zod";
import { estimateStringTokens } from "../sessions/tokens";
import { isSearchProvider, type SearchProvider } from "./search";

function slugify(text: string): string {
  return text
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function contextEntryKey(metadataTitle: string | undefined, content: string) {
  if (metadataTitle?.trim()) {
    const slug = slugify(metadataTitle);
    return slug || `entry-${stableHash(metadataTitle)}`;
  }

  const slug = slugify(content) || "entry";
  return `${slug}-${stableHash(content)}`;
}

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
   *  - SearchProvider (get+search+set?) → searchable via search_context
   *  If omitted, auto-wired to writable SQLite when using builder. */
  provider?: ContextProvider | WritableContextProvider | SearchProvider;
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
  private defaultProvider: ((label: string) => ContextProvider) | null;

  /**
   * @param configs Blocks to load on first use.
   * @param promptStore Persists the frozen system prompt, keeping the
   *   provider's prefix cache warm across wakes.
   * @param defaultProvider Supplies storage for blocks declared without a
   *   provider, so a host can offer durable writable blocks by label alone.
   */
  constructor(
    configs: ContextConfig[],
    promptStore?: WritableContextProvider,
    defaultProvider?: (label: string) => ContextProvider
  ) {
    this.configs = configs;
    this.promptStore = promptStore ?? null;
    this.defaultProvider = defaultProvider ?? null;
  }

  /** Fill in the host's storage for a block declared without a provider. */
  private withDefaultProvider(config: ContextConfig): ContextConfig {
    if (config.provider || !this.defaultProvider) return config;
    return { ...config, provider: this.defaultProvider(config.label) };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Load all blocks from their providers.
   * Called once at session init.
   */
  async load(): Promise<void> {
    this.configs = this.configs.map((config) =>
      this.withDefaultProvider(config)
    );
    for (const config of this.configs) {
      // Pass the label to the provider before first use
      if (config.provider?.init) {
        config.provider.init(config.label);
      }

      const content = config.provider
        ? ((await config.provider.get()) ?? "")
        : "";

      const searchable = config.provider
        ? isSearchProvider(config.provider)
        : false;
      const writable = config.provider
        ? isWritableProvider(config.provider) ||
          (searchable && !!(config.provider as SearchProvider).set)
        : false;

      this.blocks.set(config.label, {
        label: config.label,
        description: config.description,
        content,
        tokens: estimateStringTokens(content),
        maxTokens: config.maxTokens,
        writable,
        isSearchable: searchable
      });
    }
    this.loaded = true;
  }

  /**
   * Dynamically register a new context block after initialization.
   * Used by extensions to contribute context at runtime.
   *
   * If blocks have already been loaded, the new block's provider is
   * initialized and loaded immediately. The snapshot is NOT updated
   * automatically — call `refreshSystemPrompt()` to rebuild.
   */
  async addBlock(input: ContextConfig): Promise<ContextBlock> {
    if (!this.loaded) await this.load();

    if (this.configs.some((c) => c.label === input.label)) {
      throw new Error(`Block "${input.label}" already exists`);
    }

    const config = this.withDefaultProvider(input);
    this.configs.push(config);

    if (config.provider?.init) {
      config.provider.init(config.label);
    }

    const content = config.provider
      ? ((await config.provider.get()) ?? "")
      : "";

    const searchable = config.provider
      ? isSearchProvider(config.provider)
      : false;
    const writable = config.provider
      ? isWritableProvider(config.provider) ||
        (searchable && !!(config.provider as SearchProvider).set)
      : false;

    const block: ContextBlock = {
      label: config.label,
      description: config.description,
      content,
      tokens: estimateStringTokens(content),
      maxTokens: config.maxTokens,
      writable,
      isSearchable: searchable
    };

    this.blocks.set(config.label, block);
    return block;
  }

  /**
   * Remove a dynamically registered context block.
   * Used during extension unload cleanup.
   *
   * Returns true if the block existed and was removed.
   * The snapshot is NOT updated automatically — call
   * `refreshSystemPrompt()` to rebuild.
   */
  removeBlock(label: string): boolean {
    const idx = this.configs.findIndex((c) => c.label === label);
    if (idx === -1) return false;

    this.configs.splice(idx, 1);
    this.blocks.delete(label);
    return true;
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

    if (existing.isSearchable) {
      throw new Error(
        `Block "${label}" is a keyed provider. Use setSearchEntry() instead.`
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
    const needsSep = existing.content.length > 0 && !content.startsWith("\n");
    return this.setBlock(
      label,
      existing.content + (needsSep ? "\n" : "") + content
    );
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

  private renderPrompt(): string {
    const parts: string[] = [];
    const sep = "═".repeat(46);

    for (const block of this.blocks.values()) {
      // Skip empty readonly blocks — writable and searchable blocks always
      // render so the LLM knows which tools can address them.
      if (!block.content && !block.writable && !block.isSearchable) continue;

      let header = block.label.toUpperCase();
      if (block.description) header += ` (${block.description})`;
      if (block.maxTokens) {
        const pct = Math.round((block.tokens / block.maxTokens) * 100);
        header += ` [${pct}% — ${block.tokens}/${block.maxTokens} tokens]`;
      }
      if (block.isSearchable) header += " [searchable]";
      else if (!block.writable) header += " [readonly]";
      else header += " [writable]";

      parts.push(`${sep}\n${header}\n${sep}\n${block.content}`);
    }

    return parts.join("\n\n");
  }

  private captureSnapshot(): string {
    this.snapshot = this.renderPrompt();
    return this.snapshot;
  }

  /**
   * Get writable blocks (for tool description).
   */
  getWritableBlocks(): ContextBlock[] {
    return Array.from(this.blocks.values()).filter((b) => b.writable);
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
   * Return the cached system prompt. If no cached prompt exists,
   * loads blocks from providers, renders, and persists to the store.
   * Subsequent calls return the stored value without re-rendering.
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
   * Return the prompt text used for token estimation without persisting a new
   * frozen prompt to the prompt store.
   *
   * This still reads an existing cached prompt when present, so estimates match
   * the prompt that inference would reuse. If no cached prompt exists, it loads
   * providers and renders the current blocks without freezing the snapshot.
   */
  async getSystemPromptForEstimate(): Promise<string> {
    if (this.snapshot !== null) {
      return this.snapshot;
    }

    if (this.promptStore) {
      const stored = await this.promptStore.get();
      if (stored !== null) return stored;
    }

    if (!this.loaded) await this.load();
    return this.renderPrompt();
  }

  /**
   * Force reload blocks from providers, re-render the system prompt,
   * and persist to the store. Use this after block content has changed
   * or to invalidate the cached prompt.
   */
  async refreshSystemPrompt(): Promise<string> {
    this.loaded = false;
    await this.load();
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
   * - `search_context` — when any block is a search provider
   */
  async tools(): Promise<ToolSet> {
    if (!this.loaded) await this.load();

    const writable = this.getWritableBlocks();
    const hasSearch = this.hasSearchBlocks();
    const toolSet: ToolSet = {};

    // ── set_context ──────────────────────────────────────────────

    if (writable.length > 0) {
      const blockDescriptions = writable.map((b) => {
        const kind = b.isSearchable ? "searchable, keyed entries" : "writable";
        return `- "${b.label}" (${kind}): ${b.description ?? "no description"}`;
      });
      const keyedBlocks = writable.filter((b) => b.isSearchable);

      const properties: Record<string, unknown> = {
        label: {
          type: "string" as const,
          enum: writable.map((b) => b.label),
          description: "Block label to write to"
        },
        content: {
          type: "string" as const,
          description: "The main content to write to the block."
        },
        action: {
          type: "string" as const,
          enum: ["replace", "append"],
          description: "replace (default) or append"
        }
      };

      if (keyedBlocks.length > 0) {
        properties.metadata = {
          type: "object" as const,
          description:
            "Optional metadata for keyed entries (searchable blocks: " +
            keyedBlocks.map((b) => `"${b.label}"`).join(", ") +
            "). A title keeps updates stable; a description helps the model " +
            "pick the right entry.",
          properties: {
            title: {
              type: "string" as const,
              description:
                "Short title. Used as a stable identifier — entries with the " +
                "same title are updated in place, different titles create new entries."
            },
            description: {
              type: "string" as const,
              description:
                "One-line summary shown alongside the title in the system prompt " +
                "so the model can decide when to load the entry."
            }
          }
        };
      }

      const metadataHint =
        keyedBlocks.length > 0
          ? "\n\nFor searchable blocks, pass `metadata: { title, description }` " +
            "— title stabilises updates, description helps the model pick " +
            "entries. Metadata is optional."
          : "";

      toolSet.set_context = {
        description: `Write to a context block. Available blocks:\n${blockDescriptions.join("\n")}\n\nWrites are durable and persist across sessions.${metadataHint}`,
        inputSchema: z.fromJSONSchema({
          type: "object" as const,
          properties: properties as Record<string, Record<string, unknown>>,
          required: ["label", "content"]
        }),
        execute: async ({
          label,
          content,
          metadata,
          action
        }: {
          label: string;
          content: string;
          metadata?: { title?: string; description?: string };
          action?: string;
        }) => {
          try {
            const block = this.blocks.get(label);
            if (!block) return `Error: block "${label}" not found`;

            if (block.isSearchable) {
              const key = contextEntryKey(metadata?.title, content);
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

    // ── search_context ────────────────────────────────────────────

    if (hasSearch) {
      const searchLabels = this.getSearchLabels();

      toolSet.search_context = {
        description:
          "Search for information in a searchable context block. " +
          "ONLY these blocks are searchable: " +
          searchLabels.map((l) => `"${l}"`).join(", ") +
          ". Other blocks cannot be searched.",
        inputSchema: z.fromJSONSchema({
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
            if (!searchLabels.includes(label)) {
              return `Error: "${label}" is not searchable. Searchable blocks: ${searchLabels.join(", ")}`;
            }
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
