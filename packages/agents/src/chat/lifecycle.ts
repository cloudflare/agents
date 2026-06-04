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
 * - `"error"` — the turn ran but ended with a stream error. Partial chunks
 *   streamed before the error are still persisted.
 */
export type SaveMessagesResult = {
  /** Server-generated request ID for the chat turn. */
  requestId: string;
  /** Whether the turn completed, errored, was skipped, or was aborted. */
  status: "completed" | "error" | "skipped" | "aborted";
  /** Error message when `status` is `"error"`. */
  error?: string;
};

/**
 * Context passed to the `onChatRecovery` hook when an interrupted chat
 * stream is detected after DO restart.
 */
export type ChatRecoveryContext = {
  /** Stable identifier for this recovery incident. */
  incidentId: string;
  /**
   * Stable request ID for the whole continuation chain (the recovery "root").
   * Unlike `requestId` — which changes on every chained continuation — this is
   * constant for the lifetime of the incident, so it's the right key for
   * per-incident budget tracking or fresh-incident detection without
   * re-deriving identity from message IDs.
   */
  recoveryRootRequestId: string;
  /** Attempt number for this recovery incident, starting at 1. */
  attempt: number;
  /** Maximum attempts before the framework terminalizes recovery. */
  maxAttempts: number;
  /** Whether this recovery is retrying an unanswered user turn or continuing a partial assistant turn. */
  recoveryKind: "retry" | "continue";
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
 * Context passed when framework-owned chat recovery exhausts its retry budget.
 *
 * Carries enough to render/persist a user-facing terminal banner without
 * re-deriving anything: the `terminalMessage` that was shown, the
 * `recoveryRootRequestId` (stable incident identity), and the partial the turn
 * produced before it was given up on.
 */
export type ChatRecoveryExhaustedContext = Pick<
  ChatRecoveryContext,
  | "incidentId"
  | "requestId"
  | "recoveryRootRequestId"
  | "attempt"
  | "maxAttempts"
  | "recoveryKind"
  | "streamId"
  | "createdAt"
  | "partialText"
  | "partialParts"
> & {
  /**
   * Why recovery stopped. One of:
   * - `max_attempts_exceeded` — the per-incident attempt budget was spent.
   * - `no_progress_timeout` — no forward progress within the no-progress window.
   * - `work_budget_exceeded` — the turn kept producing content but exceeded the
   *   configured `maxRecoveryWork` runaway-loop budget.
   * - `recovery_aborted` — the caller's `shouldKeepRecovering` hook returned `false`.
   * - `stable_timeout` — a recovery attempt kept timing out waiting for the
   *   isolate to reach stable state until the budget drained (extreme churn).
   * - `max_recovery_window_exceeded` — DEPRECATED. The old absolute incident-age
   *   ceiling. No longer emitted (a progressing turn is no longer bounded by
   *   wall-clock); retained only for back-compat with persisted incidents.
   *
   * Treat this as an open string: new reasons may be added.
   */
  reason: string;
  /** The terminal message shown to the user (from the `chatRecovery` config). */
  terminalMessage: string;
};

/**
 * Context passed to the `shouldKeepRecovering` recovery predicate on each
 * attempt. Lets an integrator impose a runaway-loop guard expressed as their
 * own budget (steps / tool-calls / tokens / cost) rather than wall-clock
 * duration. `ctx.work` is the SDK's coarse progress signal; map it (or your own
 * accounting) onto whatever budget you enforce.
 */
export type ChatRecoveryProgressContext = {
  incidentId: string;
  requestId: string;
  recoveryRootRequestId: string;
  attempt: number;
  maxAttempts: number;
  recoveryKind: "retry" | "continue";
  /**
   * Recovery work units produced since this incident began — a durable,
   * monotonic, reconnect-immune count of produced content/tool segments (not
   * tokens). The signal that distinguishes a healthy long turn from a runaway
   * loop.
   */
  work: number;
  /** Wall-clock ms since the incident's first interruption. */
  ageMs: number;
};

/**
 * Configuration for durable chat recovery. `true` uses these defaults:
 * `maxAttempts: 10`, `stableTimeoutMs: 10_000`, `noProgressTimeoutMs: 300_000`
 * (5 min), `maxRecoveryWork: Infinity`, and a generic terminal message.
 */
export type ChatRecoveryConfig =
  | boolean
  | {
      maxAttempts?: number;
      stableTimeoutMs?: number;
      terminalMessage?: string;
      /**
       * How long an incident may go WITHOUT forward progress before it is
       * sealed with `reason="no_progress_timeout"`. This is the primary
       * stuck-turn bound. It **resets on every progress-bearing attempt**, so a
       * turn that keeps producing content survives unbounded interruption while
       * a genuinely idle turn is sealed within the window. Defaults to 5 min.
       */
      noProgressTimeoutMs?: number;
      /**
       * Runaway-loop guard. Maximum recovery WORK — produced content/tool units
       * since the incident began — before a still-progressing turn is sealed
       * with `reason="work_budget_exceeded"`. Defaults to `Infinity` (no cap):
       * the SDK never terminates a progressing turn on its own. Set a finite
       * value (or use `shouldKeepRecovering`) to bound a loop that keeps
       * emitting content but never converges.
       */
      maxRecoveryWork?: number;
      /**
       * Caller policy consulted on each recovery attempt from the second
       * onward — it is NOT called on the first detection (the attempt that
       * opens the incident), and not at all once a hard bound (no-progress
       * timeout, attempt cap, or `maxRecoveryWork`) has already sealed the
       * incident. Return `false` to stop recovery with
       * `reason="recovery_aborted"`; return `true` (or omit the hook) to keep
       * recovering. A throwing hook is logged and treated as "keep recovering"
       * so a buggy predicate cannot wedge a turn.
       *
       * This is the hook point for a token/cost/step budget, but note
       * `ctx.work` is a coarse count of produced content/tool segments, not
       * tokens — track real token/cost yourself (keyed by
       * `ctx.recoveryRootRequestId`) and consult it here.
       */
      shouldKeepRecovering?(
        ctx: ChatRecoveryProgressContext
      ): boolean | Promise<boolean>;
      onExhausted?(ctx: ChatRecoveryExhaustedContext): void | Promise<void>;
    };

export type ResolvedChatRecoveryConfig = {
  enabled: boolean;
  maxAttempts: number;
  stableTimeoutMs: number;
  terminalMessage: string;
  noProgressTimeoutMs: number;
  maxRecoveryWork: number;
  shouldKeepRecovering?: (
    ctx: ChatRecoveryProgressContext
  ) => boolean | Promise<boolean>;
  onExhausted?: (ctx: ChatRecoveryExhaustedContext) => void | Promise<void>;
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
