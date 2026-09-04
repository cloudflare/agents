/**
 * pi-ai `Model` construction for this provider.
 *
 * There are exactly two sources of a model here, and neither of them is a
 * catalog of ours:
 *
 * 1. A Workers AI id (`@cf/<author>/<model>`) — the one catalog Cloudflare
 *    owns. Its metadata comes from pi-ai's generated Workers AI registry.
 * 2. Anything else — a model object the caller built from their own pi-ai
 *    registry import, or an id resolved through pi-ai's generated Cloudflare
 *    AI Gateway registry. pi keeps those current; we only route them.
 *
 * A model is plain data in pi-ai, so the options a model was created with ride
 * on it under symbol keys: `JSON.stringify` and `structuredClone` drop them,
 * while an object spread — which pi-ai does when it copies a model — keeps
 * them. Routing survives that loss, because the vendor's own spelling of a
 * `<slug>/<id>` model is looked back up in pi-ai's registry; the per-model
 * options do not, so a model stored in Agent state and read back comes home
 * with this provider's defaults. Re-apply them with `ai(model, options)`
 * after loading if the model carried any.
 *
 * @experimental This surface is experimental and may change.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import type { WorkersAIModelId } from "../core/catalog";
import type { ModelOptions } from "../core/settings";

/**
 * The `api` marker Workers AI models from this provider carry. It is not a
 * wire format: Workers AI runs on `env.AI.run`, and the compat layer maps that
 * onto strict OpenAI chat completions.
 *
 * @experimental This surface is experimental and may change.
 */
export const CLOUDFLARE_AI_API = "cloudflare-ai";

/** @experimental This surface is experimental and may change. */
export type CloudflareAIApi = typeof CLOUDFLARE_AI_API;

/**
 * The pi-ai provider id. A `Models` registry resolves specifiers as
 * `cloudflare/<id>`, e.g. `cloudflare/anthropic/claude-opus-4-8`.
 *
 * @experimental This surface is experimental and may change.
 */
export const CLOUDFLARE_PROVIDER_ID = "cloudflare";

/**
 * A Workers AI model produced by this provider. `id` is the `@cf/` id exactly
 * as given; `api` is {@link CLOUDFLARE_AI_API}.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareModel = Model<CloudflareAIApi>;

/** @experimental This surface is experimental and may change. */
export type ModelCost = Model<Api>["cost"];

/**
 * A model this provider routes: a Workers AI model or any pi-ai model the
 * caller handed to `ai(model)`.
 *
 * @experimental This surface is experimental and may change.
 */
export type RoutedModel = Model<Api>;

/**
 * Per-model options: the gateway options, client-side fallback, headers and
 * session affinity, plus pi-ai model metadata overrides and the stream idle
 * deadline. Metadata overrides only apply to the `@cf/` form — a model object
 * brings its own metadata, and this module never second-guesses it.
 *
 * @experimental This surface is experimental and may change.
 */
/**
 * A fallback leg: a Workers AI id, a `<slug>/<id>` pi-ai's gateway registry
 * knows, or a model object. A raw vendor id is refused when the chain is built.
 */
export type PiFallbackLeg = WorkersAIModelId | Model<Api> | (string & {});

export interface PiModelOptions extends ModelOptions<PiFallbackLeg> {
  /** Display name. Defaults to the catalog name, else the id. */
  name?: string;
  /** Context window in tokens. Defaults to the catalog value, else 128000. */
  contextWindow?: number;
  /** Maximum output tokens. Defaults to the catalog value, else 8192. */
  maxTokens?: number;
  /** Whether the model can reason. Defaults to the catalog value, else true. */
  reasoning?: boolean;
  /** Accepted input modalities. Defaults to the catalog value. */
  input?: ("text" | "image")[];
  /** Cost per million tokens, used by pi-ai's usage accounting. */
  cost?: ModelCost;
  /**
   * Fail a stream that delivers no bytes for this long, in milliseconds. The
   * timer only runs while a read is outstanding, so consumer backpressure
   * never trips it. `0` disables the guard. Default 300000 (five minutes).
   */
  streamIdleTimeoutMs?: number;
}

