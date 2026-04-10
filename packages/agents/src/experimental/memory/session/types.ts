/**
 * Session Types
 */

import type { ContextConfig, WritableContextProvider } from "./context";

/**
 * Minimal message part shape used by Session internals.
 * Vercel AI SDK's `UIMessagePart` is structurally compatible.
 */
export interface SessionMessagePart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  result?: unknown;
}

/**
 * Minimal message shape used by Session internals.
 * Vercel AI SDK's `UIMessage` is structurally compatible — you can pass
 * `UIMessage` objects directly without conversion.
 */
export interface SessionMessage {
  id: string;
  role: string;
  parts: SessionMessagePart[];
  createdAt?: Date;
}

/**
 * Options for creating a Session.
 */
export interface SessionOptions {
  /** Context blocks for the system prompt. */
  context?: ContextConfig[];

  /** Provider for persisting the frozen system prompt. */
  promptStore?: WritableContextProvider;
}
