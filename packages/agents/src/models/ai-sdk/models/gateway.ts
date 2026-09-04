/**
 * Routing a vendor's own AI SDK model through AI Gateway.
 *
 * Nothing here knows a vendor's wire format, ids, or capabilities. The user
 * builds the model with the vendor's own provider package; this module swaps
 * the `fetch` that model would have used for one that hands the very same
 * request to the gateway's universal endpoint, and hands the gateway's answer
 * straight back to the vendor's own parser.
 *
 * @experimental This surface is experimental and may change.
 */

import type {
  JSONArray,
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
  SharedV4Warning
} from "@ai-sdk/provider";
import {
  type ResolvedGatewayProvider,
  requireGatewayProvider
} from "../../core/gateway-providers";
import { requireWorkersAIId } from "../errors";
import {
  fallbackLegs,
  rememberOptions,
  parseCallOptions,
  PROVIDER_OPTIONS_KEY,
  resolveOptions,
  withoutCallFallback,
  type FallbackLeg,
  type ModelOptions,
  type ResolvedOptions,
  type RoutedModelOptions
} from "../settings";
import {
  errorFromGatewayEnvelope,
  headersToObject,
  isGatewayErrorEnvelope
} from "../transport";
import { withFallbackLegs } from "./fallback";
import {
  cloudflareMetadata,
  CloudflareLanguageModel,
  type LanguageModelConfig
} from "./language";

/**
 * The options accepted beside a vendor model. Re-exported under the name the
 * module's public surface uses.
 *
 * @experimental This surface is experimental and may change.
 */
export type { GatewayModelOptions } from "../settings";

/** A model whose provider exposes the standard `config.fetch` setting. */
interface RoutableModel {
  config?: unknown;
  modelId?: unknown;
  provider?: unknown;
}

/** What one routed request reports back about how it travelled. */
interface RouteCapture {
  response?: Response;
  provider?: string;
}

/**
 * Throws unless a model's provider keeps its settings where every `@ai-sdk/*`
 * provider keeps them. Checked when the model is wrapped rather than when it
 * is called, so the mistake is reported at the line that made it.
 */
function requireConfig(model: LanguageModelV4): Record<string, unknown> {
  const config = (model as RoutableModel).config;
  if (config === null || typeof config !== "object") {
    throw new TypeError(
      `The model "${String((model as RoutableModel).modelId ?? "unknown")}" from provider "${String(
        (model as RoutableModel).provider ?? "unknown"
      )}" has no \`config\` setting, so AI Gateway cannot take over its requests. Every \`@ai-sdk/*\` provider has one; a middleware-wrapped or hand-written model does not. Wrap the provider's own model first and apply middleware afterwards: wrapLanguageModel({ model: ai(anthropic("claude-opus-4-8")), middleware }).`
    );
  }
  return config as Record<string, unknown>;
}

/**
 * A per-call copy of the upstream model whose `config.fetch` is ours. The
 * user's model object is never touched: it may be shared across requests, and
 * two concurrent calls must not see each other's transport.
 */
function cloneWithFetch<T extends LanguageModelV4>(
  model: T,
  fetchImpl: typeof globalThis.fetch
): T {
  const config = requireConfig(model);
  const clone = Object.create(Object.getPrototypeOf(model)) as T;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(model));
  Object.defineProperty(clone, "config", {
    configurable: true,
    enumerable: true,
    value: { ...config, fetch: fetchImpl },
    writable: true
  });
  return clone;
}

/** The request URL, whichever of `fetch`'s two call shapes was used. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * The vendor's body as the universal request's `query`. Only JSON travels:
 * the gateway's universal request has one JSON field for the whole upstream
 * body, so a multipart upload or a streamed body cannot be expressed.
 */
function universalQuery(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    const kind =
      body === null || body === undefined
        ? "an empty"
        : body instanceof FormData
          ? "a FormData"
          : `a ${body.constructor?.name ?? typeof body}`;
    throw new TypeError(
      `AI Gateway's universal request carries a JSON body only, and this model sent ${kind} body. File uploads and other multipart requests cannot be routed through the gateway; call the vendor directly for those.`
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new TypeError(
      `AI Gateway's universal request carries a JSON body only, and this model sent a body that is not JSON: ${String(error)}`
    );
  }
}

/**
 * The vendor's own request headers, minus the credential the gateway supplies
 * itself and the length of a body we are about to re-serialize.
 */
function forwardedHeaders(
  init: RequestInit | undefined,
  input: RequestInfo | URL,
  route: ResolvedGatewayProvider
): Record<string, string> {
  const source =
    init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const dropped = new Set([...route.authHeaders, "content-length"]);
  const headers: Record<string, string> = {};
  new Headers(source).forEach((value, key) => {
    if (!dropped.has(key.toLowerCase())) headers[key] = value;
  });
  return headers;
}

