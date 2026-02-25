/**
 * Session Provider Interface
 *
 * Interface that all session memory providers must implement.
 */

import type { AIMessage, MessageQueryOptions, CompactResult } from "./types";

/**
 * Session provider interface for storing and retrieving AI messages.
 *
 * Implement this interface to create custom session storage backends.
 */
export interface SessionProvider {
  /**
   * Get messages with optional filtering
   */
  getMessages(options?: MessageQueryOptions): AIMessage[];

  /**
   * Get a single message by ID
   */
  getMessage(id: string): AIMessage | null;

  /**
   * Get the last N messages (most recent)
   */
  getLastMessages(n: number): AIMessage[];

  /**
   * Append one or more messages.
   * If compaction is configured and token threshold is exceeded,
   * compaction runs automatically.
   */
  append(messages: AIMessage | AIMessage[]): Promise<void>;

  /**
   * Update an existing message
   */
  update(message: AIMessage): void;

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
   * Manually trigger compaction.
   * Useful for error recovery (e.g., catching context full errors).
   */
  compact(): Promise<CompactResult>;
}
