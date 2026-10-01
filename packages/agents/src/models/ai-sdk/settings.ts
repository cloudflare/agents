import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  SharedV4ProviderOptions
} from "@ai-sdk/provider";
import type { WorkersAIModelId } from "../core/catalog";
import {
  type ModelOptions as CoreModelOptions,
  PROVIDER_OPTIONS_KEY,
  parseModelOptions
} from "../core/settings";
import { requireWorkersAIId } from "./errors";

export {
  DEFAULT_GATEWAY_ID,
  PROVIDER_OPTIONS_KEY,
  gatewayLayerOf,
  mergeModelOptions,
  parseModelOptions,
  resolveOptions,
  type AISettings,
  type GatewayOptions,
  type ProviderGatewaySettings,
  type ResolvedGateway,
  type ResolvedOptions
} from "../core/settings";

/**
 * One leg of a fallback chain: a Workers AI id, or any AI SDK language model
 * — including one this provider has already wrapped for the gateway.
 *
 * @experimental This surface is experimental and may change.
 */
export type FallbackLeg = WorkersAIModelId | LanguageModelV4;

/**
 * Per-model and per-call options.
 *
 * The framework-neutral options, with the fallback leg type this module
 * accepts: a leg may be a model object as well as a Workers AI id, because a
 * third-party model is never an id here — it is a model its own provider
 * package built.
 *
 * @experimental This surface is experimental and may change.
 */
export type ModelOptions = CoreModelOptions<FallbackLeg>;

/**
 * The options accepted next to a model object — `ai(anthropic("…"), { … })`.
 * The same shape as {@link ModelOptions}; the Workers-AI-only knobs
 * (`reasoningEffort`, `chatTemplateKwargs`) are ignored with a warning.
 *
 * @experimental This surface is experimental and may change.
 */
export type GatewayModelOptions = ModelOptions;

/**
 * The options `ai.routed()` takes: the gateway options, `headers` and
 * `sessionAffinity`.
 *
 * A routed embedding, image, speech or transcription model is the vendor's
 * own, and only its transport is ours — there is no chain to fall back through
 * (a leg for one of those modalities would have to be another vendor's model,
 * which this module cannot build) and no Workers AI reasoning knob to apply.
 * They are absent from the type rather than dropped at runtime, so the mistake
 * is a compile error naming the option.
 *
 * @experimental This surface is experimental and may change.
 */
export type RoutedModelOptions = Omit<
  ModelOptions,
  "fallback" | "reasoningEffort" | "chatTemplateKwargs"
>;

/**
 * The options the Workers-AI-only methods take — `ai.embedding`, `ai.image`,
 * `ai.speech`, `ai.transcription`, `ai.reranking`.
 *
 * Their fallback legs are ids: those models run through the Workers AI run
 * path, which resolves a leg by id, so a model object would type-check and
 * then be silently dropped.
 *
 * @experimental This surface is experimental and may change.
 */
export type ModalityOptions = CoreModelOptions<WorkersAIModelId>;

/**
 * The fallback legs for one call, in the caller's order. Precedence matches
 * the rest of the option merge: a per-call list replaces the per-model one
 * rather than extending it.
 */
export function fallbackLegs(
  model: ModelOptions | undefined,
  call: ModelOptions | undefined
): FallbackLeg[] {
  return call?.fallback ?? model?.fallback ?? [];
}

/**
 * Reads per-call options out of AI SDK `providerOptions.cloudflare`.
 *
 * This is the one place the untyped per-call bag enters the module, so it is
 * where the "`@cf/` ids only" rule is enforced for the fallback legs a caller
 * wrote there: `parseModelOptions` is framework-neutral and drops rather than
 * throws, and no type ever sees that JSON. A vendor id in a leg would
 * otherwise reach `env.AI.run` — the path a vendor model must never take.
 *
 * @experimental This surface is experimental and may change.
 */
export function parseCallOptions(
  providerOptions: SharedV4ProviderOptions | undefined
): ModelOptions | undefined {
  const options = parseModelOptions(providerOptions?.[PROVIDER_OPTIONS_KEY]);
  for (const leg of options?.fallback ?? []) requireWorkersAIId(leg);
  return options;
}

/**
 * The options each model this provider built was built with.
 *
 * A `WeakMap` rather than a field: `createAI` needs to read a leg's own bag
 * back when it layers a fallback chain's gateway options over it, and that is
 * this module's business rather than part of any model's public shape.
 */
const MODEL_OPTIONS = new WeakMap<object, ModelOptions>();

/** Records the options a model of this provider was built with. */
export function rememberOptions(
  model: object,
  options: ModelOptions | undefined
): void {
  if (options !== undefined) MODEL_OPTIONS.set(model, options);
}

/** The options a model of this provider was built with, if it is one. */
export function optionsOf(model: unknown): ModelOptions | undefined {
  return model !== null && typeof model === "object"
    ? MODEL_OPTIONS.get(model)
    : undefined;
}

/**
 * The per-call options a fallback leg is asked with: everything the caller
 * sent, minus the fallback list itself.
 *
 * Every leg here is a model object, so a leg that read the same
 * `providerOptions.cloudflare.fallback` would build the whole chain again —
 * once per leg, each of those re-expanding in turn. The rest of the per-call
 * bag stays, so a leg still honours a per-call `cacheTtl` or gateway id.
 */
export function withoutCallFallback(
  options: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  const providerOptions = options.providerOptions;
  const ours = providerOptions?.[PROVIDER_OPTIONS_KEY];
  if (ours === undefined || !("fallback" in ours)) return options;
  const bag = { ...ours };
  delete bag.fallback;
  return {
    ...options,
    providerOptions: { ...providerOptions, [PROVIDER_OPTIONS_KEY]: bag }
  };
}
