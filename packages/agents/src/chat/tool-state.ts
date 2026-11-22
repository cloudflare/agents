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
 * Apply a tool part update to a parts array: to every part for
 * `update.toolCallId` in one of `update.matchStates`. A legacy message can
 * hold the same call twice; leaving one copy unanswered would leave the call
 * pending for ever.
 *
 * Immutable: `parts` is not changed. Returns the new array (the same array
 * when no matched part changed) and whether one changed, or `null` when no
 * part matched.
 */
export function applyToolUpdate(
  parts: Array<Record<string, unknown>>,
  update: ToolPartUpdate
): { parts: Array<Record<string, unknown>>; changed: boolean } | null {
  let next: Array<Record<string, unknown>> | undefined;
  let matched = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (
      "toolCallId" in part &&
      part.toolCallId === update.toolCallId &&
      "state" in part &&
      update.matchStates.includes(part.state as string)
    ) {
      matched = true;
      const applied = update.apply(part);
      if (applied !== part) {
        next ??= [...parts];
        next[i] = applied;
      }
    }
  }
  if (!matched) return null;
  return next ? { parts: next, changed: true } : { parts, changed: false };
}

/**
 * Build an update descriptor for applying a tool result.
 *
 * Matches the pre-terminal states (`input-available`, `approval-requested`,
 * `approval-responded`) and sets `output-available` (with output) or
 * `output-error` (with errorText). First write wins: a part that already
 * holds a terminal result is matched and returned as the same reference, so
 * a duplicate frame, a second tab or a provider replay is an idempotent
 * no-op (`unchanged`), not a miss, and never overwrites the first result.
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
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied"
    ],
    apply: (part) => {
      if (isTerminalToolState(part.state)) return part;
      return {
        ...part,
        ...(overrideState === "output-error"
          ? {
              state: "output-error",
              errorText: errorText ?? "Tool execution denied by user"
            }
          : { state: "output-available", output, preliminary: false })
      };
    }
  };
}

function isTerminalToolState(state: unknown): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

/**
 * The reply a host is streaming or storing now, whose parts an update may
 * change in place.
 */
export type InFlightToolReply<TMessage> = {
  readonly id: string;
  /** The reply's live parts array. A changed part is replaced in it. */
  readonly parts: Array<Record<string, unknown>>;
  /** The reply as a message, for the broadcast. */
  readonly snapshot: () => TMessage;
  /** A part changed in place: a store of the reply already under way must run again. */
  readonly changed: () => void;
};

/** Where {@link applyToolPartUpdate} finds, writes and announces the part. */
export type ToolPartTarget<TMessage extends { id: string; parts: unknown[] }> =
  {
    /** The reply in flight, or `null`. */
    readonly inFlight: InFlightToolReply<TMessage> | null;
    /**
     * The stored message holding the call, or `null`. `inFlightId` is set when
     * the reply in flight holds it: a row under that id exists only when part
     * of the reply was stored before it finished.
     */
    readonly storedOwner: (
      toolCallId: string,
      inFlightId: string | undefined
    ) => Promise<TMessage | null>;
    /** Store a changed message. Returns the form to broadcast. */
    readonly write: (message: TMessage) => Promise<TMessage>;
    /** Tell clients the message changed. */
    readonly broadcast: (message: TMessage) => void;
  };

/**
 * Apply a tool result, approval or outcome to its part, wherever the part
 * is: in the reply in flight, in the stored transcript, or both. Both, because
 * a reply can be partly stored while it streams (stall recovery, #1649) and a
 * result written only to one copy would be lost when the other is stored.
 *
 * An update that leaves the matched part as the same reference changed
 * nothing: no write and no broadcast.
 *
 * @returns `changed` with the message a continuation answers (the reply in
 *   flight when it holds the call), `unchanged` when the part was found and
 *   already settled, or `missing`.
 */
export async function applyToolPartUpdate<
  TMessage extends { id: string; parts: unknown[] }
>(
  update: ToolPartUpdate,
  target: ToolPartTarget<TMessage>
): Promise<
  | { status: "changed"; messageId: string }
  | { status: "unchanged" }
  | { status: "missing" }
