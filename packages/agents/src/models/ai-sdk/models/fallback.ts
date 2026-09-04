/**
 * Client-side fallback across models: the primary is tried first, then each
 * fallback in order, when a call fails before producing output. Shared by the
 * language and embedding models.
 */

import { APICallError } from "@ai-sdk/provider";
import {
  classifyStatus,
  CloudflareAIError,
  isAbortError,
  type CloudflareAIAttempt
} from "../errors";

/** One leg of a fallback chain: a name for reporting, and how to run it. */
export interface FallbackAttempt<T> {
  /** The model id reported for this leg in errors and attempt lists. */
  model: string;
  run(): PromiseLike<T>;
}

/**
 * Runs each leg in order until one answers. Legs may be anything — a model id
 * this provider owns, or a whole other `LanguageModelV4` — because a leg is
 * only ever a name and a thunk here.
 */
export async function withFallbackLegs<T>(
  legs: FallbackAttempt<T>[],
  url: string
): Promise<T> {
  const attempts: CloudflareAIAttempt[] = [];
  let lastError: unknown;
  for (const leg of legs) {
    try {
      return await leg.run();
    } catch (error) {
      if (isAbortError(error)) throw error;
      attempts.push({ error, model: leg.model });
      lastError = error;
    }
  }
  if (attempts.length <= 1) throw lastError;
  throw fallbackError(lastError, attempts, url);
}

export async function withFallback<T>(
  primary: string,
  fallback: string[],
  url: string,
  run: (modelId: string) => Promise<T>
): Promise<T> {
  return withFallbackLegs(
    [primary, ...fallback].map((modelId) => ({
      model: modelId,
      run: () => run(modelId)
    })),
    url
  );
}

/** Rebuilds the last error with the whole attempt chain attached. */
function fallbackError(
  lastError: unknown,
  attempts: CloudflareAIAttempt[],
  url: string
): unknown {
  const models = attempts.map((attempt) => attempt.model).join(", ");
  if (lastError instanceof CloudflareAIError) {
    return new CloudflareAIError({
      attempts,
      cause: lastError,
      code: lastError.code,
      data: lastError.data,
      isRetryable: lastError.isRetryable,
      logId: lastError.logId,
      message: `All models failed (${models}). Last error: ${lastError.message}`,
      model: lastError.model,
      requestBodyValues: lastError.requestBodyValues,
      responseBody: lastError.responseBody,
      responseHeaders: lastError.responseHeaders,
      status: lastError.status,
      url: lastError.url
    });
  }
  if (APICallError.isInstance(lastError)) {
    // A routed vendor leg fails with the vendor's own error: its status, body
    // and retryability are the facts of the failure and travel with the chain.
    return new CloudflareAIError({
      attempts,
      cause: lastError,
      code: classifyStatus(lastError.statusCode),
      isRetryable: lastError.isRetryable,
      message: `All models failed (${models}). Last error: ${lastError.message}`,
      model: attempts.at(-1)?.model ?? "",
      requestBodyValues: lastError.requestBodyValues,
      responseBody: lastError.responseBody,
      responseHeaders: lastError.responseHeaders,
      status: lastError.statusCode,
      url: lastError.url
    });
  }
  return new CloudflareAIError({
    attempts,
    cause: lastError,
    code: "unknown",
    // Nothing here says the failure was transport-level, and re-running a
    // chain that already failed on every leg only burns the retry budget.
    isRetryable: false,
    message: `All models failed (${models}). Last error: ${String(lastError)}`,
    model: attempts.at(-1)?.model ?? "",
    requestBodyValues: undefined,
    url
  });
}
