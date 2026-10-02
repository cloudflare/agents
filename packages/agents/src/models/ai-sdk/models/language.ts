import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
  SharedV4Warning
} from "@ai-sdk/provider";
import { CloudflareAIError, requireWorkersAIId } from "../errors";
import {
  fallbackLegs,
  rememberOptions,
  parseCallOptions,
  PROVIDER_OPTIONS_KEY,
  resolveOptions,
  withoutCallFallback,
  type FallbackLeg,
  type ModelOptions,
  type ProviderGatewaySettings,
  type ResolvedOptions
} from "../settings";
import { normalizeChatCompletionsStream } from "../../core/chat-completions";
import { sseDataStream } from "../../core/sse";
import {
  definedHeaders,
  errorFromResponse,
  headersToObject,
  unwrapEnvelope,
  type Transport
} from "../transport";
import {
  buildOpenAIRequest,
  openAIStreamParser,
  parseOpenAIGeneration
} from "../wires/chat-completions";
import { newId, type WireGeneration } from "../wires/shared";
import {
  withFallbackLegs,
  type FallbackAttempt,
  withStreamFallbackLegs
} from "./fallback";

/**
 * Typed observability attached to every result under
 * `providerMetadata.cloudflare`, so consumers never have to walk response
 * objects looking for a gateway log id.
 *
 * @experimental This surface is experimental and may change.
 */
export interface CloudflareMetadata {
  /** The model that actually answered — the fallback leg, when one was used. */
  model: string;
  /** The gateway id the request went through. */
  gateway: string;
  /**
   * The gateway provider slug the request was routed to, for a model reached
   * through the universal gateway path. Absent for Workers AI.
   */
  provider?: string;
  /** `cf-aig-log-id`, or the binding's last log id. */
  logId?: string;
  /** `cf-aig-event-id` — correlates the requests of one gateway event. */
  eventId?: string;
  /** `cf-aig-request-id` — the gateway's id for this request. */
  requestId?: string;
  /** `cf-aig-trace-id` — the trace this request belongs to. */
  traceId?: string;
  /** `cf-aig-run-id`, when the gateway sends one. */
  runId?: string;
  /** `cf-aig-cache-status`, e.g. `HIT` or `MISS`. */
  cacheStatus?: string;
  /** `cf-aig-step` — which step of a gateway route answered. */
  step?: number;
}

/** Everything a language model needs from the provider that created it. */
export interface LanguageModelConfig {
  transport: Transport;
  /**
   * The provider-wide gateway defaults, in any of the spellings `createAI`
   * takes: a bare id, a `gateway` object, or the whole settings object with
   * the flat gateway keys on it.
   */
  providerGateway: string | ProviderGatewaySettings | undefined;
}

function callHeaders(
  options: LanguageModelV4CallOptions,
  resolved: ResolvedOptions
): Record<string, string> {
  const headers = definedHeaders(options.headers);
  Object.assign(headers, resolved.headers);
  if (resolved.sessionAffinity !== undefined) {
    headers["x-session-affinity"] = resolved.sessionAffinity;
  }
  return headers;
}

/**
 * Builds the `providerMetadata.cloudflare` block every model in this module
 * attaches to its result. Shared with the non-language models in
 * `models/modality.ts`.
 */
export function cloudflareMetadata(
  model: string,
  resolved: ResolvedOptions,
  response: Response,
  transport: Transport,
  provider?: string
): SharedV4ProviderMetadata {
  const headers = response.headers;
  const rawStep = headers.get("cf-aig-step");
  const step = rawStep === null ? Number.NaN : Number(rawStep);
  const metadata: CloudflareMetadata = {
    gateway: resolved.gateway.id,
    model,
    ...(provider === undefined ? {} : { provider }),
    ...(Number.isNaN(step) ? {} : { step })
  };
  for (const [field, header] of [
    ["cacheStatus", "cf-aig-cache-status"],
    ["eventId", "cf-aig-event-id"],
    ["requestId", "cf-aig-request-id"],
    ["runId", "cf-aig-run-id"],
    ["traceId", "cf-aig-trace-id"]
  ] as const) {
    const value = headers.get(header);
    if (value !== null) metadata[field] = value;
  }
  const logId =
    headers.get("cf-aig-log-id") ?? transport.logIdFallback(response);
  if (logId !== undefined && logId !== null) metadata.logId = logId;
  return { [PROVIDER_OPTIONS_KEY]: metadata as unknown as JSONObject };
}

interface BuiltRequest {
  body: Record<string, unknown>;
  warnings: SharedV4Warning[];
  /** The body turns reasoning off via the chat template. */
  reasoningOff?: boolean;
}

