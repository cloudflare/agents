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
