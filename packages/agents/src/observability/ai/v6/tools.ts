import { toolCallSpan } from "../../genai/telemetry";
import { readString } from "../read";
import type { AgentSpan, AgentTracer } from "../../tracing/tracer";

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

  // SAFETY: AI SDK tool objects have an optional execute function.
  const toolRecord = tool as Record<string, unknown>;
  if (typeof toolRecord.execute !== "function") {
    return tool;
  }

  const wrappedTool = Object.assign(
    Object.create(Object.getPrototypeOf(tool)),
    tool
  ) as Record<string, unknown> & {
    execute: (...args: readonly unknown[]) => unknown;
  };
  const originalExecute = toolRecord.execute.bind(tool) as (
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
      const result = originalExecute(...args);

      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (resolved) => settleToolResult(resolved, toolSpan),
          (cause: unknown) => {
            toolSpan.fail(cause);
            throw cause;
          }
        );
      }

      return settleToolResult(result, toolSpan);
    });
  };

  return wrappedTool;
}

/**
 * Finishes the tool span for a settled result. Streaming tools (async
 * generators) return an iterable whose consumption is the tool's real
 * duration, so the span closes when iteration ends instead of at creation.
 */
function settleToolResult(result: unknown, span: AgentSpan): unknown {
  if (isAsyncIterable(result)) {
    return finishWhenIterableCompletes(result, span);
  }

  span.finish();
  return result;
}

function finishWhenIterableCompletes(
  iterable: AsyncIterable<unknown>,
  span: AgentSpan
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of iterable) {
          yield chunk;
        }
      } catch (cause: unknown) {
        span.fail(cause);
        throw cause;
      } finally {
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
