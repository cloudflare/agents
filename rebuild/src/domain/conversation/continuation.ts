import { ValidationError } from "../../kernel/errors.js";
import {
  isToolPart,
  toolName,
  type ChatMessage,
  type MessagePart,
  type ToolPart,
} from "../messages/model.js";
import type { Session } from "../session/session.js";
import type { AssembledTools } from "../tools/registry.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { actionRejectionErrorValue, type ActionService, type ParkedResolution } from "../actions/actions.js";
import type { ConversationEvent } from "../events/log.js";

/**
 * PendingInteractions (audit 26 extraction 2): the client-tool / approval
 * resolution loop is one domain concept. It owns writing a resolved tool
 * part back into the persisted transcript, publishing the resulting
 * message:updated event, and deciding (debounced) whether to request a
 * continuation turn once every tool part of the last assistant message has
 * settled.
 */
export interface PendingInteractions {
  /**
   * Write a client tool's output into the persisted message's matching tool
   * part; publish message:updated; maybe schedule continuation.
   */
  applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void>;
  /**
   * Approval for an approval-gated tool part (execute or deny) or a parked
   * durable-pause execution (delegates to ActionService).
   */
  resolveApproval(args: {
    toolCallId?: string;
    executionId?: string;
    approved: boolean;
    reason?: string;
  }): Promise<void>;
  /**
   * Called after any message mutation: if the last assistant message's tool
   * parts are all settled, debounce then request a continuation turn.
   */
  maybeContinue(message: ChatMessage): void;
  /** Clear debounce timers (used by clearMessages/destroy). */
  cancelPending(): void;
  /**
   * Reaction to ActionService's onResolved callback (fired for both the
   * executionId branch of resolveApproval and a direct top-level
   * approveExecution()/rejectExecution() call): writes the resolution into
   * the matching tool part of whichever transcript message carries that
   * toolCallId, publishes message:updated, and maybe continues. Not part of
   * the audit's literal 4-method sketch — folded in here because the audit's
   * own extraction rationale names the old `onActionResolved` as one of the
   * four call sites this module absorbs, and its shape is identical to
   * applyToolResult's.
   */
  onExecutionResolved(executionId: string, resolution: ParkedResolution): Promise<void>;
  /** True while a debounced continuation timer is armed. */
  hasPendingContinuation(): boolean;
  /** Resolves once no debounced continuation timer remains armed. */
  waitForNoPendingContinuation(): Promise<void>;
}