/** A response whose body can be read again, for the vendor's error handler. */
function replayed(response: Response, text: string): Response {
  const bodyless =
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  return new Response(bodyless ? null : text, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
}

/**
 * The `fetch` a routed model is given. It never reaches the vendor: it maps
 * the vendor's URL onto a gateway provider slug and endpoint, hands the body
 * over untouched, and returns the gateway's answer as the vendor's own.
 */
function routedFetch(context: {
  config: LanguageModelConfig;
  resolved: ResolvedOptions;
  capture: RouteCapture;
  signal: AbortSignal | undefined;
}): typeof globalThis.fetch {
  const routed = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = requestUrl(input);
    const route = requireGatewayProvider(url);
    const query = universalQuery(init?.body);
    const { resolved } = context;
    const extraHeaders = {
      ...resolved.headers,
      ...(resolved.sessionAffinity === undefined
        ? {}
        : { "x-session-affinity": resolved.sessionAffinity })
    };
    const response = await context.config.transport.universal({
      endpoint: route.endpoint,
      ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
      gateway: resolved.gateway,
      headers: forwardedHeaders(init, input, route),
      provider: route.provider,
      query,
      // The vendor puts the call's abort signal on the request it builds; the
      // call's own is the fallback for a provider that forgets to.
      signal: init?.signal ?? context.signal
    });
    context.capture.provider = route.provider;
    context.capture.response = response;
    // A vendor's own error is the vendor's to explain, and its provider knows
    // how; only the gateway's own failures are lifted here.
    if (response.ok) return response;
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return replayed(response, text);
    }
    if (!isGatewayErrorEnvelope(body)) return replayed(response, text);
    throw errorFromGatewayEnvelope(body, {
      model: modelOf(query) ?? route.provider,
      requestBodyValues: query,
      responseBody: text,
      responseHeaders: headersToObject(response.headers),
      status: response.status,
      url: context.config.transport.url
    });
  };
  return routed as typeof globalThis.fetch;
}

/** The model id out of a vendor body, for error reporting. */
function modelOf(query: unknown): string | undefined {
  if (query === null || typeof query !== "object") return undefined;
  const model = (query as { model?: unknown }).model;
  return typeof model === "string" ? model : undefined;
}

/** The call options a routed model sees: ours are read out and removed. */
function withoutOurOptions(
  options: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  const providerOptions = options.providerOptions;
  if (
    providerOptions === undefined ||
    !(PROVIDER_OPTIONS_KEY in providerOptions)
  ) {
    return options;
  }
  const rest = { ...providerOptions };
  delete rest[PROVIDER_OPTIONS_KEY];
  return { ...options, providerOptions: rest };
}

/** Adds our metadata block without dropping the vendor's own keys. */
function mergeMetadata(
  existing: SharedV4ProviderMetadata | undefined,
  ours: SharedV4ProviderMetadata
): SharedV4ProviderMetadata {
  return { ...existing, ...ours };
}

/**
 * The same metadata, in the shape an image result's provider metadata takes.
 *
 * `ImageModelV4ProviderMetadata` is not the shared shape: every provider block
 * must carry an `images` array, one entry per generated image, and the AI SDK
 * spreads that array when it merges the calls a multi-image request fanned out
 * into. A block without one makes `generateImage` throw, and only the array's
 * entries survive that merge, so ours goes inside it.
 */
function metadataFor(
  result: object,
  ours: SharedV4ProviderMetadata
): SharedV4ProviderMetadata {
  const images = (result as { images?: unknown }).images;
  if (!Array.isArray(images)) return ours;
  const block = ours[PROVIDER_OPTIONS_KEY] as JSONObject;
  return {
    ...ours,
    [PROVIDER_OPTIONS_KEY]: {
      ...block,
      images: images.map(() => ({ ...block })) as JSONArray
    }
  };
}

/**
 * The Workers AI knobs a routed vendor model cannot honour. They are not
 * dropped silently: the vendor decides its own reasoning, so a caller who set
 * `reasoningEffort` here is asking for something that never leaves.
 */
function ignoredWarnings(resolved: ResolvedOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  for (const [option, value] of [
    ["reasoningEffort", resolved.reasoningEffort],
    ["chatTemplateKwargs", resolved.chatTemplateKwargs]
  ] as const) {
    if (value === undefined) continue;
    warnings.push({
      details: `\`${option}\` is a Workers AI setting and does not apply to a model routed through AI Gateway; use the vendor's own reasoning options instead.`,
      feature: option,
      type: "unsupported"
    });
  }
  return warnings;
}

