import type { WorkersAIModelId } from "./catalog";

/** The gateway id Cloudflare auto-creates on first use. */
export const DEFAULT_GATEWAY_ID = "default";

/** Key that per-call options live under in a framework's per-call options bag. */
export const PROVIDER_OPTIONS_KEY = "cloudflare";

/**
 * AI Gateway settings for a request. The gateway is an option, not a separate
 * product: every call goes through one, and `id` defaults to `"default"`,
 * which Cloudflare creates on first use.
 *
 * @experimental This surface is experimental and may change.
 */
export interface GatewayOptions {
  /** Gateway id. Defaults to `"default"` (auto-created on first use). */
  id?: string;
  /** Bypass the cache for this request. */
  skipCache?: boolean;
  /** Cache lifetime in seconds. */
  cacheTtl?: number;
  /** Explicit cache key, instead of the request-derived one. */
  cacheKey?: string;
  /** Whether the gateway stores the request/response in its log. */
  collectLog?: boolean;
  /** Arbitrary key/values attached to the gateway log entry. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Correlates several requests into one gateway event. */
  eventId?: string;
  /** Upstream request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Server-side retry policy for the upstream provider call. */
  retries?: {
    maxAttempts?: 1 | 2 | 3 | 4 | 5;
    retryDelayMs?: number;
    backoff?: "constant" | "linear" | "exponential";
  };
}

/**
 * How `createAI` reaches Cloudflare: the Workers AI binding, and nothing else.
 * Workers AI models go through `env.AI.run`, vendor models through
 * `env.AI.gateway(id).run` — both are the binding, so there is no HTTP
 * transport, no account id and no API token to hold.
 *
 * @experimental This surface is experimental and may change.
 */
export type AISettings = {
  /** The `AI` binding from a Worker's env. */
  binding: Ai;
} & ProviderGatewaySettings;

/**
 * Provider-wide gateway defaults, in either spelling: nested under `gateway`,
 * or flat (`{ id: "prod", cacheTtl: 60 }`). Both merge, the flat key winning.
 *
 * @experimental This surface is experimental and may change.
 */
export interface ProviderGatewaySettings extends GatewayOptions {
  /** Gateway id or full gateway options. */
  gateway?: string | GatewayOptions;
}

/**
 * Per-model and per-call options. The flat gateway keys are sugar for
 * `gateway: { ... }`; both forms merge, with the flat key winning.
 *
 * The same shape is accepted per call under
 * `providerOptions.cloudflare`, where it takes precedence over the per-model
 * options, which in turn take precedence over the `createAI` settings.
 *
 * `Leg` is what a framework module accepts as a fallback leg. Workers AI ids
 * are the only kind this module can resolve on its own, so they are the
 * default; a module whose legs may also be model objects says so
 * (`ModelOptions<WorkersAIModelId | LanguageModelV4>`) rather than rebuilding
 * the type.
 *
 * @experimental This surface is experimental and may change.
 */
export interface ModelOptions<
  Leg = WorkersAIModelId
> extends ProviderGatewaySettings {
  /**
   * Models to try, in order, if the primary fails before any output is
   * produced. A leg travels with the chain's gateway options — those win over
   * a leg's own, and `metadata` merges — while everything a leg was built with
   * itself stays its own. Client-side today; becomes server-side when the
   * platform ships model-first routing.
   */
  fallback?: Leg[];
  /** Extra request headers, merged last. */
  headers?: Record<string, string>;
  /**
   * Workers AI only: route same-key requests to the same replica for
   * prefix-cache hits. Sent as the `x-session-affinity` header.
   */
  sessionAffinity?: string;
  /**
   * Explicit reasoning effort. `null` disables reasoning on models that
   * support toggling it. The unified AI SDK `reasoning` call option maps onto
   * this when this is not set.
   */
  reasoningEffort?: "low" | "medium" | "high" | null;
  /**
   * Workers AI only: forwarded verbatim as `chat_template_kwargs`, e.g.
   * `{ enable_thinking: false }`.
   */
  chatTemplateKwargs?: Record<string, unknown>;
}

/** A gateway config with the id filled in. */
export interface ResolvedGateway extends GatewayOptions {
  id: string;
}

/** Everything one request needs, after merging all three option layers. */
export interface ResolvedOptions {
  gateway: ResolvedGateway;
  headers: Record<string, string>;
  sessionAffinity: string | undefined;
  reasoningEffort: "low" | "medium" | "high" | null | undefined;
  chatTemplateKwargs: Record<string, unknown> | undefined;
  /**
   * The fallback legs given as ids. A module whose legs may also be model
   * objects keeps its own ordered list; this one is what the id-only callers
   * (embeddings, the other modalities) need.
   */
  fallback: string[];
}