> {
  let broadcastMessage: TMessage | undefined;
  // `undefined`: no part found; `null`: found, already settled.
  let changedMessageId: string | null | undefined;

  const inFlight = target.inFlight;
  let inFlightOwnsCall = false;
  if (inFlight) {
    const result = applyToolUpdate(inFlight.parts, update);
    if (result) {
      inFlightOwnsCall = true;
      changedMessageId = null;
      if (result.changed) {
        result.parts.forEach((part, index) => {
          inFlight.parts[index] = part;
        });
        inFlight.changed();
        broadcastMessage = inFlight.snapshot();
        changedMessageId = inFlight.id;
      }
    }
  }

  const owner = await target.storedOwner(
    update.toolCallId,
    inFlightOwnsCall && inFlight ? inFlight.id : undefined
  );
  if (owner) {
    const ownerParts = owner.parts as Array<Record<string, unknown>>;
    const result = applyToolUpdate(ownerParts, update);
    if (result) changedMessageId ??= null;
    if (result?.changed) {
      const stored = await target.write({
        ...owner,
        parts: result.parts as TMessage["parts"]
      });
      broadcastMessage = stored;
      // The reply in flight, when it also holds the call, is the one a
      // continuation answers: keep it as the changed message.
      if (typeof changedMessageId !== "string") changedMessageId = owner.id;
    }
  }

  if (broadcastMessage) target.broadcast(broadcastMessage);
  if (typeof changedMessageId === "string") {
    return { status: "changed", messageId: changedMessageId };
  }
  return changedMessageId === null
    ? { status: "unchanged" }
    : { status: "missing" };
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
      if (isTerminalToolState(part.state)) return part;
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
 * Names of the tools in `tools` the server does not run: no `execute`, and
 * not run by the provider. An app answers a call to one of them from the
 * client, sorted so the list can be compared and stored.
 */
export function unexecutedToolNames(tools: Record<string, unknown>): string[] {
  return Object.entries(tools)
    .filter(([, definition]) => {
      const candidate = definition as { execute?: unknown; type?: unknown };
      return (
        typeof candidate.execute !== "function" &&
        candidate.type !== "provider" &&
        candidate.type !== "provider-defined"
      );
    })
    .map(([name]) => name)
    .sort();
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
  clientResolvable: ReadonlySet<string>
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

/**
 * Whether the chat is waiting on a client: a tool call a client still has to
 * answer, or an approval it still has to give. The one definition both
 * `@cloudflare/ai-chat` and `@cloudflare/think` use, for apps and for
 * recovery alike.
 *
 * - In the latest stored message every `input-available` call counts,
 *   whatever its tool. A reply is stored unanswered only when its stream
 *   finished on that call, which is what a client tool does. A cut-off reply
 *   has its dead calls settled before it is stored
 *   (`settleInterruptedReply`), so the call is never a server tool whose
 *   `execute()` died. That holds for replies this version stored. An older
 *   version stored a cut-off reply as it was, so a host that can name the
 *   tools only a client can answer passes them
 *   (`clientAnswerableToolNames`), and then only those count. A dead server
 *   call in an old row is not waited on.
 * - In an earlier reply, one the conversation has moved past, only a call a
 *   client is known to own counts (`clientToolNames`, from the schemas the
 *   client sent). Nothing else there can be told apart from a dead call an
 *   older version stored, and the next turn settles it either way.
 * - In the reply that is streaming now, a server tool sits at
 *   `input-available` while it runs, so only a known client tool counts.
 * - `approval-requested` counts everywhere.
 *
 * @param input.streaming - The reply being streamed, if any. A stored copy
 *   of the same message is skipped in favor of it.
 * @param input.clientAnswerableToolNames - Every tool a client may answer,
 *   as far as the host can tell: the tools the client sent a schema for, and
 *   the tools the server declares without running them itself. `null` or
 *   absent when the host cannot tell (its tools are not visible to it), in
 *   which case any tool may be a client's.
 */
export function hasPendingToolInteraction(input: {
  messages: ReadonlyArray<ToolBatchMessage & { id?: string }>;
  streaming: (ToolBatchMessage & { id?: string }) | null | undefined;
  clientToolNames: Set<string>;
  clientAnswerableToolNames?: Set<string> | null;
}): boolean {
  const { messages, streaming, clientToolNames } = input;
  const answerable = input.clientAnswerableToolNames ?? null;
  if (
    streaming?.parts.some((part) =>
      partAwaitsClientInteraction(part, clientToolNames)
    )
  ) {
    return true;
  }
  const latest = streaming ? undefined : messages.at(-1);
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (streaming && message.id !== undefined && message.id === streaming.id) {
      continue;
    }
    for (const part of message.parts) {
      if (partAwaitsClientInteraction(part, clientToolNames)) return true;
      if (
        message === latest &&
        (part as { state?: unknown } | null)?.state === "input-available"
      ) {
        if (answerable === null) return true;
        const toolName = toolPartName(part as Record<string, unknown>);
        if (toolName != null && answerable.has(toolName)) return true;
      }
    }
  }
  return false;
}
