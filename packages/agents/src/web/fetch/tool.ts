/**
 * The harness-neutral core of the `web_fetch` tool, shared by the pi
 * (`agents/webfetch/pi`), AI SDK (`agents/webfetch/ai-sdk`), and TanStack
 * AI (`agents/webfetch/tanstack-ai`) adapters. `fetchWeb()` shares its
 * deadline. Internal — not an entry point.
 */
import { abortable } from "../abortable";
import {
  DEFAULT_WEB_FETCH_PAGE_CHARS,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  renderWebFetchPage,
  windowWebFetchPage,
  type WebFetchPage,
  type WebFetchToolInput,
  type WebFetchToolOutput
} from "./contract";
import { classifyContentType, isTextualKind } from "./convert";
import {
  WebFetchError,
  createDirectWebFetch,
  type DirectWebFetchOptions,
  type WebFetchRequest,
  type WebFetchSource
} from "./source";

/**
 * Fetch directly with `fetch`, converting through the Workers AI binding;
 * the tool builds the source with {@link createDirectWebFetch}.
 */
export type WebFetchToolDirectOptions = DirectWebFetchOptions & {
  source?: never;
};

/**
 * Fetch through a source you built. Limits, URL policy, and the user agent
 * belong to the source, so the direct-fetch options are not accepted here.
 */
export type WebFetchToolSourceOptions = {
  /** Where fetches run, instead of a direct `fetch`. */
  source: WebFetchSource;
  binding?: never;
  fetch?: never;
  userAgent?: never;
  maxBytes?: never;
  maxRedirects?: never;
  allowedHosts?: never;
  blockedHosts?: never;
  allowPrivateHosts?: never;
};

/**
 * Options every `web_fetch` tool adapter accepts. Invalid values throw a
 * `RangeError` when the tool is created.
 */
export type WebFetchToolOptions = (
  | WebFetchToolDirectOptions
  | WebFetchToolSourceOptions
) & {
  /**
   * How many characters of content the model reads per call; it continues
   * with `offset`. A positive integer; defaults to 20,000.
   */
  pageChars?: number;
  /**
   * Give up on a fetch after this many milliseconds, as a retryable
   * `web_fetch_timeout` failure. A positive integer; defaults to 30 seconds.
   */
  timeoutMs?: number;
  /** Replaces the default tool description. */
  description?: string;
};

/**
 * What one run returns to the adapter: the host output (one window of the
 * page), and the model's text. On failure, `error` is the source's error, with the detail for the
 * host, and `text` is what the model should read instead.
 */
export type WebFetchToolRun =
  | { ok: true; output: WebFetchToolOutput; text: string }
  | { ok: false; error: WebFetchError; text: string };

export interface WebFetchToolCore {
  name: typeof WEB_FETCH_TOOL_NAME;
  description: string;
  /** The host's `pageChars`: the model's window size. */
  pageChars: number;
  /** Render a stored output for the model. */
  render(output: WebFetchToolOutput): string;
  /**
   * Run one fetch. Aborting `signal` rejects with its reason rather than
   * producing a failed run, so the harness sees a cancelled call.
   */
  run(
    input: WebFetchToolInput,
    options?: { signal?: AbortSignal }
  ): Promise<WebFetchToolRun>;
}

export function createWebFetchToolCore(
  options: WebFetchToolOptions
): WebFetchToolCore {
  const pageChars = options.pageChars ?? DEFAULT_WEB_FETCH_PAGE_CHARS;
  if (!Number.isInteger(pageChars) || pageChars <= 0) {
    throw new RangeError(
      `pageChars must be a positive integer; got ${pageChars}.`
    );
  }
  const timeoutMs = validateTimeout(options.timeoutMs);
  if (options.description !== undefined) {
    if (
      typeof options.description !== "string" ||
      options.description.trim() === ""
    ) {
      throw new RangeError("description must be a non-empty string.");
    }
  }
  const source = toSource(options);

  return {
    name: WEB_FETCH_TOOL_NAME,
    description: options.description ?? WEB_FETCH_TOOL_DESCRIPTION,
    pageChars,
    render: renderWebFetchPage,
    async run(input, { signal } = {}) {
      try {
        signal?.throwIfAborted();
        // The source owns `url` and `format`; the tool owns paging.
        const { url, format, offset = 0 } = input ?? { url: "" };
        if (!Number.isInteger(offset) || offset < 0) {
          throw new WebFetchError(
            `offset must be an integer of 0 or more; got ${JSON.stringify(offset)}.`,
            { status: 400, code: "invalid_web_fetch_input" }
          );
        }
        const page = await fetchWithDeadline(
          source,
          { url, format },
          { timeoutMs, signal }
        );
        const output = windowWebFetchPage(page, { offset, pageChars });
        return { ok: true, output, text: renderWebFetchPage(output) };
      } catch (cause) {
        if (signal?.aborted) throw signal.reason;
        const error = toToolError(cause, input?.url);
        return { ok: false, error, text: describeFailureForModel(error) };
      }
    }
  };
}

/** Check `timeoutMs`, filling in the default. */
export function validateTimeout(
  timeoutMs = DEFAULT_WEB_FETCH_TIMEOUT_MS
): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `timeoutMs must be a positive integer; got ${timeoutMs}.`
    );
  }
  return timeoutMs;
}

