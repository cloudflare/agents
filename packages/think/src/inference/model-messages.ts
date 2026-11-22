/**
 * How a turn's model request is built from the stored transcript: read-time
 * truncation, the provider-safe projection, the context reminder and the
 * continue checkpoint. Nothing here writes the transcript; every change
 * shapes only the request.
 */

import type { ModelMessage, ToolSet, UIMessage } from "ai";
import { convertToModelMessages } from "ai";
import {
  truncateOlderMessages,
  truncateOlderToolResults,
  type BeforeTurnRepairResult
} from "agents/chat";

/**
 * The shortest recent-message span the model sees at FULL fidelity each turn
 * (see `_assembleModelMessages` and {@link MODEL_TRUNCATION_STEP}).
 *
 * Both memory bounds are anchored to this window (#1710):
 * - budgeted hydration (`hydrationByteBudget`) is a hard byte ceiling, so a
 *   window of unusually large messages can be shorter than this; the model
 *   then sees what fits rather than exhausting isolate memory;
 * - media eviction never rewrites messages above the stepped truncation
 *   cutoff (see {@link mediaEvictionCutoff}), so the rows the model replays
 *   at full fidelity are never stripped.
 *
 * @internal
 */
export const MODEL_RECENT_WINDOW = 4;

/**
 * Default `truncationStep`. Read-time truncation cuts the history at a
 * multiple of this many messages,
 * so the full-fidelity span grows from `MODEL_RECENT_WINDOW` to
 * `MODEL_RECENT_WINDOW + MODEL_TRUNCATION_STEP - 1` messages between cuts.
 * Providers cache on a byte-identical prompt prefix, and a cutoff that moved
 * every turn rewrote a message near the end of that prefix on every turn
 * (#2200). Stepping it rewrites the prefix once per step instead.
 *
 * @internal
 */
export const MODEL_TRUNCATION_STEP = 8;

/**
 * `Infinity` never moves the cutoff; any other invalid step cuts every turn.
 *
 * @internal
 */
export function truncationStepSize(step: number): number {
  if (step === Number.POSITIVE_INFINITY) return step;
  return Number.isFinite(step) ? Math.max(1, Math.floor(step)) : 1;
}

/** @internal */
export function truncationKeepRecent(
  messageCount: number,
  step: number
): number {
  const safeStep = truncationStepSize(step);
  if (messageCount <= MODEL_RECENT_WINDOW) return MODEL_RECENT_WINDOW;
  if (safeStep === Number.POSITIVE_INFINITY) return messageCount;
  return (
    MODEL_RECENT_WINDOW + ((messageCount - MODEL_RECENT_WINDOW) % safeStep)
  );
}

/**
 * Index below which media eviction may rewrite messages: the stepped
 * truncation cutoff, moved back whole steps until at least
 * `keepRecentMessages` messages stay above it. It only moves when the
 * truncation cutoff does, so eviction rewrites the cached prompt prefix at
 * most once per step and never inside the full-fidelity window (#2356).
 * With stepping disabled (`truncationStep = Infinity`) there is no cutoff to
 * align with, and eviction keeps exactly `keepRecentMessages`.
 *
 * @internal
 */
export function mediaEvictionCutoff(
  messageCount: number,
  keepRecentMessages: number,
  step: number
): number {
  const keep = Math.max(keepRecentMessages, MODEL_RECENT_WINDOW);
  const safeStep = truncationStepSize(step);
  if (safeStep === Number.POSITIVE_INFINITY) {
    return Math.max(0, messageCount - keep);
  }
  const stepsBack = Math.ceil((keep - MODEL_RECENT_WINDOW) / safeStep);
  return Math.max(
    0,
    messageCount -
      truncationKeepRecent(messageCount, safeStep) -
      stepsBack * safeStep
  );
}

/**
 * Stable id prefix for fallback notes that preserve orphaned execution outcomes.
 *
 * @internal
 */
export const EXECUTION_OUTCOME_MESSAGE_PREFIX = "exec-outcome-";

/**
 * Present framework-authored execution outcome notes to providers as user
 * context. Think persists these notes as system messages so clients and
 * recovery do not mistake them for human input, but AI SDK v7 and strict
 * providers reject system messages in arbitrary transcript
 * positions. The provider-only projection leaves current and legacy session
 * history unchanged.
 *
 * @internal
 */
export function toProviderSafeExecutionOutcomeMessage(
  message: UIMessage
): UIMessage {
  return message.role === "system" &&
    message.id.startsWith(EXECUTION_OUTCOME_MESSAGE_PREFIX)
    ? { ...message, role: "user" }
    : message;
}

// Ephemeral user message appended when a model request would otherwise end in
// an assistant message (see `ensureValidContinueCheckpoint`).
/** @internal */
export const CONTINUE_CHECKPOINT_PROMPT =
  "Continue your previous response from exactly where it left off. Do not repeat any of it.";

