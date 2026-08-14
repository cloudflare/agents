/**
 * DEMO MODULE — seam composition: the SAME Workers AI binding, two routes.
 *
 *   env.AI ──> WorkersAiLanguageModel                (src/models/workers-ai.ts)
 *   env.AI ──> workers-ai-provider ──> aiSdkModel    (this file)
 *
 * The direct adapter is dependency-free; this route buys the provider
 * package's maintained streaming and tool-call parsing, plus everything the
 * AI SDK layers on (middleware, wrapLanguageModel, gateways). Both end as
 * the same LanguageModel value in an AgentDefinition — the choice is a
 * one-line edit at the composition edge, which is the demo point.
 *
 * Like ai-sdk.ts: typechecks against vendor/, no local runtime, no fallback.
 */

import { createWorkersAI } from "workers-ai-provider";
import { aiSdkModel } from "./ai-sdk";
import type { LanguageModel } from "../../contract";
import type { AiBinding } from "../../models/workers-ai";

export function workersAiViaAiSdk(
  binding: AiBinding,
  model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
): LanguageModel {
  const workersai = createWorkersAI({ binding: binding as never });
  return aiSdkModel(workersai(model));
}
