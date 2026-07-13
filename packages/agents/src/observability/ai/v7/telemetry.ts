import { readString } from "../read";
import {
  modelCallSpan,
  operationSpan,
  toolCallSpan
} from "../../genai/telemetry";
import type { TraceAttributes } from "../../tracing/tracer";
import type { AgentSpan, AgentTracer } from "../../tracing/tracer";
import {
  correlationAttributes,
  finishAttributesFromEvent,
  operationNameFromId,
  requestSummaryFromEvent,
  semanticContextFromEvent
} from "./extract";
import type {
  AISDKV7ExecuteLanguageModelOptions,
  AISDKV7ExecuteToolOptions,
  AISDKV7OperationEvent,
  AISDKV7Telemetry
} from "./types";

type AISDKV7OperationName =
  | "generateObject"
  | "generateText"
  | "streamObject"
  | "streamText";

type OperationState = {
  readonly callId: string;
  readonly operationName: AISDKV7OperationName;
  readonly span: AgentSpan;
};

type ModelState = {
  readonly spanSpec: ReturnType<typeof modelCallSpan>;
  span?: AgentSpan | undefined;
};

type ToolState = {
  readonly callId: string;
  readonly spanSpec: ReturnType<typeof toolCallSpan>;
  span?: AgentSpan | undefined;
};

/** Tracing configuration for the AI SDK v7 telemetry adapter. */
export type AISDKV7Instrumentation = {
  readonly tracer: AgentTracer;
};

/**
 * Creates an AI SDK v7 `Telemetry` object that projects callback events into
 * Cloudflare-compatible GenAI spans without recording raw prompts or outputs.
 */
