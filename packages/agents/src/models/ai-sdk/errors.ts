import { APICallError } from "@ai-sdk/provider";
import {
  isCatalogModelId,
  isDynamicRouteId,
  isRunPathLanguageModelId
} from "../core/catalog";
import {
  type CloudflareAIAttempt,
  type CloudflareAIErrorCode,
  CloudflareAIError as CoreCloudflareAIError,
  isRetryableStatus,
  normalizeThrownError as normalizeCoreError
} from "../core/errors";

export {
  classifyStatus,
  isAbortError,
  isRetryableStatus,
  type CloudflareAIAttempt,
  type CloudflareAIErrorCode
} from "../core/errors";

/**
 * The error a string that names no model this provider runs produces.
 * Language models take Workers AI ids, AI Gateway catalog ids and dynamic
 * routes; the modality methods take Workers AI ids only.
 */
export function notAModelId(
  modelId: string,
  accepts: "language" | "workers-ai"
): TypeError {
  return new TypeError(
    accepts === "language"
      ? `"${modelId}" is not a model id this provider knows. Use a Workers AI id ("@cf/zai-org/glm-4.7-flash"), an AI Gateway catalog id ("<author>/<model>", e.g. "openai/gpt-5.5" or "anthropic/claude-opus-4.8"), or a dynamic route ("dynamic/<route>").`
      : `"${modelId}" is not a Workers AI model id. The embedding, image, speech, transcription and reranking methods take Workers AI ids, which start with "@cf/".`
  );
}

/**
 * The gate for the modality methods — embedding, image, speech,
 * transcription, reranking — and their fallback legs: a Workers AI id and
 * nothing else. Catalog models and dynamic routes are chat models here.
 */
export function requireWorkersAIId<Id extends string>(modelId: Id): Id {
  if (isDynamicRouteId(modelId)) {
    throw new TypeError(
      `"${modelId}" is an AI Gateway dynamic route, and a dynamic route is a chat model: it answers in the chat-completions shape. Use it as ai("${modelId}"); the embedding, image, speech, transcription and reranking methods take "@cf/" ids.`
    );
  }
  if (!modelId.startsWith("@cf/")) throw notAModelId(modelId, "workers-ai");
  return modelId;
}

/** Whether a string names a language model: any of the three id kinds. */
function isLanguageModelId(modelId: string): boolean {
  return isRunPathLanguageModelId(modelId) || isCatalogModelId(modelId);
}

/**
 * The gate every string that names a language model passes through, wherever
 * it enters the module: `ai("…")`, a per-model fallback leg, or a leg read
 * out of the per-call `providerOptions.cloudflare` bag. All three kinds run on
 * `env.AI.run`. Thrown at the line that supplied the id rather than at the
 * request it would have made.
 */
export function requireLanguageModelId<Id extends string>(modelId: Id): Id {
  if (!isLanguageModelId(modelId)) throw notAModelId(modelId, "language");
  return modelId;
}

/**
 * Error thrown for every failed Cloudflare AI call, whether it came back as a
 * non-2xx `Response` or as a thrown Workers AI binding error.
 *
 * Extends the AI SDK's `APICallError` so `ai`'s built-in retry loop honours
 * {@link CloudflareAIError.isRetryable} without any extra wiring.
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareAIError extends APICallError {
  /** HTTP status, when the failure carried one. */
  readonly status: number | undefined;
  /** Coarse classification used for routing and fallback decisions. */
  readonly code: CloudflareAIErrorCode;
  /** `cf-aig-log-id` of the failed request, when the response carried one. */
  readonly logId: string | undefined;
  /** The model id that produced this error. */
  readonly model: string;
  /** Every leg tried, when this error ends a fallback chain. */
  readonly attempts: CloudflareAIAttempt[] | undefined;

  constructor(options: {
    message: string;
    model: string;
    url: string;
    requestBodyValues: unknown;
    status?: number;
    code: CloudflareAIErrorCode;
    logId?: string;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
    isRetryable?: boolean;
    data?: unknown;
    cause?: unknown;
    attempts?: CloudflareAIAttempt[];
  }) {
    super({
      cause: options.cause,
      data: options.data,
      isRetryable: options.isRetryable ?? isRetryableStatus(options.status),
      message: options.message,
      requestBodyValues: options.requestBodyValues,
      responseBody: options.responseBody,
      responseHeaders: options.responseHeaders,
      statusCode: options.status,
      url: options.url
    });
    this.name = "CloudflareAIError";
    this.status = options.status;
    this.code = options.code;
    this.logId = options.logId;
    this.model = options.model;
    this.attempts = options.attempts;
  }

  /** Lifts the framework-neutral core error into the AI SDK error type. */
  static fromCore(error: CoreCloudflareAIError): CloudflareAIError {
    return new CloudflareAIError({
      attempts: error.attempts,
      cause: error.cause,
      code: error.code,
      data: error.data,
      isRetryable: error.isRetryable,
      logId: error.logId,
      message: error.message,
      model: error.model,
      requestBodyValues: error.requestBodyValues,
      responseBody: error.responseBody,
      responseHeaders: error.responseHeaders,
      status: error.status,
      url: error.url
    });
  }
}

/**
 * Converts whatever the core transport threw into what AI SDK callers expect:
 * core errors become {@link CloudflareAIError}s; everything else passes
 * through untouched.
 */
export function toAISDKError(error: unknown): unknown {
  return error instanceof CoreCloudflareAIError
    ? CloudflareAIError.fromCore(error)
    : error;
}

/**
 * Normalizes a thrown Workers AI binding error into a {@link CloudflareAIError}.
 * Abort errors and errors that are already `APICallError`s pass through.
 */
export function normalizeThrownError(
  error: unknown,
  context: Parameters<typeof normalizeCoreError>[1]
): unknown {
  if (APICallError.isInstance(error)) return error;
  return toAISDKError(normalizeCoreError(error, context));
}
