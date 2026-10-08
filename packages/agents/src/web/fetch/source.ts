/**
 * Where fetches run. A {@link WebFetchSource} turns a URL into a
 * {@link WebFetchPage}; the tool core is written against it, so the
 * same tool works over a direct `fetch`, a browser, a cache, or a fake in
 * tests.
 */
import {
  validateRedirect,
  validateUrl,
  validateUrlPolicy,
  type UrlPolicy,
  type UrlValidation
} from "../url-policy";
import { abortable } from "../abortable";
import {
  DEFAULT_WEB_FETCH_MAX_BYTES,
  DEFAULT_WEB_FETCH_MAX_REDIRECTS,
  MAX_WEB_FETCH_URL_LENGTH,
  type WebFetchFormat,
  type WebFetchPage
} from "./contract";
import {
  classifyContentType,
  convertBody,
  isTextualKind,
  parseContentType,
  sniffContentType,
  type AiMarkdownBinding
} from "./convert";

/** One fetch request as a source receives it. */
export interface WebFetchRequest {
  /** The http(s) URL to read. */
  url: string;
  /** Defaults to `"auto"`. */
  format?: WebFetchFormat;
}

/** Per-call options a source receives alongside the request. */
export interface WebFetchCallOptions {
  /** Abort the fetch. A source should reject with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Runs fetches. The tool core calls `fetch` and stores one window of the
 * page that comes back. A source validates the request (`url`, `format`),
 * throwing `invalid_web_fetch_input` for a malformed one, and returns the
 * whole page.
 */
export interface WebFetchSource {
  fetch(
    request: WebFetchRequest,
    options?: WebFetchCallOptions
  ): Promise<WebFetchPage>;
}

/**
 * The `User-Agent` sent by default. The package has no build-time version
 * constant, so the product token carries no version.
 */
const DEFAULT_WEB_FETCH_USER_AGENT =
  "Cloudflare-Agents (+https://github.com/cloudflare/agents)";

/**
 * The `Accept` header sent with every request. Markdown first, so sites
 * behind Cloudflare's Markdown for Agents answer in Markdown and skip
 * conversion.
 */
const WEB_FETCH_ACCEPT =
  "text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.8, */*;q=0.5";

/** The most redirects {@link DirectWebFetchOptions.maxRedirects} allows. */
const MAX_CONFIGURABLE_REDIRECTS = 20;

/** Response headers kept on the output. */
const KEPT_HEADERS = [
  "content-type",
  "content-length",
  "last-modified",
  "etag",
  "x-markdown-tokens",
  "cf-mitigated"
] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Options for {@link createDirectWebFetch}. */
export interface DirectWebFetchOptions {
  /**
   * The Workers AI binding, for converting HTML and documents to Markdown.
   * Requires `"ai": { "binding": "AI" }` in wrangler.jsonc; pass `env.AI`.
   */
  binding: Ai;
  /** Override for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to `Cloudflare-Agents (+https://github.com/cloudflare/agents)`. */
  userAgent?: string;
  /** Stop reading the body past this many bytes. A positive integer; defaults to 5 MB. */
  maxBytes?: number;
  /** Follow at most this many redirects. An integer from 0 to 20; defaults to 5. */
  maxRedirects?: number;
  /**
   * Host patterns URLs must match, when non-empty: `example.com` or
   * `*.example.com`. Empty or omitted: any public host.
   */
  allowedHosts?: string[];
  /** Host patterns never fetched, in the same syntax. */
  blockedHosts?: string[];
  /**
   * Allow loopback, private, link-local, and local-only hosts. Off by
   * default; turn on for local development against `localhost`.
   */
  allowPrivateHosts?: boolean;
}

/**
 * Fetch pages directly with `fetch`: GET only, redirects followed by hand
 * and every hop re-checked against the URL policy (an https → http
 * downgrade is refused), the body streamed up to
 * `maxBytes`, and the content converted per the content-type table. A
 * 4xx/5xx response with a textual body is returned like any page, with its
 * status; one without becomes a `web_fetch_http_error`.
 */
export function createDirectWebFetch(
  options: DirectWebFetchOptions
): WebFetchSource {
  const maxBytes = options.maxBytes ?? DEFAULT_WEB_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_WEB_FETCH_MAX_REDIRECTS;
  const userAgent = options.userAgent ?? DEFAULT_WEB_FETCH_USER_AGENT;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError(
      `maxBytes must be a positive integer; got ${maxBytes}.`
    );
  }
  if (
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > MAX_CONFIGURABLE_REDIRECTS
  ) {
    throw new RangeError(
      `maxRedirects must be an integer from 0 to ${MAX_CONFIGURABLE_REDIRECTS}; got ${maxRedirects}.`
    );
  }
  if (typeof userAgent !== "string" || userAgent.trim() === "") {
    throw new RangeError("userAgent must be a non-empty string.");
  }
  const policy: UrlPolicy = {
    allowedHosts: options.allowedHosts,
    blockedHosts: options.blockedHosts,
    allowPrivateHosts: options.allowPrivateHosts ?? false,
    maxUrlLength: MAX_WEB_FETCH_URL_LENGTH
  };
  validateUrlPolicy(policy);
  const doFetch = options.fetch ?? fetch;
  const ai = options.binding as unknown as AiMarkdownBinding;
  const headers: Record<string, string> = {
    accept: WEB_FETCH_ACCEPT,
    "accept-language": "en",
    "user-agent": userAgent
  };

