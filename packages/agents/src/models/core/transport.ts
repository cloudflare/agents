import {
  CloudflareAIError,
  classifyStatus,
  normalizeThrownError
} from "./errors";
import { isCatalogModelId, isWorkersAIId } from "./catalog";
import type { GatewayProviderName } from "./gateway-providers";
import type { AISettings, ResolvedGateway } from "./settings";

/** The reported `url` for a universal call made through the binding. */
const UNIVERSAL_BINDING_URL = "ai-gateway-binding";

/** The reported `url` for a provider-native call made through the binding. */
const NATIVE_BINDING_URL = "ai-gateway-binding-native";

/** The origin the binding's own `fetch` answers on. */
const BINDING_ORIGIN = "https://workers-binding.ai";

/**
 * The `Ai` binding's `fetch`. The binding has one at runtime (workerd's
 * `ai-api.ts`), and aig-entry routes it, but `@cloudflare/workers-types` does
 * not declare it.
 */
interface FetchingBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * The shape of a run-path request body, and of its answer. Only one today:
 * every language request this module sends is chat completions.
 *
 * @experimental This surface is experimental and may change.
 */
export type RunRequestFormat = "chat-completions";

/** One request on the Cloudflare run path. */
export interface TransportRequest {
  /**
   * Model id — a Workers AI id, an AI Gateway catalog id
   * (`<author>/<model>`), or a dynamic route (`dynamic/<route>`).
   */
  model: string;
  /** The provider-shaped request body (`input` on the run path). */
  input: Record<string, unknown>;
  /**
   * The format `input` is in, and that the answer comes back in, for a model
   * AI Gateway's `/run` serves. Defaults to chat completions. A Workers AI
   * model's input is its own, so this is ignored for one.
   */
  format?: RunRequestFormat;
  /** Gateway options for this request. */
  gateway: ResolvedGateway;
  /** Extra request headers, merged last. */
  headers: Record<string, string>;
  /** Abort signal, forwarded to the binding or to `fetch`. */
  signal?: AbortSignal;
}

/**
 * One request on the universal AI Gateway path: a vendor's own request, routed
 * by the gateway to that vendor. The body is the vendor's, untouched — nothing
 * here knows the vendor's wire format.
 *
 * @experimental This surface is experimental and may change.
 */
export interface UniversalRequest {
  /** The gateway provider slug the request is routed to. */
  provider: GatewayProviderName | string;
  /** The vendor path the gateway appends to that provider's base URL. */
  endpoint: string;
  /** The vendor's own request headers, minus its credential header. */
  headers: Record<string, string>;
  /** The vendor's request body, verbatim. */
  query: unknown;
  /** Gateway options for this request. */
  gateway: ResolvedGateway;
  /** Extra headers merged last, outside the vendor's own set. */
  extraHeaders?: Record<string, string>;
  /** Abort signal, forwarded to the binding or to `fetch`. */
  signal?: AbortSignal;
}

/**
 * A vendor's own request, sent to AI Gateway's provider-native path:
 * `{gateway}/{provider}/{endpoint}`. Nothing is converted on the way — the
 * method, headers and body are the vendor's — so the answer is the vendor's
 * own response, streams included.
 *
 * @experimental This surface is experimental and may change.
 */
export interface NativeRequest {
  /** The gateway provider slug, e.g. `anthropic`. */
  provider: GatewayProviderName | string;
  /** The vendor path after the provider slug, query string included. */
  endpoint: string;
  /** The HTTP method the vendor used. */
  method: string;
  /** The vendor's own request headers. */
  headers: Record<string, string>;
  /** The vendor's request body, untouched: JSON, multipart, or none. */
  body: BodyInit | null | undefined;
  /** Gateway options, sent as `cf-aig-*` headers. */
  gateway: ResolvedGateway;
  /** Abort signal, forwarded to the binding. */
  signal?: AbortSignal;
}

