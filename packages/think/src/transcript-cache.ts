/**
 * Think's live in-memory view of the conversation (`this.messages`).
 *
 * Storage (Sessions) is the durable source of truth. The cache is refreshed
 * from it at safe boundaries and patched by the Sessions change feed between
 * them. Refreshes are bounded by `hydrationByteBudget`: an oversized
 * transcript hydrates as a recent window instead of exhausting the isolate's
 * memory (#1710).
 *
 * In memory only: the cached messages, the last hydration's measurements and
 * whether the cache covers the whole active path.
 */

import type { UIMessage } from "ai";

const encoder = new TextEncoder();

/**
 * A cached message's size in the unit the hydration budget is measured in:
 * UTF-8 bytes of its serialized form, not UTF-16 code units.
 *
 * @internal
 */
export function cachedMessageBytes(message: UIMessage): number {
  return encoder.encode(JSON.stringify(message)).byteLength;
}

/**
 * What the last budgeted refresh measured.
 *
 * @internal
 */
export interface HydrationResult {
  /** `true` when the cache is a recent window of a larger transcript. */
  truncated: boolean;
  totalContentBytes: number;
  hydratedMessages: number;
}

/**
 * What a {@link ThinkTranscriptCache} reads from its agent.
 *
 * @internal
 */
export interface TranscriptCacheHost {
  /** The agent's `hydrationByteBudget`. Non-finite or non-positive: no budget. */
  budget(): number;
  /** The full active path, unbudgeted. */
  readAll(): Promise<UIMessage[]>;
  readRecent(budget: number): Promise<{
    messages: UIMessage[];
    truncated: boolean;
    totalContentBytes: number;
  }>;
  /** A windowed refresh measured something new. */
  emitWindowed(payload: {
    totalContentBytes: number;
    budgetBytes: number;
    hydratedMessages: number;
  }): void;
  /** Called after every successful refresh. */
  refreshed(): void;
}

/** @internal */
export class ThinkTranscriptCache {
  readonly #host: TranscriptCacheHost;

  /** The cached messages. */
  messages: UIMessage[] = [];

  /**
   * Result of the most recent refresh when the budget is active. `null`
   * when no budget applies or no refresh has run.
   */
  lastHydration: HydrationResult | null = null;

  /**
   * `true` while the cache holds every message on the active path. That is
   * the common case: the default budget admits whole transcripts, and the
   * Sessions change feed patches the cache after every durable write. Set by
   * {@link sync}; `false` when the last refresh was windowed, failed, or has
   * not run yet. Readers that need the complete path consult it to decide
   * whether the cache can answer or storage must be read.
   */
  coversActivePath = false;

  /**
   * Serialized bytes the cache has grown by since the last refresh. Once the
   * growth would carry the cache past the budget measured at that refresh,
   * the cache stops claiming to cover the path, so the next boundary re-reads
   * storage and re-windows (#1710).
   */
  #bytesSinceSync = 0;
  #warnedWindowed = false;
  /**
   * Snapshot of the last windowed emit, so a chronically oversized session
   * that syncs many times per turn emits on change, not on every sync.
   */
  #lastWindowedEmit: {
    totalContentBytes: number;
    hydratedMessages: number;
  } | null = null;

  constructor(host: TranscriptCacheHost) {
    this.#host = host;
  }

  /** Replace the cache with a durable storage snapshot. */
  replace(messages: UIMessage[]): UIMessage[] {
    this.messages = messages;
    return this.messages;
  }

  /** Charge `bytes` of growth since the last refresh against the budget. */
  noteGrowth(bytes: number): void {
    const budget = this.#host.budget();
    if (
      bytes <= 0 ||
      !Number.isFinite(budget) ||
      budget <= 0 ||
      !this.lastHydration
    ) {
      return;
    }
    this.#bytesSinceSync += bytes;
    if (this.lastHydration.totalContentBytes + this.#bytesSinceSync > budget) {
      this.coversActivePath = false;
    }
  }

  /**
   * Refresh the cache from durable storage at a safe boundary. The budget is
   * a hard ceiling with no message-count floor beneath it, so a window of
   * unusually large messages can be shorter than the model's recent window;
   * `getHistory()` still reads the full path.
   */
  async sync(): Promise<UIMessage[]> {
    // A refresh that throws leaves the cache unreliable until the next one.
    this.coversActivePath = false;
    this.#bytesSinceSync = 0;
    const budget = this.#host.budget();
    if (!Number.isFinite(budget) || budget <= 0) {
      this.lastHydration = null;
      this.#lastWindowedEmit = null;
      const full = this.replace(await this.#host.readAll());
      this.coversActivePath = true;
      this.#host.refreshed();
      return full;
    }

    const recent = await this.#host.readRecent(budget);
    this.lastHydration = {
      truncated: recent.truncated,
      totalContentBytes: recent.totalContentBytes,
      hydratedMessages: recent.messages.length
    };
    if (recent.truncated) {
      if (!this.#warnedWindowed) {
        this.#warnedWindowed = true;
        console.warn(
          `[Think] Stored transcript (${recent.totalContentBytes} bytes) ` +
            `exceeds hydrationByteBudget (${budget} bytes); hydrated the ` +
            `most recent ${recent.messages.length} message(s) instead of ` +
            "the full history. Durable storage is untouched. Compact the " +
            "session (or enable media eviction) to shrink it."
        );
      }
      const changed =
        this.#lastWindowedEmit === null ||
        this.#lastWindowedEmit.totalContentBytes !== recent.totalContentBytes ||
        this.#lastWindowedEmit.hydratedMessages !== recent.messages.length;
      if (changed) {
        this.#lastWindowedEmit = {
          totalContentBytes: recent.totalContentBytes,
          hydratedMessages: recent.messages.length
        };
        this.#host.emitWindowed({
          totalContentBytes: recent.totalContentBytes,
          budgetBytes: budget,
          hydratedMessages: recent.messages.length
        });
      }
    } else {
      this.#lastWindowedEmit = null;
    }
    const hydrated = this.replace(recent.messages);
    this.coversActivePath = !recent.truncated;
    this.#host.refreshed();
    return hydrated;
  }
}
