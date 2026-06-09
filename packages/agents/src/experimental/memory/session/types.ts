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
   * Usually unnecessary: when assistant messages carry model-reported usage
   * in their metadata (`metadata.usage` / `metadata.totalUsage`), the Session
   * uses it automatically — last reported usage plus a heuristic for newer
   * messages. Without usage metadata the default is a Workers-safe heuristic
   * over message parts plus the Session-managed frozen system prompt.
   *
   * The counter is whole-prompt scoped by signature; ignoring the input and
   * returning a model-reported total (e.g. `() => lastUsage.inputTokens`) is
   * legal — the boundary logic auto-calibrates around it.
   */
  tokenCounter?: SessionTokenCounter;
}

/**
 * Context the Session passes to the registered compaction function. Lets the
 * same authoritative token accounting drive BOTH the "should we compact?"
 * (`compactAfter`) and "what should we compact?" (boundary) decisions, so the
 * two never disagree — compaction can't fire every turn yet silently no-op
 * because the boundary logic used a different (under-counting) estimate.
 */
export interface CompactContext {
  /**
   * Best-known size of the current context in model tokens — from the
   * `compactAfter()` counter if configured, otherwise from usage metadata on
   * assistant messages (last reported usage plus the heuristic for newer
   * messages). Undefined when only the heuristic is available. The boundary
   * walk uses it to calibrate the built-in heuristic to the model's scale.
   */
  contextTokens?: number;
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
  /**
   * Arbitrary message metadata (AI SDK `UIMessage.metadata` is structurally
   * compatible). When an assistant message carries model-reported usage here
   * (`metadata.usage` or `metadata.totalUsage`, e.g. from the AI SDK's
   * `messageMetadata` callback), the Session uses it for token accounting —
   * no `tokenCounter` configuration needed.
   */
  metadata?: unknown;
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
