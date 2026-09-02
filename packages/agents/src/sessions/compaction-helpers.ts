/**
 * Compaction Helpers
 *
 * Utilities for full compaction (LLM-based summarization).
 * Used by the reference compaction implementation and available
 * for custom CompactFunction implementations.
 */

import type { SessionMessage } from "./types";
import { estimateMessageTokens } from "./tokens";

// ── Compaction ID constants ─────────────────────────────────────────

/** Prefix for all compaction messages (overlays and summaries) */
export const COMPACTION_PREFIX = "compaction_";

/** Head messages kept verbatim so the conversation's opening survives. */
const PROTECT_HEAD = 3;
/** Tail messages kept verbatim regardless of the token budget. */
const MIN_TAIL_MESSAGES = 2;

/** Check if a message is a compaction message */
export function isCompactionMessage(msg: SessionMessage): boolean {
  return msg.id.startsWith(COMPACTION_PREFIX);
}

// ── Tool Pair Alignment ──────────────────────────────────────────────

/**
 * Check if a message contains tool invocations.
 */
function hasToolCalls(msg: SessionMessage): boolean {
  return msg.parts.some(
    (p) => p.type.startsWith("tool-") || p.type === "dynamic-tool"
  );
}

/**
 * Get tool call IDs from a message's parts.
 */
function getToolCallIds(msg: SessionMessage): Set<string> {
  const ids = new Set<string>();
  for (const part of msg.parts) {
    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      "toolCallId" in part
    ) {
      ids.add((part as { toolCallId: string }).toolCallId);
    }
  }
  return ids;
}

/**
 * Check if a message is a tool result referencing a specific call ID.
 */
