/**
 * `agents/webfetch` — read a URL as Markdown, JSON, or text, with
 * host-controlled URL policy and size limits, from a Worker.
 *
 * The tool adapters live beside this entry: `agents/webfetch/pi`,
 * `agents/webfetch/ai-sdk`, and `agents/webfetch/tanstack-ai`. Import from
 * here to fetch without a model in the loop, or to build a source for the
 * tools.
 *
 * @beta
 */
import type { WebFetchPage } from "./contract";
import {
  createDirectWebFetch,
  type DirectWebFetchOptions,
  type WebFetchRequest
} from "./source";
import { fetchWithDeadline, validateTimeout } from "./tool";

export {
  DEFAULT_WEB_FETCH_MAX_BYTES,
  DEFAULT_WEB_FETCH_MAX_REDIRECTS,
  DEFAULT_WEB_FETCH_PAGE_CHARS,
  DEFAULT_WEB_FETCH_TIMEOUT_MS,
  MAX_WEB_FETCH_URL_LENGTH,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  renderWebFetchPage,
  windowWebFetchPage,
  type WebFetchFormat,
  type WebFetchPage,
  type WebFetchToolInput,
  type WebFetchToolOutput,
  type WebFetchVia,
  type WindowWebFetchPageOptions
} from "./contract";
export {
  WebFetchError,
  createDirectWebFetch,
  type DirectWebFetchOptions,
  type WebFetchCallOptions,
  type WebFetchErrorCode,
  type WebFetchRequest,
  type WebFetchSource
} from "./source";
export { isPrivateOrLocalHost } from "../url-policy";
export {
  type WebFetchToolDirectOptions,
  type WebFetchToolOptions,
  type WebFetchToolSourceOptions
} from "./tool";

/** Options for {@link fetchWeb}: the direct source's, plus a deadline. */
export interface FetchWebOptions extends DirectWebFetchOptions {
  /**
   * Give up after this many milliseconds with a `web_fetch_timeout` error.
   * A positive integer; defaults to 30 seconds.
   */
  timeoutMs?: number;
  /** Abort the fetch; rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Fetch one URL directly, without a tool: {@link createDirectWebFetch} plus
 * a deadline. Returns the whole page; to show it to a model a window at a
 * time, as the tool does, pass it to {@link windowWebFetchPage} and
 * {@link renderWebFetchPage}.
 */
export async function fetchWeb(
  request: WebFetchRequest,
  options: FetchWebOptions
): Promise<WebFetchPage> {
  const { timeoutMs, signal, ...sourceOptions } = options;
  const deadline = validateTimeout(timeoutMs);
  const source = createDirectWebFetch(sourceOptions);
  return fetchWithDeadline(source, request, { timeoutMs: deadline, signal });
}
