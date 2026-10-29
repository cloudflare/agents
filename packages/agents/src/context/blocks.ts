/**
 * Context blocks: labelled sections of a system prompt (SOUL, MEMORY, and
 * so on), each backed by a provider, and the tools a model uses to write and
 * search them.
 *
 * Provider type determines behavior:
 * - ContextProvider (get only)        → readonly block in system prompt
 * - WritableContextProvider (get+set) → writable via set_context tool
 * - SearchProvider (get+search+set?)  → searchable via search_context tool
 *
 * Blocks hold no prompt state. `Context` binds them to a session, which
 * records the prompt each turn was sent with.
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

/** Name of the tool that writes a writable or searchable block. */
export const SET_CONTEXT_TOOL = "set_context";

/** Name of the tool that searches a searchable block. */
export const SEARCH_CONTEXT_TOOL = "search_context";

const SECTION_RULE = "═".repeat(46);

const REMINDER_PREAMBLE =
  "These context blocks changed after the system prompt was written. " +
  "Their current values below replace the ones in the system prompt.";

/**
 * Empty readonly blocks are left out of the prompt. Writable and searchable
 * blocks always render so the model knows which tools can address them.
 * Remind blocks always render, so a later change has a section to replace.
 */
function rendersInPrompt(block: ContextBlock, remind: boolean): boolean {
  return !!block.content || block.writable || block.isSearchable || remind;
}

/** The text that introduces changed blocks sent after the cached prefix. */
export function renderReminder(sections: readonly string[]): string {
  return [REMINDER_PREAMBLE, ...sections].join("\n\n");
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
   *  If omitted, the host's default provider supplies storage (with
   *  `Context`, writable SQLite). */
  provider?: ContextProvider | WritableContextProvider | SearchProvider;
  /**
   * What the model sees when this block's value moves on after the system
   * prompt was recorded (see `Context`).
   *
   * - `"wait"` (default): nothing, until a refresh records a new prompt.
   * - `"remind"`: the next turn delivers the new value after the cached
   *   prefix, next to that turn's user message, and records it there. The
   *   prompt, and the provider's prefix cache, stay intact. The block
   *   renders in the prompt even when empty.
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

/** Options for {@link ContextBlocks}. */
export interface ContextBlocksOptions {
  /**
   * Supplies storage for blocks declared without a provider, so a host can
   * offer durable writable blocks by label alone.
   */
  readonly defaultProvider?: (label: string) => ContextProvider;
}

/**
 * A set of context blocks: their current values, the sections they render
 * as, and the model's tools for them.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class ContextBlocks {
  private configs: ContextConfig[];
  private blocks = new Map<string, ContextBlock>();
  private loaded = false;
  private defaultProvider: ((label: string) => ContextProvider) | null;

  /** @param configs Blocks to load on first use. */
  constructor(configs: ContextConfig[], options: ContextBlocksOptions = {}) {
    this.configs = configs;
    this.defaultProvider = options.defaultProvider ?? null;
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
   * initialized and loaded immediately.
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
   * Set block content. Writes to the provider immediately.
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

  /**
   * @internal Every block's prompt section in declaration order, as
   * `[label, section]` pairs; a block left out of the prompt has an empty
   * section. Read from the loaded blocks.
   */
  async internal_sections(): Promise<Array<[string, string]>> {
    if (!this.loaded) await this.load();
    const remind = this.remindLabels();
    return Array.from(this.blocks.values(), (block) => [
      block.label,
      rendersInPrompt(block, remind.has(block.label))
        ? renderSection(block)
        : ""
    ]);
  }

  /**
   * @internal Re-read the `whenChanged: "remind"` blocks from their
   * providers and return their current sections.
   */
  async internal_remindSections(): Promise<Array<[string, string]>> {
    if (!this.loaded) await this.load();
    const sections: Array<[string, string]> = [];
    for (const config of this.configs) {
      if (config.whenChanged !== "remind") continue;
      const block = await this.readBlock(config);
      this.blocks.set(config.label, block);
      sections.push([config.label, renderSection(block)]);
    }
    return sections;
  }

  private remindLabels(): Set<string> {
    return new Set(
      this.configs
        .filter((config) => config.whenChanged === "remind")
        .map((config) => config.label)
    );
  }

  /**
   * The blocks rendered as a system prompt, from their loaded values.
   * Nothing is stored: a host that needs the prompt to stay the same across
   * turns keeps it, as `Context` does in the session.
   */
  async renderSystemPrompt(): Promise<string> {
    return (await this.internal_sections())
      .map(([, section]) => section)
      .filter((section) => section.length > 0)
      .join("\n\n");
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

      toolSet[SET_CONTEXT_TOOL] = {
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
      toolSet[SEARCH_CONTEXT_TOOL] = {
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