/** The id legs of a fallback list; model objects are their module's business. */
function idLegs(fallback: unknown[] | undefined): string[] {
  return (fallback ?? []).filter(
    (leg): leg is string => typeof leg === "string"
  );
}

/** Strips `undefined` values so a later layer never blanks an earlier one. */
function defined<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as T;
}

function normalizeGateway(
  gateway: string | GatewayOptions | undefined
): GatewayOptions {
  if (gateway === undefined) return {};
  // An explicit `undefined` inside a gateway object means "not set", exactly
  // as the flat sugar does; it must not blank out a lower layer's value.
  return typeof gateway === "string" ? { id: gateway } : defined(gateway);
}

/**
 * Folds one layer's flat gateway sugar into its `gateway` object. The flat key
 * wins over the nested one, and an explicit `undefined` on either never blanks
 * a lower layer.
 */
function layerGateway(
  options: ProviderGatewaySettings | undefined
): GatewayOptions {
  if (options === undefined) return {};
  return {
    ...normalizeGateway(options.gateway),
    ...defined({
      cacheKey: options.cacheKey,
      cacheTtl: options.cacheTtl,
      collectLog: options.collectLog,
      eventId: options.eventId,
      id: options.id,
      metadata: options.metadata,
      requestTimeoutMs: options.requestTimeoutMs,
      retries: options.retries,
      skipCache: options.skipCache
    })
  };
}

/** The flat gateway sugar {@link layerGateway} folds into `gateway`. */
const FLAT_GATEWAY_KEYS = [
  "cacheKey",
  "cacheTtl",
  "collectLog",
  "eventId",
  "gateway",
  "id",
  "metadata",
  "requestTimeoutMs",
  "retries",
  "skipCache"
] as const;

/**
 * One layer's gateway options as a single object, both spellings folded in.
 * Exported so a module that collapses two option layers into one bag (a
 * fallback leg inheriting a chain's gateway) can merge them field by field
 * rather than replacing one object with the other.
 *
 * @experimental This surface is experimental and may change.
 */
export function gatewayLayerOf(
  options: ProviderGatewaySettings | undefined
): GatewayOptions {
  return layerGateway(options);
}

/** An option bag without the gateway keys, whichever spelling they used. */
function withoutGatewayKeys<Leg>(
  options: ModelOptions<Leg>
): ModelOptions<Leg> {
  const rest: Record<string, unknown> = { ...options };
  for (const key of FLAT_GATEWAY_KEYS) delete rest[key];
  return defined(rest as ModelOptions<Leg>);
}

/**
 * Collapses two option layers into one bag, `override` winning field by field.
 *
 * The gateway keys of both are folded into a single `gateway` object, so
 * neither layer's flat sugar can out-rank the other's nested spelling when the
 * bag is resolved later, and `metadata` merges rather than replaces — the same
 * rules {@link resolveOptions} applies across its three layers.
 *
 * @experimental This surface is experimental and may change.
 */
export function mergeModelOptions<Leg>(
  base: ModelOptions<Leg> | undefined,
  override: ModelOptions<Leg> | undefined
): ModelOptions<Leg> | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  const layers = [layerGateway(base), layerGateway(override)];
  const gateway: GatewayOptions = Object.assign({}, ...layers);
  const metadata = Object.assign({}, ...layers.map((layer) => layer.metadata));
  const retries = mergeRetries(layers);
  // Headers merge field by field, as they do across `resolveOptions`' three
  // layers: replacing the object wholesale would drop a header the lower layer
  // was configured with. The spread comes after the override's own keys so it
  // wins over the `headers` that spread carried.
  const headers = { ...base.headers, ...override.headers };
  return {
    ...withoutGatewayKeys(base),
    ...withoutGatewayKeys(override),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    gateway: {
      ...gateway,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(retries === undefined ? {} : { retries })
    }
  };
}

/**
 * Merges the retry policies field by field, so a provider-wide `backoff` still
 * applies when a call only sets `maxAttempts`. `undefined` on any layer means
 * "not set" and never blanks a lower one.
 */