const MODEL_OPTIONS: unique symbol = Symbol.for("agents.models.pi-ai.options");
const MODEL_ROUTING: unique symbol = Symbol.for("agents.models.pi-ai.routing");

/** What a registry specifier resolved to, kept for routing and diagnostics. */
interface ModelRouting {
  /** The vendor's own spelling of the id, which is what the body must carry. */
  modelId: string;
  /** The `<slug>/<id>` specifier the caller asked for. */
  specifier: string;
}

type TaggedModel = Model<Api> & {
  [MODEL_OPTIONS]?: PiModelOptions;
  [MODEL_ROUTING]?: ModelRouting;
};

function tag(model: Model<Api>, key: symbol, value: unknown): void {
  Object.defineProperty(model, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: false
  });
}

/** Reads the options a model was created with, if it came from this provider. */
export function optionsOf(model: Model<Api>): PiModelOptions | undefined {
  const options = (model as TaggedModel)[MODEL_OPTIONS];
  return options !== null && typeof options === "object" ? options : undefined;
}

/**
 * The gateway registry entry a model's own id names, for a model this provider
 * built from a `<slug>/<id>` specifier. It is looked up rather than inferred,
 * so a model that lost its symbol tags — `JSON.stringify` and
 * `structuredClone` drop them, and an Agent's state goes through both — still
 * reaches the vendor under the vendor's own spelling.
 */
function registryEntryFor(model: Model<Api>): Model<Api> | undefined {
  if (
    model.provider !== CLOUDFLARE_PROVIDER_ID ||
    model.id.startsWith("@cf/")
  ) {
    return undefined;
  }
  gatewayRegistry ??= buildGatewayRegistry();
  return gatewayRegistry.get(model.id);
}

/**
 * The id the request body must carry. It differs from `model.id` only for a
 * `<slug>/<id>` specifier, whose model is listed under the specifier so a
 * `Models` registry can find it while the vendor still sees its own spelling.
 */
export function wireModelId(model: Model<Api>): string {
  const tagged = (model as TaggedModel)[MODEL_ROUTING]?.modelId;
  if (tagged !== undefined) return tagged;
  return registryEntryFor(model)?.id ?? model.id;
}

/** The `<slug>/<id>` specifier a model was resolved from, for diagnostics. */
export function specifierOf(model: Model<Api>): string | undefined {
  const tagged = (model as TaggedModel)[MODEL_ROUTING]?.specifier;
  if (tagged !== undefined) return tagged;
  return registryEntryFor(model) === undefined ? undefined : model.id;
}

/**
 * Copies a caller's model and tags the copy with the resolved options. The
 * caller's object is never mutated, and every field it declares — `api`,
 * `provider`, `id`, `baseUrl`, `compat`, `thinkingLevelMap`, cost and limits —
 * is kept verbatim, because that metadata is the model's own author's, not
 * ours.
 */
export function withOptions<TApi extends Api>(
  model: Model<TApi>,
  options: PiModelOptions | undefined
): Model<TApi> {
  const copy = { ...model };
  if (options !== undefined) tag(copy, MODEL_OPTIONS, options);
  return copy;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
const ZERO_COST: ModelCost = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0
};

let workersAI: Map<string, Model<Api>> | undefined;

function workersAIEntry(modelId: string): Model<Api> | undefined {
  workersAI ??= new Map(
    (Object.values(CLOUDFLARE_WORKERS_AI_MODELS) as Model<Api>[]).map(
      (entry) => [entry.id, entry]
    )
  );
  return workersAI.get(modelId);
}

/** Every Workers AI id pi-ai knows, for the provider's static model list. */
export function workersAIModelIds(): string[] {
  workersAI ??= new Map(
    (Object.values(CLOUDFLARE_WORKERS_AI_MODELS) as Model<Api>[]).map(
      (entry) => [entry.id, entry]
    )
  );
  return [...workersAI.keys()].sort();
}

