import type { UIMessage } from "ai";

/**
 * AI SDK v5 Migration following https://jhak.im/blog/ai-sdk-migration-handling-previously-saved-messages
 * Using exact types from the official AI SDK documentation
 */

/**
 * AI SDK v5 Message Part types reference (from official AI SDK documentation)
 *
 * The migration logic below transforms legacy messages to match these official AI SDK v5 formats:
 * - TextUIPart: { type: "text", text: string, state?: "streaming" | "done" }
 * - ReasoningUIPart: { type: "reasoning", text: string, state?: "streaming" | "done", providerMetadata?: Record<string, unknown> }
 * - FileUIPart: { type: "file", mediaType: string, filename?: string, url: string }
 * - ToolUIPart: { type: `tool-${string}`, toolCallId: string, state: "input-streaming" | "input-available" | "output-available" | "output-error", input?: Record<string, unknown>, output?: unknown, errorText?: string, providerExecuted?: boolean }
 */

/**
 * Tool invocation from v4 format
 */
type ToolInvocation = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  state: "partial-call" | "call" | "result" | "error";
};

/**
 * Legacy part from v4 format
 */
type LegacyPart = {
  type: string;
  text?: string;
  url?: string;
  data?: string;
  mimeType?: string;
  mediaType?: string;
  filename?: string;
};

/**
 * Legacy message format from AI SDK v4
 */
export type LegacyMessage = {
  id?: string;
  role: string;
  content: string;
  reasoning?: string;
  toolInvocations?: ToolInvocation[];
  parts?: LegacyPart[];
  [key: string]: unknown;
};

/**
 * Corrupt content item
 */
type CorruptContentItem = {
  type: string;
  text: string;
};

/**
 * Corrupted message format - has content as array instead of parts
 */
export type CorruptArrayMessage = {
  id?: string;
  role: string;
  content: CorruptContentItem[];
  reasoning?: string;
  toolInvocations?: ToolInvocation[];
  [key: string]: unknown;
};

/**
 * Union type for messages that could be in any format
 */
export type MigratableMessage = LegacyMessage | CorruptArrayMessage | UIMessage;

/**
 * Tool call state mapping for v4 to v5 migration
 */
const STATE_MAP = {
  "partial-call": "input-streaming",
  call: "input-available",
  result: "output-available",
  error: "output-error"
} as const;

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
 * Internal message part type for transformation
 */
type TransformMessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  state?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  url?: string;
  mediaType?: string;
  errorText?: string;
  filename?: string;
};

/**
 * Input message that could be in any format - using unknown for flexibility
 */
type InputMessage = {
  id?: string;
  role?: string;
  content?: unknown;
  reasoning?: string;
  toolInvocations?: unknown[];
  parts?: unknown[];
  [key: string]: unknown;
};

/**
 * Automatic message transformer following the blog post pattern
 * Handles comprehensive migration from AI SDK v4 to v5 format
 * @param message - Message in any legacy format
 * @param index - Index for ID generation fallback
 * @returns UIMessage in v5 format
 */
export function autoTransformMessage(
  message: InputMessage,
  index = 0
): UIMessage {
  // Already in v5 format
  if (isUIMessage(message)) {
    return message;
  }

  const parts: TransformMessagePart[] = [];

  // Handle reasoning transformation
  if (message.reasoning) {
    parts.push({
      type: "reasoning",
      text: message.reasoning
    });
  }

  // Handle tool invocations transformation
  if (message.toolInvocations && Array.isArray(message.toolInvocations)) {
    message.toolInvocations.forEach((inv: unknown) => {
      if (typeof inv === "object" && inv !== null && "toolName" in inv) {
        const invObj = inv as ToolInvocation;
        parts.push({
          type: `tool-${invObj.toolName}`,
          toolCallId: invObj.toolCallId,
          state:
            STATE_MAP[invObj.state as keyof typeof STATE_MAP] ||
            "input-available",
          input: invObj.args,
          output: invObj.result !== undefined ? invObj.result : null
        });
      }
    });
  }

  // Handle file parts transformation
  if (message.parts && Array.isArray(message.parts)) {
    message.parts.forEach((part: unknown) => {
      if (typeof part === "object" && part !== null && "type" in part) {
        const partObj = part as LegacyPart;
        if (partObj.type === "file") {
          parts.push({
            type: "file",
            url:
              partObj.url ||
              (partObj.data
                ? `data:${partObj.mimeType || partObj.mediaType};base64,${partObj.data}`
                : undefined),
            mediaType: partObj.mediaType || partObj.mimeType,
            filename: partObj.filename
          });
        }
      }
    });
  }

  // Handle corrupt array format: {role: "user", content: [{type: "text", text: "..."}]}
  if (Array.isArray(message.content)) {
    message.content.forEach((item: unknown) => {
      if (typeof item === "object" && item !== null && "text" in item) {
        const itemObj = item as CorruptContentItem;
        parts.push({
          type: itemObj.type || "text",
          text: itemObj.text || ""
        });
      }
    });
  }

  // Fallback: convert plain content to text part
  if (!parts.length && message.content !== undefined) {
    parts.push({
      type: "text",
      text:
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
    });
  }

  // If still no parts, create a default text part
  if (!parts.length) {
    parts.push({
      type: "text",
      text: typeof message === "string" ? message : JSON.stringify(message)
    });
  }

  return {
    id: message.id || `msg-${index}`,
    role:
      message.role === "data"
        ? "system"
        : (message.role as "user" | "assistant" | "system") || "user",
    parts: parts as UIMessage["parts"]
  };
}

/**
 * Legacy single message migration for backward compatibility
 */
export function migrateToUIMessage(message: MigratableMessage): UIMessage {
  return autoTransformMessage(message as InputMessage);
}

/**
 * Automatic message transformer for arrays following the blog post pattern
 * @param messages - Array of messages in any format
 * @returns Array of UIMessages in v5 format
 */
export function autoTransformMessages(messages: unknown[]): UIMessage[] {
  return messages.map((msg, i) => autoTransformMessage(msg as InputMessage, i));
}

/**
 * Migrates an array of messages to UIMessage format (legacy compatibility)
 * @param messages - Array of messages in old or new format
 * @returns Array of UIMessages in the new format
 */
export function migrateMessagesToUIFormat(
  messages: MigratableMessage[]
): UIMessage[] {
  return autoTransformMessages(messages as InputMessage[]);
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
    examples: {} as {
      legacyString?: unknown;
      corruptArray?: unknown;
      unknown?: unknown;
    }
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