function buildRequest(
  modelId: string,
  options: LanguageModelV4CallOptions,
  resolved: ResolvedOptions,
  stream: boolean
): BuiltRequest {
  return buildOpenAIRequest(options, {
    chatTemplateKwargs: resolved.chatTemplateKwargs,
    modelId,
    reasoningEffort: resolved.reasoningEffort,
    stream
  });
}

/**
 * Prepends the single `stream-start` part and stamps `providerMetadata` onto
 * the `finish` part. A `TransformStream` rather than a manual enqueue so the
 * pipeline keeps its backpressure and error propagation.
 */
function decorateStream(
  warnings: SharedV4Warning[],
  providerMetadata: SharedV4ProviderMetadata
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  let started = false;
  const start = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    if (started) return;
    started = true;
    controller.enqueue({ type: "stream-start", warnings });
  };
  return new TransformStream({
    flush(controller) {
      // A stream that produced nothing still owes the caller a stream-start.
      start(controller);
    },
    transform(part, controller) {
      start(controller);
      controller.enqueue(
        part.type === "finish" ? { ...part, providerMetadata } : part
      );
    }
  });
}

/**
 * Replays an already-complete generation as a stream. Workers AI sometimes
 * answers a `stream: true` request with a plain JSON body; degrading
 * gracefully beats failing the call.
 */
function oneShotStream(
  generation: WireGeneration
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      if (
        generation.responseId !== undefined ||
        generation.responseModelId !== undefined
      ) {
        controller.enqueue({
          id: generation.responseId,
          modelId: generation.responseModelId,
          timestamp: generation.timestamp,
          type: "response-metadata"
        });
      }
      for (const part of generation.content) {
        emitContent(part, controller);
      }
      controller.enqueue({
        finishReason: generation.finishReason,
        type: "finish",
        usage: generation.usage
      });
      controller.close();
    }
  });
}

function emitContent(
  part: LanguageModelV4Content,
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>
): void {
  switch (part.type) {
    case "text": {
      const id = newId();
      controller.enqueue({ id, type: "text-start" });
      controller.enqueue({ delta: part.text, id, type: "text-delta" });
      controller.enqueue({
        id,
        type: "text-end",
        ...(part.providerMetadata === undefined
          ? {}
          : { providerMetadata: part.providerMetadata })
      });
      break;
    }
    case "reasoning": {
      const id = newId();
      controller.enqueue({ id, type: "reasoning-start" });
      controller.enqueue({ delta: part.text, id, type: "reasoning-delta" });
      controller.enqueue({
        id,
        type: "reasoning-end",
        ...(part.providerMetadata === undefined
          ? {}
          : { providerMetadata: part.providerMetadata })
      });
      break;
    }
    case "tool-call": {
      controller.enqueue({
        id: part.toolCallId,
        toolName: part.toolName,
        type: "tool-input-start"
      });
      controller.enqueue({
        delta: part.input,
        id: part.toolCallId,
        type: "tool-input-delta"
      });
      controller.enqueue({ id: part.toolCallId, type: "tool-input-end" });
      controller.enqueue(part);
      break;
    }
    default:
      controller.enqueue(part);
  }
}

