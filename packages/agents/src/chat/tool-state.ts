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
