import { modelCallSpan } from "../../genai/telemetry";
import type { AgentTracer } from "../../tracing/tracer";
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
  parentOperation: string
): unknown {
  if (!wrapLanguageModel) {
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
          parentOperation
        );
        return tracer.withSpan(
          span.name,
          span.attributes,
          async (modelCall) => {
            const result = await doGenerate();
            modelCall.finish(finishAttributesFromResult(result));
            return result;
          }
        );
      },
      wrapStream: async ({ doStream, params }) => {
        const span = modelCallSpanForModel(
          "doStream",
          modelInfo,
          params,
          parentOperation
        );
        const modelCall = tracer.openSpan(
          span.name,
          span.attributes,
          (span) => span
        );

        try {
          const result = await doStream();
          return finishWhenStreamCompletes(result, modelCall);
        } catch (cause: unknown) {
          modelCall.fail(cause);
          throw cause;
        }
      }
    }
  });
}

function modelCallSpanForModel(
  operation: string,
  model: ModelInfo | undefined,
  params: unknown,
  parentOperation: string
): ReturnType<typeof modelCallSpan> {
  return modelCallSpan({
    integration: "ai-sdk",
    model: model?.modelId,
    operation,
    provider: model?.provider,
    request: extractRequestSummary(
      // SAFETY: AI SDK middleware params are records; only known numeric fields are read via readNumber.
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)
        : {},
      parentOperation
    )
  });
}
