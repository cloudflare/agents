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
  DEFAULT_WEBSEARCH_DESCRIPTION_CHARS,
  DEFAULT_WEBSEARCH_LIMIT,
  MAX_WEBSEARCH_LIMIT,
  MAX_WEBSEARCH_QUERY_LENGTH,
  WEBSEARCH_TOOL_DESCRIPTION,
  WEBSEARCH_TOOL_NAME,
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
  type WebSearchGatewayOptions,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchSource
} from "./source";
export type { WebSearchToolOptions } from "./tool";
