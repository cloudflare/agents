/**
 * Where searches run. A {@link WebSearchSource} turns a query into a
 * {@link WebSearchResponse}; the tool core is written against it, so the
 * same tool works over the Workers AI binding, the HTTP API, or a fake in
 * tests.
 */
import { DEFAULT_GATEWAY_ID } from "../models/core/settings";
import {
  DEFAULT_WEB_SEARCH_LIMIT,
  MAX_WEB_SEARCH_LIMIT,
  MAX_WEB_SEARCH_QUERY_LENGTH,
  type WebSearchResponse,
  type WebSearchResult
} from "./contract";

/**
 * Search providers behind the Cloudflare Web Search API. `ceramic` is the
 * platform default and the cheapest; `exa` and `linkup` cost more and, in our
 * testing, ranked announcement-style queries noticeably better. Pricing and
 * data-retention terms are in the Web Search docs.
 */
export type WebSearchProvider = "ceramic" | "exa" | "linkup";

/** One search request as a source receives it. */
export interface WebSearchRequest {
  /** 1–1024 characters. */
  query: string;
  /** 1–10. Defaults to 5. */
  limit?: number;
}

/** Per-call options a source receives alongside the request. */
export interface WebSearchCallOptions {
  /** Abort the search. A source should reject with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Runs searches. The tool core calls `search` and renders what comes back.
 * An object rather than a bare function so a wrapper (caching, logging)
 * keeps `provider` by spreading the source it wraps.
 */
export interface WebSearchSource {
  search(
    request: WebSearchRequest,
    options?: WebSearchCallOptions
  ): Promise<WebSearchResponse>;
  /**
   * The provider this source searches with, when known. Informational:
   * recorded on the tool's host output.
   */
  readonly provider?: WebSearchProvider;
}

/** Options shared by the AI-binding and HTTP sources. */
export interface WebSearchGatewayOptions {
  /** AI Gateway id. Defaults to `"default"`, which Cloudflare creates on first use. */
  gateway?: string;
  /**
   * Which provider runs the search. Host-chosen; the model never picks.
   * Defaults to the platform default (`ceramic`).
   */
  provider?: WebSearchProvider;
  /**
   * The BYOK key alias on the gateway to bill the provider with. When set
   * and no such key exists the request fails rather than falling back to
   * AI Gateway credits. When omitted, a key under the `default` alias is
   * used if one exists, otherwise credits.
   */
  byokAlias?: string;
}

/** A search over the Workers AI binding (`env.AI.websearch`). */
export interface AIWebSearchOptions extends WebSearchGatewayOptions {
  /** The Workers AI binding. Requires `"ai": { "binding": "AI" }` in wrangler.jsonc. */
  binding: Ai;
}

/**
 * `Ai.websearch` as `@cloudflare/workers-types` ≥ 5.20260812.1 declares it.
 * This repo can't take that version yet — it breaks `@types/node`'s
 * `Buffer` (cloudflare/workerd#7026) — so the method is spelled out here
 * and the binding is viewed through it. Drop once the repo bumps.
 */
interface AiWebSearchBinding {
  websearch(request: {
    gatewayId: string;
    query: string;
    limit?: number;
    provider?: string;
    byokAlias?: string;
  }): Promise<Response>;
}

/**
 * Search through the Workers AI binding. The Worker's own account and the
 * named gateway are billed.
 */
export function createAIWebSearch(
  options: AIWebSearchOptions
): WebSearchSource {
  validateGatewayOptions(options);
  const binding = options.binding as unknown as AiWebSearchBinding;
  const search: WebSearchSource["search"] = async (input, call = {}) => {
    const request = validateRequest(input);
    if (typeof binding.websearch !== "function") {
      throw new WebSearchError(
        "This Workers runtime has no env.AI.websearch(). Web search needs workerd 1.20260924.1 or later; see https://github.com/cloudflare/agents/blob/main/docs/agents/search-the-web.md.",
        {
          status: 501,
          code: "web_search_unsupported_runtime",
          retryable: false
        }
      );
    }
    // The binding takes no signal, so an abort stops waiting for it.
    const response = await abortable(
      binding.websearch({
        gatewayId: options.gateway ?? DEFAULT_GATEWAY_ID,
        query: request.query,
        limit: request.limit,
        provider: options.provider,
        byokAlias: options.byokAlias
      }),
      call.signal
    );
    return readResponse(response, request.query);
  };
  return { search, provider: options.provider };
}

/** A search over the HTTP API, from any runtime with `fetch`. */
export interface HTTPWebSearchOptions extends WebSearchGatewayOptions {
  /** The Cloudflare account the gateway belongs to. */
  accountId: string;
  /** An API token with `Workers AI: Read` and `AI Gateway: Read` on that account. */
  apiToken: string;
  /** Override for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** API origin. Defaults to `https://api.cloudflare.com`. */
  baseUrl?: string;
}

/**
 * Search through `POST /accounts/{account_id}/ai/websearch`. Use this
 * outside Workers, or to search through a gateway in another account.
 */
export function createHTTPWebSearch(
  options: HTTPWebSearchOptions
): WebSearchSource {
  validateGatewayOptions(options);
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? "https://api.cloudflare.com").replace(
    /\/+$/,
    ""
  );
  const url = `${baseUrl}/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/websearch/`;
  const search: WebSearchSource["search"] = async (input, call = {}) => {
    const request = validateRequest(input);
    const response = await doFetch(url, {
      method: "POST",
      signal: call.signal,
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: request.query,
        limit: request.limit,
        provider: options.provider,
        byokAlias: options.byokAlias,
        options: { gateway: { id: options.gateway ?? DEFAULT_GATEWAY_ID } }
      })
    });
    return readResponse(response, request.query);
  };
  return { search, provider: options.provider };
}

