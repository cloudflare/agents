import { AsyncLocalStorage } from "node:async_hooks";
import { toolApprovalSpan, toolCallSpan } from "../../genai/telemetry";
import { readString } from "../read";
import type { AgentSpan, AgentTracer } from "../../tracing/tracer";

/** Context snapshot type returned by AsyncLocalStorage.snapshot(). */
type ContextSnapshot = <R>(fn: () => R) => R;

export function wrapTools(tracer: AgentTracer, tools: unknown): unknown {
  if (typeof tools !== "object" || tools === null) {
    return tools;
  }

  // SAFETY: AI SDK tools are a record of named tool objects.
  const toolRecord = tools as Record<string, unknown>;
  const wrappedTools: Record<string, unknown> = {};
  for (const [toolName, tool] of Object.entries(toolRecord)) {
    wrappedTools[toolName] = wrapTool(tracer, toolName, tool);
  }
  return wrappedTools;
}

function wrapTool(
  tracer: AgentTracer,
  toolName: string,
  tool: unknown
): unknown {
  if (typeof tool !== "object" || tool === null) {
    return tool;
  }

  // SAFETY: AI SDK tool objects have optional execute / needsApproval fields.
  const toolRecord = tool as Record<string, unknown>;
  const hasExecute = typeof toolRecord.execute === "function";
  const hasApproval =
    typeof toolRecord.needsApproval === "boolean" ||
    typeof toolRecord.needsApproval === "function";
  if (!hasExecute && !hasApproval) {
    return tool;
  }

  const wrappedTool = Object.assign(
    Object.create(Object.getPrototypeOf(tool)),
    tool
  ) as Record<string, unknown> & {
    execute: (...args: readonly unknown[]) => unknown;
  };
  if (hasApproval) {
    wrapApprovalCheck(tracer, wrappedTool, toolRecord, tool, toolName);
  }
  if (!hasExecute) {
    return wrappedTool;
  }

  const execute = toolRecord.execute;
  if (typeof execute !== "function") {
    return wrappedTool;
  }
  const originalExecute = execute.bind(tool) as (
    ...args: readonly unknown[]
  ) => unknown;

  wrappedTool.execute = (...args) => {
    const span = toolCallSpan({
      integration: "ai-sdk",
      operation: "tool.execute",
      toolCallId: extractToolCallId(args[1]),
      toolName
    });
    // The span may outlive this call frame (streaming tools yield after
    // returning), so the wrapper owns the span lifetime via openSpan.
    return tracer.openSpan(span.name, span.attributes, (toolSpan) => {
      // Captured inside the activation so generator bodies (which resume at
      // the consumer's next() call sites) can be re-entered into the tool
      // span's async context.
      const inSpanContext = AsyncLocalStorage.snapshot() as ContextSnapshot;
      const approval = approvalResponseForOptions(
        args[1],
        extractToolCallId(args[1])
      );
      if (approval?.approved === true) {
        recordApprovalChild(tracer, toolName, approval.toolCallId, "approved");
      }
      const result = originalExecute(...args);

      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (resolved) => settleToolResult(resolved, toolSpan, inSpanContext),
          (cause: unknown) => {
            toolSpan.fail(cause);
            throw cause;
          }
        );
      }

      return settleToolResult(result, toolSpan, inSpanContext);
    });
  };

  return wrappedTool;
}

function wrapApprovalCheck(
  tracer: AgentTracer,
  wrappedTool: Record<string, unknown>,
  toolRecord: Record<string, unknown>,
  tool: object,
  toolName: string
): void {
  const approval = toolRecord.needsApproval;
  const original =
    typeof approval === "function"
      ? (approval.bind(tool) as (...args: readonly unknown[]) => unknown)
      : undefined;

  wrappedTool.needsApproval = (...args: readonly unknown[]) => {
    const result = original ? original(...args) : approval;
    const recordRequested = (needed: unknown): unknown => {
      const toolCallId = extractToolCallId(args[1]);
      if (needed === true && !hasApprovalResponse(args[1], toolCallId)) {
        recordApprovalSegment(tracer, toolName, toolCallId, "requested");
      }
      return needed;
    };

    return isPromiseLike(result)
      ? Promise.resolve(result).then(recordRequested)
      : recordRequested(result);
  };
}

/** Records denied responses, whose tool never reaches execute(). */
export function recordDeniedApprovalResponses(
  tracer: AgentTracer,
  messages: unknown
): void {
  for (const response of approvalResponses(messages)) {
    if (!response.approved) {
      recordApprovalSegment(
        tracer,
        response.toolName,
        response.toolCallId,
        "denied"
      );
    }
  }
}

