import { APICallError } from "@ai-sdk/provider";
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

/** The provider packages worth naming when someone passes a vendor id. */
const VENDOR_PACKAGES: Record<string, { package: string; call: string }> = {
  anthropic: {
    call: 'anthropic("claude-opus-4-8")',
    package: "@ai-sdk/anthropic"
  },
  google: { call: 'google("gemini-3-flash")', package: "@ai-sdk/google" },
  openai: { call: 'openai("gpt-5-mini")', package: "@ai-sdk/openai" }
};

/**
 * The one error a bad model id produces. Workers AI ids are the only strings
 * this provider knows; a third-party model is a model object built by that
 * vendor's own provider package.
 */
export function notAWorkersAIId(modelId: string): TypeError {
  const vendor = VENDOR_PACKAGES[modelId.split("/")[0] ?? ""];
  const advice =
    vendor === undefined
      ? 'install its AI SDK provider package and pass the model object, e.g. ai(anthropic("claude-opus-4-8"))'
      : `install ${vendor.package} and pass the model object: ai(${vendor.call})`;
  return new TypeError(
    `"${modelId}" is not a Workers AI model id. Workers AI ids start with "@cf/", and they are the only ids this provider takes: a third-party model goes through its own provider and is only routed by AI Gateway — ${advice}.`
  );
}

/**
 * The gate every string that names a model passes through, wherever it enters
 * the module: `ai("…")`, a per-model fallback leg, or a leg read out of the
 * per-call `providerOptions.cloudflare` bag. One rule, one message, thrown at
 * the line that supplied the id rather than at the request it would have made.
 */
export function requireWorkersAIId<Id extends string>(modelId: Id): Id {
  if (!modelId.startsWith("@cf/")) throw notAWorkersAIId(modelId);
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
