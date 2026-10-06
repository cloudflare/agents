/**
 * Where searches run. A {@link WebSearchSource} turns a query into a
 * {@link WebSearchResponse}; the tool core is written against it, so the
 * same tool works over the Workers AI binding, the REST API, or a fake in
 * tests.
 */
import { DEFAULT_GATEWAY_ID } from "../models/core/settings";
import {
  MAX_WEBSEARCH_LIMIT,
  MAX_WEBSEARCH_QUERY_LENGTH,
  type WebSearchResponse
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
  /** 1–10. */
  limit: number;
}

/**
 * Runs a search. The tool core calls this and renders what comes back.
 * `provider` is informational — recorded on the tool's host output when the
 * source knows which provider it searches with.
 */
export type WebSearchSource = ((
  request: WebSearchRequest
) => Promise<WebSearchResponse>) & {
  readonly provider?: WebSearchProvider;
};

/** Options shared by the AI-binding and REST sources. */
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
export interface AIWebSearchSourceOptions extends WebSearchGatewayOptions {
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
export function webSearchFromAI(
  options: AIWebSearchSourceOptions
): WebSearchSource {
  const binding = options.binding as unknown as AiWebSearchBinding;
  const source: WebSearchSource = async (request) => {
    validateRequest(request);
    if (typeof binding.websearch !== "function") {
      throw new WebSearchError(
        "This Workers runtime has no env.AI.websearch(). Web search needs workerd 1.20260924.1 or later (wrangler 4.141.0 or later, @cloudflare/vite-plugin 1.60.2 or later).",
        { status: 501, code: "websearch_unsupported_runtime" }
      );
    }
    const response = await binding.websearch({
      gatewayId: options.gateway ?? DEFAULT_GATEWAY_ID,
      query: request.query,
      limit: request.limit,
      provider: options.provider,
      byokAlias: options.byokAlias
    });
    return readResponse(response);
  };
  return withProvider(source, options.provider);
}

/** A search over the REST API, from any runtime with `fetch`. */
export interface RestWebSearchSourceOptions extends WebSearchGatewayOptions {
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
export function webSearchFromRest(
  options: RestWebSearchSourceOptions
): WebSearchSource {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl ?? "https://api.cloudflare.com"}/client/v4/accounts/${options.accountId}/ai/websearch/`;
  const source: WebSearchSource = async (request) => {
    validateRequest(request);
    const response = await doFetch(url, {
      method: "POST",
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
    return readResponse(response);
  };
  return withProvider(source, options.provider);
}

function withProvider(
  source: WebSearchSource,
  provider: WebSearchProvider | undefined
): WebSearchSource {
  return provider === undefined ? source : Object.assign(source, { provider });
}

/**
 * Why a search failed, with what the API said. `code` is the API's own
 * error code when it gave one (`web_search_payment_required`,
 * `web_search_byok_not_configured`, `invalid_web_search_input`, …).
 */
export class WebSearchError extends Error {
  override readonly name = "WebSearchError";
  readonly status: number;
  readonly code?: string;
  /** Whether the API said retrying might help. */
  readonly retryable: boolean;
  /** AI Gateway's id for the failed request, for the gateway log. */
  readonly requestId?: string;

  constructor(
    message: string,
    details: {
      status: number;
      code?: string;
      retryable?: boolean;
      requestId?: string;
    }
  ) {
    super(message);
    this.status = details.status;
    this.code = details.code;
    this.retryable = details.retryable ?? false;
    this.requestId = details.requestId;
  }
}

function validateRequest(request: WebSearchRequest): void {
  const query = request.query.trim();
  if (query.length === 0) {
    throw new WebSearchError("Query must not be empty.", {
      status: 400,
      code: "invalid_web_search_input"
    });
  }
  if (query.length > MAX_WEBSEARCH_QUERY_LENGTH) {
    throw new WebSearchError(
      `Query must be at most ${MAX_WEBSEARCH_QUERY_LENGTH} characters.`,
      { status: 400, code: "invalid_web_search_input" }
    );
  }
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_WEBSEARCH_LIMIT
  ) {
    throw new WebSearchError(
      `Limit must be an integer from 1 to ${MAX_WEBSEARCH_LIMIT}.`,
      { status: 400, code: "invalid_web_search_input" }
    );
  }
}

async function readResponse(response: Response): Promise<WebSearchResponse> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok || !isWebSearchResponse(body)) {
    throw toWebSearchError(response.status, body, text);
  }
  return body;
}

function isWebSearchResponse(body: unknown): body is WebSearchResponse {
  if (!isRecord(body) || !Array.isArray(body.items)) return false;
  const metadata = body.metadata;
  return isRecord(metadata) && typeof metadata.query === "string";
}

/**
 * The API fails in three shapes. Gateway-native:
 * `{ ok: false, error: { category, code, status, retryable, gatewayRequestId } }`.
 * Request validation, the Cloudflare envelope with issue details:
 * `{ success: false, errors: [{ code, message }], messages: [{ message, path }] }`.
 * Gateway configuration (`AiGatewayError`):
 * `{ success: false, error: [{ code, message }], message, description }`.
 */
function toWebSearchError(
  status: number,
  body: unknown,
  text: string
): WebSearchError {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.code === "string") {
      return new WebSearchError(describeCode(error.code, status), {
        status: typeof error.status === "number" ? error.status : status,
        code: error.code,
        retryable: error.retryable === true,
        requestId: asString(error.gatewayRequestId)
      });
    }
    const issues = Array.isArray(body.messages)
      ? body.messages.map(describeIssue).filter(Boolean)
      : [];
    const envelope = Array.isArray(body.errors)
      ? body.errors
      : Array.isArray(error)
        ? error
        : [];
    const messages = envelope
      .map((entry) => (isRecord(entry) ? asString(entry.message) : undefined))
      .filter((m): m is string => Boolean(m));
    const message =
      [...messages, ...issues].join("; ") || asString(body.message);
    if (message) {
      return new WebSearchError(message, {
        status,
        code: asString(body.name) ?? asString(envelope[0]?.code)
      });
    }
  }
  return new WebSearchError(
    `Web search failed with HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}.`,
    { status, retryable: status >= 500 }
  );
}

function describeCode(code: string, status: number): string {
  switch (code) {
    case "web_search_payment_required":
      return "Web search is unavailable: the AI Gateway has no credits and no provider key for this search. Top up AI Gateway credits or store a BYOK key for the provider.";
    case "web_search_byok_not_configured":
      return "Web search is unavailable: the requested BYOK key alias is not configured on the gateway.";
    case "invalid_web_search_input":
      return "Web search rejected the request: check the query (1–1024 characters), limit (1–10), and provider (ceramic, exa, or linkup).";
    default:
      return `Web search failed (${code}, HTTP ${status}).`;
  }
}

function describeIssue(issue: unknown): string {
  if (!isRecord(issue)) return "";
  const message = asString(issue.message);
  if (!message) return "";
  const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
  return path ? `${path}: ${message}` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
