import { toolCallSpan } from "../../../genai/telemetry.js";
import type { Tracer } from "../../../tracing/tracer.js";

export function wrapTools(
  tracer: Tracer,
  tools: unknown,
): unknown {
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
  tracer: Tracer,
  toolName: string,
  tool: unknown,
): unknown {
  if (typeof tool !== "object" || tool === null) {
    return tool;
  }

  // SAFETY: AI SDK tool objects have an optional execute function.
  const toolRecord = tool as Record<string, unknown>;
  if (typeof toolRecord.execute !== "function") {
    return tool;
  }

  const wrappedTool = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool) as Record<
    string,
    unknown
  > & {
    execute: (...args: readonly unknown[]) => unknown;
  };
  const originalExecute = toolRecord.execute.bind(tool) as (...args: readonly unknown[]) => unknown;

  wrappedTool.execute = (...args) => {
    const span = toolCallSpan({
      integration: "ai-sdk",
      operation: "tool.execute",
      toolName,
    });
    return tracer.withSpan(
      span.name,
      span.attributes,
      (toolSpan) => {
        const result = originalExecute(...args);
        if (isPromiseLike(result)) {
          return Promise.resolve(result).then((resolved) => {
            toolSpan.finish();
            return resolved;
          });
        }

        toolSpan.finish();
        return result;
      },
    );
  };

  return wrappedTool;
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
