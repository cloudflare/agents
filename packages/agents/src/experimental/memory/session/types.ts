/**
 * Session Types
 */

import type {
  ContextBlock,
  ContextConfig,
  WritableContextProvider
} from "./context";

/**
 * Minimal message part shape used by Session internals.
 * Vercel AI SDK's `UIMessagePart` is structurally compatible.
 */
export interface SessionMessagePart {
  type: string;
  text?: string;
  reasoning?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  result?: unknown;
}

export interface SessionTokenCounterInput {
  /** Messages returned by `session.getHistory()` for the active branch. */
  messages: SessionMessage[];

  /** Frozen system prompt managed by the Session context system. */
  systemPrompt: string;

  /** Loaded context blocks that were used to build `systemPrompt`. */
  contextBlocks: ContextBlock[];
}

export type SessionTokenCounter = (
  input: SessionTokenCounterInput
) => number | Promise<number>;

export interface CompactAfterOptions {
  /**
   * Override the token estimate used by auto-compaction and status broadcasts.
   *
   * The default is a Workers-safe heuristic over message parts plus the
   * Session-managed frozen system prompt. Callers that have model-reported
   * usage or a tokenizer can provide a more precise counter here.
   */
  tokenCounter?: SessionTokenCounter;
}

export type CompactionErrorHandler = (error: unknown) => void | Promise<void>;

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

  /** Custom token counter for auto-compaction/status estimates. */
  tokenCounter?: SessionTokenCounter;

  /** Called when automatic compaction fails after a threshold trigger. */
  onCompactionError?: CompactionErrorHandler;
}
