/**
 * Helpers shared by the three pi-ai wires: the empty assistant message every
 * stream starts from, usage and cost accounting, response diagnostics, the
 * stream idle deadline, SSE iteration, and error termination.
 */

import type { CompatWarning } from "../../core/chat-completions";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageDiagnostic,
  type Model,
  type SimpleStreamOptions,
  type Usage,
  calculateCost
} from "@earendil-works/pi-ai";
import { sseDataStream } from "../../core/sse";
import type { Transport } from "../../core/transport";
import {
  errorFromGatewayEnvelope,
  headersToObject,
  isGatewayErrorEnvelope
} from "../../core/transport";
import { specifierOf, wireModelId } from "../catalog";
import { gatewaySlugForModel, routeForModel } from "../routing";
import type { WireRequest } from "../settings";

/** Diagnostic type under which gateway correlation ids are recorded. */
export const CLOUDFLARE_DIAGNOSTIC = "cloudflare";

/** The diagnostic type under which compat-layer warnings are recorded. */
export const COMPAT_DIAGNOSTIC = "cloudflare-compat";

/** Records compat warnings on a message as a `cloudflare-compat` diagnostic. */
export function recordWarnings(
  output: AssistantMessage,
  warnings: CompatWarning[]
): void {
  if (warnings.length === 0) return;
  output.diagnostics = [
    ...(output.diagnostics ?? []),
    {
      details: { warnings },
      timestamp: Date.now(),
      type: COMPAT_DIAGNOSTIC
    }
  ];
}

/**
 * The Workers-AI-only knobs a vendor model cannot honour. They are not sent —
 * the vendor's own reasoning follows the model's metadata and the pi
 * `reasoning` level — and the drop is recorded rather than silent.
 */
export function ignoredWorkersAIKnobs(request: {
  resolved: { reasoningEffort?: unknown; chatTemplateKwargs?: unknown };
}): CompatWarning[] {
  const warnings: CompatWarning[] = [];
  if (request.resolved.reasoningEffort !== undefined) {
    warnings.push({
      feature: "reasoning-effort",
      message:
        "reasoningEffort is a Workers AI setting and does not apply to a model routed through AI Gateway; use the pi `reasoning` level, which the model's own metadata maps."
    });
  }
  if (request.resolved.chatTemplateKwargs !== undefined) {
    warnings.push({
      feature: "chat-template-kwargs",
      message:
        "chatTemplateKwargs is a Workers AI setting and was not sent to a model routed through AI Gateway."
    });
  }
  return warnings;
}

/** Default cap on how long a stream may stay silent before it is failed. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** OpenAI Responses rejects `max_output_tokens` below 16. */
export const MIN_OUTPUT_TOKENS = 16;

export function emptyUsage(): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0
  };
}

/** The assistant message a stream mutates as events arrive. */
export function startMessage(model: Model<Api>): AssistantMessage {
  return {
    api: model.api,
    content: [],
    model: model.id,
    provider: model.provider,
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: emptyUsage()
  };
}

/**
 * Usage in the OpenAI shape, shared by chat completions and Workers AI.
 *
 * The cache fields are the ones pi-ai's own `parseChunkUsage` reads, spelling
 * for spelling: `prompt_tokens_details.cached_tokens` is OpenAI's, DeepSeek
 * sends `prompt_cache_hit_tokens` instead, and OpenRouter-compatible providers
 * add `prompt_tokens_details.cache_write_tokens`.
 */
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Maps OpenAI-shaped usage onto pi-ai's. `input` excludes cached tokens, as
 * pi-ai's own OpenAI adapter does, and cost comes from the model metadata.
 */
