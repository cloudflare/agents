/**
 * Client-side fallback across models: the primary is tried first, then each
 * fallback in order, when a call fails before producing output. Shared by the
 * language and embedding models.
 */

import {
  APICallError,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult
} from "@ai-sdk/provider";
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

/**
 * The parts a stream emits before it has said anything: protocol preamble
 * that every leg would repeat. Anything else is output the caller has seen,
 * after which the leg is committed and a later failure is its own.
 */
const PREAMBLE_PARTS = new Set<LanguageModelV4StreamPart["type"]>([
  "stream-start",
  "response-metadata",
  "text-start",
  "reasoning-start",
  "tool-input-start",
  "raw"
]);

/**
 * {@link withFallbackLegs} for streams. A 2xx that then fails before any
 * output — an `error` part, an error finish, or a broken body — is still a
 * failed leg, so the next one is tried; the preamble the failed leg sent is
 * dropped and the answering leg's own is delivered instead. Once a leg has
 * produced output it is the answer, failures and all.
 */
export async function withStreamFallbackLegs(
  legs: FallbackAttempt<LanguageModelV4StreamResult>[],
  url: string
): Promise<LanguageModelV4StreamResult> {
  if (legs.length <= 1) return withFallbackLegs(legs, url);
  const attempts: CloudflareAIAttempt[] = [];
  let lastError: unknown;
  for (const leg of legs) {
    let result: LanguageModelV4StreamResult;
    try {
      result = await leg.run();
    } catch (error) {
      if (isAbortError(error)) throw error;
      attempts.push({ error, model: leg.model });
      lastError = error;
      continue;
    }
    const reader = result.stream.getReader();
    const preamble: LanguageModelV4StreamPart[] = [];
    let failure: unknown;
    let committed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          committed = true;
          break;
        }
        if (value.type === "error") {
          failure = value.error;
          break;
        }
        if (value.type === "finish" && value.finishReason.unified === "error") {
          failure = streamFailure(leg.model, url, value.finishReason.raw);
          break;
        }
        preamble.push(value);
        if (!PREAMBLE_PARTS.has(value.type)) {
          committed = true;
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      failure = error;
    }
    if (!committed) {
      await reader.cancel().catch(() => undefined);
      attempts.push({ error: failure, model: leg.model });
      lastError = failure;
      continue;
    }
    return { ...result, stream: resumed(preamble, reader) };
  }
  if (attempts.length <= 1) throw lastError;
  throw fallbackError(lastError, attempts, url);
}

/** The parts already read, then the rest of the stream, as one stream. */
function resumed<T>(
  head: T[],
  reader: ReadableStreamDefaultReader<T>
): ReadableStream<T> {
  return new ReadableStream<T>({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    start(controller) {
      for (const part of head) controller.enqueue(part);
    }
  });
}

/** A stream that ended in an error finish before it produced anything. */
function streamFailure(
  model: string,
  url: string,
  raw: string | undefined
): CloudflareAIError {
  return new CloudflareAIError({
    code: "provider-error",
    isRetryable: false,
    message: `The stream from ${model} ended in an error before producing any output${raw === undefined ? "" : ` (${raw})`}.`,
    model,
    requestBodyValues: undefined,
    url
  });
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
