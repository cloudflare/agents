/**
 * Session — top-level API for conversation history with compaction.
 *
 * Wraps any SessionProvider (pure storage) and orchestrates compaction:
 * - microCompaction on every append() — cheap, no LLM
 * - full compaction when token threshold exceeded — user-supplied fn
 */

import type { UIMessage } from "ai";
import type { SessionProvider } from "./provider";
import type {
  MessageQueryOptions,
  SessionProviderOptions,
  CompactResult
} from "./types";
import {
  parseMicroCompactionRules,
  microCompact,
  type ResolvedMicroCompactionRules
} from "../utils/compaction";
import { estimateMessageTokens } from "../utils/tokens";

export class Session {
  private storage: SessionProvider;
  private microCompactionRules: ResolvedMicroCompactionRules | null;
  private compactionConfig: SessionProviderOptions["compaction"] | null;

  constructor(storage: SessionProvider, options?: SessionProviderOptions) {
    this.storage = storage;

    const mc = options?.microCompaction ?? true;
    this.microCompactionRules = parseMicroCompactionRules(mc);
    this.compactionConfig = options?.compaction ?? null;
  }

  // ── Read (delegated to storage) ────────────────────────────────────

  getMessages(options?: MessageQueryOptions): UIMessage[] {
    return this.storage.getMessages(options);
  }

  getMessage(id: string): UIMessage | null {
    return this.storage.getMessage(id);
  }

  getLastMessages(n: number): UIMessage[] {
    return this.storage.getLastMessages(n);
  }

  // ── Write (delegated + compaction) ─────────────────────────────────

  async append(messages: UIMessage | UIMessage[]): Promise<void> {
    // 1. Storage inserts
    await this.storage.appendMessages(messages);

    // 2. Full compaction if token threshold exceeded — runs instead of microCompaction
    if (this.shouldAutoCompact()) {
      const result = await this.compact();
      if (result.success) return;
      // Fall through to microCompaction if full compaction failed
    }

    // 3. MicroCompaction on older messages (only if no full compaction)
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

  // ── Compaction ─────────────────────────────────────────────────────

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

  /**
   * Pre-check for auto-compaction using token estimate heuristic.
   */
  private shouldAutoCompact(): boolean {
    if (!this.compactionConfig?.tokenThreshold) return false;

    const messages = this.storage.getMessages();
    const approxTokens = estimateMessageTokens(messages);
    return approxTokens > this.compactionConfig.tokenThreshold;
  }
}