function recordApprovalSegment(
  tracer: AgentTracer,
  toolName: string,
  toolCallId: string | undefined,
  state: "approved" | "denied" | "requested"
): void {
  const tool = toolCallSpan({
    integration: "ai-sdk",
    operation: "tool.approval",
    toolCallId,
    toolName
  });
  tracer.withSpan(tool.name, tool.attributes, () => {
    recordApprovalChild(tracer, toolName, toolCallId, state);
  });
}

function recordApprovalChild(
  tracer: AgentTracer,
  toolName: string,
  toolCallId: string | undefined,
  state: "approved" | "denied" | "requested"
): void {
  const approval = toolApprovalSpan({ state, toolCallId, toolName });
  tracer.withSpan(approval.name, approval.attributes, () => undefined);
}

function hasApprovalResponse(
  options: unknown,
  toolCallId: string | undefined
): boolean {
  return approvalResponseForOptions(options, toolCallId) !== undefined;
}

function approvalResponseForOptions(
  options: unknown,
  toolCallId: string | undefined
): ReturnType<typeof approvalResponses>[number] | undefined {
  if (
    toolCallId === undefined ||
    typeof options !== "object" ||
    options === null
  ) {
    return undefined;
  }
  return approvalResponses((options as Record<string, unknown>).messages).find(
    (response) => response.toolCallId === toolCallId
  );
}

function approvalResponses(messagesValue: unknown): Array<{
  readonly approved: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
}> {
  if (!Array.isArray(messagesValue)) {
    return [];
  }

  const approvalToTool = new Map<string, string>();
  const toolNames = new Map<string, string>();
  for (const message of messagesValue) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      const type = readString(record.type);
      if (type === "tool-call") {
        const toolCallId = readString(record.toolCallId);
        const toolName = readString(record.toolName);
        if (toolCallId && toolName) toolNames.set(toolCallId, toolName);
      } else if (type === "tool-approval-request") {
        const approvalId = readString(record.approvalId);
        const toolCallId = readString(record.toolCallId);
        if (approvalId && toolCallId)
          approvalToTool.set(approvalId, toolCallId);
      }
    }
  }

  const lastMessage = messagesValue.at(-1);
  const lastContent =
    typeof lastMessage === "object" && lastMessage !== null
      ? (lastMessage as Record<string, unknown>).content
      : undefined;
  const decisions: Array<{
    readonly approvalId: string;
    readonly approved: boolean;
  }> = [];
  if (Array.isArray(lastContent)) {
    for (const part of lastContent) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "tool-approval-response") continue;
      const approvalId = readString(record.approvalId);
      if (approvalId && typeof record.approved === "boolean") {
        decisions.push({ approvalId, approved: record.approved });
      }
    }
  }

  return decisions.flatMap(({ approvalId, approved }) => {
    const toolCallId = approvalToTool.get(approvalId);
    if (!toolCallId) return [];
    return [
      {
        approved,
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? "tool"
      }
    ];
  });
}

/**
 * Finishes the tool span for a settled result. Streaming tools (async
 * generators) return an iterable whose consumption is the tool's real
 * duration, so the span closes when iteration ends instead of at creation.
 */
function settleToolResult(
  result: unknown,
  span: AgentSpan,
  inSpanContext: ContextSnapshot
): unknown {
  if (isAsyncIterable(result)) {
    return finishWhenIterableCompletes(result, span, inSpanContext);
  }

  span.finish();
  return result;
}

function finishWhenIterableCompletes(
  iterable: AsyncIterable<unknown>,
  span: AgentSpan,
  inSpanContext: ContextSnapshot
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      // Each pull re-enters the tool span's captured async context, so the
      // generator body (which otherwise resumes under the CONSUMER's context)
      // runs — and creates any nested spans — under the tool span.
      const iterator = inSpanContext(() => iterable[Symbol.asyncIterator]());
      let exhausted = false;
      try {
        while (true) {
          const step = await inSpanContext(() => iterator.next());
          if (step.done) {
            exhausted = true;
            return step.value;
          }
          yield step.value;
        }
      } catch (cause: unknown) {
        span.fail(cause);
        throw cause;
      } finally {
        if (!exhausted) {
          // Early consumer termination (break/cancel while suspended at
          // yield): forward return() so the tool generator's own finally
          // blocks run, still inside the tool span's context. A no-op when
          // the underlying iterator already settled (e.g. next() threw).
          try {
            await inSpanContext(() => iterator.return?.(undefined));
          } catch {
            // Cleanup failures must not mask the consumer's exit reason.
          }
        }
        // Covers normal completion and early consumer return; a no-op after
        // fail() since span closure is idempotent.
        span.finish();
      }
    }
  };
}

/** Reads the AI SDK tool-call id from the execute options argument. */
function extractToolCallId(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) {
    return undefined;
  }

  // SAFETY: AI SDK tool execute options carry a toolCallId string field.
  return readString((options as Record<string, unknown>).toolCallId);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}