function toSource(options: WebFetchToolOptions): WebFetchSource {
  if (options.source !== undefined) {
    if (options.binding !== undefined) {
      throw new RangeError("Pass `binding` or `source`, not both.");
    }
    if (typeof options.source?.fetch !== "function") {
      throw new RangeError("source must have a fetch() method.");
    }
    return options.source;
  }
  if (options.binding === undefined || options.binding === null) {
    throw new RangeError(
      "Pass `binding` (the Workers AI binding) or a `source` to fetch through."
    );
  }
  const {
    pageChars: _pageChars,
    timeoutMs: _timeoutMs,
    description: _description,
    source: _source,
    ...direct
  } = options;
  // createDirectWebFetch checks maxBytes, maxRedirects, userAgent, and the
  // URL policy, throwing RangeError.
  return createDirectWebFetch(direct);
}

/**
 * Fetch one page through `source` with a deadline. Shared by the tool core
 * and `fetchWeb()`. Throws the source's error as is, a `web_fetch_timeout`
 * at the deadline, and `signal.reason` on abort.
 */
export async function fetchWithDeadline(
  source: WebFetchSource,
  request: WebFetchRequest,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<WebFetchPage> {
  const { timeoutMs, signal } = options;
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    // Race the source too: a custom source may ignore the signal, and the
    // deadline must still end the call.
    return await abortable(
      source.fetch(request, { signal: fetchSignal }),
      fetchSignal
    );
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) {
      const url = typeof request.url === "string" ? request.url.trim() : "";
      throw new WebFetchError(
        `Fetching ${url || "the URL"} timed out after ${timeoutMs} ms.`,
        { status: 504, code: "web_fetch_timeout", url, timeoutMs, cause }
      );
    }
    throw cause;
  }
}

/**
 * The error a throwing adapter (AI SDK, TanStack AI) raises for a failed
 * run. Those frameworks show the model the error's `message`, so it carries
 * the model's text; the source's error, with the detail, is `cause`.
 */
export function toolFailure(
  run: Extract<WebFetchToolRun, { ok: false }>
): WebFetchError {
  const { error } = run;
  return new WebFetchError(run.text, {
    status: error.status,
    code: error.code,
    retryable: error.retryable,
    url: error.url,
    contentType: error.contentType,
    timeoutMs: error.timeoutMs,
    cause: error
  });
}

function toToolError(cause: unknown, url: unknown): WebFetchError {
  if (cause instanceof WebFetchError) return cause;
  return new WebFetchError(
    cause instanceof Error ? cause.message : String(cause),
    {
      status: 502,
      code: "web_fetch_unavailable",
      url: typeof url === "string" ? url : undefined,
      cause
    }
  );
}

/**
 * What the model reads when a fetch fails: what went wrong, and whether to
 * retry, change the input, or move on.
 */
export function describeFailureForModel(error: WebFetchError): string {
  const detail = error.message.replace(/\.$/, "");
  const url = error.url ?? "The URL";
  switch (error.code) {
    case "invalid_web_fetch_input":
      return `web_fetch rejected the input (${detail}). Fix it and try again.`;
    case "web_fetch_disallowed_url":
      return `That URL can't be fetched here (${detail}). Do not retry it.`;
    case "web_fetch_disallowed_redirect":
      return `${detail}. Do not retry.`;
    case "web_fetch_too_many_redirects":
      return `${detail}. Do not retry.`;
    case "web_fetch_timeout": {
      const after =
        error.timeoutMs === undefined
          ? ""
          : ` after ${formatSeconds(error.timeoutMs)}`;
      return `web_fetch timed out${after}. You may retry once.`;
    }
    case "web_fetch_too_large":
      return `${detail}. Do not retry.`;
    case "web_fetch_unsupported_content_type":
      return error.contentType
        ? `${url} is ${error.contentType}, which can't be read as text. Do not retry it.`
        : `${detail}. Do not retry it.`;
    case "web_fetch_http_error":
      return error.retryable
        ? `${url} answered HTTP ${error.status} with no readable body. You may retry once after a short wait.`
        : `${url} answered HTTP ${error.status} with no readable body. Do not retry it.`;
    case "web_fetch_blocked":
      return `${url} is behind a bot challenge that web_fetch cannot pass. Do not retry it; use a browser tool if one is available, or another source.`;
    case "web_fetch_conversion_failed": {
      // `format: "raw"` only helps when the body is text (HTML); a document
      // requested raw is guaranteed to fail.
      return isTextualKind(classifyContentType(error.contentType ?? ""))
        ? `${url} could not be converted; retry once with format: "raw".`
        : `${url} (${error.contentType || "unknown type"}) could not be converted to text. Do not retry it.`;
    }
    default:
      return error.retryable
        ? `web_fetch could not fetch ${url} (${detail}). You may retry once after a short wait.`
        : `web_fetch could not fetch ${url} (${detail}). Do not retry it.`;
  }
}

/** `30 s`, `1.5 s`, or `250 ms` under a second. */
function formatSeconds(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round((ms / 1000) * 10) / 10;
  return `${seconds} s`;
}
