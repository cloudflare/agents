/**
 * `agents/websearch` — search the public web through Cloudflare's Web
 * Search API (AI Gateway), from a Worker or anywhere with `fetch`.
 *
 * The tool adapters live beside this entry: `agents/websearch/pi`,
 * `agents/websearch/ai-sdk`, and `agents/websearch/tanstack-ai`. Import
 * from here to search without a model in the loop, or to build a source
 * for the tools.
 *
 * @beta
 */
export {
  DEFAULT_WEB_SEARCH_DESCRIPTION_CHARS,
  DEFAULT_WEB_SEARCH_LIMIT,
  MAX_WEB_SEARCH_LIMIT,
  MAX_WEB_SEARCH_QUERY_LENGTH,
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  renderWebSearchResults,
  type RenderWebSearchResultsOptions,
  type WebSearchResponse,
  type WebSearchResult,
  type WebSearchToolInput,
  type WebSearchToolOutput
} from "./contract";
export {
  WebSearchError,
  createAIWebSearch,
  createHTTPWebSearch,
  type AIWebSearchOptions,
  type HTTPWebSearchOptions,
  type WebSearchCallOptions,
  type WebSearchErrorCode,
  type WebSearchGatewayOptions,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchSource
} from "./source";
export {
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  type WebSearchToolBindingOptions,
  type WebSearchToolOptions,
  type WebSearchToolSourceOptions
} from "./tool";