  const fetchPage: WebFetchSource["fetch"] = async (request, call = {}) => {
    const { signal } = call;
    signal?.throwIfAborted();
    const format = request.format ?? "auto";
    if (format !== "auto" && format !== "raw") {
      throw new WebFetchError(
        `format must be "auto" or "raw"; got ${JSON.stringify(format)}.`,
        { status: 400, code: "invalid_web_fetch_input" }
      );
    }
    if (typeof request.url !== "string" || request.url.trim() === "") {
      throw new WebFetchError("url must be a non-empty string.", {
        status: 400,
        code: "invalid_web_fetch_input"
      });
    }
    const requested = request.url.trim();
    const checked = validateUrl(requested, policy);
    if (!checked.ok) throw toPolicyError(checked, requested);

    let url = checked.url;
    const redirects: string[] = [];
    for (;;) {
      let response: Response;
      try {
        // Race the fetch too: an injected fetch may ignore the signal.
        response = await abortable(
          doFetch(url.href, {
            method: "GET",
            redirect: "manual",
            headers,
            signal
          }),
          signal
        );
      } catch (cause) {
        if (signal?.aborted) throw signal.reason;
        throw new WebFetchError(
          `Fetching ${url.href} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { status: 502, code: "web_fetch_unavailable", url: url.href, cause }
        );
      }
      const location = REDIRECT_STATUSES.has(response.status)
        ? response.headers.get("location")
        : null;
      if (location === null) {
        return readPage(response, {
          requested,
          url,
          redirects,
          format,
          maxBytes,
          ai,
          signal
        });
      }
      discardBody(response);
      const next = validateRedirect(location, url, policy);
      // A read-only GET has no reason to follow https down to http, and
      // `finalUrl` is what the model cites.
      if (!next.ok || isDowngrade(url, next.url)) {
        const why = next.ok
          ? `it downgrades https to http: ${next.url.href}`
          : next.message.replace(/\.$/, "");
        throw new WebFetchError(
          `${url.href} redirected to a URL that can't be fetched here (${why}).`,
          {
            status: response.status,
            code: "web_fetch_disallowed_redirect",
            url: url.href
          }
        );
      }
      const loop =
        next.url.href === url.href || redirects.includes(next.url.href);
      if (loop || redirects.length >= maxRedirects) {
        throw new WebFetchError(
          loop
            ? `${requested} redirects in a loop (back to ${next.url.href}).`
            : `${requested} redirected more than ${maxRedirects} times.`,
          {
            status: response.status,
            code: "web_fetch_too_many_redirects",
            url: url.href
          }
        );
      }
      redirects.push(url.href);
      url = next.url;
    }
  };
  return { fetch: fetchPage };
}

