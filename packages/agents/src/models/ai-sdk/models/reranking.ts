/**
 * Reranking over the Cloudflare run path.
 *
 * The BAAI rerankers take `{ query, contexts: [{ text }], top_k? }` and answer
 * `{ response: [{ id, score }] }`, where `id` is the index of the context in
 * the request — which is exactly the AI SDK's `ranking` shape once renamed.
 */

import type {
  JSONObject,
  RerankingModelV4,
  RerankingModelV4CallOptions,
  RerankingModelV4Result,
  SharedV4Warning
} from "@ai-sdk/provider";
import type { ModelOptions } from "../settings";
import { array, count, record } from "../wires/shared";
import {
  CloudflareModalityModel,
  type ModalityConfig,
  type ModalityRequest
} from "./modality";

/** Builds the run-path body for one reranking leg. */
export function buildRerankingRequest(
  options: RerankingModelV4CallOptions
): ModalityRequest {
  const warnings: SharedV4Warning[] = [];
  const documents =
    options.documents.type === "text"
      ? options.documents.values
      : options.documents.values.map((value) => JSON.stringify(value));
  if (options.documents.type === "object") {
    warnings.push({
      details: "Object documents are sent as JSON text.",
      feature: "documents",
      type: "compatibility"
    });
  }

  const input: Record<string, unknown> = {
    contexts: documents.map((value) => ({ text: value })),
    query: options.query
  };
  if (options.topN !== undefined) input.top_k = options.topN;
  return { input, warnings };
}

/**
 * A `RerankingModelV4` over the Workers AI reranker catalog.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareRerankingModel
  extends CloudflareModalityModel
  implements RerankingModelV4
{
  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: ModalityConfig
  ) {
    super(modelId, options, config);
  }

  async doRerank(
    options: RerankingModelV4CallOptions
  ): Promise<RerankingModelV4Result> {
    const answer = await this.send({
      abortSignal: options.abortSignal,
      build: () => buildRerankingRequest(options),
      headers: options.headers,
      providerOptions: options.providerOptions
    });

    const body = record(answer.json) ?? {};
    const ranking = (array(body.response) ?? []).flatMap((entry) => {
      const row = record(entry);
      const index = count(row?.id);
      const relevanceScore = count(row?.score);
      if (index === undefined || relevanceScore === undefined) return [];
      return [{ index, relevanceScore }];
    });
    // The live model already answers in descending score order; sorting makes
    // that a guarantee of this provider rather than of one model.
    ranking.sort((left, right) => right.relevanceScore - left.relevanceScore);

    return {
      providerMetadata: answer.providerMetadata as Record<string, JSONObject>,
      ranking,
      response: {
        body: answer.json,
        headers: answer.headers,
        modelId: answer.modelId,
        timestamp: answer.timestamp
      },
      warnings: answer.warnings
    };
  }
}