export function createAISDKV7Telemetry(
  instrumentation: AISDKV7Instrumentation
): AISDKV7Telemetry {
  const operations = new Map<string, OperationState>();
  const modelSpans = new Map<string, ModelState[]>();
  // Keyed by `${callId}:${toolCallId}` — concurrent operations can reuse a
  // provider tool-call id, and a flat key would let one overwrite/finish the
  // other's span.
  const toolSpans = new Map<string, ToolState>();
  const toolSpanKey = (callId: string, toolCallId: string): string =>
    `${callId}:${toolCallId}`;

  const finishOperation = (event: AISDKV7OperationEvent): void => {
    const state = operations.get(event.callId);
    if (!state) {
      return;
    }

    finishOpenModelSpans(
      event.callId,
      undefined,
      modelSpans,
      instrumentation.tracer
    );
    finishOpenToolSpans(
      event.callId,
      undefined,
      toolSpans,
      instrumentation.tracer
    );
    state.span.finish(finishAttributesFromEvent(event));
    operations.delete(event.callId);
  };

  return {
    onStart(event) {
      const operationName = supportedOperationName(
        operationNameFromId(event.operationId)
      );
      if (!operationName) {
        return;
      }

      const span = operationSpan({
        attributes: {
          ...correlationAttributes({ callId: event.callId }),
          ...runtimeContextAttributes(event.runtimeContext)
        },
        context: semanticContextFromEvent(event),
        integration: "ai-sdk",
        model: readString(event.modelId),
        operation: operationName,
        provider: readString(event.provider),
        request: requestSummaryFromEvent(event, operationName)
      });
      const operation = instrumentation.tracer.openSpan(
        span.name,
        span.attributes,
        (activeSpan) => activeSpan
      );
      operations.set(event.callId, {
        callId: event.callId,
        operationName,
        span: operation
      });
    },

    onLanguageModelCallStart(event) {
      const state = operations.get(event.callId);
      if (!state) {
        return;
      }

      const span = modelCallSpan({
        attributes: correlationAttributes({ callId: event.callId }),
        integration: "ai-sdk",
        model: readString(event.modelId),
        operation: isStreamOperation(state.operationName)
          ? "doStream"
          : "doGenerate",
        provider: readString(event.provider),
        request: requestSummaryFromEvent(event, state.operationName)
      });
      const spans = modelSpans.get(event.callId) ?? [];
      spans.push({ spanSpec: span });
      modelSpans.set(event.callId, spans);
    },

    onLanguageModelCallEnd(event) {
      const state = shiftModelSpan(modelSpans, event.callId);
      if (!state) {
        return;
      }

      const span =
        state.span ??
        instrumentation.tracer.openSpan(
          state.spanSpec.name,
          state.spanSpec.attributes,
          (activeSpan) => activeSpan
        );
      span.finish(
        finishAttributesFromEvent(event, {
          includePerformance: true,
          includeResponse: true
        })
      );
    },

    onToolExecutionStart(event) {
      const toolCallId = readString(event.toolCall.toolCallId);
      if (toolCallId === undefined || !operations.has(event.callId)) {
        return;
      }

      const toolName = readString(event.toolCall.toolName) ?? "tool";
      const span = toolCallSpan({
        integration: "ai-sdk",
        operation: "tool.execute",
        toolName
      });
      toolSpans.set(toolSpanKey(event.callId, toolCallId), {
        callId: event.callId,
        spanSpec: {
          name: span.name,
          attributes: {
            ...span.attributes,
            ...correlationAttributes({ callId: event.callId, toolCallId }),
            ...toolContextAttributes(toolName, event.toolContext)
          }
        }
      });
    },

    onToolExecutionEnd(event) {
      const toolCallId = readString(event.toolCall.toolCallId);
      if (toolCallId === undefined) {
        return;
      }

      const state = toolSpans.get(toolSpanKey(event.callId, toolCallId));
      if (!state) {
        return;
      }

      const span =
        state.span ??
        instrumentation.tracer.openSpan(
          state.spanSpec.name,
          state.spanSpec.attributes,
          (activeSpan) => activeSpan
        );
      if (event.toolOutput?.type === "tool-error") {
        span.fail(event.toolOutput.error);
      } else {
        span.finish();
      }
      toolSpans.delete(toolSpanKey(event.callId, toolCallId));
    },

    onAbort(event) {
      const cause = { name: "AbortError" };
      finishOpenModelSpans(
        event.callId,
        cause,
        modelSpans,
        instrumentation.tracer
      );
      finishOpenToolSpans(
        event.callId,
        cause,
        toolSpans,
        instrumentation.tracer
      );

      const state = operations.get(event.callId);
      if (!state) {
        return;
      }

      state.span.fail(cause);
      operations.delete(event.callId);
    },

    onEnd: finishOperation,

    onError(event) {
      const errorEvent = eventObject(event);
      const callId = readString(errorEvent.callId);
      if (callId === undefined) {
        return;
      }

      const cause = errorEvent.error ?? event;
      finishOpenModelSpans(callId, cause, modelSpans, instrumentation.tracer);
      finishOpenToolSpans(callId, cause, toolSpans, instrumentation.tracer);

      const state = operations.get(callId);
      if (!state) {
        return;
      }

      state.span.fail(cause);
      operations.delete(callId);
    },

    executeLanguageModelCall<T>(
      options: AISDKV7ExecuteLanguageModelOptions<T>
    ): PromiseLike<T> {
      const states = modelSpans.get(options.callId);
      const state = states?.find((candidate) => candidate.span === undefined);
      if (!state) {
        return options.execute();
      }

      return instrumentation.tracer.openSpan(
        state.spanSpec.name,
        state.spanSpec.attributes,
        (span) => {
          state.span = span;
          try {
            return Promise.resolve(options.execute()).catch(
              (cause: unknown) => {
                span.fail(cause);
                removeModelState(modelSpans, options.callId, state);
                throw cause;
              }
            );
          } catch (cause: unknown) {
            span.fail(cause);
            removeModelState(modelSpans, options.callId, state);
            throw cause;
          }
        }
      );
    },

    executeTool<T>(options: AISDKV7ExecuteToolOptions<T>): PromiseLike<T> {
      const state = toolSpans.get(
        toolSpanKey(options.callId, options.toolCallId)
      );
      if (!state) {
        return options.execute();
      }

      return instrumentation.tracer.openSpan(
        state.spanSpec.name,
        state.spanSpec.attributes,
        (span) => {
          state.span = span;
          try {
            return Promise.resolve(options.execute()).catch(
              (cause: unknown) => {
                span.fail(cause);
                toolSpans.delete(
                  toolSpanKey(options.callId, options.toolCallId)
                );
                throw cause;
              }
            );
          } catch (cause: unknown) {
            span.fail(cause);
            toolSpans.delete(toolSpanKey(options.callId, options.toolCallId));
            throw cause;
          }
        }
      );
    }
  };
}

