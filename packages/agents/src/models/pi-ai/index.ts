/**
 * `agents/models/pi-ai` — Cloudflare's AI as a pi-ai provider, with the same
 * shape as `agents/models/ai-sdk`.
 *
 * One rule decides everything here: **Workers AI is the catalog Cloudflare
 * keeps; every other vendor is pi-ai's.** So there are two call forms, and no
 * third:
 *
 * ```ts
 * import { createAI } from "agents/models/pi-ai";
 * import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
 *
 * const ai = createAI({ binding: env.AI, id: "prod" });
 *
 * ai("@cf/zai-org/glm-4.7-flash");                     // Workers AI: ours
 * ai(getBuiltinModel("anthropic", "claude-opus-4-8")); // theirs, our transport
 * ai("anthropic/claude-opus-4-8");                     // same, via pi's catalog
 * ```
 *
 * Workers AI runs on `env.AI.run` with Cloudflare's own compat layer. Every
 * other model goes to AI Gateway's universal endpoint, which forwards the
 * vendor's own request to the vendor with the key the gateway holds — so no
 * provider key, and no vendor wire format, lives in your Worker. The model's
 * metadata (`api`, `compat`, `thinkingLevelMap`, cost, limits) is whatever its
 * own registry says, and pi-ai's converters and stream processors do the rest.
 *
 * @experimental Everything exported here is experimental: the surface may
 * change in a minor release while the design settles.
 *
 * @module
 */

import {
  type Api,
  type AssistantMessage,
  type Context,
  type ImagesContext,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  createProvider
} from "@earendil-works/pi-ai";
import type { WorkersAIModelId } from "../core/catalog";
import type { AISettings } from "../core/settings";
import { createTransport } from "../core/transport";
import {
  type CloudflareAssistantImages,
  type CloudflareImagesModel,
  type PiImagesCallOptions,
  type PiImagesModelOptions,
  buildImagesModel,
  generateImages
} from "./models/image";
import {
  CLOUDFLARE_PROVIDER_ID,
  type CloudflareModel,
  type PiModelOptions,
  type RoutedModel,
  buildGatewayModel,
  buildWorkersAIModel,
  gatewayModelIds,
  withOptions,
  workersAIModelIds
} from "./catalog";
import { createStreams } from "./models/language";

export type {
  CloudflareEmbeddingModelId,
  WorkersAIModelId
} from "../core/catalog";
export {
  CloudflareAIError,
  type CloudflareAIAttempt,
  type CloudflareAIErrorCode
} from "../core/errors";
export type {
  AISettings,
  GatewayOptions,
  ModelOptions
} from "../core/settings";
export {
  GATEWAY_PROVIDER_NAMES,
  type GatewayProviderName
} from "../core/gateway-providers";
export { FALLBACK_DIAGNOSTIC, type FallbackAttempt } from "./models/fallback";
export {
  CLOUDFLARE_AI_IMAGES_API,
  type CloudflareAssistantImages,
  type CloudflareImagesModel,
  type PiImagesCallOptions,
  type PiImagesModelOptions
} from "./models/image";
export {
  CLOUDFLARE_AI_API,
  CLOUDFLARE_PROVIDER_ID,
  type CloudflareAIApi,
  type CloudflareModel,
  type ModelCost,
  type PiModelOptions,
  type RoutedModel
} from "./catalog";
export { CLOUDFLARE_ERROR_DIAGNOSTIC } from "./errors";
export { CLOUDFLARE_DIAGNOSTIC } from "./wires/shared";

/**
 * pi-agent-core's `streamFn` shape: what `Agent` calls to run a turn.
 *
 * @experimental This surface is experimental and may change.
 */
export type StreamFn = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions
) => ReturnType<Provider["streamSimple"]>;

/**
 * The provider `createAI` returns. Call it with a Workers AI id or with a
 * pi-ai model to get a model this instance routes; use `stream`/`complete` to
 * run it, `streamFn` with pi-agent-core's `Agent`, and `provider` with a pi-ai
 * `Models` registry.
 *
 * @experimental This surface is experimental and may change.
 */
export interface AI {
  /** A Workers AI model: Cloudflare's own catalog, on the run path. */
  (modelId: WorkersAIModelId, options?: PiModelOptions): CloudflareModel;
  /** Any pi-ai model, routed through AI Gateway with its metadata intact. */
  <TApi extends Api>(model: Model<TApi>, options?: PiModelOptions): Model<TApi>;
  /**
   * A `<slug>/<id>` id from pi-ai's Cloudflare AI Gateway catalog, or either
   * form when the caller only knows which at runtime.
   */
  (target: string | Model<Api>, options?: PiModelOptions): RoutedModel;
  /** Same as calling the provider directly. */
  model(modelId: WorkersAIModelId, options?: PiModelOptions): CloudflareModel;
  model<TApi extends Api>(
    model: Model<TApi>,
    options?: PiModelOptions
  ): Model<TApi>;
  model(target: string | Model<Api>, options?: PiModelOptions): RoutedModel;
  /**
   * The pi-ai `Provider` (id `cloudflare`) for `Models.setProvider` and
   * frameworks built on the registry. Its static model list is every Workers
   * AI id plus every `<slug>/<id>` in pi-ai's Cloudflare AI Gateway catalog;
   * any other model still streams when passed to `ai(model)`.
   */
  readonly provider: Provider;
  /** Full-options streaming, like pi-ai's `stream`. */
  stream(
    model: Model<string>,
    context: Context,
    options?: StreamOptions
  ): ReturnType<Provider["stream"]>;
  /** Full-options completion, like pi-ai's `complete`. */
  complete(
    model: Model<string>,
    context: Context,
    options?: StreamOptions
  ): Promise<AssistantMessage>;
  /** Simple streaming, with `reasoning` as a level, like pi-ai's `streamSimple`. */
  streamSimple(
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions
  ): ReturnType<Provider["streamSimple"]>;
  /** Simple completion, like pi-ai's `completeSimple`. */
  completeSimple(
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions
  ): Promise<AssistantMessage>;
  /** `streamSimple`, bound, for pi-agent-core's `Agent({ streamFn })`. */
  readonly streamFn: StreamFn;
  /** A pi-ai image model over a Workers AI text-to-image id. */
  images(
    modelId: string,
    options?: PiImagesModelOptions
  ): CloudflareImagesModel;
  /** Generates images with a model from {@link AI.images}, like pi-ai's `generateImages`. */
  generateImages(
    model: CloudflareImagesModel,
    context: ImagesContext,
    options?: PiImagesCallOptions
  ): Promise<CloudflareAssistantImages>;
}

