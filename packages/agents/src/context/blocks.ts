/**
 * Context Block Management
 *
 * Persistent key-value blocks (MEMORY, USER, SOUL, etc.) that are:
 * - Loaded from their providers at init
 * - Frozen into a snapshot when toSystemPrompt() is called
 * - Updated via setBlock() which writes to the provider immediately
 *   but does NOT update the frozen snapshot (preserves LLM prefix cache)
 * - Re-snapshotted on next toSystemPrompt() call
 * - Reported by reminder(), when declared `whenChanged: "remind"`, while
 *   their current value differs from the frozen snapshot
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

const SECTION_RULE = "═".repeat(46);

const REMINDER_PREAMBLE =
  "These context blocks changed after the system prompt was written. " +
  "Their current values below replace the ones in the system prompt.";

/**
 * Empty readonly blocks are left out of the prompt. Writable and searchable
 * blocks always render so the model knows which tools can address them.
 * Remind blocks always render so `promptRendersBlock` can match them exactly:
 * an absent section cannot be told apart from another label's by prefix.
 */
function rendersInPrompt(block: ContextBlock, remind: boolean): boolean {
  return !!block.content || block.writable || block.isSearchable || remind;
}

function renderSection(block: ContextBlock): string {
  let header = block.label.toUpperCase();
  if (block.description) header += ` (${block.description})`;
  if (block.maxTokens) {
    const pct = Math.round((block.tokens / block.maxTokens) * 100);
    header += ` [${pct}% — ${block.tokens}/${block.maxTokens} tokens]`;
  }
  if (block.isSearchable) header += " [searchable]";
  else if (!block.writable) header += " [readonly]";
  else header += " [writable]";
  return `${SECTION_RULE}\n${header}\n${SECTION_RULE}\n${block.content}`;
}

/**
 * Whether `prompt` renders `block` exactly as it stands now. Sections are
 * joined by a blank line and each opens with a rule, so padding the prompt
 * with a blank line in front and a rule behind lets one containment test
 * pin both ends of a section: content that only grew or shrank at the
 * edges does not pass for unchanged.
 */
function promptRendersBlock(prompt: string, block: ContextBlock): boolean {
  const padded = `\n\n${prompt}\n\n${SECTION_RULE}\n`;
  return padded.includes(`\n\n${renderSection(block)}\n\n${SECTION_RULE}\n`);
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
  /**
   * What the model sees when this block's value moves on after the system
   * prompt was frozen.
   *
   * - `"wait"` (default): nothing, until `refreshSystemPrompt()` rebuilds
   *   the prompt.
   * - `"remind"`: `reminder()` re-reads the block and, while it differs from
   *   the frozen prompt, returns its current value for the host to send
   *   after the cached prefix. The frozen prompt, and the provider's prefix
   *   cache, stay intact until `refreshSystemPrompt()` promotes the value.
   *   The block renders in the prompt even when empty.
   *
   * A change is any difference in what the provider returns, so return only
   * what should count: a date rather than a timestamp.
   */
  whenChanged?: "wait" | "remind";
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

  /**
   * Load all blocks from their providers. Hosts call this once at startup;
   * every other entry point loads lazily.
   */
  async load(): Promise<void> {
    this.configs = this.configs.map((config) =>
      this.withDefaultProvider(config)
    );
    for (const config of this.configs) {
      this.blocks.set(config.label, await this.loadBlock(config));
    }
    this.loaded = true;
  }

  /** Initialize a block's provider and read its current content. */
  private async loadBlock(config: ContextConfig): Promise<ContextBlock> {
    config.provider?.init?.(config.label);
    return this.readBlock(config);
  }

  private async readBlock(config: ContextConfig): Promise<ContextBlock> {
    const provider = config.provider;
    const content = provider ? ((await provider.get()) ?? "") : "";
    const searchable = isSearchProvider(provider);
    return {
      label: config.label,
      description: config.description,
      content,
      tokens: estimateStringTokens(content),
      maxTokens: config.maxTokens,
      writable: isWritableProvider(provider) || (searchable && !!provider?.set),
      isSearchable: searchable
    };
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
    const block = await this.loadBlock(config);
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

  /** Index a search entry within a searchable block. */
  private async setSearchEntry(
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

  /** Search a searchable block. */
  private async searchContext(
    label: string,
    query: string
  ): Promise<string | null> {
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

  private renderPrompt(): string {
    const remind = new Set(
      this.configs
        .filter((config) => config.whenChanged === "remind")
        .map((config) => config.label)
    );
    return Array.from(this.blocks.values())
      .filter((block) => rendersInPrompt(block, remind.has(block.label)))
      .map(renderSection)
      .join("\n\n");
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * The frozen system prompt. The first call renders the blocks and stores
   * the result; every later call returns that same string, so the model
   * provider's prefix cache stays warm. Block edits do not change it until
   * `refreshSystemPrompt()` is called.
   */
  async freezeSystemPrompt(): Promise<string> {
    if (this.promptStore) {
      const stored = await this.promptStore.get();
      if (stored !== null) return stored;
    }
    if (this.snapshot !== null) return this.snapshot;

    if (!this.loaded) await this.load();
    this.snapshot = this.renderPrompt();
    await this.promptStore?.set(this.snapshot);
    return this.snapshot;
  }

  /**
   * Reload every block from its provider, re-render the system prompt, and
   * persist it. Use this after block content has changed.
   */
  async refreshSystemPrompt(): Promise<string> {
    this.loaded = false;
    await this.load();
    this.snapshot = this.renderPrompt();
    await this.promptStore?.set(this.snapshot);
    return this.snapshot;
  }

  /**
   * Current values of the `whenChanged: "remind"` blocks that no longer
   * match the frozen prompt, rendered for the host to send after the cached
   * prefix: at the end of the conversation, not in the system prompt. `null`
   * when nothing has changed or nothing is frozen yet.
   *
   * Each call re-reads those blocks from their providers. The comparison is
   * against the frozen prompt itself, so it holds across restarts, and a
   * reminder keeps appearing on every call until `refreshSystemPrompt()`
   * folds the value in.
   */
  async reminder(): Promise<string | null> {
    if (!this.loaded) await this.load();
    const frozen = this.promptStore
      ? ((await this.promptStore.get()) ?? this.snapshot)
      : this.snapshot;
    if (frozen === null) return null;

    const sections: string[] = [];
    for (const config of this.configs) {
      if (config.whenChanged !== "remind") continue;
      const block = await this.readBlock(config);
      this.blocks.set(config.label, block);
      if (!promptRendersBlock(frozen, block)) {
        sections.push(renderSection(block));
      }
    }
    if (sections.length === 0) return null;
    return [REMINDER_PREAMBLE, ...sections].join("\n\n");
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

    const blocks = Array.from(this.blocks.values());
    const writable = blocks.filter((b) => b.writable);
    const searchLabels = blocks
      .filter((b) => b.isSearchable)
      .map((b) => b.label);
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

    if (searchLabels.length > 0) {
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
