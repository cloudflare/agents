/**
 * `agents/models/ai-sdk` — Cloudflare's AI SDK provider.
 *
 * Every model is a string, and every string runs on one method: `env.AI.run`.
 *
 * 1. **`ai("@cf/…")`** is a Workers AI model.
 * 2. **`ai("<author>/<model>")`** is a model from the AI Gateway catalog —
 *    `openai/gpt-5.5`, `anthropic/claude-opus-4.8`, `cloudflare/auto` — in the
 *    gateway's own spelling. The gateway picks the provider and converts the
 *    request; Unified Billing means no vendor key.
 * 3. **`ai("dynamic/<route>")`** is a dynamic route on your gateway.
 *
 * Every one of them speaks chat completions, so one request builder and one
 * parser serve them all. The gateway is an option, not a product: caching,
 * logging, metadata, timeouts and retries are options on the call, and the
 * `default` gateway is created on first use.
 *
 * ```ts
 * import { createAI } from "agents/models/ai-sdk";
 * import { generateText } from "ai";
 *
 * const ai = createAI({ binding: env.AI, id: "prod" });
 *
 * await generateText({ model: ai("@cf/zai-org/glm-4.7-flash"), prompt: "Hi" });
 * await generateText({ model: ai("anthropic/claude-opus-4.8"), prompt: "Hi" });
 * ```
 *
 * @experimental Everything exported here is experimental: the surface may
 * change in a minor release while the unified catalog settles.
 *
 * @module
 */

import type {
  EmbeddingModelV4,
  ImageModelV4,
  LanguageModelV4,
  RerankingModelV4,
  SpeechModelV4,
  TranscriptionModelV4
} from "@ai-sdk/provider";
import type {
  CloudflareEmbeddingModelId,
  CloudflareImageModelId,
  CloudflareRerankingModelId,
  CloudflareSpeechModelId,
  CloudflareTranscriptionModelId
} from "../core/catalog";
import { requireLanguageModelId } from "./errors";
import { CloudflareEmbeddingModel } from "./models/embedding";
import { CloudflareImageModel } from "./models/image";
import {
  CloudflareLanguageModel,
  type LanguageModelConfig
} from "./models/language";
import { CloudflareRerankingModel } from "./models/reranking";
import { CloudflareSpeechModel } from "./models/speech";
import { CloudflareTranscriptionModel } from "./models/transcription";
import {
  gatewayLayerOf,
  mergeModelOptions,
  optionsOf,
  type AISettings,
  type CloudflareLanguageModelId,
  type FallbackLeg,
  type ModalityOptions,
  type ModelOptions
} from "./settings";
import { createTransport } from "./transport";

export type {
  CatalogModelId,
  CloudflareEmbeddingModelId,
  CloudflareImageModelId,
  CloudflareRerankingModelId,
  CloudflareSpeechModelId,
  CloudflareTranscriptionModelId,
  DynamicRouteId,
  KnownImageModelId,
  KnownSpeechModelId,
  WorkersAIModelId
} from "../core/catalog";
export {
  CloudflareAIError,
  type CloudflareAIAttempt,
  type CloudflareAIErrorCode
} from "./errors";
export type { CloudflareMetadata } from "./models/language";
export type {
  AISettings,
  CloudflareLanguageModelId,
  FallbackLeg,
  GatewayOptions,
  ModalityOptions,
  ModelOptions,
  ProviderGatewaySettings
} from "./settings";

/**
 * The provider `createAI` returns. Call it with a model id: a Workers AI id,
 * an AI Gateway catalog id, or a dynamic route.
 *
 * It satisfies `ProviderV4`, so it drops into
 * `createProviderRegistry({ cloudflare: ai })` and into
 * `globalThis.AI_SDK_DEFAULT_PROVIDER`, where the AI SDK resolves a bare
 * `model: "@cf/…"` or `"openai/gpt-5.5"` string through it.
 *
 * @experimental This surface is experimental and may change.
 */
export interface AI {
  /**
   * A language model: `@cf/…` (Workers AI), `<author>/<model>` (the AI
   * Gateway catalog, in its spelling), or `dynamic/<route>`.
   */
  (modelId: CloudflareLanguageModelId, options?: ModelOptions): LanguageModelV4;
  /** The AI SDK provider specification this implements. */
  readonly specificationVersion: "v4";
  /** Same as calling the provider directly. */
  languageModel(
    modelId: CloudflareLanguageModelId,
    options?: ModelOptions
  ): LanguageModelV4;
  /** The `ProviderV4` shape: a registry resolves models by string alone. */
  languageModel(modelId: string, options?: ModelOptions): LanguageModelV4;
  /** A text-embedding model from the Workers AI catalog. */
  embedding(
    modelId: CloudflareEmbeddingModelId,
    options?: ModalityOptions
  ): EmbeddingModelV4;
  /** Alias of {@link AI.embedding}, the `ProviderV4` method name. */
  embeddingModel(
    modelId: CloudflareEmbeddingModelId,
    options?: ModalityOptions
  ): EmbeddingModelV4;
  /**
   * Alias of {@link AI.embedding}.
   *
   * @deprecated `embeddingModel` is the `ProviderV4` name; this is the older
   * `ProviderV2`/`ProviderV3` spelling, kept for one release.
   */
  textEmbeddingModel(
    modelId: CloudflareEmbeddingModelId,
    options?: ModalityOptions
  ): EmbeddingModelV4;
  /** A text-to-image model from the Workers AI catalog. */
  image(
    modelId: CloudflareImageModelId,
    options?: ModalityOptions
  ): ImageModelV4;
  /** Alias of {@link AI.image}, the `ProviderV4` method name. */
  imageModel(
    modelId: CloudflareImageModelId,
    options?: ModalityOptions
  ): ImageModelV4;
  /** A speech-recognition model from the Workers AI catalog. */
  transcription(
    modelId: CloudflareTranscriptionModelId,
    options?: ModalityOptions
  ): TranscriptionModelV4;
  /** Alias of {@link AI.transcription}, the `ProviderV4` method name. */
  transcriptionModel(
    modelId: CloudflareTranscriptionModelId,
    options?: ModalityOptions
  ): TranscriptionModelV4;
  /** A text-to-speech model from the Workers AI catalog. */
  speech(
    modelId: CloudflareSpeechModelId,
    options?: ModalityOptions
  ): SpeechModelV4;
  /** Alias of {@link AI.speech}, the `ProviderV4` method name. */
  speechModel(
    modelId: CloudflareSpeechModelId,
    options?: ModalityOptions
  ): SpeechModelV4;
  /** A reranking model from the Workers AI catalog. */
  reranking(
    modelId: CloudflareRerankingModelId,
    options?: ModalityOptions
  ): RerankingModelV4;
  /** Alias of {@link AI.reranking}, the `ProviderV4` method name. */
  rerankingModel(
    modelId: CloudflareRerankingModelId,
    options?: ModalityOptions
  ): RerankingModelV4;
}

