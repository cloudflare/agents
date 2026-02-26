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
	CompactResult,
} from "./types";
import {
	parseMicroCompactionRules,
	microCompact,
	type ResolvedMicroCompactionRules,
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

	count(): number {
		return this.storage.count();
	}

	// ── Write (delegated + compaction) ─────────────────────────────────

	async append(messages: UIMessage | UIMessage[]): Promise<void> {
		// 1. Storage inserts
		await this.storage.append(messages);

		// 2. MicroCompaction on older messages
		if (this.microCompactionRules) {
			const rules = this.microCompactionRules;
			const older = this.storage.getOlderMessages(rules.keepRecent);

			if (older.length > 0) {
				const compacted = microCompact(older, rules);
				for (let i = 0; i < older.length; i++) {
					if (compacted[i] !== older[i]) {
						this.storage.update(compacted[i]);
					}
				}
			}
		}

		// 3. Full compaction if token threshold exceeded (fast heuristic check first)
		if (this.shouldAutoCompactFast()) {
			await this.compact();
		}
	}

	update(message: UIMessage): void {
		this.storage.update(message);
	}

	delete(messageIds: string[]): void {
		this.storage.delete(messageIds);
	}

	clear(): void {
		this.storage.clear();
	}

	// ── Compaction ─────────────────────────────────────────────────────

	async compact(): Promise<CompactResult> {
		const messages = this.storage.getMessages();

		if (messages.length === 0) {
			return { success: true };
		}

		try {
			let result = messages;

			// Run microCompaction first (if enabled) — skip recent messages
			if (this.microCompactionRules) {
				const rules = this.microCompactionRules;
				result = result.map((msg, i) => {
					const isRecent = i >= result.length - rules.keepRecent;
					if (isRecent) return msg;
					return microCompact([msg], rules)[0];
				});
			}

			// Then run custom fn if provided
			if (this.compactionConfig?.fn) {
				result = await this.compactionConfig.fn(result);
			}

			// Replace all messages
			await this.storage.replace(result);

			return { success: true };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Fast pre-check for auto-compaction using character-count heuristic.
	 * Avoids parsing all messages when token threshold is clearly not met.
	 */
	private shouldAutoCompactFast(): boolean {
		if (!this.compactionConfig?.tokenThreshold) return false;

		const messages = this.storage.getMessages();
		const approxTokens = estimateMessageTokens(messages);
		return approxTokens > this.compactionConfig.tokenThreshold;
	}
}