/**
 * Builds the pi-ai model for a Workers AI id. Registry metadata is used when
 * pi-ai knows the id; explicit options override it; everything else falls back
 * to defaults that keep the model usable, because the Workers AI catalog moves
 * faster than any generated registry.
 */
export function buildWorkersAIModel(
  modelId: string,
  options: PiModelOptions | undefined
): CloudflareModel {
  const known = workersAIEntry(modelId);
  const model: CloudflareModel = {
    api: CLOUDFLARE_AI_API,
    baseUrl: "",
    contextWindow:
      options?.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    cost: options?.cost ?? known?.cost ?? ZERO_COST,
    id: modelId,
    input: options?.input ?? known?.input ?? ["text"],
    maxTokens: options?.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
    name: options?.name ?? known?.name ?? modelId,
    provider: CLOUDFLARE_PROVIDER_ID,
    reasoning: options?.reasoning ?? known?.reasoning ?? true,
    ...(known?.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: known.thinkingLevelMap }
      : {})
  };
  if (options !== undefined) tag(model, MODEL_OPTIONS, options);
  return model;
}

/** The gateway provider slug a registry entry's base URL names. */
function slugOf(entry: Model<Api>): string | undefined {
  const segments = entry.baseUrl.split("/").filter((part) => part !== "");
  return segments.at(-1);
}

let gatewayRegistry: Map<string, Model<Api>> | undefined;

/**
 * pi-ai's generated Cloudflare AI Gateway registry, keyed by `<slug>/<id>`.
 * `/compat` entries are skipped: they alias `@cf/` ids the Workers AI registry
 * already declares, and those belong on the run path.
 */
function buildGatewayRegistry(): Map<string, Model<Api>> {
  const map = new Map<string, Model<Api>>();
  for (const entry of Object.values(
    CLOUDFLARE_AI_GATEWAY_MODELS
  ) as Model<Api>[]) {
    const slug = slugOf(entry);
    if (slug === undefined || slug === "compat") continue;
    map.set(`${slug}/${entry.id}`, entry);
  }
  return map;
}

/** Every `<slug>/<id>` specifier pi-ai's gateway registry declares. */
export function gatewayModelIds(): string[] {
  gatewayRegistry ??= buildGatewayRegistry();
  return [...gatewayRegistry.keys()].sort();
}

/**
 * Resolves a `<slug>/<id>` specifier through pi-ai's generated Cloudflare AI
 * Gateway registry. The entry's metadata — api, base URL, compat,
 * `thinkingLevelMap`, cost, limits — is kept exactly as pi generated it; only
 * `id` and `provider` are restated so a `Models` registry can find the model
 * under `cloudflare/<slug>/<id>`, and the vendor's own spelling rides along for
 * the request body.
 *
 * There is no prefix guessing: an id pi-ai does not list is a `TypeError`,
 * pointing at the model-object form, which needs no catalog of ours at all.
 */
export function buildGatewayModel(
  specifier: string,
  options: PiModelOptions | undefined
): Model<Api> {
  gatewayRegistry ??= buildGatewayRegistry();
  const separator = specifier.indexOf("/");
  const slug = separator === -1 ? "" : specifier.slice(0, separator);
  const vendorId = specifier.slice(separator + 1);
  if (slug === "workers-ai") {
    throw new TypeError(
      `"${specifier}" is a Workers AI model: pass its id directly, ai("${vendorId}").`
    );
  }
  const entry = gatewayRegistry.get(specifier);
  if (entry === undefined) {
    throw new TypeError(
      `"${specifier}" is not in pi-ai's Cloudflare AI Gateway catalog. Pass the model object instead, e.g. ai(getBuiltinModel("${slug || "anthropic"}", "${vendorId}")) from "@earendil-works/pi-ai/providers/all", or any model from a provider registry you imported.`
    );
  }
  const model: Model<Api> = {
    ...entry,
    id: specifier,
    provider: CLOUDFLARE_PROVIDER_ID
  };
  tag(model, MODEL_ROUTING, { modelId: entry.id, specifier });
  if (options !== undefined) tag(model, MODEL_OPTIONS, options);
  return model;
}