/**
 * The single code path both backends implement. Always resolves to a raw
 * `Response`, so streaming and non-streaming calls share one path and nothing
 * is buffered on the caller's behalf.
 *
 * @experimental This surface is experimental and may change.
 */
export interface Transport {
  /** A stable identifier for the endpoint, used in error reporting. */
  readonly url: string;
  run(request: TransportRequest): Promise<Response>;
  /**
   * Sends a vendor's own request through the gateway's universal endpoint.
   * Always resolves to the vendor's raw `Response`, error responses included:
   * only the gateway's own failures (a missing gateway, an unpaid account) are
   * lifted into a {@link CloudflareAIError}, because the vendor's provider
   * knows how to read its own errors and we do not.
   */
  universal(request: UniversalRequest): Promise<Response>;
  /**
   * Sends a vendor's own request to AI Gateway's provider-native path. Like
   * {@link Transport.universal} it resolves to the vendor's raw `Response`,
   * error responses included; the caller lifts only the gateway's own
   * failures.
   */
  native(request: NativeRequest): Promise<Response>;
  /**
   * A log id read off the backend itself when the response carried none. The
   * Workers AI binding exposes the last gateway log id as a mutable property,
   * so it is captured per response rather than read late.
   */
  logIdFallback(response: Response): string | undefined;
}

/**
 * Drops entries whose value is `undefined`. The AI SDK types call headers as
 * `Record<string, string | undefined>`, and an undefined value reaches the
 * binding as the string "undefined" rather than as an absent header.
 */
export function definedHeaders(
  headers: Record<string, string | undefined> | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Copies response headers into a plain object. */
export function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Some run-path responses arrive bare and some wrapped in the Cloudflare API
 * envelope. Unwrap only when the envelope keys are actually present, so a
 * provider payload that happens to have a `result` field is left alone.
 */
export function unwrapEnvelope(
  value: unknown,
  context?: { model: string; url: string; status: number }
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  // A failure envelope may carry no `result` at all, only its errors.
  const failed =
    record.success === false && firstEnvelopeError(record) !== undefined;
  if (failed || ("success" in record && "result" in record)) {
    if (record.success === true) return record.result;
    // A failure envelope can arrive with a 2xx status. Parsing it as a
    // provider payload would produce an empty result and no diagnostic.
    throw new CloudflareAIError({
      code: classifyStatus(
        context?.status,
        typeof record.name === "string" ? record.name : undefined
      ),
      data: value,
      message: errorMessageFrom(value, context?.status),
      model: context?.model ?? "",
      requestBodyValues: undefined,
      status: context?.status,
      url: context?.url ?? ""
    });
  }
  return value;
}

function firstEnvelopeError(
  record: Record<string, unknown>
): { code?: unknown; message?: unknown } | undefined {
  // Live gateway responses use `error` (an array of one); the documented
  // Cloudflare envelope uses `errors`. Accept either.
  for (const key of ["error", "errors"]) {
    const value = record[key];
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first !== null && typeof first === "object") {
        return first as { code?: unknown; message?: unknown };
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as { code?: unknown; message?: unknown };
    }
  }
  return undefined;
}

/**
 * Pulls a human message out of any of the error envelopes the platform emits:
 * the gateway envelope (`error: [{ code, message }]`), the Workers AI
 * validation envelope (`message`/`description` only), a bare
 * `{ error: "..." }`, and the "Model ID missing" internal error, which carries
 * only `description`.
 */
export function errorMessageFrom(
  body: unknown,
  status: number | undefined
): string {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  if (record !== undefined) {
    const envelope = firstEnvelopeError(record);
    if (typeof envelope?.message === "string") return envelope.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
    if (typeof record.description === "string") return record.description;
  }
  if (typeof body === "string" && body !== "") return body;
  return `HTTP ${status ?? "error"}`;
}