function isToolResultFor(msg: SessionMessage, callIds: Set<string>): boolean {
  return msg.parts.some(
    (p) =>
      (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
      "toolCallId" in p &&
      callIds.has((p as { toolCallId: string }).toolCallId)
  );
}

/**
 * Align a boundary index forward to avoid splitting tool call/result groups.
 * If the boundary falls between an assistant message with tool calls and its
 * tool results, move it forward past the results.
 */
export function alignBoundaryForward(
  messages: SessionMessage[],
  idx: number
): number {
  if (idx <= 0 || idx >= messages.length) return idx;

  // Check if the message before the boundary has tool calls
  const prev = messages[idx - 1];
  if (prev.role === "assistant" && hasToolCalls(prev)) {
    const callIds = getToolCallIds(prev);
    // Skip forward past any tool results for these calls
    while (idx < messages.length && isToolResultFor(messages[idx], callIds)) {
      idx++;
    }
  }

  return idx;
}

/**
 * Align a boundary index backward to avoid splitting tool call/result groups.
 * If the boundary falls in the middle of tool results, move it backward to
 * include the assistant message that made the calls.
 */
export function alignBoundaryBackward(
  messages: SessionMessage[],
  idx: number
): number {
  if (idx <= 0 || idx >= messages.length) return idx;

  // If the message at idx is a tool result, walk backward to find the call
  while (idx > 0) {
    const msg = messages[idx];
    if (msg.role === "assistant" && hasToolCalls(msg)) {
      break; // This is a tool call message — include it
    }
    // Check if this looks like a tool result (assistant message following another)
    const prev = messages[idx - 1];
    if (prev.role === "assistant" && hasToolCalls(prev)) {
      const callIds = getToolCallIds(prev);
      if (isToolResultFor(msg, callIds)) {
        idx--; // Move back to include the call
        continue;
      }
    }
    break;
  }

  return idx;
}

// ── Token-Budget Tail Protection ─────────────────────────────────────

/**
 * Find the compression end boundary using a token budget for the tail.
 * Walks backward from the end, accumulating tokens until budget is reached.
 * Returns the index where compression should stop (everything from this
 * index onward is protected).
 *
 * @param messages All messages
 * @param headEnd Index where the protected head ends (compression starts here)
 * @param tailTokenBudget Maximum tokens to keep in the tail
 * @param minTailMessages Minimum messages to protect in the tail (fallback)
 */
export function findTailCutByTokens(
  messages: SessionMessage[],
  headEnd: number,
  tailTokenBudget = 20000,
  minTailMessages = 2
): number {
  const n = messages.length;
  let accumulated = 0;
  let tokenCut = n;

  for (let i = n - 1; i >= headEnd; i--) {
    const msgTokens = estimateMessageTokens([messages[i]]);

    if (accumulated + msgTokens > tailTokenBudget && tokenCut < n) {
      // Budget exceeded and we already have at least one tail message
      break;
    }
    accumulated += msgTokens;
    tokenCut = i;
  }

  // Protect whichever is larger: token-based tail or minTailMessages
  const minCut = n - minTailMessages;
  const cutIdx = minCut >= headEnd ? Math.min(tokenCut, minCut) : tokenCut;

  // Align to avoid splitting tool groups
  return alignBoundaryBackward(messages, cutIdx);
}

export function computeSummaryBudget(messages: SessionMessage[]): number {
  const contentTokens = estimateMessageTokens(messages);
  // Summary is ~20% of the content being compressed.
  // The summary replaces the compressed middle, so it's sized relative
  // to what it's replacing — not the tail budget (they occupy different
  // slots in the context window).
  const budget = Math.floor(contentTokens * 0.2);
  return Math.max(100, budget);
}

// ── Structured Summary Prompt ────────────────────────────────────────

/**
 * Build a prompt for LLM summarization of compressed messages.
 *
 * @param messages Messages to summarize
 * @param previousSummary Previous summary for iterative updates (or null for first compaction)
 * @param budget Target token count for the summary
 */
export function buildSummaryPrompt(
  messages: SessionMessage[],
  previousSummary: string | null,
  budget: number
): string {
  const content = messages
    .map((msg) => {
      const textParts = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");

      const toolParts = msg.parts
        .filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool")
        .map((p) => {
          const tp = p as {
            toolName?: string;
            input?: unknown;
            output?: unknown;
          };
          const parts = [`[Tool: ${tp.toolName ?? "unknown"}]`];
          if (tp.input)
            parts.push(`Input: ${JSON.stringify(tp.input).slice(0, 500)}`);
          if (tp.output)
            parts.push(`Output: ${String(tp.output).slice(0, 500)}`);
          return parts.join("\n");
        })
        .join("\n");

      return `[${msg.role}]\n${textParts}${toolParts ? "\n" + toolParts : ""}`;
    })
    .join("\n\n---\n\n");

  if (previousSummary) {
    return `You are updating a conversation summary. A previous summary exists below. New conversation turns have occurred since then and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW TURNS TO INCORPORATE:
${content}

Update the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if it is clearly obsolete.

## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now — what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]

Target ~${budget} tokens. Be factual — only include information that was explicitly discussed in the conversation. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
  }

  return `Create a concise summary of this conversation that preserves the important information for future context.

CONVERSATION TO SUMMARIZE:
${content}

Use this structure:

## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now — what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]

Target ~${budget} tokens. Be factual — only include information that was explicitly discussed in the conversation. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
}

// ── Reference Compaction Implementation ──────────────────────────────

/**
 * Result of a compaction function — describes the overlay to store.
 */
export interface CompactResult {
  /** First message ID in the compacted range */
  fromMessageId: string;
  /** Last message ID in the compacted range */
  toMessageId: string;
  /** Summary text to store as the overlay */
  summary: string;
}

export interface CompactOptions {
  /** Calls the model to summarize; receives a prompt, returns its text. */
  summarize: (prompt: string) => Promise<string>;
  /**
   * Token budget for the recent tail kept verbatim. Older messages above the
   * protected head are summarized into one overlay. Default 20,000.
   */
  keepRecentTokens?: number;
}

/**
 * Reference compaction implementation.
 *
 * Implements the full hermes-style compaction algorithm:
 * 1. Protect head messages (first N)
 * 2. Protect tail by token budget (walk backward)
 * 3. Align boundaries to tool call groups
 * 4. Summarize middle section with LLM (structured format)
 * 5. Iterative summary updates on subsequent compactions
 *
 * @example
 * ```typescript
 * import { createCompactFunction } from "agents/sessions";
 *
 * sessions
 *   .session()
 *   .onCompaction(
 *     createCompactFunction({
 *       summarize: (prompt) => generateText({ model, prompt }).then((r) => r.text)
 *     })
 *   )
 *   .compactAfter(100_000);
 * ```
 */
export function createCompactFunction(opts: CompactOptions) {
  const keepRecentTokens = opts.keepRecentTokens ?? 20_000;

  return async (messages: SessionMessage[]): Promise<CompactResult | null> => {
    if (messages.length <= PROTECT_HEAD + MIN_TAIL_MESSAGES) return null;

    // 1. Find compression boundaries
    const compressStart = alignBoundaryForward(messages, PROTECT_HEAD);
    const compressEnd = findTailCutByTokens(
      messages,
      compressStart,
      keepRecentTokens,
      MIN_TAIL_MESSAGES
    );

    if (compressEnd <= compressStart) {
      return null;
    }

    // Filter out compaction overlay messages — they have virtual IDs
    // and should not be included in the summary prompt or used as range IDs
    const middleMessages = messages
      .slice(compressStart, compressEnd)
      .filter((m) => !isCompactionMessage(m));

    if (middleMessages.length === 0) return null;

    // 2. Generate summary — extract previous summary from compaction overlays
    const existingCompaction = messages.find(isCompactionMessage);
    const previousSummary = existingCompaction
      ? existingCompaction.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("\n")
      : null;

    const budget = computeSummaryBudget(middleMessages);
    const prompt = buildSummaryPrompt(middleMessages, previousSummary, budget);
    const summary = await opts.summarize(prompt);

    if (!summary.trim()) return null;

    return {
      fromMessageId: middleMessages[0].id,
      toMessageId: middleMessages[middleMessages.length - 1].id,
      summary
    };
  };
}