export function usageFromOpenAI(
  model: Model<Api>,
  raw: OpenAIUsage | undefined
): Usage {
  if (raw === undefined) return emptyUsage();
  const prompt = raw.prompt_tokens ?? 0;
  const completion = raw.completion_tokens ?? 0;
  // pi-ai's `parseChunkUsage`, field for field: cached tokens are reads, cache
  // writes are counted separately and both come out of `input`, and a write
  // count is never subtracted from the read count.
  const cacheRead =
    raw.prompt_tokens_details?.cached_tokens ??
    raw.prompt_cache_hit_tokens ??
    0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  const totalTokens = raw.total_tokens ?? prompt + completion;
  // Google counts reasoning outside `completion_tokens` (live: prompt 6 +
  // completion 3 + reasoning 57 = total 66); OpenAI and Workers AI satisfy
  // prompt + completion = total, so the derived figure agrees with theirs.
  const output =
    raw.total_tokens === undefined
      ? completion
      : Math.max(completion, totalTokens - prompt);
  const usage: Usage = {
    cacheRead,
    cacheWrite,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output,
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens
  };
  usage.cost = calculateCost(model, usage);
  return usage;
}

/** Gateway correlation read off a response. */
export interface ResponseCorrelation {
  logId?: string;
  runId?: string;
  cacheStatus?: string;
  step?: string;
  eventId?: string;
  traceId?: string;
}

export function correlationOf(
  response: Response,
  transport: Transport
): ResponseCorrelation {
  const get = (name: string) => response.headers.get(name) ?? undefined;
  return {
    cacheStatus: get("cf-aig-cache-status"),
    eventId: get("cf-aig-event-id"),
    logId: get("cf-aig-log-id") ?? transport.logIdFallback(response),
    runId: get("cf-aig-run-id"),
    step: get("cf-aig-step"),
    traceId: get("cf-aig-trace-id")
  };
}

function definedEntries(
  record: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Records where a response came from on the assistant message, as a pi-ai
 * diagnostic: the gateway log id and friends, the answering model and the
 * gateway id. Callers read it back from `message.diagnostics`.
 */
export function attachCorrelation(
  message: AssistantMessage,
  details: ResponseCorrelation & {
    model: string;
    gateway: string;
    provider?: string;
    specifier?: string;
  }
): void {
  const diagnostic: AssistantMessageDiagnostic = {
    details: definedEntries({ ...details }),
    timestamp: Date.now(),
    type: CLOUDFLARE_DIAGNOSTIC
  };
  message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

/**
 * Wraps a body so a gap longer than `idleMs` between chunks rejects the read
 * instead of pending forever. Only an outstanding read is timed, so a slow
 * consumer never trips it; `idleMs <= 0` disables the guard.
 */
export function withIdleDeadline(
  body: ReadableStream<Uint8Array>,
  idleMs: number
): ReadableStream<Uint8Array> {
  if (idleMs <= 0) return body;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(
                  `Model stream stalled: no data received for ${Math.round(idleMs / 1000)}s.`
                )
              );
            }, idleMs);
          })
        ]);
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        void reader.cancel().catch(() => {});
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

/**
 * Iterates the JSON payload of each SSE event. `[DONE]` sentinels and
 * unparseable payloads are skipped; the reader is cancelled if iteration
 * stops early so the upstream request is not left generating.
 */
export async function* sseJson(
  body: ReadableStream<Uint8Array>,
  onDone?: () => void
): AsyncGenerator<unknown> {
  const reader = body.pipeThrough(sseDataStream()).getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value === "") continue;
      if (value === "[DONE]") {
        onDone?.();
        continue;
      }
      try {
        yield JSON.parse(value);
      } catch {
        // A malformed event is dropped rather than failing the stream.
      }
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

/** `response.headers` as pi-ai's `onResponse` callback wants them. */
export function responseInfo(response: Response): {
  status: number;
  headers: Record<string, string>;
} {
  return {
    headers: headersToObject(response.headers),
    status: response.status
  };
}

/**
 * The Anthropic API version every Messages request must name. pi-ai leaves it
 * to the Anthropic SDK, which we replace, so the wire states it here.
 */
const ANTHROPIC_VERSION = "2023-06-01";

/** Beta features pi-ai's own Anthropic client asks for, replicated here. */
const FINE_GRAINED_TOOL_STREAMING_BETA =
  "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/**
 * The vendor headers an Anthropic Messages request needs. pi-ai normally gets
 * them from the Anthropic SDK's defaults plus its own `createClient`; this
 * wire owns the transport instead, so it sets the ones the vendor requires and
 * the betas pi-ai would have asked for. No credential header is sent: the
 * gateway holds the key (unified billing or BYOK).
 */