/**
 * The Workers AI knobs a routed non-language model was asked with, added to
 * the result's own `warnings` when it has one.
 *
 * Only the per-call `providerOptions.cloudflare` bag can carry them here —
 * {@link RoutedModelOptions} leaves them off the per-model type — and only
 * some v4 result shapes have somewhere to put a warning: image, speech,
 * transcription and reranking results do, an embedding result does not.
 */
function routedWarnings(
  result: object,
  resolved: ResolvedOptions
): { warnings?: SharedV4Warning[] } {
  const existing = (result as { warnings?: unknown }).warnings;
  if (!Array.isArray(existing)) return {};
  const warnings = ignoredWarnings(resolved);
  if (warnings.length === 0) return {};
  return { warnings: [...(existing as SharedV4Warning[]), ...warnings] };
}

/**
 * Stamps the finish part with `providerMetadata.cloudflare`, and adds our own
 * warnings to the `stream-start` the vendor emitted.
 */
function stampStream(
  metadata: () => SharedV4ProviderMetadata,
  warnings: SharedV4Warning[]
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  return new TransformStream({
    transform(part, controller) {
      if (part.type === "finish") {
        controller.enqueue({
          ...part,
          providerMetadata: mergeMetadata(part.providerMetadata, metadata())
        });
        return;
      }
      if (part.type === "stream-start" && warnings.length > 0) {
        controller.enqueue({
          ...part,
          warnings: [...part.warnings, ...warnings]
        });
        return;
      }
      controller.enqueue(part);
    }
  });
}

/**
 * A `LanguageModelV4` that is the user's own vendor model, routed through AI
 * Gateway. Generation, parsing, tool handling and error shapes stay the
 * vendor's; only the transport is Cloudflare's.
 *
 * @experimental This surface is experimental and may change.
 */
export class GatewayLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;

  readonly #model: LanguageModelV4;
  readonly #options: ModelOptions | undefined;
  readonly #config: LanguageModelConfig;

  constructor(
    model: LanguageModelV4,
    options: ModelOptions | undefined,
    config: LanguageModelConfig
  ) {
    // Fail where the mistake was made, not one call later.
    requireConfig(model);
    this.#model = model;
    this.#options = options;
    this.#config = config;
    rememberOptions(this, options);
  }

  /** The vendor's own provider name — `anthropic.messages`, `openai.responses`. */
  get provider(): string {
    return this.#model.provider;
  }

  /** The vendor's own id spelling, which the gateway requires verbatim. */
  get modelId(): string {
    return this.#model.modelId;
  }

  get supportedUrls(): LanguageModelV4["supportedUrls"] {
    return this.#model.supportedUrls;
  }

  /** The model this wraps, for callers that need the vendor object back. */
  get model(): LanguageModelV4 {
    return this.#model;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    const call = parseCallOptions(options.providerOptions);
    const resolved = this.#resolve(call);
    const upstream = withoutOurOptions(options);
    const legOptions = withoutCallFallback(options);
    return this.#withFallback(
      call,
      (leg) => leg.doGenerate(legOptions),
      async () => {
        const capture: RouteCapture = {};
        const clone = this.#route(resolved, capture, options.abortSignal);
        const result = await clone.doGenerate(upstream);
        const warnings = ignoredWarnings(resolved);
        return {
          ...result,
          providerMetadata: mergeMetadata(
            result.providerMetadata,
            this.#metadata(resolved, capture)
          ),
          response: this.#response(result.response, capture),
          warnings:
            warnings.length > 0
              ? [...result.warnings, ...warnings]
              : result.warnings
        };
      }
    );
  }

  async doStream(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4StreamResult> {
    const call = parseCallOptions(options.providerOptions);
    const resolved = this.#resolve(call);
    const upstream = withoutOurOptions(options);
    const legOptions = withoutCallFallback(options);
    return this.#withFallback(
      call,
      (leg) => leg.doStream(legOptions),
      async () => {
        const capture: RouteCapture = {};
        const clone = this.#route(resolved, capture, options.abortSignal);
        const result = await clone.doStream(upstream);
        return {
          ...result,
          response: this.#response(result.response, capture),
          stream: result.stream.pipeThrough(
            stampStream(
              () => this.#metadata(resolved, capture),
              ignoredWarnings(resolved)
            )
          )
        };
      }
    );
  }

  #route(
    resolved: ResolvedOptions,
    capture: RouteCapture,
    signal: AbortSignal | undefined
  ): LanguageModelV4 {
    return cloneWithFetch(
      this.#model,
      routedFetch({ capture, config: this.#config, resolved, signal })
    );
  }

  #resolve(call: ModelOptions | undefined): ResolvedOptions {
    return resolveOptions(this.#config.providerGateway, this.#options, call);
  }

  #metadata(
    resolved: ResolvedOptions,
    capture: RouteCapture
  ): SharedV4ProviderMetadata {
    const response = capture.response ?? new Response(null);
    return cloudflareMetadata(
      this.modelId,
      resolved,
      response,
      this.#config.transport,
      capture.provider
    );
  }

  #response<T extends { headers?: Record<string, string> } | undefined>(
    response: T,
    capture: RouteCapture
  ): T {
    if (capture.response === undefined) return response;
    const headers = headersToObject(capture.response.headers);
    return { ...response, headers: { ...response?.headers, ...headers } } as T;
  }

  /**
   * The vendor model first, then each fallback leg. A leg named by id is a
   * Workers AI model; a leg that is a model object is asked as it stands, so
   * `ai()` has already wrapped it if it needed wrapping.
   */
  #withFallback<T>(
    call: ModelOptions | undefined,
    runLeg: (model: LanguageModelV4) => PromiseLike<T>,
    run: () => Promise<T>
  ): Promise<T> {
    const legs: FallbackLeg[] = fallbackLegs(this.#options, call);
    if (legs.length === 0) return run();
    return withFallbackLegs(
      [
        { model: this.modelId, run },
        ...legs.map((leg) => {
          const model = typeof leg === "string" ? this.#workersAI(leg) : leg;
          return { model: model.modelId, run: () => runLeg(model) };
        })
      ],
      this.#config.transport.url
    );
  }

  /** A Workers AI leg, carrying this model's gateway options but no chain. */
  #workersAI(modelId: string): LanguageModelV4 {
    return new CloudflareLanguageModel(
      // Belt and braces: `ai()` and the per-call bag both gate their legs, so
      // a non-`@cf/` id can only arrive from a caller that built the model
      // some other way — and it must not reach `env.AI.run` either.
      requireWorkersAIId(modelId),
      { ...this.#options, fallback: undefined },
      this.#config
    );
  }
}

