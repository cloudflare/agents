import { aiGatewayLogAttributes, modelCallSpan } from "../../genai/telemetry";
import type { SemanticContext } from "../../genai/telemetry";
import { writeSpanAttributes } from "../../tracing/tracer";
import type { AgentSpan, AgentTracer } from "../../tracing/tracer";
import {
  captureAIGatewayLogFromModel,
  extractAIGatewayLogId
} from "../ai-gateway";
import { inputMessageAttributes, outputMessageAttributes } from "../content";
import {
  extractModelInfo,
  extractRequestSummary,
  finishAttributesFromResult
} from "./extract";
import type { ModelInfo } from "./extract";
import { finishWhenStreamCompletes } from "./streams";
import type { AISDKV6WrapLanguageModel } from "./types";

export function wrapModel(
  tracer: AgentTracer,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  model: unknown,
  parentOperation: string,
  storeMessages: boolean,
  context: SemanticContext
): unknown {
  if (!wrapLanguageModel) {
    return model;
  }

  // Gateway-style string model ids can't take middleware; leave them to the
  // SDK's own resolution (the operation root span still carries the model).
  if (typeof model !== "object" || model === null) {
    return model;
  }

  const modelInfo = extractModelInfo(model);
  const aiGatewayLog = captureAIGatewayLogFromModel(model, modelInfo?.provider);
  return wrapLanguageModel({
    model: aiGatewayLog.model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const span = modelCallSpanForModel(
          "doGenerate",
          modelInfo,
          params,
          parentOperation,
          storeMessages,
          context
        );
        return tracer.withSpan(
          span.name,
          span.attributes,
          async (modelCall) => {
            aiGatewayLog.reset();
            try {
              const result = await doGenerate();
              modelCall.finish({
                ...finishAttributesFromResult(result, {
                  aiGatewayLogId:
                    extractAIGatewayLogId(result) ?? aiGatewayLog.get(),
                  includeResponse: true
                }),
                ...outputMessageAttributes(result, storeMessages)
              });
              return result;
            } catch (cause: unknown) {
              recordAIGatewayLogOnError(modelCall, cause, aiGatewayLog.get());
              throw cause;
            }
          }
        );
      },
      wrapStream: async ({ doStream, params }) => {
        const span = modelCallSpanForModel(
          "doStream",
          modelInfo,
          params,
          parentOperation,
          storeMessages,
          context
        );
        // The provider call runs INSIDE the activation callback so its work
        // (fetch subrequests, etc.) nests under the chat span; the span stays
        // caller-owned because the stream outlives the callback.
        return tracer.openSpan(
          span.name,
          span.attributes,
          async (modelCall) => {
            aiGatewayLog.reset();
            try {
              const startedAtMs = Date.now();
              const result = await doStream();
              return finishWhenStreamCompletes(result, modelCall, {
                aiGatewayLogId:
                  extractAIGatewayLogId(result) ?? aiGatewayLog.get(),
                includeAIGatewayLog: true,
                includeResponse: true,
                storeMessages,
                startedAtMs
              });
            } catch (cause: unknown) {
              recordAIGatewayLogOnError(modelCall, cause, aiGatewayLog.get());
              modelCall.fail(cause);
              throw cause;
            }
          }
        );
      }
    }
  });
}

function recordAIGatewayLogOnError(
  span: AgentSpan,
  cause: unknown,
  capturedLogId: string | undefined
): void {
  writeSpanAttributes(
    span,
    aiGatewayLogAttributes(extractAIGatewayLogId(cause) ?? capturedLogId)
  );
}

function modelCallSpanForModel(
  operation: string,
  model: ModelInfo | undefined,
  params: unknown,
  parentOperation: string,
  storeMessages: boolean,
  context: SemanticContext
): ReturnType<typeof modelCallSpan> {
  const record =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};
  const span = modelCallSpan({
    context,
    integration: "ai-sdk",
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(record, parentOperation)
  });
  return {
    ...span,
    attributes: {
      ...span.attributes,
      ...inputMessageAttributes(record, storeMessages)
    }
  };
}