/** Builds a {@link CloudflareAIError} from a non-2xx run-path response. */
export async function errorFromResponse(
  response: Response,
  context: { model: string; url: string; requestBodyValues: unknown }
): Promise<CloudflareAIError> {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    // Not JSON — the raw text is the best message we have.
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const envelopeName =
    typeof record?.name === "string" ? record.name : undefined;
  const headers = headersToObject(response.headers);
  return new CloudflareAIError({
    code: classifyStatus(response.status, envelopeName),
    data: body,
    logId: headers["cf-aig-log-id"],
    message: errorMessageFrom(body, response.status),
    model: context.model,
    requestBodyValues: context.requestBodyValues,
    responseBody: text,
    responseHeaders: headers,
    status: response.status,
    url: context.url
  });
}

/**
 * The gateway's own options for the universal call. The id is not among them:
 * it selects the gateway (`env.AI.gateway(id)`), and the binding's own `id`
 * field is deprecated.
 */
function universalGatewayOptions(
  gateway: ResolvedGateway
): UniversalGatewayOptions {
  // `id` is deprecated on this type but still required by it; the gateway is
  // already selected by `env.AI.gateway(id)`, so it repeats that id.
  const options: UniversalGatewayOptions = { id: gateway.id };
  if (gateway.skipCache !== undefined) options.skipCache = gateway.skipCache;
  if (gateway.cacheTtl !== undefined) options.cacheTtl = gateway.cacheTtl;
  if (gateway.cacheKey !== undefined) options.cacheKey = gateway.cacheKey;
  if (gateway.metadata !== undefined) options.metadata = gateway.metadata;
  if (gateway.collectLog !== undefined) options.collectLog = gateway.collectLog;
  if (gateway.eventId !== undefined) options.eventId = gateway.eventId;
  if (gateway.requestTimeoutMs !== undefined) {
    options.requestTimeoutMs = gateway.requestTimeoutMs;
  }
  if (gateway.retries !== undefined) options.retries = gateway.retries;
  return options;
}

/**
 * The gateway options as the `cf-aig-*` request headers AI Gateway reads.
 * The provider-native path has no options object, so every option travels
 * this way; the names are the gateway's own.
 */
function gatewayHeaders(gateway: ResolvedGateway): Record<string, string> {
  const headers: Record<string, string> = {};
  if (gateway.cacheTtl !== undefined) {
    headers["cf-aig-cache-ttl"] = String(gateway.cacheTtl);
  }
  if (gateway.skipCache !== undefined) {
    headers["cf-aig-skip-cache"] = String(gateway.skipCache);
  }
  if (gateway.cacheKey !== undefined) {
    headers["cf-aig-cache-key"] = gateway.cacheKey;
  }
  if (gateway.metadata !== undefined) {
    headers["cf-aig-metadata"] = JSON.stringify(gateway.metadata);
  }
  if (gateway.collectLog !== undefined) {
    headers["cf-aig-collect-log"] = String(gateway.collectLog);
  }
  if (gateway.eventId !== undefined) {
    headers["cf-aig-event-id"] = gateway.eventId;
  }
  if (gateway.requestTimeoutMs !== undefined) {
    headers["cf-aig-request-timeout"] = String(gateway.requestTimeoutMs);
  }
  const retries = gateway.retries;
  if (retries?.maxAttempts !== undefined) {
    headers["cf-aig-max-attempts"] = String(retries.maxAttempts);
  }
  if (retries?.retryDelayMs !== undefined) {
    headers["cf-aig-retry-delay"] = String(retries.retryDelayMs);
  }
  if (retries?.backoff !== undefined) {
    headers["cf-aig-backoff"] = retries.backoff;
  }
  if (gateway.byokAlias !== undefined) {
    headers["cf-aig-byok-alias"] = gateway.byokAlias;
  }
  if (gateway.zdr !== undefined) headers["cf-aig-zdr"] = String(gateway.zdr);
  return headers;
}