/** The prefixes a bare vendor id is most often written with, for the error. */
const VENDOR_HINTS: Record<string, string> = {
  anthropic: "anthropic",
  google: "google",
  openai: "openai"
};

/**
 * A string that is neither a Workers AI id nor a `<slug>/<id>` this provider
 * can resolve. There is no guessing here by design: a model we cannot name
 * exactly is the caller's to construct.
 */
function unroutableString(specifier: string): TypeError {
  const prefix = specifier.split("/")[0] ?? "";
  const hint = VENDOR_HINTS[prefix];
  return new TypeError(
    `ai("${specifier}") is not a model this provider knows. Workers AI ids start with "@cf/". A third-party model comes from its own pi-ai registry: ai(getBuiltinModel(${
      hint === undefined ? '"<provider>"' : `"${hint}"`
    }, "<model id>")) from "@earendil-works/pi-ai/providers/all", or any Model object you built yourself.`
  );
}

function buildModel(
  target: string | Model<Api>,
  options: PiModelOptions | undefined
): Model<Api> {
  // A string leg follows the same rule as a string target, checked here so
  // the mistake is reported at the line that wrote the chain.
  for (const leg of options?.fallback ?? []) {
    if (typeof leg !== "string" || leg.startsWith("@cf/")) continue;
    if (!leg.includes("/")) throw unroutableString(leg);
    buildGatewayModel(leg, undefined);
  }
  if (typeof target !== "string") return withOptions(target, options);
  if (target.startsWith("@cf/")) return buildWorkersAIModel(target, options);
  if (!target.includes("/")) throw unroutableString(target);
  return buildGatewayModel(target, options);
}

/**
 * Creates a pi-ai provider over Cloudflare's AI.
 *
 * The Workers AI binding is the only way in — Workers AI models go through
 * `env.AI.run`, vendor models through `env.AI.gateway(id).run`, and there is
 * no HTTP transport and no API token. Gateway options may be given flat
 * (`{ binding, id: "prod", cacheTtl: 60 }`) or nested under `gateway`;
 * per-model options and per-call pi-ai options (`headers`, `metadata`,
 * `sessionId`) override them in that order.
 *
 * ```ts
 * const ai = createAI({ binding: env.AI, id: "prod" });
 * ai("@cf/zai-org/glm-4.7-flash");
 * ai(anthropicModel, { fallback: ["@cf/zai-org/glm-4.7-flash"] });
 * new Agent({ streamFn: ai.streamFn, initialState: { model: ai(openaiModel) } });
 * ```
 *
 * @experimental This surface is experimental and may change.
 */
export function createAI(settings: AISettings): AI {
  const transport = createTransport(settings);
  const streams = createStreams({ providerGateway: settings, transport });

  const model = ((
    target: string | Model<Api>,
    options?: PiModelOptions
  ): Model<Api> => buildModel(target, options)) as AI["model"];

  const provider = createProvider({
    api: streams,
    auth: {
      apiKey: {
        name: "Cloudflare (the AI binding)",
        // The transport is already authenticated; nothing to resolve.
        resolve: async () => ({ auth: {} })
      }
    },
    id: CLOUDFLARE_PROVIDER_ID,
    models: [
      ...workersAIModelIds().map((id) => buildWorkersAIModel(id, undefined)),
      ...gatewayModelIds().map((id) => buildGatewayModel(id, undefined))
    ],
    name: "Cloudflare"
  });

  const stream: AI["stream"] = (target, context, options) =>
    streams.stream(target, context, options);
  const streamSimple: AI["streamSimple"] = (target, context, options) =>
    streams.streamSimple(target, context, options);

  return Object.assign(model as AI, {
    complete: (target, context, options) =>
      stream(target, context, options).result(),
    completeSimple: (target, context, options) =>
      streamSimple(target, context, options).result(),
    generateImages: (target, context, options) =>
      generateImages(
        { providerGateway: settings, transport },
        target,
        context,
        options
      ),
    images: (modelId, options) => buildImagesModel(modelId, options),
    model,
    provider,
    stream,
    streamFn: streamSimple,
    streamSimple
  } satisfies Omit<AI, "call">);
}
