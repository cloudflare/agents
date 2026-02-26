/**
 * Context — top-level API for persistent key-value context blocks.
 *
 * Wraps any ContextProvider (pure storage) and adds:
 * - readonly enforcement
 * - maxTokens enforcement via token estimation
 * - computed `tokens` field on read
 * - predefined block initialization
 * - AI tool integration via tools()
 * - System prompt rendering via toString()
 */

import { jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { ContextProvider } from "./provider";
import type {
  ContextBlock,
  StoredBlock,
  ContextOptions,
  SetBlockOptions,
  BlockDefinition
} from "./types";
import { estimateStringTokens } from "../utils/tokens";

export class Context {
  private storage: ContextProvider;
  private blockDefinitions: Map<string, BlockDefinition>;
  private defaultsInitialized = false;

  constructor(storage: ContextProvider, options?: ContextOptions) {
    this.storage = storage;
    this.blockDefinitions = new Map();

    if (options?.blocks) {
      for (const def of options.blocks) {
        this.blockDefinitions.set(def.label, def);
      }
    }
  }

  // ── Read ───────────────────────────────────────────────────────────

  getBlocks(): Record<string, ContextBlock> {
    this.ensureDefaults();

    const stored = this.storage.getBlocks();
    const result: Record<string, ContextBlock> = {};
    for (const [label, block] of Object.entries(stored)) {
      result[label] = this.addTokens(block);
    }
    return result;
  }

  getBlock(label: string): ContextBlock | null {
    this.ensureDefaults();

    const stored = this.storage.getBlock(label);
    return stored ? this.addTokens(stored) : null;
  }

  // ── Write ──────────────────────────────────────────────────────────

  setBlock(
    label: string,
    content: string,
    options?: SetBlockOptions
  ): ContextBlock {
    this.ensureDefaults();
    this.assertWritable(label);

    const maxTokens = this.resolveMaxTokens(label, options?.maxTokens);
    if (maxTokens !== undefined) {
      const tokens = estimateStringTokens(content);
      if (tokens > maxTokens) {
        throw new Error(
          `Content exceeds maxTokens for block "${label}": ${tokens} estimated tokens > ${maxTokens} max`
        );
      }
    }

    const def = this.blockDefinitions.get(label);
    const existing = this.storage.getBlock(label);

    this.storage.setBlock(label, content, {
      description:
        options?.description ?? existing?.description ?? def?.description,
      maxTokens: maxTokens ?? existing?.maxTokens ?? def?.maxTokens,
      readonly: existing?.readonly ?? def?.readonly
    });

    return this.addTokens(this.storage.getBlock(label)!);
  }

  appendToBlock(label: string, content: string): ContextBlock {
    this.ensureDefaults();
    this.assertWritable(label);

    const existing = this.storage.getBlock(label);
    if (!existing) {
      throw new Error(`Block "${label}" does not exist`);
    }

    const newContent = existing.content + content;
    const maxTokens = this.resolveMaxTokens(label);

    if (maxTokens !== undefined) {
      const tokens = estimateStringTokens(newContent);
      if (tokens > maxTokens) {
        throw new Error(
          `Content exceeds maxTokens for block "${label}": ${tokens} estimated tokens > ${maxTokens} max`
        );
      }
    }

    this.storage.setBlock(label, newContent, {
      description: existing.description,
      maxTokens: existing.maxTokens,
      readonly: existing.readonly
    });

    return this.addTokens(this.storage.getBlock(label)!);
  }

  deleteBlock(label: string): void {
    this.ensureDefaults();
    this.storage.deleteBlock(label);
  }

  clearBlocks(): void {
    this.storage.clearBlocks();
    this.defaultsInitialized = false;
  }

  // ── AI Tool Integration ────────────────────────────────────────────

  tools(): ToolSet {
    const blocks = this.getBlocks();
    const writable = Object.values(blocks).filter((b) => !b.readonly);
    const blockList = writable
      .map((b) => `- "${b.label}": ${b.description ?? "no description"}`)
      .join("\n");

    return {
      update_context_block: {
        description: `Update a context block. Writable blocks:\n${blockList}`,
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Block label to update"
            },
            content: {
              type: "string",
              description: "New full content for the block"
            }
          },
          required: ["label", "content"]
        }),
        execute: async ({
          label,
          content
        }: {
          label: string;
          content: string;
        }) => {
          return this.setBlock(label, content);
        }
      }
    };
  }

  // ── System Prompt Rendering ────────────────────────────────────────

  toString(): string {
    const blocks = this.getBlocks();
    const entries = Object.values(blocks);
    if (entries.length === 0) return "";

    return entries
      .map((b) => {
        const attrs = [`label="${b.label}"`];
        if (b.description) attrs.push(`description="${b.description}"`);
        if (b.readonly) attrs.push('readonly="true"');
        return `<context_block ${attrs.join(" ")}>\n${b.content}\n</context_block>`;
      })
      .join("\n\n");
  }

  // ── Private helpers ────────────────────────────────────────────────

  private ensureDefaults(): void {
    if (this.defaultsInitialized) return;
    this.defaultsInitialized = true;

    for (const def of this.blockDefinitions.values()) {
      const existing = this.storage.getBlock(def.label);
      if (!existing) {
        this.storage.setBlock(def.label, def.defaultContent ?? "", {
          description: def.description,
          maxTokens: def.maxTokens,
          readonly: def.readonly
        });
      }
    }
  }

  private addTokens(block: StoredBlock): ContextBlock {
    return {
      ...block,
      tokens: estimateStringTokens(block.content)
    };
  }

  private assertWritable(label: string): void {
    const def = this.blockDefinitions.get(label);
    if (def?.readonly) {
      throw new Error(`Block "${label}" is readonly`);
    }

    const existing = this.storage.getBlock(label);
    if (existing?.readonly) {
      throw new Error(`Block "${label}" is readonly`);
    }
  }

  private resolveMaxTokens(
    label: string,
    fromOptions?: number
  ): number | undefined {
    if (fromOptions !== undefined) return fromOptions;

    const def = this.blockDefinitions.get(label);
    if (def?.maxTokens !== undefined) return def.maxTokens;

    const existing = this.storage.getBlock(label);
    if (existing?.maxTokens !== undefined) return existing.maxTokens;

    return undefined;
  }
}