/** Read the final response's body and convert it into the output. */
async function readPage(
  response: Response,
  context: {
    requested: string;
    url: URL;
    redirects: string[];
    format: WebFetchFormat;
    maxBytes: number;
    ai: AiMarkdownBinding;
    signal?: AbortSignal;
  }
): Promise<WebFetchPage> {
  const { url, maxBytes, signal } = context;
  const { status } = response;
  const served = parseContentType(response.headers.get("content-type"));
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (declaredLength > maxBytes) {
    discardBody(response);
    throw tooLarge(url, status, served.mediaType, maxBytes);
  }
  // A bot-management challenge page is never the page the model asked for,
  // and a plain fetch can't solve it; say so instead of returning its HTML.
  if (response.headers.get("cf-mitigated") === "challenge") {
    discardBody(response);
    throw new WebFetchError(
      `${url.href} answered with a bot challenge (HTTP ${status}) that a plain fetch can't pass.`,
      {
        status,
        code: "web_fetch_blocked",
        url: url.href,
        contentType: served.mediaType
      }
    );
  }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = await readCapped(response, maxBytes, signal);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw new WebFetchError(
      `Reading ${url.href} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { status: 502, code: "web_fetch_unavailable", url: url.href, cause }
    );
  }
  if (bytes === undefined) {
    throw tooLarge(url, status, served.mediaType, maxBytes);
  }
  // Report what the body is when the server didn't say, or only said
  // "bytes": plenty of servers send .md, .ts, .yaml, and .csv files as
  // application/octet-stream.
  const mediaType =
    served.mediaType && served.mediaType !== "application/octet-stream"
      ? served.mediaType
      : sniffContentType(bytes);

  if (
    status >= 400 &&
    (bytes.byteLength === 0 || !isTextualKind(classifyContentType(mediaType)))
  ) {
    throw httpError(url, status, mediaType);
  }
  const converted = await convertBody({
    bytes,
    mediaType,
    charset: served.charset,
    format: context.format,
    ai: context.ai,
    signal
  });
  if (!converted.ok) {
    if (status >= 400) throw httpError(url, status, mediaType, converted.cause);
    throw new WebFetchError(converted.message, {
      status,
      code: converted.code,
      url: url.href,
      contentType: mediaType,
      cause: converted.cause
    });
  }
  if (status >= 400 && converted.content.trim() === "") {
    throw httpError(url, status, mediaType);
  }
  const page: WebFetchPage = {
    url: context.requested,
    finalUrl: url.href,
    status,
    contentType: mediaType,
    via: converted.via,
    content: converted.content,
    totalChars: converted.content.length,
    headers: keptHeaders(response.headers),
    bytes: bytes.byteLength,
    redirects: context.redirects
  };
  if (converted.title) page.title = converted.title;
  return page;
}

/**
 * Read a body up to `maxBytes`, cancelling the stream as soon as it goes
 * over. Returns `undefined` when it does.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // Race each read: a stubbed or slow body may ignore the fetch signal.
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isDowngrade(from: URL, to: URL): boolean {
  return from.protocol === "https:" && to.protocol === "http:";
}

/** Cancel a body we won't read, so the connection isn't left dangling. */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

function keptHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

function toPolicyError(
  result: Extract<UrlValidation, { ok: false }>,
  url: string
): WebFetchError {
  const inputProblem =
    result.code === "invalid_url" || result.code === "too_long";
  return new WebFetchError(result.message, {
    status: inputProblem ? 400 : 403,
    code: inputProblem ? "invalid_web_fetch_input" : "web_fetch_disallowed_url",
    url
  });
}

function tooLarge(
  url: URL,
  status: number,
  contentType: string,
  maxBytes: number
): WebFetchError {
  return new WebFetchError(
    `${url.href} is larger than ${formatSize(maxBytes)}.`,
    { status, code: "web_fetch_too_large", url: url.href, contentType }
  );
}

function httpError(
  url: URL,
  status: number,
  contentType: string,
  cause?: unknown
): WebFetchError {
  return new WebFetchError(
    `${url.href} answered HTTP ${status} without a readable body.`,
    { status, code: "web_fetch_http_error", url: url.href, contentType, cause }
  );
}

/** `5 MB` for the default limit; exact bytes below a megabyte. */
function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${bytes} bytes`;
  return `${Math.round((bytes / 1_000_000) * 100) / 100} MB`;
}

/**
 * Error codes a {@link WebFetchError} carries, so every failure has a code
 * to branch on.
 */
export type WebFetchErrorCode =
  /** The URL or format was malformed or too long. */
  | "invalid_web_fetch_input"
  /** The URL's scheme, credentials, or host isn't allowed here. */
  | "web_fetch_disallowed_url"
  /** A redirect pointed at a URL that isn't allowed here, or from https to http. */
  | "web_fetch_disallowed_redirect"
  /** More redirects than allowed, or a redirect loop. */
  | "web_fetch_too_many_redirects"
  /** The fetch took longer than the tool's `timeoutMs` (on the error as `timeoutMs`). */
  | "web_fetch_timeout"
  /** The body is larger than `maxBytes`. */
  | "web_fetch_too_large"
  /** The body is binary, or a document requested with `format: "raw"`. */
  | "web_fetch_unsupported_content_type"
  /** A 4xx/5xx response with an empty or non-textual body. */
  | "web_fetch_http_error"
  /** The site answered with a bot challenge instead of the page. */
  | "web_fetch_blocked"
  /** Workers AI could not convert the body to Markdown. */
  | "web_fetch_conversion_failed"
  /** The network failed: before a response (DNS, TLS, connection) or while reading the body. */
  | "web_fetch_unavailable";

/** Why a fetch failed. */
export class WebFetchError extends Error {
  override readonly name = "WebFetchError";
  /**
   * The HTTP status of the response the failure is about, when there was
   * one; otherwise 400 (bad input), 403 (disallowed URL), 502 (unavailable),
   * or 504 (timeout).
   */
  readonly status: number;
  readonly code: WebFetchErrorCode;
  /** Whether retrying the same fetch might succeed. */
  readonly retryable: boolean;
  /** The URL the failure is about: the requested URL, or the redirecting hop. */
  readonly url?: string;
  /** The response's media type, when a response was read. */
  readonly contentType?: string;
  /** The deadline that expired, in milliseconds, for `web_fetch_timeout`. */
  readonly timeoutMs?: number;

  constructor(
    message: string,
    details: {
      status: number;
      code: WebFetchErrorCode;
      retryable?: boolean;
      url?: string;
      contentType?: string;
      timeoutMs?: number;
      cause?: unknown;
    }
  ) {
    super(message, { cause: details.cause });
    this.status = details.status;
    this.code = details.code;
    this.retryable =
      details.retryable ?? isRetryableCode(details.code, details.status);
    this.url = details.url;
    this.contentType = details.contentType;
    this.timeoutMs = details.timeoutMs;
  }
}

function isRetryableCode(code: WebFetchErrorCode, status: number): boolean {
  switch (code) {
    case "web_fetch_timeout":
    case "web_fetch_conversion_failed":
    case "web_fetch_unavailable":
      return true;
    case "web_fetch_http_error":
      // Server errors, rate limits, and request timeouts may clear up.
      return status >= 500 || status === 429 || status === 408;
    default:
      return false;
  }
}
