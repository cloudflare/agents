import type { UIMessage } from "ai";

/**
 * Utility to help migrate messages from AI SDK v4 format to v5 UIMessage format
 */

/**
 * Legacy message format from AI SDK v4
 */
export type LegacyMessage = {
  id?: string;
  role: string;
  content: string;
  [key: string]: unknown; // Allow additional properties
};

/**
 * Union type for messages that could be either format
 */
export type MigratableMessage = LegacyMessage | UIMessage;

/**
 * Checks if a message is already in the UIMessage format (has parts array)
 */
export function isUIMessage(message: unknown): message is UIMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "parts" in message &&
    Array.isArray((message as { parts: unknown }).parts)
  );
}

/**
 * Type guard to check if a message is in legacy format
 */
function isLegacyMessage(message: unknown): message is LegacyMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "content" in message &&
    typeof (message as { role: unknown }).role === "string" &&
    typeof (message as { content: unknown }).content === "string"
  );
}

/**
 * Migrates a single message from the old format to UIMessage format
 * @param message - Message in old or new format
 * @returns UIMessage in the new format
 */
export function migrateToUIMessage(message: MigratableMessage): UIMessage {
  // Already in new format
  if (isUIMessage(message)) {
    return message;
  }

  // Handle old format with role and content
  if (isLegacyMessage(message)) {
    const baseMessage = {
      id: message.id || crypto.randomUUID(),
      role: message.role,
      parts: [
        {
          type: "text" as const,
          text: message.content
        }
      ]
    };

    // Preserve any additional properties except id, role, and content
    const additionalProps = Object.fromEntries(
      Object.entries(message).filter(
        ([key]) => !["id", "role", "content"].includes(key)
      )
    );

    return { ...baseMessage, ...additionalProps } as UIMessage;
  }

  // This should not happen with proper typing, but throw an error for safety
  throw new Error(
    "Cannot migrate message: not a valid legacy or UI message format"
  );
}

/**
 * Migrates an array of messages to UIMessage format
 * @param messages - Array of messages in old or new format
 * @returns Array of UIMessages in the new format
 */
export function migrateMessagesToUIFormat(
  messages: MigratableMessage[]
): UIMessage[] {
  return messages.map(migrateToUIMessage);
}

/**
 * Checks if any messages in an array need migration
 * @param messages - Array of messages to check
 * @returns true if any messages are in the old format
 */
export function needsMigration(messages: unknown[]): boolean {
  return messages.some((message) => !isUIMessage(message));
}