/**
 * Creates a provider over Workers AI and the AI Gateway catalog.
 *
 * The Workers AI binding is the only way in, and `env.AI.run` the only method:
 * a Workers AI id goes to Workers AI, a catalog id or dynamic route to AI
 * Gateway's `/run`. There is no HTTP transport and no API token. Gateway
 * options are flat (`id`, `cacheTtl`, …) or nested under `gateway`; per-model
 * options and per-call `providerOptions.cloudflare` override them in that
 * order.
 *
 * ```ts
 * const ai = createAI({ binding: env.AI, id: "prod", cacheTtl: 60 });
 *
 * ai("@cf/zai-org/glm-4.7-flash");
 * ai("anthropic/claude-opus-4.8", { fallback: ["openai/gpt-5.5"] });
 * ai.embedding("@cf/baai/bge-base-en-v1.5");
 * ```
 *
 * @experimental This surface is experimental and may change.
 */
export function createAI(settings: AISettings): AI {
  const config: LanguageModelConfig = {
    providerGateway: settings,
    transport: createTransport(settings)
  };

  /**
   * Fallback legs are normalized once, here. A leg written as an id is gated
   * at the line that wrote it. A leg this provider built moves onto the
   * chain's gateway: it inherits the chain's *gateway* options and keeps
   * everything else it was configured with. Any other model object is
   * another provider's, called as it is.
   */
  const normalize = (options?: ModelOptions): ModelOptions | undefined => {
    if (options?.fallback === undefined) return options;
    const inherited: ModelOptions = gatewayLayerOf(options);
    return {
      ...options,
      fallback: options.fallback.map((leg: FallbackLeg) => {
        if (typeof leg === "string") return requireLanguageModelId(leg);
        if (!(leg instanceof CloudflareLanguageModel)) return leg;
        return relayer(leg, inherited);
      })
    };
  };

  /** A model this provider built, with `options` layered over its own. */
  const relayer = (
    model: CloudflareLanguageModel,
    options: ModelOptions | undefined
  ): CloudflareLanguageModel =>
    // The merged bag's legs are normalized too, so a chain configured earlier
    // moves with the model onto the gateway named here.
    new CloudflareLanguageModel(
      model.modelId,
      normalize(mergeModelOptions(optionsOf(model), options)),
      config
    );

  const languageModel = (
    modelId: CloudflareLanguageModelId,
    options?: ModelOptions
  ): LanguageModelV4 =>
    new CloudflareLanguageModel(
      requireLanguageModelId(modelId),
      normalize(options),
      config
    );

  const embedding = (
    modelId: CloudflareEmbeddingModelId,
    options?: ModalityOptions
  ): EmbeddingModelV4 => new CloudflareEmbeddingModel(modelId, options, config);

  const image = (
    modelId: CloudflareImageModelId,
    options?: ModalityOptions
  ): ImageModelV4 => new CloudflareImageModel(modelId, options, config);

  const transcription = (
    modelId: CloudflareTranscriptionModelId,
    options?: ModalityOptions
  ): TranscriptionModelV4 =>
    new CloudflareTranscriptionModel(modelId, options, config);

  const speech = (
    modelId: CloudflareSpeechModelId,
    options?: ModalityOptions
  ): SpeechModelV4 => new CloudflareSpeechModel(modelId, options, config);

  const reranking = (
    modelId: CloudflareRerankingModelId,
    options?: ModalityOptions
  ): RerankingModelV4 => new CloudflareRerankingModel(modelId, options, config);

  const provider = (
    modelId: CloudflareLanguageModelId,
    options?: ModelOptions
  ): LanguageModelV4 => languageModel(modelId, options);

  return Object.assign(provider, {
    embedding,
    embeddingModel: embedding,
    image,
    imageModel: image,
    languageModel,
    reranking,
    rerankingModel: reranking,
    specificationVersion: "v4" as const,
    speech,
    speechModel: speech,
    textEmbeddingModel: embedding,
    transcription,
    transcriptionModel: transcription
  }) as AI;
}