/** The API's pattern for `byokAlias`. */
const BYOK_ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Host configuration errors are programming errors: throw when building. */
function validateGatewayOptions(options: WebSearchGatewayOptions): void {
  if (
    options.byokAlias !== undefined &&
    !BYOK_ALIAS_PATTERN.test(options.byokAlias)
  ) {
    throw new RangeError(
      `byokAlias must be 1–64 letters, digits, "_" or "-"; got ${JSON.stringify(options.byokAlias)}.`
    );
  }
}

/**
 * Error codes a {@link WebSearchError} carries. The `web_search_*` codes the
 * API returns pass through as-is; failures without one get a code from the
 * HTTP status, so every error has a code to branch on.
 */
export type WebSearchErrorCode =
  /** No AI Gateway credits and no provider key for the search. */
  | "web_search_payment_required"
  /** `byokAlias` names a key the gateway does not have. */
  | "web_search_byok_not_configured"
  /** The query, limit, or provider was rejected. */
  | "invalid_web_search_input"
  /** The gateway does not exist or is not set up. */
  | "web_search_gateway_not_configured"
  /** The API token or binding is not allowed to search. */
  | "web_search_unauthorized"
  /** Too many searches; retry later. */
  | "web_search_rate_limited"
  /** The search took longer than the tool's `timeoutMs`. */
  | "web_search_timeout"
  /** The API or the provider failed. */
  | "web_search_unavailable"
  /** The Workers runtime has no `env.AI.websearch()`. */
  | "web_search_unsupported_runtime"
  /** A code the API added after this release. */
  | (string & {});

/** Why a search failed, with what the API said. */
export class WebSearchError extends Error {
  override readonly name = "WebSearchError";
  readonly status: number;
  readonly code: WebSearchErrorCode;
  /** Whether retrying the same search might succeed. */
  readonly retryable: boolean;
  /** AI Gateway's id for the failed request, for the gateway log. */
  readonly requestId?: string;
  /** The Cloudflare API's numeric error code, when it gave one. */
  readonly apiCode?: number;

  constructor(
    message: string,
    details: {
      status: number;
      code: WebSearchErrorCode;
      retryable?: boolean;
      requestId?: string;
      apiCode?: number;
      cause?: unknown;
    }
  ) {
    super(message, { cause: details.cause });
    this.status = details.status;
    this.code = details.code;
    this.retryable = details.retryable ?? isRetryableStatus(details.status);
    this.requestId = details.requestId;
    this.apiCode = details.apiCode;
  }
}

