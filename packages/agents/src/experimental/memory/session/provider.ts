/**
 * Session Provider Interface
 *
 * Pure storage interface that all session providers must implement.
 * Compaction orchestration lives in the Session wrapper, not here.
 */

import type { UIMessage } from "ai";
import type { MessageQueryOptions } from "./types";

/**
 * Session storage provider interface.
 *
 * Implement this interface to create custom session storage backends.
 * Providers handle CRUD only — compaction is orchestrated by the Session wrapper.
 */
export interface SessionProvider {
	/**
	 * Get messages with optional filtering
	 */
	getMessages(options?: MessageQueryOptions): UIMessage[];

	/**
	 * Get a single message by ID
	 */
	getMessage(id: string): UIMessage | null;

	/**
	 * Get the last N messages (most recent)
	 */
	getLastMessages(n: number): UIMessage[];

	/**
	 * Append one or more messages to storage.
	 */
	append(messages: UIMessage | UIMessage[]): Promise<void>;

	/**
	 * Update an existing message
	 */
	update(message: UIMessage): void;

	/**
	 * Delete messages by ID
	 */
	delete(messageIds: string[]): void;

	/**
	 * Clear all messages
	 */
	clear(): void;

	/**
	 * Get the count of messages
	 */
	count(): number;

	/**
	 * Fetch messages outside the recent window (for microCompaction).
	 * Returns all messages except the most recent `keepRecent`.
	 */
	getOlderMessages(keepRecent: number): UIMessage[];

	/**
	 * Bulk replace all messages (used by compact).
	 * Clears existing messages and inserts the new ones,
	 * preserving original created_at timestamps where possible.
	 */
	replace(messages: UIMessage[]): Promise<void>;
}
