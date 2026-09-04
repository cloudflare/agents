/**
 * `agents/models/ai-sdk` — Cloudflare's AI SDK provider.
 *
 * One rule decides everything here: **Workers AI is the one catalog this
 * package keeps up with; every other vendor brings its own provider.**
 *
 * 1. **`ai("@cf/…")`** is a Workers AI model — ours, wire format and all.
 * 2. **`ai(anthropic("claude-opus-4-8"))`** is the vendor's model, routed
 *    through AI Gateway. Their code builds and parses the request; we only
 *    carry it. No vendor ids, wire formats or model metadata live here, and
 *    this package takes no vendor package as a dependency.
 * 3. **The gateway is an option, not a product.** Caching, logging, metadata,
 *    timeouts and retries are options on the call; the `default` gateway is
 *    created on first use, and unified billing means no vendor key.
 *
 * ```ts
 * import { createAI } from "agents/models/ai-sdk";
 * import { createAnthropic } from "@ai-sdk/anthropic";
 * import { generateText } from "ai";
 *
 * const ai = createAI({ binding: env.AI, id: "prod" });
 * const anthropic = createAnthropic({ apiKey: "cloudflare" });
 *
 * await generateText({ model: ai("@cf/zai-org/glm-4.7-flash"), prompt: "Hi" });
 * await generateText({ model: ai(anthropic("claude-opus-4-8")), prompt: "Hi" });
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
  CloudflareTranscriptionModelId,
  WorkersAIModelId
} from "../core/catalog";
import { requireWorkersAIId } from "./errors";
import { CloudflareEmbeddingModel } from "./models/embedding";
import { GatewayLanguageModel, routed } from "./models/gateway";
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
  type FallbackLeg,
  type ModalityOptions,
  type ModelOptions,
  type RoutedModelOptions
} from "./settings";
import { createTransport } from "./transport";

export type {
  CloudflareEmbeddingModelId,
  CloudflareImageModelId,
  CloudflareRerankingModelId,
  CloudflareSpeechModelId,
  CloudflareTranscriptionModelId,
  KnownImageModelId,
  KnownSpeechModelId,
  WorkersAIModelId
} from "../core/catalog";
export {
  CloudflareAIError,
  type CloudflareAIAttempt,
  type CloudflareAIErrorCode
} from "./errors";
export { GatewayLanguageModel } from "./models/gateway";
export type { CloudflareMetadata } from "./models/language";
export type {
  AISettings,
  FallbackLeg,
  GatewayModelOptions,
  GatewayOptions,
  ModalityOptions,
  ModelOptions,
  ProviderGatewaySettings,
  RoutedModelOptions
} from "./settings";

/** Whether a value is a model object rather than a model id. */
function isModel(value: unknown): value is LanguageModelV4 {
  return typeof value === "object" && value !== null;
}

/**
 * The provider `createAI` returns. Call it with a Workers AI id or with a
 * model another provider built.
 *
 * It satisfies `ProviderV4`, so it drops into
 * `createProviderRegistry({ cloudflare: ai })` and into
 * `globalThis.AI_SDK_DEFAULT_PROVIDER`, where the AI SDK resolves a bare
 * `model: "@cf/…"` string through it. That is why the named methods also
 * accept a plain `string`: a registry has only the string, and an id that is
 * not a Workers AI one throws there exactly as it does here.
 *
 * @experimental This surface is experimental and may change.
 */
