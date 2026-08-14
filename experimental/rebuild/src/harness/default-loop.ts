/**
 * The default AgentLoop: assemble context → generate → execute tool calls →
 * commit, one step per model invocation.
 *
 * The at-least-once discipline (residue 2) lives here and is view-first:
 * before generating, the step reads the newest turn-tagged messages and
 * decides whether the work already happened —
 * - newest assistant message with NO tool calls → the final answer is already
 *   committed (a crash ate only the marker) → completed, no regeneration.
 * - newest assistant message WITH unresolved tool calls → resume by executing
 *   those calls; the Ledger makes re-execution safe (settled calls replay
 *   their recorded result).
 *
 * Tool results are committed as tool-role carrier messages (Role gained
 * "tool" in ADR 0004); LanguageModel adapters map them to their provider's
 * tool-message format.
 */

import type {
  AgentLoop,
  Entry,
  MessagePayload,
  NewEntry,
  Part,
  SettleOutcome,
  StepDeps,
  StepOutcome,
  ToolOutcome
} from "../contract.js";

export interface DefaultLoopOptions {
  /** Abort a generate() whose stream goes silent for this long. */
  readonly stallTimeoutMs?: number;
}

export function defaultLoop(opts: DefaultLoopOptions = {}): AgentLoop {
  return {
    async step(deps: StepDeps): Promise<StepOutcome> {
      // ---- rehydrate: what does the log already show for this turn? ----
      const recent = await deps.view.query({
        kinds: ["message"],
        turn: deps.turn.turnId,
        limit: 12
      });
      const resume = classifyResume(recent);
      if (resume.kind === "already-answered") {
        return { outcome: "completed" };
      }
      if (resume.kind === "unresolved-tools") {
        return executeCalls(deps, resume.calls);
      }

      // ---- fresh step: assemble → generate ----
      const catalog = await deps.tools.catalog();
      const request = await deps.context.assemble({
        view: deps.view,
        turn: deps.turn,
        tools: catalog,
        budget: {}
      });

      const stall = new AbortController();
      const signal = anySignal(deps.signal, stall.signal);
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStall = () => {
        if (opts.stallTimeoutMs === undefined) return;
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stall.abort(), opts.stallTimeoutMs);
        (stallTimer as unknown as { unref?: () => void }).unref?.();
      };
      armStall();

      let output;
      try {
        output = await deps.model.generate(request, {
          onChunk: (chunk) => {
            armStall();
            deps.write(chunk as unknown as Parameters<typeof deps.write>[0]);
          },
          signal
        });
      } catch (error) {
        const kind = deps.model.classifyError(error);
        return {
          outcome: "failed",
          message: `model ${kind}: ${error instanceof Error ? error.message : String(error)}`,
          retryable:
            kind === "transient" ||
            kind === "rate-limit" ||
            kind === "context-overflow"
        };
      } finally {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      }

      const assistant: MessagePayload = {
        kind: "message",
        v: 1,
        role: "assistant",
        parts: output.parts
      };
      await deps.commit([message(deps, assistant)]);

      if (output.finish === "stop") {
        return { outcome: "completed" };
      }
      if (output.finish === "tool-calls") {
        const calls = output.parts.filter(
          (p): p is Extract<Part, { type: "tool-call" }> =>
            p.type === "tool-call"
        );
        return executeCalls(deps, calls);
      }
      return {
        outcome: "failed",
        message: `model finished with ${output.finish}`,
        retryable: output.finish === "length"
      };
    }
  };
}

// ---------------------------------------------------------------------------

type ToolCallPart = Extract<Part, { type: "tool-call" }>;

function classifyResume(
  newestFirst: readonly Entry[]
):
  | { kind: "fresh" }
  | { kind: "already-answered" }
  | { kind: "unresolved-tools"; calls: readonly ToolCallPart[] } {
  // Find the newest assistant message; anything newer than it can only be
  // tool-result carrier messages (partial results committed before a park).
  const i = newestFirst.findIndex(
    (e) => (e.payload as MessagePayload).role === "assistant"
  );
  if (i === -1) return { kind: "fresh" };
  const assistant = newestFirst[i].payload as MessagePayload;
  const calls = assistant.parts.filter(
    (p): p is ToolCallPart => p.type === "tool-call"
  );
  if (calls.length === 0) {
    // A final answer with no calls: if it is the newest message, the turn is
    // already answered (the crash ate only the marker).
    return i === 0 ? { kind: "already-answered" } : { kind: "fresh" };
  }
  const resolved = new Set<string>();
  for (const entry of newestFirst.slice(0, i)) {
    for (const part of (entry.payload as MessagePayload).parts) {
      if (part.type === "tool-result") resolved.add(part.callId);
    }
  }
  const unresolved = calls.filter((c) => !resolved.has(c.callId));
  if (unresolved.length === 0) return { kind: "fresh" };
  // The Ledger makes re-execution of already-settled calls safe (replay).
  return { kind: "unresolved-tools", calls: unresolved };
}

export async function executeCalls(
  deps: StepDeps,
  calls: readonly ToolCallPart[]
): Promise<StepOutcome> {
  const results: Part[] = [];
  for (const call of calls) {
    const outcome: ToolOutcome = await deps.tools.execute({
      callId: call.callId,
      name: call.name,
      input: call.input
    });
    if (outcome.status === "awaiting-approval") {
      if (results.length > 0) await commitResults(deps, results);
      return { outcome: "parked", reason: `awaiting approval: ${call.name}` };
    }
    if (outcome.status === "pending") {
      if (results.length > 0) await commitResults(deps, results);
      return { outcome: "parked", reason: `pending effect: ${call.name}` };
    }
    results.push(toolResultPart(call, outcome.result));
  }
  await commitResults(deps, results);
  return { outcome: "continue" };
}

function toolResultPart(call: ToolCallPart, result: SettleOutcome): Part {
  if (result.status === "ok") {
    return { type: "tool-result", callId: call.callId, output: result.output };
  }
  const message =
    result.status === "error"
      ? result.message
      : result.status === "aborted"
        ? `aborted: ${result.reason ?? "aborted"}`
        : `expired: ${result.reason}`;
  return {
    type: "tool-result",
    callId: call.callId,
    output: message,
    isError: true
  };
}

async function commitResults(
  deps: StepDeps,
  results: readonly Part[]
): Promise<void> {
  const payload: MessagePayload = {
    kind: "message",
    v: 1,
    role: "tool",
    parts: results
  };
  await deps.commit([message(deps, payload)]);
}

function message(deps: StepDeps, payload: MessagePayload): NewEntry {
  return {
    origin: { module: "harness" },
    turn: deps.turn.turnId,
    payload
  } as NewEntry;
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return controller.signal;
}
