/**
 * The harness-neutral core of the `web_search` tool, shared by the pi
 * (`agents/websearch/pi`), AI SDK (`agents/websearch/ai-sdk`), and TanStack
 * AI (`agents/websearch/tanstack-ai`) adapters. Internal — not an entry point.
 */
import {
  DEFAULT_WEB_SEARCH_LIMIT,
  MAX_WEB_SEARCH_LIMIT,
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  renderWebSearchResults,
  type WebSearchResponse,
  type WebSearchToolInput,
  type WebSearchToolOutput
} from "./contract";
import {
  WebSearchError,
  createAIWebSearch,
  type AIWebSearchOptions,
  type WebSearchSource
} from "./source";

/** Search through the Workers AI binding; the tool builds the source. */
export type WebSearchToolBindingOptions = AIWebSearchOptions & {
  source?: never;
};

/**
 * Search through a source you built. Gateway, provider, and billing belong
 * to the source, so the binding options are not accepted here.
 */
export type WebSearchToolSourceOptions = {
  /** Where searches run, instead of the Workers AI binding. */
  source: WebSearchSource;
  binding?: never;
  gateway?: never;
  provider?: never;
  byokAlias?: never;
};

/**
 * Options every `web_search` tool adapter accepts. Invalid values throw a
 * `RangeError` when the tool is created.
 */
export type WebSearchToolOptions = (
  | WebSearchToolBindingOptions
  | WebSearchToolSourceOptions
) & {
  /**
   * Results per search when the model doesn't ask for a count, and the most
   * it gets when it asks for more. An integer from 1 to 10; defaults to 5.
   */
  limit?: number;
  /** Replaces the default tool description. */
  description?: string;
  /**
   * Per-result description length in the model's view. A positive integer;
   * defaults to 600 characters. `Infinity` passes descriptions through whole.
   */
  maxDescriptionChars?: number;
  /**
   * Give up on a search after this many milliseconds, as a retryable
   * `web_search_timeout` failure. A positive integer; defaults to 30 seconds.
   */
  timeoutMs?: number;
};

/** The default for {@link WebSearchToolOptions.timeoutMs}. */
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 30_000;

/**
 * What one run returns to the adapter: the host output, and the model's
 * text. On failure, `error` is the source's error, with the API's detail for
 * the host, and `text` is what the model should read instead.
 */
export type WebSearchToolRun =
  | { ok: true; output: WebSearchToolOutput; text: string }
  | { ok: false; error: WebSearchError; text: string };

export interface WebSearchToolCore {
  name: typeof WEB_SEARCH_TOOL_NAME;
  description: string;
  /** The host's `limit`: the default and the cap for the model's `limit`. */
  limit: number;
  /** Render a search's output as the text the model reads. */
  render(output: WebSearchResponse): string;
  /**
   * Run one search. Aborting `signal` rejects with its reason rather than
   * producing a failed run, so the harness sees a cancelled call.
   */
  run(
    input: WebSearchToolInput,
    options?: { signal?: AbortSignal }
  ): Promise<WebSearchToolRun>;
}

export function createWebSearchToolCore(
  options: WebSearchToolOptions
): WebSearchToolCore {
  const limit = options.limit ?? DEFAULT_WEB_SEARCH_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS;
  const { maxDescriptionChars } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEB_SEARCH_LIMIT) {
    throw new RangeError(
      `limit must be an integer from 1 to ${MAX_WEB_SEARCH_LIMIT}; got ${limit}.`
    );
  }
  if (
    maxDescriptionChars !== undefined &&
    maxDescriptionChars !== Infinity &&
    !(Number.isInteger(maxDescriptionChars) && maxDescriptionChars > 0)
  ) {
    throw new RangeError(
      `maxDescriptionChars must be a positive integer or Infinity; got ${maxDescriptionChars}.`
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `timeoutMs must be a positive integer; got ${timeoutMs}.`
    );
  }
  const source =
    options.source === undefined ? createAIWebSearch(options) : options.source;
  const provider = source.provider;
  const render = (output: WebSearchResponse) =>
    renderWebSearchResults(output, { maxDescriptionChars });

  return {
    name: WEB_SEARCH_TOOL_NAME,
    description: options.description ?? WEB_SEARCH_TOOL_DESCRIPTION,
    limit,
    render,
    async run(input, { signal } = {}) {
      signal?.throwIfAborted();
      const request = {
        query: input.query,
        limit: Math.min(clampLimit(input.limit ?? limit), limit)
      };
      const timeout = AbortSignal.timeout(timeoutMs);
      const searchSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      try {
        const response = await source.search(request, {
          signal: searchSignal
        });
        const output: WebSearchToolOutput = provider
          ? { ...response, provider }
          : response;
        return {
          ok: true,
          output,
          text: render(response)
        };
      } catch (cause) {
        if (signal?.aborted) throw signal.reason;
        const error = toToolError(cause, timeout.aborted, timeoutMs);
        return { ok: false, error, text: describeFailureForModel(error) };
      }
    }
  };
}

/**
 * The error a throwing adapter (AI SDK, TanStack AI) raises for a failed
 * run. Those frameworks show the model the error's `message`, so it carries
 * the model's text; the source's error, with the API's detail, is `cause`.
 */
export function toolFailure(
  run: Extract<WebSearchToolRun, { ok: false }>
): WebSearchError {
  const { error } = run;
  return new WebSearchError(run.text, {
    status: error.status,
    code: error.code,
    retryable: error.retryable,
    requestId: error.requestId,
    apiCode: error.apiCode,
    cause: error
  });
}

function toToolError(
  cause: unknown,
  timedOut: boolean,
  timeoutMs: number
): WebSearchError {
  if (timedOut) {
    return new WebSearchError(`Web search timed out after ${timeoutMs} ms.`, {
      status: 504,
      code: "web_search_timeout",
      retryable: true,
      cause
    });
  }
  if (cause instanceof WebSearchError) return cause;
  return new WebSearchError(
    cause instanceof Error ? cause.message : String(cause),
    { status: 500, code: "web_search_unavailable", retryable: true, cause }
  );
}

/**
 * What the model reads when a search fails: whether to retry, change the
 * query, or carry on without search. The operator's detail (credits, keys,
 * gateway setup) stays on the error for the host.
 */
function describeFailureForModel(error: WebSearchError): string {
  if (error.code === "invalid_web_search_input") {
    return `Web search rejected the query (${error.message.replace(/\.$/, "")}). Fix the query and try again.`;
  }
  if (error.retryable) {
    return `Web search failed temporarily (${error.code}). You may retry once.`;
  }
  return `Web search is unavailable here (${error.code}). Do not retry; answer without it and say that web search was unavailable.`;
}

/** The model's `limit`, made an integer from 1 to 10. */
function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WEB_SEARCH_LIMIT;
  return Math.min(MAX_WEB_SEARCH_LIMIT, Math.max(1, Math.trunc(value)));
}