export interface PendingInteractionsTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export function createPendingInteractions(deps: {
  session: () => Promise<Session>;
  /**
   * Optional (ADR-0002 migration): a bare ChatAgent composes no HITL/actions
   * opinion. Absent, `resolveApproval({ executionId })` throws — the
   * executionId-addressed approval path is meaningless without an
   * ActionService to own parked executions; the toolCallId-addressed path
   * (a suspended client/approval tool part in the transcript) and
   * `applyToolResult` work fully without it.
   */
  actions?: ActionService;
  /** Re-assembled tools for re-executing an approved server tool. */
  tools: () => Promise<AssembledTools>;
  /** The requestId to stamp on a freshly-built ToolExecutionContext. */
  requestId: () => string | undefined;
  publish: (e: ConversationEvent) => void;
  /** Think enqueues a continuation TurnRequest. */
  requestContinuation: () => void;
  debounceMs?: number;
  timers?: PendingInteractionsTimers;
}): PendingInteractions {
  const debounceMs = deps.debounceMs ?? 150;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const continuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stableWaiters: Array<() => void> = [];

  function notifyIfNoPendingContinuation(): void {
    if (continuationTimers.size > 0) return;
    const waiters = stableWaiters;
    stableWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function maybeContinue(message: ChatMessage): void {
    const toolParts = message.parts.filter(isToolPart);
    if (toolParts.length === 0) return;
    const allSettled = toolParts.every(
      (p) => p.state === "output-available" || p.state === "output-error" || p.state === "output-denied",
    );
    if (!allSettled) return;

    const key = message.id;
    const existing = continuationTimers.get(key);
    if (existing !== undefined) timers.clearTimeout(existing);

    const fire = (): void => {
      continuationTimers.delete(key);
      notifyIfNoPendingContinuation();
      deps.requestContinuation();
    };

    if (debounceMs <= 0) {
      fire();
    } else {
      continuationTimers.set(key, timers.setTimeout(fire, debounceMs));
    }
  }

  function publishUpdated(message: ChatMessage): void {
    const requestId = deps.requestId();
    deps.publish({ type: "message:updated", message, ...(requestId ? { requestId } : {}) });
  }

  async function applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void> {
    const session = await deps.session();
    const last = await session.getLatestLeaf();
    if (!last || last.role !== "assistant") return;

    const updatedParts = last.parts.map((p) => {
      if (!isToolPart(p) || p.toolCallId !== args.toolCallId) return p;
      // Results apply to awaiting-execution states — including the approval
      // states (a result implies the client ran it) — but never to a denied
      // or already-settled part (ISSUE-029).
      if (
        p.state !== "input-available" &&
        p.state !== "input-streaming" &&
        p.state !== "approval-requested" &&
        p.state !== "approval-responded"
      ) {
        return p;
      }
      if (args.isError) {
        return {
          ...p,
          state: "output-error",
          errorText: typeof args.output === "string" ? args.output : JSON.stringify(args.output),
        } as MessagePart;
      }
      return { ...p, state: "output-available", output: args.output } as MessagePart;
    });

    const updated: ChatMessage = { ...last, parts: updatedParts };
    await session.updateMessage(updated);
    publishUpdated(updated);
    maybeContinue(updated);
  }

  async function resolveApproval(args: {
    toolCallId?: string;
    executionId?: string;
    approved: boolean;
    reason?: string;
  }): Promise<void> {
    if (args.executionId) {
      if (!deps.actions) {
        throw new ValidationError(
          "resolveApproval({ executionId }) requires an ActionService — this agent composes no actions/HITL opinion",
        );
      }
      if (args.approved) await deps.actions.approveExecution(args.executionId);
      else await deps.actions.rejectExecution(args.executionId, args.reason);
      return;
    }
    if (!args.toolCallId) return;

    const session = await deps.session();
    const last = await session.getLatestLeaf();
    if (!last || last.role !== "assistant") return;
    const part = last.parts.find((p): p is ToolPart => isToolPart(p) && p.toolCallId === args.toolCallId);
    if (!part || part.state !== "approval-requested") return;

    let updatedPart: MessagePart;
    if (!args.approved) {
      // ISSUE-029: denial is its own terminal state, not a generic error.
      updatedPart = {
        ...part,
        state: "output-denied",
        errorText: actionRejectionErrorValue(toolName(part), args.reason).error.message,
      };
    } else {
      const tools = await deps.tools();
      const name = toolName(part);
      if (tools.isClientTool(name)) {
        // ISSUE-029: the server cannot run a client tool — mark the approval
        // answered and wait for the client's cf_agent_tool_result.
        updatedPart = { ...part, state: "approval-responded" };
      } else {
        const ctx: ToolExecutionContext = {
          toolCallId: args.toolCallId,
          requestId: deps.requestId() ?? "",
          messages: await session.getHistory(),
          signal: new AbortController().signal,
        };
        const { output, isError } = await tools.execute(name, part.input, ctx);
        updatedPart = isError
          ? { ...part, state: "output-error", errorText: typeof output === "string" ? output : JSON.stringify(output) }
          : { ...part, state: "output-available", output };
      }
    }

    const updated: ChatMessage = { ...last, parts: last.parts.map((p) => (p === part ? updatedPart : p)) };
    await session.updateMessage(updated);
    publishUpdated(updated);
    maybeContinue(updated);
  }

  async function onExecutionResolved(_executionId: string, resolution: ParkedResolution): Promise<void> {
    const session = await deps.session();
    const history = await session.getHistory();
    const target = history.find((m) => m.parts.some((p) => isToolPart(p) && p.toolCallId === resolution.toolCallId));
    if (!target) return;

    const updatedParts = target.parts.map((p) => {
      if (!isToolPart(p) || p.toolCallId !== resolution.toolCallId) return p;
      if (resolution.rejection) {
        return { ...p, state: "output-error", errorText: resolution.rejection.message } as MessagePart;
      }
      return { ...p, state: "output-available", output: resolution.output } as MessagePart;
    });
    const updated: ChatMessage = { ...target, parts: updatedParts };
    await session.updateMessage(updated);
    publishUpdated(updated);
    maybeContinue(updated);
  }

  return {
    applyToolResult,
    resolveApproval,
    maybeContinue,
    onExecutionResolved,
    hasPendingContinuation() {
      return continuationTimers.size > 0;
    },
    waitForNoPendingContinuation() {
      if (continuationTimers.size === 0) return Promise.resolve();
      return new Promise((resolve) => {
        stableWaiters.push(resolve);
      });
    },
    cancelPending() {
      for (const handle of continuationTimers.values()) timers.clearTimeout(handle);
      continuationTimers.clear();
      notifyIfNoPendingContinuation();
    },
  };
}
