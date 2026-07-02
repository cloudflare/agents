import type { AISDKInstrumentationOptions } from "../options.js";
import { readString } from "../read.js";
import {
  modelCallSpan,
  operationSpan,
  toolCallSpan
} from "../../../genai/telemetry.js";
import type { Attributes } from "../../../tracing/tracer.js";
import type { Span, Tracer } from "../../../tracing/tracer.js";
import {
  correlationAttributes,
  finishAttributesFromEvent,
  operationNameFromId,
  requestSummaryFromEvent,
  semanticContextFromEvent
} from "./extract.js";
import type {
  AISDKV7ExecuteToolOptions,
  AISDKV7LanguageModelCallEvent,
  AISDKV7OperationEvent,
  AISDKV7Telemetry,
  AISDKV7ToolExecutionEvent
} from "./types.js";

type AISDKV7OperationName =
  | "generateObject"
  | "generateText"
  | "streamObject"
  | "streamText";

type OperationState = {
  readonly callId: string;
  readonly operationName: AISDKV7OperationName;
  readonly span: Span;
};

type ToolState = {
  readonly callId: string;
  readonly spanSpec: ReturnType<typeof toolCallSpan>;
  span?: Span | undefined;
};

/** Tracing configuration for the AI SDK v7 telemetry adapter. */
export type AISDKV7Instrumentation = {
  readonly options?: AISDKInstrumentationOptions | undefined;
  readonly tracer: Tracer;
};

/**
 * Creates an AI SDK v7 `Telemetry` object that projects callback events into
 * Cloudflare-compatible GenAI spans without recording raw prompts or outputs.
 */
export function createAISDKV7Telemetry(
  instrumentation: AISDKV7Instrumentation
): AISDKV7Telemetry {
  const operations = new Map<string, OperationState>();
  const modelSpans = new Map<string, Span[]>();
  const toolSpans = new Map<string, ToolState>();

  const finishOperation = (event: AISDKV7OperationEvent): void => {
    const state = operations.get(event.callId);
    if (!state) {
      return;
    }

    finishOpenModelSpans(event.callId, undefined, modelSpans);
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
          ...contextAttributes(event)
        },
        context: semanticContextFromEvent(event),
        integration: "ai-sdk",
        model: readString(event.modelId),
        operation: operationName,
        provider: readString(event.provider),
        request: requestSummaryFromEvent(event, operationName)
      });
      const operation = instrumentation.tracer.startSpan(
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
      const modelSpan = instrumentation.tracer.startSpan(
        span.name,
        span.attributes,
        (activeSpan) => activeSpan
      );
      const spans = modelSpans.get(event.callId) ?? [];
      spans.push(modelSpan);
      modelSpans.set(event.callId, spans);
    },

    onLanguageModelCallEnd(event) {
      const span = shiftModelSpan(modelSpans, event.callId);
      if (!span) {
        return;
      }

      span.finish(finishAttributesFromEvent(event));
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
      toolSpans.set(toolCallId, {
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

      const state = toolSpans.get(toolCallId);
      if (!state) {
        return;
      }

      const span =
        state.span ??
        instrumentation.tracer.startSpan(
          state.spanSpec.name,
          state.spanSpec.attributes,
          (activeSpan) => activeSpan
        );
      if (event.toolOutput?.type === "tool-error") {
        span.fail(event.toolOutput.error);
      } else {
        span.finish();
      }
      toolSpans.delete(toolCallId);
    },

    onEnd: finishOperation,
    onFinish: finishOperation,

    onError(event) {
      const errorEvent = eventObject(event);
      const callId = readString(errorEvent.callId);
      if (callId === undefined) {
        return;
      }

      const cause = errorEvent.error ?? event;
      finishOpenModelSpans(callId, cause, modelSpans);
      finishOpenToolSpans(callId, cause, toolSpans, instrumentation.tracer);

      const state = operations.get(callId);
      if (!state) {
        return;
      }

      state.span.fail(cause);
      operations.delete(callId);
    },

    executeTool<T>(options: AISDKV7ExecuteToolOptions<T>): PromiseLike<T> {
      const state = toolSpans.get(options.toolCallId);
      if (!state || state.callId !== options.callId) {
        return options.execute();
      }

      return instrumentation.tracer.startSpan(
        state.spanSpec.name,
        state.spanSpec.attributes,
        (span) => {
          state.span = span;
          try {
            return Promise.resolve(options.execute()).catch(
              (cause: unknown) => {
                span.fail(cause);
                toolSpans.delete(options.toolCallId);
                throw cause;
              }
            );
          } catch (cause: unknown) {
            span.fail(cause);
            toolSpans.delete(options.toolCallId);
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
  spansByCallId: Map<string, Span[]>,
  callId: string
): Span | undefined {
  const spans = spansByCallId.get(callId);
  const span = spans?.shift();
  if (spans && spans.length === 0) {
    spansByCallId.delete(callId);
  }

  return span;
}

function finishOpenModelSpans(
  callId: string,
  cause: unknown,
  spansByCallId: Map<string, Span[]>
): void {
  const spans = spansByCallId.get(callId);
  if (!spans) {
    return;
  }

  for (const span of spans) {
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
  tracer: Tracer
): void {
  for (const [toolCallId, state] of spansByToolCallId) {
    if (state.callId !== callId) {
      continue;
    }

    const span =
      state.span ??
      tracer.startSpan(
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

function contextAttributes(event: {
  readonly runtimeContext?: unknown;
  readonly toolsContext?: unknown;
}): Attributes {
  const attributes: Record<string, string | number | boolean> = {};
  const runtimeContext = recordValue(event.runtimeContext);
  for (const [key, value] of Object.entries(runtimeContext ?? {})) {
    if (isScalarAttributeValue(value)) {
      attributes[`ai.runtime_context.${key}`] = value;
    }
  }

  const toolsContext = recordValue(event.toolsContext);
  for (const [toolName, toolContextValue] of Object.entries(
    toolsContext ?? {}
  )) {
    const toolContext = recordValue(toolContextValue);
    for (const [key, value] of Object.entries(toolContext ?? {})) {
      if (isScalarAttributeValue(value)) {
        attributes[`ai.tool_context.${toolName}.${key}`] = value;
      }
    }
  }

  return attributes;
}

function toolContextAttributes(
  toolName: string,
  toolContextValue: unknown
): Attributes {
  const attributes: Record<string, string | number | boolean> = {};
  const toolContext = recordValue(toolContextValue);
  for (const [key, value] of Object.entries(toolContext ?? {})) {
    if (isScalarAttributeValue(value)) {
      attributes[`ai.tool_context.${toolName}.${key}`] = value;
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
