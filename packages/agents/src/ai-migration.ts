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
 * Corrupted message format - has content as array instead of parts
 * This is the specific corruption pattern: {role: "user", content: [{type: "text", text: "..."}]}
 */
export type CorruptArrayMessage = {
  id?: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  [key: string]: unknown; // Allow additional properties
};

/**
 * Union type for messages that could be in any format
 */
export type MigratableMessage = LegacyMessage | CorruptArrayMessage | UIMessage;

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
 * Type guard to check if a message is in legacy format (content as string)
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
 * Type guard to check if a message has corrupted array content format
 * Detects: {role: "user", content: [{type: "text", text: "..."}]}
 */
function isCorruptArrayMessage(
  message: unknown
): message is CorruptArrayMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "content" in message &&
    typeof (message as { role: unknown }).role === "string" &&
    Array.isArray((message as { content: unknown }).content) &&
    !("parts" in message) // Ensure it's not already a UIMessage
  );
}

/**
 * Migrates a single message from any format to UIMessage format
 * @param message - Message in old, corrupt, or new format
 * @returns UIMessage in the new format
 */
export function migrateToUIMessage(message: MigratableMessage): UIMessage {
  // Already in new format
  if (isUIMessage(message)) {
    return message;
  }

  // Handle corrupt array format: {role: "user", content: [{type: "text", text: "..."}]}
  if (isCorruptArrayMessage(message)) {
    const baseMessage = {
      id: message.id || crypto.randomUUID(),
      role: message.role,
      parts: message.content.map((item) => ({
        type: (item.type || "text") as "text", // Default to "text" if type is missing
        text: item.text || "" // Default to empty string if text is missing
      }))
    };

    // Preserve any additional properties except id, role, and content
    const additionalProps = Object.fromEntries(
      Object.entries(message).filter(
        ([key]) => !["id", "role", "content"].includes(key)
      )
    );

    return { ...baseMessage, ...additionalProps } as UIMessage;
  }

  // Handle legacy format with role and content as string
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

  // Fallback for completely malformed messages - create a safe default
  console.warn("Unknown message format, creating fallback message:", message);
  return {
    id: crypto.randomUUID(),
    role: "user", // Default to user role
    parts: [
      {
        type: "text" as const,
        text:
          typeof message === "object" && message !== null
            ? JSON.stringify(message)
            : String(message || "")
      }
    ]
  };
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
 * @returns true if any messages are not in proper UIMessage format
 */
export function needsMigration(messages: unknown[]): boolean {
  return messages.some((message) => {
    // If it's already a UIMessage, no migration needed
    if (isUIMessage(message)) {
      return false;
    }

    // Check for corrupt array format specifically
    if (isCorruptArrayMessage(message)) {
      return true;
    }

    // Check for legacy string format
    if (isLegacyMessage(message)) {
      return true;
    }

    // Any other format needs migration
    return true;
  });
}

/**
 * Analyzes the corruption types in a message array for debugging
 * @param messages - Array of messages to analyze
 * @returns Statistics about corruption types found
 */
export function analyzeCorruption(messages: unknown[]): {
  total: number;
  clean: number;
  legacyString: number;
  corruptArray: number;
  unknown: number;
  examples: {
    legacyString?: unknown;
    corruptArray?: unknown;
    unknown?: unknown;
  };
} {
  const stats = {
    total: messages.length,
    clean: 0,
    legacyString: 0,
    corruptArray: 0,
    unknown: 0,
    examples: {} as any
  };

  for (const message of messages) {
    if (isUIMessage(message)) {
      stats.clean++;
    } else if (isCorruptArrayMessage(message)) {
      stats.corruptArray++;
      if (!stats.examples.corruptArray) {
        stats.examples.corruptArray = message;
      }
    } else if (isLegacyMessage(message)) {
      stats.legacyString++;
      if (!stats.examples.legacyString) {
        stats.examples.legacyString = message;
      }
    } else {
      stats.unknown++;
      if (!stats.examples.unknown) {
        stats.examples.unknown = message;
      }
    }
  }

  return stats;
}