/** Check a request against the API's limits and fill in the default limit. */
function validateRequest(
  request: WebSearchRequest
): Required<WebSearchRequest> {
  const query = request.query.trim();
  const limit = request.limit ?? DEFAULT_WEB_SEARCH_LIMIT;
  if (query.length === 0) {
    throw new WebSearchError("Query must not be empty.", {
      status: 400,
      code: "invalid_web_search_input"
    });
  }
  if (query.length > MAX_WEB_SEARCH_QUERY_LENGTH) {
    throw new WebSearchError(
      `Query must be at most ${MAX_WEB_SEARCH_QUERY_LENGTH} characters.`,
      { status: 400, code: "invalid_web_search_input" }
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEB_SEARCH_LIMIT) {
    throw new WebSearchError(
      `Limit must be an integer from 1 to ${MAX_WEB_SEARCH_LIMIT}.`,
      { status: 400, code: "invalid_web_search_input" }
    );
  }
  return { query, limit };
}

/** Settle with `promise`, or reject with the signal's reason once it aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function readResponse(
  response: Response,
  query: string
): Promise<WebSearchResponse> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const result = response.ok ? toWebSearchResponse(body, query) : undefined;
  if (!result) throw toWebSearchError(response.status, body, text);
  return result;
}

/**
 * Read a 200 body into a {@link WebSearchResponse}, tolerating what a beta
 * API and three providers might send: items without a URL are dropped, a
 * missing title falls back to the URL, unknown or mistyped fields are left
 * out, and missing metadata gets defaults. Only a body with no `items`
 * array is rejected.
 */
function toWebSearchResponse(
  body: unknown,
  query: string
): WebSearchResponse | undefined {
  if (!isRecord(body) || !Array.isArray(body.items)) return undefined;
  const items: WebSearchResult[] = [];
  for (const item of body.items as unknown[]) {
    if (!isRecord(item)) continue;
    const url = asString(item.url)?.trim();
    if (!url) continue;
    const result: WebSearchResult = {
      url,
      title: asString(item.title)?.trim() || url
    };
    for (const key of OPTIONAL_RESULT_FIELDS) {
      const value = asString(item[key]);
      if (value !== undefined) result[key] = value;
    }
    items.push(result);
  }
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  return {
    items,
    metadata: {
      query: asString(metadata.query) ?? query,
      requestId: asString(metadata.requestId) ?? "",
      latencyMs: typeof metadata.latencyMs === "number" ? metadata.latencyMs : 0
    }
  };
}

const OPTIONAL_RESULT_FIELDS = [
  "description",
  "lastModifiedDate",
  "imageUrl",
  "faviconUrl"
] as const satisfies readonly (keyof WebSearchResult)[];

/**
 * The API fails in three shapes. Gateway-native:
 * `{ ok: false, error: { category, code, status, retryable, gatewayRequestId } }`.
 * Request validation, the Cloudflare envelope with issue details:
 * `{ success: false, errors: [{ code: 7000, message }], messages: [{ message, path }] }`.
 * Gateway configuration (`AiGatewayError`):
 * `{ success: false, error: [{ code: 2001, message }], message, description }`.
 */
function toWebSearchError(
  status: number,
  body: unknown,
  text: string
): WebSearchError {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.code === "string") {
      const errorStatus =
        typeof error.status === "number" ? error.status : status;
      return new WebSearchError(describeCode(error.code, errorStatus), {
        status: errorStatus,
        code: error.code,
        retryable:
          typeof error.retryable === "boolean" ? error.retryable : undefined,
        requestId: asString(error.gatewayRequestId)
      });
    }
    const envelope: unknown[] = Array.isArray(body.errors)
      ? body.errors
      : Array.isArray(error)
        ? error
        : [];
    const entries = envelope.filter(isRecord);
    const issues: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    const message =
      [
        ...entries.map((entry) => asString(entry.message)),
        ...issues.map(describeIssue)
      ]
        .filter((m): m is string => Boolean(m))
        .join("; ") || asString(body.message);
    if (message) {
      const apiCode = entries
        .map((entry) => entry.code)
        .find((code): code is number => typeof code === "number");
      return new WebSearchError(message, {
        status,
        code: codeForApiError(apiCode, status),
        apiCode
      });
    }
  }
  return new WebSearchError(
    `Web search failed with HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}.`,
    { status, code: codeForStatus(status) }
  );
}

function codeForApiError(
  apiCode: number | undefined,
  status: number
): WebSearchErrorCode {
  switch (apiCode) {
    case 7000:
      return "invalid_web_search_input";
    case 2001:
      return "web_search_gateway_not_configured";
    default:
      return codeForStatus(status);
  }
}

function codeForStatus(status: number): WebSearchErrorCode {
  if (status === 400) return "invalid_web_search_input";
  if (status === 401 || status === 403) return "web_search_unauthorized";
  if (status === 402) return "web_search_payment_required";
  if (status === 429) return "web_search_rate_limited";
  return "web_search_unavailable";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function describeCode(code: string, status: number): string {
  switch (code) {
    case "web_search_payment_required":
      return "Web search is unavailable: the AI Gateway has no credits and no provider key for this search. Top up AI Gateway credits or store a BYOK key for the provider.";
    case "web_search_byok_not_configured":
      return "Web search is unavailable: the requested BYOK key alias is not configured on the gateway.";
    case "invalid_web_search_input":
      return "The API rejected the request: check the query (1–1024 characters), limit (1–10), and provider (ceramic, exa, or linkup).";
    default:
      return `Web search failed (${code}, HTTP ${status}).`;
  }
}

function describeIssue(issue: unknown): string | undefined {
  if (!isRecord(issue)) return undefined;
  const message = asString(issue.message);
  if (!message) return undefined;
  const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
  return path ? `${path}: ${message}` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
