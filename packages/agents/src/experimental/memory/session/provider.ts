/**
 * Session Provider Interface
 *
 * Interface that all session memory providers must implement.
 */

import type { AIMessage, MessageQueryOptions } from "./types";

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
   * Append one or more messages
   */
  append(messages: AIMessage | AIMessage[]): void;

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
}