export interface AI {
  /** A Workers AI model. Third-party ids are not ids here — pass the model. */
  (modelId: WorkersAIModelId, options?: ModelOptions): LanguageModelV4;
  /** Any AI SDK v4 language model, routed through AI Gateway. */
  (model: LanguageModelV4, options?: ModelOptions): LanguageModelV4;
  /** The AI SDK provider specification this implements. */
  readonly specificationVersion: "v4";
  /** Same as calling the provider directly. */
  languageModel(
    modelId: WorkersAIModelId,
    options?: ModelOptions
  ): LanguageModelV4;
  languageModel(
    model: LanguageModelV4,
    options?: ModelOptions
  ): LanguageModelV4;
  /** The `ProviderV4` shape: a registry resolves models by string alone. */
  languageModel(modelId: string, options?: ModelOptions): LanguageModelV4;
  /**
   * Any other v4 model a vendor built — embedding, image, speech,
   * transcription — routed through AI Gateway with its own code intact.
   *
   * The options are the gateway ones: a routed model has no chain to fall back
   * through and no Workers AI reasoning knob to apply, so
   * {@link RoutedModelOptions} leaves those out rather than dropping them.
   */
  routed<T extends object>(model: T, options?: RoutedModelOptions): T;
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
 * Creates a provider over Workers AI, and over every vendor AI Gateway can
 * reach.
 *
 * The Workers AI binding is the only way in — Workers AI models go through
 * `env.AI.run`, vendor models through `env.AI.gateway(id).run`, and there is
 * no HTTP transport and no API token. Gateway options are flat (`id`,
 * `cacheTtl`, …) or nested under `gateway`; per-model options and per-call
 * `providerOptions.cloudflare` override them in that order.
 *
 * ```ts
 * const ai = createAI({ binding: env.AI, id: "prod", cacheTtl: 60 });
 * const anthropic = createAnthropic({ apiKey: "cloudflare" });
 *
 * ai("@cf/zai-org/glm-4.7-flash");
 * ai(anthropic("claude-opus-4-8"), { fallback: [ai("@cf/zai-org/glm-4.7-flash")] });
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
   * Fallback legs are normalized once, here: a model object becomes a routed
   * model, so every leg a model runs is already this provider's.
   *
   * A leg inherits the chain's *gateway* options and nothing else. The rest of
   * the bag — `reasoningEffort`, `chatTemplateKwargs`, `headers`,
   * `sessionAffinity` — was written for the model it was written on, and a leg
   * that was configured with its own keeps every one of them.
   */
  const normalize = (options?: ModelOptions): ModelOptions | undefined => {
    if (options?.fallback === undefined) return options;
    const inherited: ModelOptions = gatewayLayerOf(options);
    return {
      ...options,
      fallback: options.fallback.map((leg: FallbackLeg) =>
        typeof leg === "string"
          ? // The same gate the primary passes, at the line that wrote the
            // leg: a vendor model is never a string here, in a chain either.
            requireWorkersAIId(leg)
          : languageModel(leg, inherited)
      )
    };
  };

  function languageModel(
    model: WorkersAIModelId | LanguageModelV4,
    options?: ModelOptions
  ): LanguageModelV4 {
    const resolved = normalize(options);
    if (isModel(model)) {
      // Already ours: layer the options over the model's own rather than wrap
      // it a second time, so nothing it was configured with is dropped.
      if (model instanceof CloudflareLanguageModel) {
        // The merged bag's legs are re-wrapped too, so a chain configured
        // earlier moves with the model onto the gateway named here.
        const merged = normalize(mergeModelOptions(optionsOf(model), resolved));
        return new CloudflareLanguageModel(model.modelId, merged, config);
      }
      if (model instanceof GatewayLanguageModel) {
        // The merged bag's legs are re-wrapped too, so a chain configured
        // earlier moves with the model onto the gateway named here.
        const merged = normalize(mergeModelOptions(optionsOf(model), resolved));
        return new GatewayLanguageModel(model.model, merged, config);
      }
      return new GatewayLanguageModel(model, resolved, config);
    }
    return new CloudflareLanguageModel(
      requireWorkersAIId(model),
      resolved,
      config
    );
  }

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
    model: WorkersAIModelId | LanguageModelV4,
    options?: ModelOptions
  ): LanguageModelV4 => languageModel(model, options);

  return Object.assign(provider, {
    embedding,
    embeddingModel: embedding,
    image,
    imageModel: image,
    languageModel,
    reranking,
    rerankingModel: reranking,
    routed: <T extends object>(model: T, options?: RoutedModelOptions): T =>
      routed(model, options, config),
    specificationVersion: "v4" as const,
    speech,
    speechModel: speech,
    textEmbeddingModel: embedding,
    transcription,
    transcriptionModel: transcription
  }) as AI;
}
