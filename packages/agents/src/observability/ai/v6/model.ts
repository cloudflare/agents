import { modelCallSpan } from "../../genai/telemetry";
import type { AgentTracer } from "../../tracing/tracer";
import {
  extractInputContent,
  extractModelInfo,
  extractRequestSummary,
  finishAttributesFromResult
} from "./extract";
import type { ModelInfo } from "./extract";
import { finishWhenStreamCompletes } from "./streams";
import type { ContentRecording } from "./tools";
import type { AISDKV6WrapLanguageModel } from "./types";

export function wrapModel(
  tracer: AgentTracer,
  wrapLanguageModel: AISDKV6WrapLanguageModel | undefined,
  model: unknown,
  parentOperation: string,
  content: ContentRecording
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
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const span = modelCallSpanForModel(
          "doGenerate",
          modelInfo,
          params,
          parentOperation,
          content
        );
        return tracer.withSpan(
          span.name,
          span.attributes,
          async (modelCall) => {
            const result = await doGenerate();
            modelCall.finish(
              finishAttributesFromResult(result, {
                includeResponse: true,
                recordOutputs: content.recordOutputs
              })
            );
            return result;
          }
        );
      },
      wrapStream: async ({ doStream, params }) => {
        const span = modelCallSpanForModel(
          "doStream",
          modelInfo,
          params,
          parentOperation,
          content
        );
        // The provider call runs INSIDE the activation callback so its work
        // (fetch subrequests, etc.) nests under the chat span; the span stays
        // caller-owned because the stream outlives the callback.
        return tracer.openSpan(
          span.name,
          span.attributes,
          async (modelCall) => {
            try {
              const startedAtMs = Date.now();
              const result = await doStream();
              return finishWhenStreamCompletes(result, modelCall, {
                includeResponse: true,
                recordOutputs: content.recordOutputs,
                startedAtMs
              });
            } catch (cause: unknown) {
              modelCall.fail(cause);
              throw cause;
            }
          }
        );
      }
    }
  });
}

function modelCallSpanForModel(
  operation: string,
  model: ModelInfo | undefined,
  params: unknown,
  parentOperation: string,
  content: ContentRecording
): ReturnType<typeof modelCallSpan> {
  const record =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)
      : {};
  return modelCallSpan({
    content: content.recordInputs
      ? { inputMessages: extractInputContent(record) }
      : undefined,
    integration: "ai-sdk",
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(record, parentOperation)
  });
}
