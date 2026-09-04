/**
 * Coarse classification of a failed Cloudflare AI call.
 *
 * @experimental This surface is experimental and may change.
 */
export type CloudflareAIErrorCode =
  | "auth"
  | "rate-limit"
  | "not-found"
  | "bad-request"
  | "provider-error"
  | "gateway-error"
  | "unknown";

/**
 * One leg of a {@link CloudflareAIError} fallback chain.
 *
 * @experimental This surface is experimental and may change.
 */
export interface CloudflareAIAttempt {
  /** The model id that was tried. */
  model: string;
  /** The error that leg failed with. */
  error: unknown;
}

/**
 * Error thrown for every failed Cloudflare AI call, whether it came back as a
 * non-2xx `Response` or as a thrown Workers AI binding error. Framework
 * modules wrap it into their own error type at their boundary (the AI SDK
 * module into an `APICallError`, so `ai`'s retry loop honours
 * {@link CloudflareAIError.isRetryable}).
 *
 * @experimental This surface is experimental and may change.
 */
export class CloudflareAIError extends Error {
  /** HTTP status, when the failure carried one. */
  readonly status: number | undefined;
  /** Coarse classification used for routing and fallback decisions. */
  readonly code: CloudflareAIErrorCode;
  /** `cf-aig-log-id` of the failed request, when the response carried one. */
  readonly logId: string | undefined;
  /** The model id that produced this error. */
  readonly model: string;
  /** Which binding path the request went down, for error reporting. */
  readonly url: string;
  /** The request body that failed. */
  readonly requestBodyValues: unknown;
  /** Response headers, when there was a response. */
  readonly responseHeaders: Record<string, string> | undefined;
  /** Raw response body text, when there was a response. */
  readonly responseBody: string | undefined;
  /** Whether a retry is worth attempting. */
  readonly isRetryable: boolean;
  /** Parsed error envelope, or other structured detail. */
  readonly data: unknown;
  /** Every leg tried, when this error ends a fallback chain. */
  readonly attempts: CloudflareAIAttempt[] | undefined;
  override readonly cause: unknown;

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
    super(options.message);
    this.name = "CloudflareAIError";
    this.status = options.status;
    this.code = options.code;
    this.logId = options.logId;
    this.model = options.model;
    this.url = options.url;
    this.requestBodyValues = options.requestBodyValues;
    this.responseHeaders = options.responseHeaders;
    this.responseBody = options.responseBody;
    this.isRetryable = options.isRetryable ?? isRetryableStatus(options.status);
    this.data = options.data;
    this.cause = options.cause;
    this.attempts = options.attempts;
  }
}

/**
 * Whether a status is worth retrying. Missing status means a transport-level
 * failure (connection reset, DNS, abort-adjacent), which is retryable.
 *
 * @experimental This surface is experimental and may change.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Classifies an HTTP status into a {@link CloudflareAIErrorCode}. The
 * `AiGatewayError` envelope name catches gateway-level statuses that are not
 * otherwise meaningful (notably 402 "insufficient balance").
 */
export function classifyStatus(
  status: number | undefined,
  envelopeName?: string
): CloudflareAIErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 404) return "not-found";
  if (status === 400 || status === 422) return "bad-request";
  if (status !== undefined && status >= 500) return "provider-error";
  if (envelopeName === "AiGatewayError") return "gateway-error";
  return "unknown";
}

/**
 * Workers AI binding error codes that map onto an HTTP status.
 *
 * @see https://developers.cloudflare.com/workers-ai/platform/errors/
 */
const BINDING_CODE_STATUS: Record<number, number> = {
  3003: 400,
  3006: 413,
  3007: 408,
  3008: 408,
  3023: 403,
  3036: 429,
  3039: 400,
  3040: 429,
  3041: 403,
  3042: 404,
  5004: 400,
  5005: 405,
  5007: 400,
  5016: 403,
  5018: 403,
  5019: 405
};

/** Abort-shaped errors must propagate untouched so callers can detect them. */
export function isAbortError(error: unknown): boolean {
  const name =
    error instanceof Error || error instanceof DOMException
      ? error.name
      : undefined;
  return (
    name === "AbortError" ||
    name === "ResponseAborted" ||
    name === "TimeoutError"
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * Extracts a Workers AI internal error code from a thrown binding error. The
 * binding reports codes inside the message text (`"3040: Capacity temporarily
 * exceeded"`) rather than as a status, so only known codes are accepted — an
 * unrelated leading number must not be misread as a code.
 */
function bindingErrorCode(error: unknown): number | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "number" && code in BINDING_CODE_STATUS) return code;
  }
  const matches = messageOf(error).matchAll(/\b(\d{3,5})\s*:/g);
  for (const match of matches) {
    const code = Number(match[1]);
    if (code in BINDING_CODE_STATUS) return code;
  }
  return undefined;
}

/**
 * Normalizes a thrown Workers AI binding error into a {@link CloudflareAIError}.
 * Abort errors and errors that are already {@link CloudflareAIError}s pass through.
 */
export function normalizeThrownError(
  error: unknown,
  context: {
    model: string;
    url: string;
    requestBodyValues: unknown;
  }
): unknown {
  if (isAbortError(error)) return error;
  if (error instanceof CloudflareAIError) return error;

  const code = bindingErrorCode(error);
  const status = code === undefined ? undefined : BINDING_CODE_STATUS[code];
  return new CloudflareAIError({
    cause: error,
    code: classifyStatus(status),
    data: code === undefined ? undefined : { code },
    // A recognised code decides for itself. Everything else is not worth
    // retrying: the binding is the only backend, so a throw with no status is
    // a programming error rather than a transport failure, and re-running it
    // on every fallback leg helps nobody.
    isRetryable: status === undefined ? false : isRetryableStatus(status),
    message: messageOf(error),
    model: context.model,
    requestBodyValues: context.requestBodyValues,
    status,
    url: context.url
  });
}
