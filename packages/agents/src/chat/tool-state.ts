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
    apply: (part) => {
      const approval =
        typeof part.approval === "object" &&
        part.approval !== null &&
        !Array.isArray(part.approval)
          ? (part.approval as Record<string, unknown>)
          : undefined;
      const approvalId =
        typeof approval?.id === "string" ? approval.id : toolCallId;

      return {
        ...part,
        state: approved ? "approval-responded" : "output-denied",
        approval: {
          ...approval,
          id: approvalId,
          approved
        }
      };
    }
  };
}

// ── Client-interaction predicates (recovery classification) ─────────────────
//
// `@internal` — these leaf predicates are byte-identical in `AIChatAgent` and
// `Think`. The broad-vs-client-only asymmetry lives in each package's
// higher-level `hasPendingInteraction` / `hasPendingClientInteraction`
// wrappers, which both call the identical leaf, so the wrappers stay
// package-local. See `design/rfc-chat-recovery-foundation.md`.

/** A minimal message shape for the leaf tool/interaction scans. */
type ToolBatchMessage = {
  role: string;
  parts: ReadonlyArray<unknown>;
};

/** Extract a tool part's name from its `tool-<name>` / `dynamic-tool` shape. */
export function toolPartName(
  record: Record<string, unknown>
): string | undefined {
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "dynamic-tool") {
    return typeof record.toolName === "string" ? record.toolName : undefined;
  }
  if (type.startsWith("tool-")) {
    return type.slice("tool-".length);
  }
  return undefined;
}

/**
 * Whether a part is still awaiting a CLIENT interaction that can genuinely
 * arrive after a restart: an `approval-requested` part (a reconnecting client
 * replays the approval) or an `input-available` part for a CLIENT tool (the SPA
 * replays the `tool-result`). A SERVER tool's `input-available` is NOT pending —
 * its `execute()` died with the isolate.
 */
export function partAwaitsClientInteraction(
  part: unknown,
  clientResolvable: Set<string>
): boolean {
  if (typeof part !== "object" || part === null || !("state" in part)) {
    return false;
  }
  const record = part as Record<string, unknown>;
  const state = record.state;
  if (state === "approval-requested") return true;
  if (state !== "input-available") return false;
  const toolName = toolPartName(record);
  return toolName != null && clientResolvable.has(toolName);
}

/**
 * Names of the CLIENT-resolvable tools — the client-provided schemas from the
 * last request, which have no server `execute`. An interrupted `input-available`
 * part for one of these can still be resolved by the client replaying a
 * `tool-result`; a server tool's cannot.
 */
export function clientResolvableToolNames(
  tools: ReadonlyArray<{ name?: string } | null | undefined> | undefined
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool?.name) names.add(tool.name);
  }
  return names;
}

/**
 * `true` when the latest assistant message is mid-batch: it carries at least
 * one settled tool result AND at least one tool call/approval still awaiting a
 * client result. That is the #1649 signature — the model fanned out parallel
 * tool calls and only some have been answered. Scoped to the leaf (the step the
 * continuation answers) so an unrelated dangling tool in an earlier message
 * doesn't block a legitimate follow-up continuation.
 */
export function hasIncompleteToolBatch(
  messages: ReadonlyArray<ToolBatchMessage>
): boolean {
  // Zero-allocation backward scan for the latest assistant message — this runs
  // on every barrier poll tick, and `messages` can be large.
  let leaf: ToolBatchMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      leaf = messages[i];
      break;
    }
  }
  if (!leaf) return false;
  let hasPending = false;
  let hasSettled = false;
  for (const part of leaf.parts) {
    const record = part as Record<string, unknown>;
    const state = record.state;
    if (state === "input-available" || state === "approval-requested") {
      hasPending = true;
    } else if (
      typeof record.type === "string" &&
      (record.type.startsWith("tool-") || record.type === "dynamic-tool") &&
      (state === "output-available" ||
        state === "output-error" ||
        state === "output-denied" ||
        state === "approval-responded")
    ) {
      hasSettled = true;
    }
    if (hasPending && hasSettled) return true;
  }
  return false;
}
