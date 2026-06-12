/**
 * Tool State — shared update builders and applicator for tool part state changes.
 *
 * Used by both AIChatAgent and Think to apply tool results and approvals
 * to message parts. Each agent handles find-message, persist, and broadcast
 * in their own way; this module provides the state matching and update logic.
 */

/**
 * Describes an update to apply to a tool part.
 */
export type ToolPartUpdate = {
  toolCallId: string;
  matchStates: string[];
  apply: (part: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Apply a tool part update to a parts array.
 * Finds the first part matching `update.toolCallId` in one of `update.matchStates`,
 * applies the update immutably, and returns the new parts array with the index.
 *
 * Returns `null` if no matching part was found.
 */
export function applyToolUpdate(
  parts: Array<Record<string, unknown>>,
  update: ToolPartUpdate
): { parts: Array<Record<string, unknown>>; index: number } | null {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (
      "toolCallId" in part &&
      part.toolCallId === update.toolCallId &&
      "state" in part &&
      update.matchStates.includes(part.state as string)
    ) {
      const updatedParts = [...parts];
      updatedParts[i] = update.apply(part);
      return { parts: updatedParts, index: i };
    }
  }
  return null;
}

/**
 * Build an update descriptor for applying a tool result.
 *
 * Matches parts in `input-available`, `approval-requested`, or `approval-responded` state.
 * Sets state to `output-available` (with output) or `output-error` (with errorText).
 */
export function toolResultUpdate(
  toolCallId: string,
  output: unknown,
  overrideState?: "output-error",
  errorText?: string
): ToolPartUpdate {
  return {
    toolCallId,
    matchStates: [
      "input-available",
      "approval-requested",
      "approval-responded"
    ],
    apply: (part) => ({
      ...part,
      ...(overrideState === "output-error"
        ? {
            state: "output-error",
            errorText: errorText ?? "Tool execution denied by user"
          }
        : { state: "output-available", output, preliminary: false })
    })
  };
}

/**
 * Build an update descriptor for a terminal tool result that belongs to a
 * tool part in a *different* (earlier) assistant message than the one
 * currently being streamed.
 *
 * This is the "cross-message" case: an approved server tool executes during a
 * continuation stream, but its tool part lives in the assistant message that
 * originally requested it. `StreamAccumulator` surfaces this as a
 * `cross-message-tool-update` action because the accumulator only owns the
 * current turn's new content and cannot mutate a part from a prior message.
 *
 * Compared to {@link toolResultUpdate} this builder is deliberately more
 * defensive, mirroring the equivalent fallback in `@cloudflare/ai-chat`:
 *
 * - It matches the broad set of pre-terminal **and** terminal states, so a
 *   provider that replays the entire prior tool round-trip during a
 *   continuation (notably the OpenAI Responses API — issue #1404) still
 *   resolves to the same part instead of silently missing it.
 * - It is **first-write-wins**: a chunk arriving for a tool that already holds
 *   a terminal result is treated as a replay and the existing output is never
 *   overwritten. In that case `apply` returns the *same part reference*, which
 *   callers use as an idempotent-no-op signal to skip the durable write and a
 *   redundant `MESSAGE_UPDATED` broadcast.
 * - It preserves a streamed `preliminary` flag when one is present, otherwise
 *   marks the result final (`preliminary: false`).
 */
export function crossMessageToolResultUpdate(
  toolCallId: string,
  updateType: "output-available" | "output-error",
  output?: unknown,
  errorText?: string,
  preliminary?: boolean
): ToolPartUpdate {
  return {
    toolCallId,
    matchStates: [
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied"
    ],
    apply: (part) => {
      if (
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied"
      ) {
        return part;
      }
      if (updateType === "output-error") {
        return {
          ...part,
          state: "output-error",
          errorText: errorText ?? "Tool execution failed"
        };
      }
      return {
        ...part,
        state: "output-available",
        output,
        preliminary: preliminary ?? false
      };
    }
  };
}

/**
 * Build an update descriptor that replaces the output of a *paused durable
 * execution* tool part (e.g. a codemode runtime tool that paused for
 * approval).
 *
 * A paused execution completes its tool call normally — the part is already
 * `output-available` with an output of `{ status: "paused", executionId }`.
 * When the host later approves/rejects the execution, the new outcome
 * (completed / rejected / paused-again) must replace that output in place.
 *
 * Matching is deliberately narrow and idempotent:
 *
 * - only `output-available` parts are considered;
 * - the existing output must be a paused-execution object carrying the same
 *   `executionId` — anything else (already replaced, different execution)
 *   returns the *same part reference*, which callers treat as a no-op signal
 *   (skip persist + broadcast), mirroring {@link crossMessageToolResultUpdate}.
 */
export function pausedExecutionUpdate(
  toolCallId: string,
  executionId: string,
  output: unknown
): ToolPartUpdate {
  return {
    toolCallId,
    matchStates: ["output-available"],
    apply: (part) => {
      const current = part.output as
        | { status?: unknown; executionId?: unknown }
        | null
        | undefined;
      if (
        current == null ||
        typeof current !== "object" ||
        current.status !== "paused" ||
        current.executionId !== executionId
      ) {
        return part;
      }
      return { ...part, output, preliminary: false };
    }
  };
}

/**
 * Build an update descriptor for applying a tool approval.
 *
 * Matches parts in `input-available` or `approval-requested` state.
 * Sets state to `approval-responded` (if approved) or `output-denied` (if denied).
 */
export function toolApprovalUpdate(
  toolCallId: string,
  approved: boolean
): ToolPartUpdate {
  return {
    toolCallId,
    matchStates: ["input-available", "approval-requested"],
    apply: (part) => ({
      ...part,
      state: approved ? "approval-responded" : "output-denied",
      approval: {
        ...(part.approval as Record<string, unknown> | undefined),
        approved
      }
    })
  };
}