export function anthropicVendorHeaders(
  model: Model<Api>,
  hasTools: boolean,
  options: SimpleStreamOptions
): {
  [key: string]: string;
} {
  const compat = (model as { compat?: Record<string, unknown> }).compat;
  const betas: string[] = [];
  // pi-ai defaults `supportsEagerToolInputStreaming` to true, and asks for the
  // fine-grained beta only for a model whose author declared it false.
  if (hasTools && compat?.supportsEagerToolInputStreaming === false) {
    betas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  // Adaptive-thinking models have interleaved thinking built in, so pi-ai
  // skips the beta for them; asking anyway is an error on those models. The
  // caller may also turn it off, exactly as pi-ai's own client lets them.
  const interleaved =
    (options as { interleavedThinking?: boolean }).interleavedThinking ?? true;
  if (interleaved && compat?.forceAdaptiveThinking !== true) {
    betas.push(INTERLEAVED_THINKING_BETA);
  }
  return {
    accept: "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(betas.length > 0 ? { "anthropic-beta": betas.join(",") } : {}),
    "content-type": "application/json"
  };
}

/** The vendor headers an OpenAI-shaped request needs. */
export function openAIVendorHeaders(): Record<string, string> {
  return { accept: "application/json", "content-type": "application/json" };
}

/**
 * Sends a vendor's own request body through AI Gateway's universal endpoint.
 *
 * The provider slug comes from the model's base URL and the endpoint from its
 * `api`; the body is what pi-ai's converter built, `model` included, because
 * that is what the universal request carries. The gateway's *own* failures
 * (no such gateway, unified billing unpaid) are lifted into a
 * `CloudflareAIError` so fallback and retry classification behave as they do on
 * the Workers AI run path; a vendor's own error response is left alone for the
 * wire's parser to read.
 */
export async function sendUniversal(
  request: WireRequest,
  transport: Transport,
  body: Record<string, unknown>,
  vendorHeaders: Record<string, string>,
  onResponse?: (response: Response) => void
): Promise<Response> {
  const { model, options, resolved } = request;
  const route = routeForModel(model);
  const response = await transport.universal({
    endpoint: route.endpoint,
    extraHeaders:
      Object.keys(request.headers).length > 0 ? request.headers : undefined,
    gateway: resolved.gateway,
    headers: vendorHeaders,
    provider: route.provider,
    query: body,
    signal: options.signal
  });
  // The correlation ids are on the raw response, and a gateway envelope is
  // about to throw, so the caller sees them either way.
  onResponse?.(response);
  return await liftGatewayError(response, {
    model: wireModelId(model),
    requestBodyValues: body,
    url: transport.url
  });
}

/**
 * Turns the gateway's own error envelope into a `CloudflareAIError`. Only a
 * JSON body can be one, so a streaming response is passed straight through and
 * never buffered.
 */
async function liftGatewayError(
  response: Response,
  context: { model: string; url: string; requestBodyValues: unknown }
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (isGatewayErrorEnvelope(parsed)) {
    throw errorFromGatewayEnvelope(parsed, {
      ...context,
      responseBody: text,
      responseHeaders: headersToObject(response.headers),
      status: response.status
    });
  }
  return new Response(text, response);
}

/** The correlation details every wire records, with the routing it used. */
export function correlationDetails(
  request: WireRequest,
  response: Response,
  transport: Transport
): ResponseCorrelation & {
  model: string;
  gateway: string;
  provider?: string;
  specifier?: string;
} {
  const { model, resolved } = request;
  const specifier = specifierOf(model);
  return {
    ...correlationOf(response, transport),
    gateway: resolved.gateway.id,
    model: model.id,
    ...(specifier !== undefined ? { specifier } : {}),
    ...(model.api === "cloudflare-ai"
      ? {}
      : { provider: gatewaySlugForModel(model) })
  };
}