/**
 * The binding's options for the Workers AI run path: the gateway options its
 * `GatewayOptions` type defines, and the headers for the ones it does not.
 *
 * `byokAlias` reaches `/run` as `cf-aig-byok-alias`, which aig-entry forwards
 * and `/run` reads for a catalog model's stored key. `zdr` is left off: `/run`
 * does not read it, so it applies to provider-native requests only.
 */
function runOptions(request: TransportRequest): {
  gateway: GatewayOptions;
  headers: Record<string, string>;
} {
  const { byokAlias, zdr: _zdr, ...gateway } = request.gateway;
  return {
    gateway,
    headers: {
      ...request.headers,
      ...(byokAlias !== undefined && isCatalogModelId(request.model)
        ? { "cf-aig-byok-alias": byokAlias }
        : {})
    }
  };
}

/**
 * What `/run` calls each request format in the binding's `openaiEndpoint`
 * option, which `aig-entry` turns into `/run`'s `requestFormat`.
 */
const OPENAI_ENDPOINTS: Record<RunRequestFormat, string> = {
  "chat-completions": "/v1/chat/completions"
};

/**
 * Whether a parsed body is the gateway's own error envelope rather than a
 * vendor payload — `{ success: false, error: [{ code, message }] }`, named
 * `AiGatewayError`. The gateway answers this for its own failures (no such
 * gateway, unified billing unpaid, provider not configured); everything else
 * on this path is the vendor's own error, which the vendor's provider reads.
 *
 * @experimental This surface is experimental and may change.
 */
export function isGatewayErrorEnvelope(json: unknown): boolean {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return false;
  }
  const record = json as Record<string, unknown>;
  if (record.name === "AiGatewayError") return true;
  if (record.success !== false) return false;
  const errors = record.error ?? record.errors;
  return (
    Array.isArray(errors) &&
    errors.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { message?: unknown }).message === "string"
    )
  );
}

/**
 * Builds a {@link CloudflareAIError} from the gateway's own error envelope, so
 * a gateway failure on the universal path classifies and retries exactly as
 * one on the Workers AI run path.
 *
 * @experimental This surface is experimental and may change.
 */
export function errorFromGatewayEnvelope(
  body: unknown,
  context: {
    model: string;
    url: string;
    requestBodyValues: unknown;
    status?: number;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
  }
): CloudflareAIError {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  return new CloudflareAIError({
    code: classifyStatus(
      context.status,
      typeof record?.name === "string" ? record.name : "AiGatewayError"
    ),
    data: body,
    logId: context.responseHeaders?.["cf-aig-log-id"],
    message: errorMessageFrom(body, context.status),
    model: context.model,
    requestBodyValues: context.requestBodyValues,
    responseBody: context.responseBody,
    responseHeaders: context.responseHeaders,
    status: context.status,
    url: context.url
  });
}

/**
 * The model id a universal request is about, for error reporting. Every vendor
 * body carries `model`; the endpoint is the fallback.
 */
function universalModel(request: UniversalRequest): string {
  const query = request.query;
  if (query !== null && typeof query === "object" && !Array.isArray(query)) {
    const model = (query as Record<string, unknown>).model;
    if (typeof model === "string") return model;
  }
  return `${request.provider}/${request.endpoint}`;
}

/**
 * The `Ai` binding narrowed to the raw-response overload. The ambient
 * overloads pick their return type from the model id, and every catalog slug
 * lands on the `Record<string, unknown>` fallback, so the run-path signature
 * is stated explicitly here.
 */
interface RawResponseBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: AiOptions & {
      returnRawResponse: true;
      /**
       * Not in `AiOptions`: the binding forwards every option, and
       * `aig-entry` maps this one onto `/run`'s `requestFormat`.
       */
      openaiEndpoint?: string;
    }
  ): Promise<Response>;
}

