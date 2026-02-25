/**
 * Session Memory Types
 *
 * Types for session memory API.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SerializableValue = any;

/**
 * AI SDK UIMessage format (compatible with @ai-sdk/ui-utils)
 */
export interface AIMessage {
  id: string;
  role: "user" | "assistant" | "system";
  parts: AIMessagePart[];
  metadata?: Record<string, SerializableValue>;
}

export type AIMessagePart =
  | { type: "text"; text: string; state?: "streaming" | "done" }
  | {
      type: "reasoning";
      text: string;
      providerMetadata?: Record<string, SerializableValue>;
    }
  | {
      type: "tool-invocation";
      toolCallId: string;
      toolName: string;
      args: SerializableValue;
      state: string;
      output?: SerializableValue;
    }
  | { type: "file"; mimeType: string; data: string }
  | { type: "source"; source: SerializableValue }
  | Record<string, SerializableValue>;

/**
 * Options for querying messages
 */
export interface MessageQueryOptions {
  /** Maximum number of messages to return */
  limit?: number;
  /** Number of messages to skip */
  offset?: number;
  /** Only return messages created before this timestamp */
  before?: Date;
  /** Only return messages created after this timestamp */
  after?: Date;
  /** Filter by role */
  role?: "user" | "assistant" | "system";
}