/**
 * Ensure a model request does not end in an assistant message.
 *
 * Continuing a partial assistant turn (e.g. after a deploy interrupts a stream)
 * replays a transcript whose final message is that partial assistant message —
 * an "assistant prefill". Modern chat models reject this: Anthropic Claude 4.6+
 * returns a 400 ("This model does not support assistant message prefill. The
 * conversation must end with a user message."). To reach a valid continue
 * checkpoint across providers we append an ephemeral user message. This shapes
 * only the model request; it is never persisted to the transcript.
 *
 * @internal
 */
export function ensureValidContinueCheckpoint(
  messages: ModelMessage[]
): ModelMessage[] {
  if (messages.length === 0) return messages;
  if (messages[messages.length - 1]?.role !== "assistant") return messages;
  return [...messages, { role: "user", content: CONTINUE_CHECKPOINT_PROMPT }];
}

/**
 * Carry a context reminder (`ContextBlocks.reminder()`) after the cached
 * prefix without persisting it. It joins the final user message when there is
 * one, since not every provider accepts two user messages in a row. A request
 * ending in a partial assistant message gets the continue checkpoint here,
 * carrying the reminder, so `ensureValidContinueCheckpoint` adds nothing.
 *
 * @internal
 */
export function withContextReminder(
  messages: ModelMessage[],
  reminder: string | null
): ModelMessage[] {
  if (!reminder || messages.length === 0) return messages;
  const part = { type: "text" as const, text: reminder };
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (last.role === "user") {
    const content =
      typeof last.content === "string"
        ? [{ type: "text" as const, text: last.content }, part]
        : [...last.content, part];
    return [...messages.slice(0, lastIndex), { ...last, content }];
  }
  const content =
    last.role === "assistant"
      ? [{ type: "text" as const, text: CONTINUE_CHECKPOINT_PROMPT }, part]
      : [part];
  return [...messages, { role: "user", content }];
}

/**
 * What {@link modelMessagesFromHistory} needs besides the repaired history.
 *
 * @internal
 */
export interface ModelMessagesOptions {
  readonly tools: ToolSet;
  /** The agent's `truncationStep`. */
  readonly truncationStep: number;
  /** Tool call ids in `messages` that have no settled result. */
  readonly incompleteToolCallIds: (messages: UIMessage[]) => string[];
  /** Called when calls with no result survived repair and are dropped. */
  readonly onIncompleteToolCalls: (toolCallIds: string[]) => void;
}

/**
 * Build the provider-ready model messages for a turn from its repaired
 * history: project execution outcomes for providers, truncate older
 * messages, drop any still-incomplete tool calls, and convert.
 *
 * @throws When repair kept a tool call a client still has to answer. A
 * continuation turn in that state has nothing to continue, and the request
 * would hold a call with no result.
 *
 * @internal
 */
export async function modelMessagesFromHistory(
  repair: BeforeTurnRepairResult,
  options: ModelMessagesOptions
): Promise<ModelMessage[]> {
  // The rule holds where the request is built: a continuation turn whose
  // repair kept a call a client still has to answer has nothing to
  // continue. The continuation entry points end such a turn before it
  // gets here (`ChatTurns.continuationWaitsOnClient`). One that did not
  // must not reach the model: the request would hold a call with no
  // result, and with it dropped the model calls the same tool again.
  if (repair.keptToolCallIds.length > 0) {
    throw new Error(
      `[Think] A continuation turn cannot call the model while its reply waits on a client for tool call(s) ${repair.keptToolCallIds.join(", ")}.`
    );
  }
  const history = repair.messages;
  const providerSafeHistory = history.map(
    toProviderSafeExecutionOutcomeMessage
  );
  const keepRecent = truncationKeepRecent(
    providerSafeHistory.length,
    options.truncationStep
  );
  const truncated = truncateOlderMessages(providerSafeHistory, {
    keepRecent,
    toolOutputs: false
  }) as UIMessage[];
  // The before-turn repair above already heals orphan tool calls
  // (flipping them to errored results, preserving the record). This is the
  // last-line backstop: if any incomplete tool call still slips through
  // (compaction edge, addToolOutput race, an unrecognized part shape), drop it
  // here rather than letting the provider 400 with AI_MissingToolResultsError.
  //
  // The backstop drops silently. Repair should have left nothing incomplete,
  // so a non-empty set here means repair missed a shape — surface it (rather
  // than masking a repair bug) without breaking the turn.
  const incompleteAfterRepair = options.incompleteToolCallIds(truncated);
  if (incompleteAfterRepair.length > 0) {
    console.warn(
      `[Think] ${incompleteAfterRepair.length} incomplete tool call(s) survived transcript repair and will be dropped by ignoreIncompleteToolCalls: ${incompleteAfterRepair.join(", ")}. This indicates a gap in the before-turn repair.`
    );
    options.onIncompleteToolCalls(incompleteAfterRepair);
  }
  const modelMessages = await convertToModelMessages(truncated, {
    tools: options.tools,
    ignoreIncompleteToolCalls: true
  });
  return truncateOlderToolResults(modelMessages, truncated, { keepRecent });
}