function mergeRetries(
  layers: GatewayOptions[]
): GatewayOptions["retries"] | undefined {
  const merged = layers.reduce<NonNullable<GatewayOptions["retries"]>>(
    (result, layer) => ({
      ...result,
      ...(layer.retries === undefined ? {} : defined(layer.retries))
    }),
    {}
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merges the option layers. Precedence is per-call
 * (`providerOptions.cloudflare`) > per-model (`ai(id, options)`) >
 * provider (`createAI({ ... })`).
 *
 * The provider layer takes the whole settings object as well as a bare
 * `gateway` value, so `createAI({ binding, id: "prod", cacheTtl: 60 })` reads
 * the same as `createAI({ binding, gateway: { id: "prod", cacheTtl: 60 } })`.
 *
 * @experimental This surface is experimental and may change.
 */
export function resolveOptions(
  provider: string | ProviderGatewaySettings | undefined,
  model: ModelOptions<unknown> | undefined,
  call: ModelOptions<unknown> | undefined
): ResolvedOptions {
  const layers =
    typeof provider === "string"
      ? [normalizeGateway(provider), layerGateway(model), layerGateway(call)]
      : [layerGateway(provider), layerGateway(model), layerGateway(call)];
  const gateway: GatewayOptions = Object.assign({}, ...layers);
  const metadata = Object.assign({}, ...layers.map((layer) => layer.metadata));
  const retries = mergeRetries(layers);
  return {
    chatTemplateKwargs: call?.chatTemplateKwargs ?? model?.chatTemplateKwargs,
    fallback: idLegs(call?.fallback ?? model?.fallback),
    gateway: {
      ...gateway,
      id: gateway.id ?? DEFAULT_GATEWAY_ID,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(retries === undefined ? {} : { retries })
    },
    headers: { ...model?.headers, ...call?.headers },
    // `null` is a meaningful value here (it disables reasoning), so the call
    // layer wins on any value it actually set, not just on a truthy one.
    reasoningEffort:
      call?.reasoningEffort !== undefined
        ? call.reasoningEffort
        : model?.reasoningEffort,
    sessionAffinity: call?.sessionAffinity ?? model?.sessionAffinity
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asReasoningEffort(
  value: unknown
): "low" | "medium" | "high" | null | undefined {
  if (value === null) return null;
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

/**
 * Metadata values the gateway accepts are scalars only; a nested object or
 * array would be rejected by the binding, so drop those rather than forward
 * them.
 */
function asMetadata(value: unknown): GatewayOptions["metadata"] {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const result: NonNullable<GatewayOptions["metadata"]> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      result[key] = entry;
    }
  }
  return result;
}

const BACKOFFS = ["constant", "linear", "exponential"] as const;

/** Reads the retry policy field by field; the binding validates it strictly. */
function asRetries(value: unknown): GatewayOptions["retries"] {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const maxAttempts = asNumber(record.maxAttempts);
  const backoff = asString(record.backoff);
  const retries = defined({
    backoff: BACKOFFS.find((entry) => entry === backoff),
    maxAttempts:
      maxAttempts !== undefined &&
      Number.isInteger(maxAttempts) &&
      maxAttempts >= 1 &&
      maxAttempts <= 5
        ? (maxAttempts as 1 | 2 | 3 | 4 | 5)
        : undefined,
    retryDelayMs: asNumber(record.retryDelayMs)
  });
  // An empty policy is not a policy: returning `{}` would out-rank a lower
  // layer's real one when the layers merge.
  return Object.keys(retries).length > 0 ? retries : undefined;
}

/** Reads the shared gateway keys out of a loosely-typed record. */
function parseGatewayFields(raw: Record<string, unknown>): GatewayOptions {
  return defined({
    cacheKey: asString(raw.cacheKey),
    cacheTtl: asNumber(raw.cacheTtl),
    collectLog: asBoolean(raw.collectLog),
    eventId: asString(raw.eventId),
    id: asString(raw.id),
    metadata: asMetadata(raw.metadata),
    requestTimeoutMs: asNumber(raw.requestTimeoutMs),
    retries: asRetries(raw.retries),
    skipCache: asBoolean(raw.skipCache)
  });
}

/**
 * Reads per-call options out of a loosely-typed options bag (the value a
 * framework keeps under {@link PROVIDER_OPTIONS_KEY}).
 *
 * The bag is plain JSON, so every field is read defensively: anything of an
 * unexpected type is dropped rather than thrown, because a malformed
 * observability hint should never fail a generation.
 *
 * @experimental This surface is experimental and may change.
 */
export function parseModelOptions(value: unknown): ModelOptions | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;

  const nested = asRecord(raw.gateway);
  const gateway: string | GatewayOptions | undefined =
    typeof raw.gateway === "string"
      ? raw.gateway
      : nested !== undefined
        ? parseGatewayFields(nested)
        : undefined;

  const fallback = Array.isArray(raw.fallback)
    ? raw.fallback.filter(
        (entry): entry is WorkersAIModelId => typeof entry === "string"
      )
    : undefined;

  return defined({
    ...parseGatewayFields(raw),
    chatTemplateKwargs: asRecord(raw.chatTemplateKwargs),
    fallback,
    gateway,
    headers: asStringRecord(raw.headers),
    reasoningEffort: asReasoningEffort(raw.reasoningEffort),
    sessionAffinity: asString(raw.sessionAffinity)
  });
}