function supportedOperationName(
  operationName: string
): AISDKV7OperationName | undefined {
  if (
    operationName === "generateObject" ||
    operationName === "generateText" ||
    operationName === "streamObject" ||
    operationName === "streamText"
  ) {
    return operationName;
  }

  return undefined;
}

function isStreamOperation(operationName: AISDKV7OperationName): boolean {
  return operationName === "streamObject" || operationName === "streamText";
}

function shiftModelSpan(
  spansByCallId: Map<string, ModelState[]>,
  callId: string
): ModelState | undefined {
  const spans = spansByCallId.get(callId);
  const span = spans?.shift();
  if (spans && spans.length === 0) {
    spansByCallId.delete(callId);
  }

  return span;
}

function removeModelState(
  statesByCallId: Map<string, ModelState[]>,
  callId: string,
  state: ModelState
): void {
  const states = statesByCallId.get(callId);
  if (!states) {
    return;
  }
  const index = states.indexOf(state);
  if (index !== -1) {
    states.splice(index, 1);
  }
  if (states.length === 0) {
    statesByCallId.delete(callId);
  }
}

function finishOpenModelSpans(
  callId: string,
  cause: unknown,
  spansByCallId: Map<string, ModelState[]>,
  tracer: AgentTracer
): void {
  const states = spansByCallId.get(callId);
  if (!states) {
    return;
  }

  for (const state of states) {
    const span =
      state.span ??
      tracer.openSpan(
        state.spanSpec.name,
        state.spanSpec.attributes,
        (activeSpan) => activeSpan
      );
    if (cause === undefined) {
      span.finish();
    } else {
      span.fail(cause);
    }
  }
  spansByCallId.delete(callId);
}

function finishOpenToolSpans(
  callId: string,
  cause: unknown,
  spansByToolCallId: Map<string, ToolState>,
  tracer: AgentTracer
): void {
  for (const [toolCallId, state] of spansByToolCallId) {
    if (state.callId !== callId) {
      continue;
    }

    const span =
      state.span ??
      tracer.openSpan(
        state.spanSpec.name,
        state.spanSpec.attributes,
        (activeSpan) => activeSpan
      );
    if (cause === undefined) {
      span.finish();
    } else {
      span.fail(cause);
    }
    spansByToolCallId.delete(toolCallId);
  }
}

function eventObject(event: unknown): Record<string, unknown> {
  return typeof event === "object" && event !== null
    ? (event as Record<string, unknown>)
    : {};
}

const SEMANTIC_CONTEXT_KEYS = new Set([
  "agentId",
  "agentName",
  "agentVersion",
  "conversationId",
  "gen_ai.agent.id",
  "gen_ai.agent.name",
  "gen_ai.agent.version",
  "gen_ai.conversation.id"
]);

function runtimeContextAttributes(
  runtimeContextValue: unknown
): TraceAttributes {
  const attributes: Record<string, string | number | boolean> = {};
  const runtimeContext = recordValue(runtimeContextValue);
  for (const [key, value] of Object.entries(runtimeContext ?? {})) {
    if (!SEMANTIC_CONTEXT_KEYS.has(key) && isScalarAttributeValue(value)) {
      attributes[`cloudflare.agents.runtime_context.${key}`] = value;
    }
  }

  return attributes;
}

function toolContextAttributes(
  toolName: string,
  toolContextValue: unknown
): TraceAttributes {
  const attributes: Record<string, string | number | boolean> = {};
  const toolContext = recordValue(toolContextValue);
  for (const [key, value] of Object.entries(toolContext ?? {})) {
    if (isScalarAttributeValue(value)) {
      attributes[`cloudflare.agents.tool_context.${toolName}.${key}`] = value;
    }
  }

  return attributes;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isScalarAttributeValue(
  value: unknown
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
