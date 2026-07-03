import { AsyncLocalStorage } from "node:async_hooks";
import { toolCallSpan } from "../../genai/telemetry";
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
      // Captured inside the activation so generator bodies (which resume at
      // the consumer's next() call sites) can be re-entered into the tool
      // span's async context.
      const inSpanContext = AsyncLocalStorage.snapshot() as ContextSnapshot;
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