/**
 * A `LanguageModelV4` backed by the Cloudflare run path. The model id decides
 * the wire format; nothing about transport or wire format reaches user land.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "cloudflare";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]>;

  readonly #config: LanguageModelConfig;
  readonly #options: ModelOptions | undefined;

  constructor(
    modelId: string,
    options: ModelOptions | undefined,
    config: LanguageModelConfig
  ) {
    this.modelId = modelId;
    this.#options = options;
    this.#config = config;
    rememberOptions(this, options);
    // Workers AI takes image bytes inline; it fetches no URL on our behalf.
    this.supportedUrls = {};
  }

  async doGenerate(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> {
    const call = parseCallOptions(options.providerOptions);
    const resolved = this.#resolve(call);
    const legOptions = withoutCallFallback(options);
    return this.#withFallback(
      call,
      (model) => model.doGenerate(legOptions),
      async (modelId) => {
        const request = buildRequest(modelId, options, resolved, false);
        const response = await this.#send(modelId, request, options, resolved);
        const raw = await this.#readBody(modelId, request, response);
        const generation = parseOpenAIGeneration(raw, modelId);
        return {
          content: generation.content,
          finishReason: generation.finishReason,
          providerMetadata: cloudflareMetadata(
            modelId,
            resolved,
            response,
            this.#config.transport
          ),
          request: { body: request.body },
          response: {
            headers: headersToObject(response.headers),
            id: generation.responseId,
            modelId: generation.responseModelId ?? modelId,
            timestamp: generation.timestamp
          },
          usage: generation.usage,
          warnings: request.warnings
        };
      }
    );
  }

  async doStream(
    options: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4StreamResult> {
    const call = parseCallOptions(options.providerOptions);
    const resolved = this.#resolve(call);
    const legOptions = withoutCallFallback(options);
    return this.#withFallback(
      call,
      (model) => model.doStream(legOptions),
      async (modelId) => {
        const request = buildRequest(modelId, options, resolved, true);
        const response = await this.#send(modelId, request, options, resolved);
        const providerMetadata = cloudflareMetadata(
          modelId,
          resolved,
          response,
          this.#config.transport
        );
        const contentType = response.headers.get("content-type") ?? "";
        const decorate = decorateStream(request.warnings, providerMetadata);

        let parts: ReadableStream<LanguageModelV4StreamPart>;
        if (!contentType.includes("event-stream") || response.body === null) {
          const raw = await this.#readBody(modelId, request, response);
          parts = oneShotStream(parseOpenAIGeneration(raw, modelId));
        } else {
          parts = response.body
            .pipeThrough(sseDataStream())
            // Strict OpenAI chunks only: the compat layer absorbs Workers AI's
            // native events, heartbeats and per-delta usage.
            .pipeThrough(
              normalizeChatCompletionsStream(modelId, {
                reasoningOff: request.reasoningOff
              })
            )
            .pipeThrough(openAIStreamParser());
        }

        return {
          request: { body: request.body },
          response: { headers: headersToObject(response.headers) },
          stream: parts.pipeThrough(decorate)
        };
      },
      "stream"
    );
  }

  /**
   * Reads a 2xx body as JSON and unwraps the Cloudflare envelope. A 2xx that
   * is not JSON at all is a provider failure, not a caller bug, so it comes
   * back as a {@link CloudflareAIError} rather than a bare `SyntaxError`.
   */
  async #readBody(
    modelId: string,
    request: BuiltRequest,
    response: Response
  ): Promise<unknown> {
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new CloudflareAIError({
        cause: error,
        code: "provider-error",
        isRetryable: false,
        message: `The model answered ${response.status} with a body that is not JSON.`,
        model: modelId,
        requestBodyValues: request.body,
        status: response.status,
        url: this.#config.transport.url
      });
    }
    return unwrapEnvelope(json, {
      model: modelId,
      status: response.status,
      url: this.#config.transport.url
    });
  }

  #resolve(call: ModelOptions | undefined): ResolvedOptions {
    return resolveOptions(this.#config.providerGateway, this.#options, call);
  }

  async #send(
    modelId: string,
    request: BuiltRequest,
    options: LanguageModelV4CallOptions,
    resolved: ResolvedOptions
  ): Promise<Response> {
    const response = await this.#config.transport.run({
      gateway: resolved.gateway,
      headers: callHeaders(options, resolved),
      input: request.body,
      model: modelId,
      signal: options.abortSignal
    });
    if (!response.ok) {
      throw await errorFromResponse(response, {
        model: modelId,
        requestBodyValues: request.body,
        url: this.#config.transport.url
      });
    }
    return response;
  }

  /**
   * Runs this model, then each fallback leg in order. A leg named by id runs
   * through this same pipeline; a leg that is a model object — a vendor model
   * `ai()` already wrapped, or another provider's — is asked directly, so a
   * chain can mix Workers AI with anything the AI SDK can reach.
   */
  #withFallback<T>(
    call: ModelOptions | undefined,
    runLeg: (model: LanguageModelV4) => PromiseLike<T>,
    runSelf: (modelId: string) => Promise<T>,
    mode: "generate" | "stream" = "generate"
  ): Promise<T> {
    const legs: FallbackLeg[] = fallbackLegs(this.#options, call);
    const chain = (attempts: FallbackAttempt<T>[]): Promise<T> =>
      mode === "stream"
        ? (withStreamFallbackLegs(
            attempts as FallbackAttempt<LanguageModelV4StreamResult>[],
            this.#config.transport.url
          ) as Promise<T>)
        : withFallbackLegs(attempts, this.#config.transport.url);
    return chain([
      { model: this.modelId, run: () => runSelf(this.modelId) },
      ...legs.map((leg) =>
        typeof leg === "string"
          ? // Belt and braces: `ai()` and the per-call bag both gate their
            // legs, and a vendor id must never reach `env.AI.run`. Checked
            // as the chain is built, so the throw is not swallowed as one
            // more failed leg.
            { model: requireWorkersAIId(leg), run: () => runSelf(leg) }
          : { model: leg.modelId, run: () => runLeg(leg) }
      )
    ]);
  }
}