/** The per-call shape every v4 model method takes, in the parts we read. */
interface RoutedCall {
  abortSignal?: AbortSignal;
  providerOptions?: SharedV4ProviderOptions;
}

/**
 * Routes any other AI SDK v4 model the vendor built — embedding, image,
 * speech, transcription — through the same universal gateway request. Only
 * `fetch` is swapped; every `do…` method stays the vendor's, and its result
 * gains `providerMetadata.cloudflare` when the result is an object that can
 * carry one.
 *
 * @experimental This surface is experimental and may change.
 */
export function routed<T extends object>(
  model: T,
  options: RoutedModelOptions | undefined,
  config: LanguageModelConfig
): T {
  requireConfig(model as LanguageModelV4);
  return new Proxy(model, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        typeof value !== "function" ||
        typeof property !== "string" ||
        !property.startsWith("do")
      ) {
        return value;
      }
      return async (call: RoutedCall): Promise<unknown> => {
        const resolved = resolveOptions(
          config.providerGateway,
          options,
          parseCallOptions(call?.providerOptions)
        );
        // Our per-call bag is ours: read here, never handed on, exactly as the
        // language path does. A `fallback` written there is deliberately not
        // acted on — this proxy is modality-blind, so it cannot build a leg
        // for whatever kind of model it wraps, and the option is not on its
        // type. A vendor id inside one is still refused, as everywhere.
        const upstream =
          call?.providerOptions === undefined
            ? call
            : (withoutOurOptions(
                call as unknown as LanguageModelV4CallOptions
              ) as unknown as RoutedCall);
        const capture: RouteCapture = {};
        const clone = cloneWithFetch(
          target as LanguageModelV4,
          routedFetch({ capture, config, resolved, signal: call?.abortSignal })
        );
        const method = Reflect.get(clone, property) as (
          argument: RoutedCall
        ) => Promise<unknown>;
        const result = await method.call(clone, upstream);
        if (result === null || typeof result !== "object") return result;
        const existing = (result as { providerMetadata?: unknown })
          .providerMetadata;
        return {
          ...result,
          ...routedWarnings(result, resolved),
          providerMetadata: mergeMetadata(
            existing as SharedV4ProviderMetadata | undefined,
            metadataFor(
              result,
              cloudflareMetadata(
                String((target as RoutableModel).modelId ?? ""),
                resolved,
                capture.response ?? new Response(null),
                config.transport,
                capture.provider
              )
            )
          )
        };
      };
    }
  });
}
