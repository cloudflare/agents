/**
 * Compaction Helpers
 *
 * Utilities for full compaction (LLM-based summarization).
 * Used by the reference compaction implementation and available
 * for custom CompactFunction implementations.
 */

import type { UIMessage } from "ai";
import { estimateMessageTokens } from "./tokens";

// ── Tool Pair Alignment ──────────────────────────────────────────────

/**
 * Check if a message contains tool invocations.
 */
function hasToolCalls(msg: UIMessage): boolean {
  return msg.parts.some(
    (p) => p.type.startsWith("tool-") || p.type === "dynamic-tool"
  );
}

/**
 * Get tool call IDs from a message's parts.
 */
function getToolCallIds(msg: UIMessage): Set<string> {
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
function isToolResultFor(msg: UIMessage, callIds: Set<string>): boolean {
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
  messages: UIMessage[],
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
  messages: UIMessage[],
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
  messages: UIMessage[],
  headEnd: number,
  tailTokenBudget = 20000,
  minTailMessages = 4
): number {
  const n = messages.length;
  let accumulated = 0;
  let cutIdx = n;

  for (let i = n - 1; i >= headEnd; i--) {
    const msgTokens = estimateMessageTokens([messages[i]]);

    if (accumulated + msgTokens > tailTokenBudget) {
      break;
    }
    accumulated += msgTokens;
    cutIdx = i;
  }

  // Fallback: ensure at least minTailMessages stay
  const fallbackCut = n - minTailMessages;
  if (cutIdx > fallbackCut && fallbackCut >= headEnd) {
    cutIdx = fallbackCut;
  }

  // Align to avoid splitting tool groups
  return alignBoundaryBackward(messages, cutIdx);
}

// ── Tool Pair Sanitization ───────────────────────────────────────────

/**
 * Fix orphaned tool call/result pairs after compaction.
 *
 * Two failure modes:
 * 1. Tool result references a call_id whose assistant tool_call was removed
 *    → Remove the orphaned result
 * 2. Assistant has tool_calls whose results were dropped
 *    → Add stub results so the API doesn't error
 *
 * @param messages Messages after compaction
 * @returns Sanitized messages with no orphaned pairs
 */
export function sanitizeToolPairs(messages: UIMessage[]): UIMessage[] {
  // Build set of surviving tool call IDs (from assistant messages)
  const survivingCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const id of getToolCallIds(msg)) {
        survivingCallIds.add(id);
      }
    }
  }

  // Build set of tool result IDs
  const resultCallIds = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (
        (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
        "toolCallId" in part &&
        "output" in part
      ) {
        resultCallIds.add((part as { toolCallId: string }).toolCallId);
      }
    }
  }

  // Remove orphaned results (results whose calls were dropped)
  const orphanedResults = new Set<string>();
  for (const id of resultCallIds) {
    if (!survivingCallIds.has(id)) {
      orphanedResults.add(id);
    }
  }

  let result = messages;
  if (orphanedResults.size > 0) {
    result = result.map((msg) => {
      const filteredParts = msg.parts.filter((part) => {
        if (
          (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
          "toolCallId" in part &&
          "output" in part
        ) {
          return !orphanedResults.has(
            (part as { toolCallId: string }).toolCallId
          );
        }
        return true;
      });
      if (filteredParts.length !== msg.parts.length) {
        return { ...msg, parts: filteredParts } as UIMessage;
      }
      return msg;
    });
  }

  // Add stub results for calls whose results were dropped
  const missingResults = new Set<string>();
  for (const id of survivingCallIds) {
    if (!resultCallIds.has(id) && !orphanedResults.has(id)) {
      missingResults.add(id);
    }
  }

  if (missingResults.size > 0) {
    const patched: UIMessage[] = [];
    for (const msg of result) {
      patched.push(msg);
      if (msg.role === "assistant") {
        for (const id of getToolCallIds(msg)) {
          if (missingResults.has(id)) {
            // Find the tool name from the call
            const callPart = msg.parts.find(
              (p) =>
                "toolCallId" in p &&
                (p as { toolCallId: string }).toolCallId === id
            ) as { toolName?: string } | undefined;

            patched.push({
              id: `stub-${id}`,
              role: "assistant",
              parts: [
                {
                  type: "tool-result" as const,
                  toolCallId: id,
                  toolName: callPart?.toolName ?? "unknown",
                  result:
                    "[Result from earlier conversation — see context summary above]"
                } as unknown as UIMessage["parts"][number]
              ],
              createdAt: new Date()
            } as UIMessage);
          }
        }
      }
    }
    result = patched;
  }

  // Remove empty messages (all parts filtered out)
  return result.filter((msg) => msg.parts.length > 0);
}

// ── Summary Budget ───────────────────────────────────────────────────

/**
 * Compute a summary token budget based on the content being compressed.
 * 20% of the compressed content, clamped to 2K-8K tokens.
 */