/** The keyless in-Worker backend: `env.AI.run(...)`. */
function bindingTransport(binding: Ai): Transport {
  const raw = binding as unknown as RawResponseBinding;
  // `aiGatewayLogId` is a mutable property on the binding that every
  // concurrent `run` overwrites, so it is snapshotted against the response it
  // belongs to the moment that response arrives. A run that resolves while
  // another is mid-flight can still read the other's id; the window is one
  // microtask rather than the whole request.
  const logIds = new WeakMap<Response, string>();
  return {
    logIdFallback(response) {
      return logIds.get(response);
    },
    async run(request) {
      try {
        // Called as a method, never detached: the binding reads private
        // fields and throws on a detached reference.
        const run = runOptions(request);
        const response = await raw.run(request.model, request.input, {
          ...(Object.keys(run.headers).length > 0
            ? { extraHeaders: run.headers }
            : {}),
          gateway: run.gateway,
          // A Workers AI id goes to Workers AI itself; any other id is served
          // by AI Gateway's `/run`, which reads the body and answers in the
          // format named here. Without it `/run` guesses the format from the
          // body and wraps an answer it cannot place in `{ state, result }`.
          ...(isWorkersAIId(request.model)
            ? {}
            : {
                openaiEndpoint:
                  OPENAI_ENDPOINTS[request.format ?? "chat-completions"]
              }),
          returnRawResponse: true,
          signal: request.signal
        });
        const logId = binding.aiGatewayLogId;
        if (logId !== null && logId !== undefined) {
          logIds.set(response, logId);
        }
        return response;
      } catch (error) {
        // `returnRawResponse` resolves with a `Response` for upstream errors,
        // so a throw here means the binding itself failed (e.g. code 3040,
        // out of capacity).
        throw normalizeThrownError(error, {
          model: request.model,
          requestBodyValues: request.input,
          url: "workers-ai-binding"
        });
      }
    },
    async universal(request) {
      try {
        // Called as a method on the binding, and on the `AiGateway` it
        // returns: both read private fields.
        return await binding.gateway(request.gateway.id).run(
          {
            endpoint: request.endpoint,
            headers: request.headers,
            provider: request.provider,
            query: request.query
          },
          {
            ...(request.extraHeaders === undefined
              ? {}
              : { extraHeaders: request.extraHeaders }),
            gateway: universalGatewayOptions(request.gateway),
            signal: request.signal
          }
        );
      } catch (error) {
        throw normalizeThrownError(error, {
          model: universalModel(request),
          requestBodyValues: request.query,
          url: UNIVERSAL_BINDING_URL
        });
      }
    },
    async native(request) {
      try {
        // `fetch` is the binding's own and is called as a method: aig-entry
        // serves `/ai-gateway/gateways/{gateway}/{provider}/*` for it and
        // forwards the request to the provider-native path unchanged.
        return await (binding as unknown as FetchingBinding).fetch(
          `${BINDING_ORIGIN}/ai-gateway/gateways/${encodeURIComponent(
            request.gateway.id
          )}/${request.provider}/${request.endpoint}`,
          {
            body: request.body ?? null,
            headers: { ...request.headers, ...gatewayHeaders(request.gateway) },
            method: request.method,
            signal: request.signal
          }
        );
      } catch (error) {
        throw normalizeThrownError(error, {
          model: `${request.provider}/${request.endpoint}`,
          requestBodyValues: undefined,
          url: NATIVE_BINDING_URL
        });
      }
    },
    url: "workers-ai-binding"
  };
}

/**
 * Builds the transport for a set of provider settings. The model id, not the
 * caller, decides the wire format; the transport only decides how the request
 * physically leaves the Worker.
 *
 * @experimental This surface is experimental and may change.
 */
export function createTransport(settings: AISettings): Transport {
  if (settings.binding === undefined) {
    throw new Error("createAI requires { binding }: the Workers AI binding.");
  }
  return bindingTransport(settings.binding);
}
