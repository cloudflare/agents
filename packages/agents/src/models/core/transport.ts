import {
  CloudflareAIError,
  classifyStatus,
  normalizeThrownError
} from "./errors";
import { isCatalogModelId, isWorkersAIId } from "./catalog";
import { type ResumeFetch, resumableBody } from "./resume";
import type { GatewayProviderName } from "./gateway-providers";
import type { AISettings, ResolvedGateway } from "./settings";

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
 * The shape of a run-path request body, and of its answer, for a model AI
 * Gateway's `/run` serves. A request in a model's native format is not
 * converted, streams included.
 *
 * @experimental This surface is experimental and may change.
 */
export type RunRequestFormat = "chat-completions" | "messages" | "responses";

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
   * Sends a vendor's own request to AI Gateway's provider-native path. It
   * resolves to the vendor's raw `Response`, error responses included: only
   * the gateway's own failures (a missing gateway, an unpaid account) are
   * lifted, by the caller, because the vendor's own code knows how to read
   * its errors and we do not.
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
 * The binding's resume route for the run a response names. Only called for a
 * response {@link withResume} has checked carries `cf-aig-run-id`.
 */
function resumeUrl(
  gatewayId: string,
  response: Response,
  from: number
): string {
  const runId = response.headers.get("cf-aig-run-id") ?? "";
  return `${BINDING_ORIGIN}/ai-gateway/gateways/${encodeURIComponent(
    gatewayId
  )}/run/${encodeURIComponent(runId)}/resume?from=${from}`;
}

/**
 * A streamed `/run` answer that names its run (`cf-aig-run-id`) resumes from
 * the last complete event if the connection drops; see `resume.ts`. Anything
 * else — a JSON answer, an error, a Workers AI stream with no run id — is
 * returned as it is.
 */
function withResume(
  response: Response,
  request: TransportRequest,
  resume: ResumeFetch
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !response.ok ||
    response.body === null ||
    !contentType.includes("text/event-stream") ||
    response.headers.get("cf-aig-run-id") === null
  ) {
    return response;
  }
  return new Response(
    resumableBody({
      initial: response.body,
      model: request.model,
      resume,
      signal: request.signal,
      url: "workers-ai-binding"
    }),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    }
  );
}

/**
 * What `/run` calls each request format in the binding's `openaiEndpoint`
 * option, which `aig-entry` turns into `/run`'s `requestFormat`.
 */
const OPENAI_ENDPOINTS: Record<RunRequestFormat, string> = {
  "chat-completions": "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses"
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
 * a gateway failure on the provider-native path classifies and retries exactly as
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
        const resumable = withResume(response, request, (from, signal) =>
          // The binding's own `fetch`; aig-entry serves the resume route for it.
          (binding as unknown as FetchingBinding).fetch(
            resumeUrl(run.gateway.id, response, from),
            { method: "GET", signal }
          )
        );
        const logId = binding.aiGatewayLogId;
        if (logId !== null && logId !== undefined) {
          logIds.set(resumable, logId);
        }
        return resumable;
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
