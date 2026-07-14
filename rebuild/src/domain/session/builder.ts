import type { CompactionConfig } from "./compaction.js";
import type { ContextBlockConfig, ContextProviderLike } from "./session.js";

/**
 * SessionBuilder (audit 23 "configureSession(builder)"; moved out of app/
 * per audit 26 extraction 6 — this is domain logic, not app composition).
 */
export interface SessionBuilder {
  withContext(
    label: string,
    opts?: { description?: string; maxTokens?: number; provider?: ContextProviderLike },
  ): SessionBuilder;
  /** Marks the base instructions block with a token budget; content still comes from getSystemPrompt(). */
  withCachedPrompt(opts?: { maxTokens?: number }): SessionBuilder;
  onCompaction(summarize: (prompt: string) => Promise<string>, opts?: Omit<CompactionConfig, "summarize">): SessionBuilder;
  compactAfter(tokens: number): SessionBuilder;
}

export class SessionBuilderImpl implements SessionBuilder {
  readonly extraBlocks: ContextBlockConfig[] = [];
  baseMaxTokens: number | undefined;
  compaction: CompactionConfig | undefined;

  withContext(label: string, opts?: { description?: string; maxTokens?: number; provider?: ContextProviderLike }): SessionBuilder {
    const block: ContextBlockConfig = { label };
    if (opts?.description !== undefined) block.description = opts.description;
    if (opts?.maxTokens !== undefined) block.maxTokens = opts.maxTokens;
    if (opts?.provider !== undefined) block.provider = opts.provider;
    this.extraBlocks.push(block);
    return this;
  }

  withCachedPrompt(opts?: { maxTokens?: number }): SessionBuilder {
    this.baseMaxTokens = opts?.maxTokens;
    return this;
  }

  onCompaction(summarize: (prompt: string) => Promise<string>, opts?: Omit<CompactionConfig, "summarize">): SessionBuilder {
    this.compaction = { ...(opts ?? {}), summarize };
    return this;
  }

  compactAfter(tokens: number): SessionBuilder {
    const base = this.compaction ?? { summarize: async (prompt: string) => prompt };
    this.compaction = { ...base, compactAfterTokens: tokens };
    return this;
  }
}
