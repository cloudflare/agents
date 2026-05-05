/**
 * Shared lifecycle/result types for chat agent base classes.
 *
 * `AIChatAgent` (in `@cloudflare/ai-chat`) and `Think` (in
 * `@cloudflare/think`) both surface the same result/context shapes on
 * their public hooks. Rather than duplicate the types in each package,
 * they live here in `agents/chat` and are re-exported by both.
 *
 * These are intentionally narrow — protocol constants, primitive
 * helpers, and stream machinery live in sibling modules. This file
 * contains only the types that appear on a chat agent's public API
 * surface.
 */

import type { UIMessage } from "ai";
import type { ClientToolSchema } from "./client-tools";
import type { MessagePart } from "./message-builder";

/**
 * Result passed to the `onChatResponse` lifecycle hook after a chat
 * turn completes.
 */
export type ChatResponseResult = {
  /** The finalized assistant message from this turn. */
  message: UIMessage;
  /** The request ID associated with this turn. */
  requestId: string;
  /** Whether this turn was a continuation of a previous assistant turn. */
  continuation: boolean;
  /** How the turn ended. */
  status: "completed" | "error" | "aborted";
  /** Error message when `status` is `"error"`. */
  error?: string;
};

/**
 * Options accepted by programmatic entry points that drive a chat turn
 * (`saveMessages`, `continueLastTurn`).
 */
export type SaveMessagesOptions = {
  /**
   * External `AbortSignal` for cancelling the turn from outside.
   *
   * When the signal aborts, the in-flight turn is cancelled exactly the
   * same way an internal `chat-request-cancel` WebSocket message would
   * cancel it: the inference loop's signal aborts, partially streamed
   * chunks are still persisted, and the resolved result reports
   * `status: "aborted"`. If the signal is already aborted when the
   * turn starts, no inference work is performed.
   *
   * Useful for bridging an external caller's abort intent into a turn
   * whose request id is generated server-side and not surfaced until
   * after completion — e.g. forwarding the AI SDK tool `execute`'s
   * `abortSignal` into a sub-agent's `saveMessages` call. See
   * [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406)
   * for the motivating use case.
   */
  signal?: AbortSignal;
};

/**
 * Result returned by programmatic entry points.
 *
 * - `"completed"` — the turn ran to completion.
 * - `"skipped"` — the turn was invalidated mid-flight, typically by a
 *   `CHAT_CLEAR` protocol message that bumped the turn-queue
 *   generation.
 * - `"aborted"` — the turn started but was cancelled before
 *   completion, either by `MSG_CHAT_CANCEL` over the chat WebSocket or
 *   by an external `AbortSignal` passed via {@link SaveMessagesOptions}.
 *   Partial chunks streamed before the abort are still persisted.
 */
export type SaveMessagesResult = {
  /** Server-generated request ID for the chat turn. */
  requestId: string;
  /** Whether the turn ran, was skipped, or was aborted. */
  status: "completed" | "skipped" | "aborted";
};

/**
 * Context passed to the `onChatRecovery` hook when an interrupted chat
 * stream is detected after DO restart.
 */
export type ChatRecoveryContext = {
  /** Stream ID from the interrupted stream. */
  streamId: string;
  /** Request ID from the interrupted stream. */
  requestId: string;
  /** Partial text extracted from stored chunks. */
  partialText: string;
  /** Partial message parts reconstructed from chunks. */
  partialParts: MessagePart[];
  /** Checkpoint data from `this.stash()` during the interrupted stream. */
  recoveryData: unknown | null;
  /** Current persisted messages. */
  messages: UIMessage[];
  /** Custom body from the last chat request. */
  lastBody?: Record<string, unknown>;
  /** Client tool schemas from the last chat request. */
  lastClientTools?: ClientToolSchema[];
  /**
   * Epoch milliseconds when the underlying fiber was started. Compare
   * against `Date.now()` to suppress continuations for turns that have
   * been orphaned too long to safely replay.
   */
  createdAt: number;
};

/**
 * Options returned from `onChatRecovery` to control recovery behavior.
 */
export type ChatRecoveryOptions = {
  /** Save the partial response from stored chunks. Default: true. */
  persist?: boolean;
  /** Schedule a continuation via `continueLastTurn()`. Default: true. */
  continue?: boolean;
};

/**
 * Controls how overlapping user submit requests behave while another
 * chat turn is already active or queued.
 *
 * - `"queue"` (default) — queue every submit and process them in order.
 * - `"latest"` — keep only the latest overlapping submit; superseded
 *   submits still persist their user messages, but do not start their
 *   own model turn.
 * - `"merge"` — coalesce overlapping submits into one model turn while
 *   preserving the submitted user content. Exact persistence depends on
 *   the chat package's message model.
 * - `"drop"` — ignore overlapping submits entirely (messages not
 *   persisted).
 * - `{ strategy: "debounce", debounceMs? }` — trailing-edge latest with
 *   a quiet window.
 *
 * Only applies to `submit-message` requests. Regenerations, tool
 * continuations, approvals, clears, programmatic `saveMessages`, and
 * `continueLastTurn` keep their existing serialized behavior.
 */
export type MessageConcurrency =
  | "queue"
  | "latest"
  | "merge"
  | "drop"
  | { strategy: "debounce"; debounceMs?: number };