export function computeSummaryBudget(messages: UIMessage[]): number {
  const contentTokens = estimateMessageTokens(messages);
  const budget = Math.floor(contentTokens * 0.2);
  return Math.max(2000, Math.min(budget, 8000));
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
  messages: UIMessage[],
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
    return `You are updating a context compaction summary. A previous compaction produced the summary below. New conversation turns have occurred since then and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW TURNS TO INCORPORATE:
${content}

Update the summary using this exact structure. PRESERVE existing information that is still relevant. ADD new progress. Move items from "In Progress" to "Done" when completed. Remove information only if it is clearly obsolete.

## Goal
[What the user is trying to accomplish]

## Progress
### Done
[Completed work — include specific file paths, commands run, results obtained]
### In Progress
[Work currently underway]

## Key Decisions
[Important technical decisions and why they were made]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Next Steps
[What needs to happen next to continue the work]

## Critical Context
[Any specific values, error messages, configuration details that must be preserved]

Target ~${budget} tokens. Be specific — include file paths, command outputs, error messages. Write only the summary body.`;
  }

  return `Create a structured handoff summary of this conversation for a later assistant that will continue the work. Be specific and concrete.

CONVERSATION TO SUMMARIZE:
${content}

Use this exact structure:

## Goal
[What the user is trying to accomplish]

## Progress
### Done
[Completed work — include specific file paths, commands run, results obtained]
### In Progress
[Work currently underway]

## Key Decisions
[Important technical decisions and why they were made]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Next Steps
[What needs to happen next to continue the work]

## Critical Context
[Any specific values, error messages, configuration details that must be preserved]

Target ~${budget} tokens. Be specific — include file paths, command outputs, error messages. Write only the summary body.`;
}

// ── Reference Compaction Implementation ──────────────────────────────

export interface CompactOptions {
  /**
   * Function to call the LLM for summarization.
   * Takes a user prompt string, returns the LLM's text response.
   */
  summarize: (prompt: string) => Promise<string>;

  /** Number of head messages to protect (default: 2) */
  protectHead?: number;

  /** Token budget for tail protection (default: 20000) */
  tailTokenBudget?: number;

  /** Minimum tail messages to protect (default: 4) */
  minTailMessages?: number;
}

/**
 * Reference compaction implementation.
 *
 * Implements the full hermes-style compaction algorithm:
 * 1. Protect head messages (first N)
 * 2. Protect tail by token budget (walk backward)
 * 3. Align boundaries to tool call groups
 * 4. Summarize middle section with LLM (structured format)
 * 5. Sanitize orphaned tool pairs
 * 6. Iterative summary updates on subsequent compactions
 *
 * @example
 * ```typescript
 * import { createCompactFunction } from "agents/experimental/memory/utils";
 *
 * const session = new Session(provider, {
 *   compaction: {
 *     tokenThreshold: 100000,
 *     fn: createCompactFunction({
 *       summarize: (prompt) => generateText({ model, prompt }).then(r => r.text)
 *     })
 *   }
 * });
 * ```
 */
export function createCompactFunction(opts: CompactOptions) {
  const protectHead = opts.protectHead ?? 2;
  const tailTokenBudget = opts.tailTokenBudget ?? 20000;
  const minTailMessages = opts.minTailMessages ?? 4;

  let previousSummary: string | null = null;

  return async (messages: UIMessage[]): Promise<UIMessage[]> => {
    if (messages.length <= protectHead + minTailMessages) {
      return messages; // Too few messages to compact
    }

    // 1. Find compression boundaries
    let compressStart = protectHead;
    compressStart = alignBoundaryForward(messages, compressStart);

    let compressEnd = findTailCutByTokens(
      messages,
      compressStart,
      tailTokenBudget,
      minTailMessages
    );

    if (compressEnd <= compressStart) {
      return messages; // Nothing to compress
    }

    const middleMessages = messages.slice(compressStart, compressEnd);

    // 2. Generate summary
    const budget = computeSummaryBudget(middleMessages);
    const prompt = buildSummaryPrompt(middleMessages, previousSummary, budget);
    const summary = await opts.summarize(prompt);
    previousSummary = summary;

    // 3. Assemble compressed messages
    const compressed: UIMessage[] = [];

    // Protected head
    for (let i = 0; i < compressStart; i++) {
      compressed.push(messages[i]);
    }

    // Summary as assistant message
    if (summary.trim()) {
      compressed.push({
        id: `compaction-summary-${Date.now()}`,
        role: "assistant",
        parts: [
          {
            type: "text" as const,
            text: `[Context Summary — earlier conversation compressed]\n\n${summary}`
          }
        ],
        createdAt: new Date()
      } as UIMessage);
    }

    // Protected tail
    for (let i = compressEnd; i < messages.length; i++) {
      compressed.push(messages[i]);
    }

    // 4. Sanitize tool pairs
    return sanitizeToolPairs(compressed);
  };
}
