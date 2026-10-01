import {
  TooManyEmbeddingValuesForCallError,
  type EmbeddingModelV4,
  type EmbeddingModelV4CallOptions,
  type EmbeddingModelV4Result
} from "@ai-sdk/provider";
import {
  parseCallOptions,
  resolveOptions,
  type ModelOptions
} from "../settings";
import {
  definedHeaders,
  errorFromResponse,
  headersToObject,
  unwrapEnvelope,
  type Transport
} from "../transport";
import { withFallback } from "./fallback";
import type { LanguageModelConfig } from "./language";
import { array, count, record } from "../wires/shared";
import { requireWorkersAIId } from "../errors";

/**
 * Workers AI batches up to this many strings per embedding call.
 *
 * @see https://developers.cloudflare.com/workers-ai/platform/limits/
 */
const MAX_EMBEDDINGS_PER_CALL = 3000;

/**
 * An `EmbeddingModelV4` over the Workers AI text-embedding catalog. The run
 * path takes `{ text: string[] }` and answers `{ data, shape, usage }`,
 * sometimes inside the Cloudflare envelope.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareEmbeddingModel implements EmbeddingModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "cloudflare";
  readonly modelId: string;
  readonly maxEmbeddingsPerCall = MAX_EMBEDDINGS_PER_CALL;
  readonly supportsParallelCalls = true;

  readonly #config: LanguageModelConfig;
  readonly #options: ModelOptions | undefined;

  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: LanguageModelConfig
  ) {
    // A leg written as a string is a Workers AI id, and nothing else: the
    // same gate the language models apply, at the line that wrote the leg.
    options?.fallback?.forEach((leg) => {
      if (typeof leg === "string") requireWorkersAIId(leg);
    });
    this.modelId = modelId;
    this.#options = options;
    this.#config = config;
  }

  async doEmbed(
    options: EmbeddingModelV4CallOptions
  ): Promise<EmbeddingModelV4Result> {
    if (options.values.length > MAX_EMBEDDINGS_PER_CALL) {
      throw new TooManyEmbeddingValuesForCallError({
        maxEmbeddingsPerCall: MAX_EMBEDDINGS_PER_CALL,
        modelId: this.modelId,
        provider: this.provider,
        values: options.values
      });
    }

    const resolved = resolveOptions(
      this.#config.providerGateway,
      this.#options,
      parseCallOptions(options.providerOptions)
    );
    const input = { text: options.values };
    const transport: Transport = this.#config.transport;
    return withFallback(
      this.modelId,
      resolved.fallback,
      transport.url,
      async (modelId) => {
        const response = await transport.run({
          gateway: resolved.gateway,
          headers: {
            // The AI SDK types these as `string | undefined`; an undefined
            // value must not reach the binding as the string "undefined".
            ...definedHeaders(options.headers),
            ...resolved.headers,
            ...(resolved.sessionAffinity === undefined
              ? {}
              : { "x-session-affinity": resolved.sessionAffinity })
          },
          input,
          model: modelId,
          signal: options.abortSignal
        });
        if (!response.ok) {
          throw await errorFromResponse(response, {
            model: modelId,
            requestBodyValues: input,
            url: transport.url
          });
        }

        const body =
          record(
            unwrapEnvelope(await response.json(), {
              model: modelId,
              status: response.status,
              url: transport.url
            })
          ) ?? {};
        const embeddings = (array(body.data) ?? []).map((row) =>
          (array(row) ?? []).filter(
            (value): value is number => typeof value === "number"
          )
        );
        const tokens = count(record(body.usage)?.prompt_tokens);
        return {
          embeddings,
          response: { headers: headersToObject(response.headers) },
          ...(tokens === undefined ? {} : { usage: { tokens } }),
          warnings: []
        };
      }
    );
  }
}
