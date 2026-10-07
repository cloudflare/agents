/**
 * The `web_search` tool contract: its name, what it tells the model, what the
 * model passes in, what comes back, and how results are rendered for the
 * model. Shared by every executor of the tool — the harness-executed
 * adapters in `agents/websearch/*` today, and a gateway-executed variant in
 * `agents/models/*` once AI Gateway server tools ship — so a `web_search` call
 * looks the same in a transcript whoever ran it.
 */

/**
 * The tool's name, as the model calls it and as it appears in transcripts.
 * `web_search` is the name models know from Anthropic's and OpenAI's built-in
 * search tools.
 */
export const WEBSEARCH_TOOL_NAME = "web_search";

/** The default number of results when the model doesn't ask for a count. */
export const DEFAULT_WEBSEARCH_LIMIT = 5;

/** The most results one search can return; the API rejects more. */
export const MAX_WEBSEARCH_LIMIT = 10;

/** The longest query the API accepts, in characters. */
export const MAX_WEBSEARCH_QUERY_LENGTH = 1024;

/**
 * Per-result description length in the model's view, in characters. Provider
 * descriptions run to ~8,000 characters (Ceramic returns page text), which at
 * ten results is 80 KB of context per search. The full text stays in the
 * host-side output.
 */
export const DEFAULT_WEBSEARCH_DESCRIPTION_CHARS = 600;

/*
 * These are type aliases, not interfaces: pi stores tool details as strict
 * JSON, and only aliases satisfy its `JsonValue` index signature.
 */

/** What the model says when it wants a search. */
export type WebSearchToolInput = {
  /** The search query. */
  query: string;
  /** How many results to return, 1–10. Defaults to the host's `limit`. */
  limit?: number;
};

/**
 * One search result. `url` and `title` are always present; the rest only
 * when the provider returns them (Exa adds `imageUrl` and
 * `lastModifiedDate`, Linkup adds `faviconUrl`, Ceramic adds neither).
 */
export type WebSearchResult = {
  url: string;
  title: string;
  /** A snippet or extract of the page. Length and style vary by provider. */
  description?: string;
  /** ISO 8601 timestamp of the page's last modification. */
  lastModifiedDate?: string;
  imageUrl?: string;
  faviconUrl?: string;
};

/** The Web Search API's response: results plus request metadata. */
export type WebSearchResponse = {
  items: WebSearchResult[];
  metadata: {
    /** The query as the provider saw it. */
    query: string;
    /** AI Gateway request id, for the gateway log. */
    requestId: string;
    /** Provider latency in milliseconds. */
    latencyMs: number;
  };
};

/**
 * What one `web_search` run produces for the host: the full API response and
 * which provider served it. The model sees {@link renderWebSearchResults}
 * of this.
 */
export type WebSearchToolOutput = WebSearchResponse & {
  /** The provider that ran the search, when the source knows. */
  provider?: string;
};

export const WEBSEARCH_TOOL_DESCRIPTION = [
  "Search the public web. Returns up to `limit` results, each with a URL, a title, and a short description of the page.",
  "Use it for current events, facts you're unsure of, documentation, and anything that may have changed since your training.",
  "There is no next page: for more or different results, search again with a rephrased query.",
  "Results are discovery only: to read a page, fetch its URL if you have a tool that reads pages."
].join(" ");

export interface RenderWebSearchResultsOptions {
  /**
   * Trim each description to this many characters in the model's view.
   * Defaults to {@link DEFAULT_WEBSEARCH_DESCRIPTION_CHARS}; `Infinity`
   * disables trimming.
   */
  maxDescriptionChars?: number;
}

/**
 * Render search results as the text the model reads: one numbered block per
 * result, descriptions trimmed and whitespace collapsed.
 */
export function renderWebSearchResults(
  response: WebSearchResponse,
  options: RenderWebSearchResultsOptions = {}
): string {
  const maxChars =
    options.maxDescriptionChars ?? DEFAULT_WEBSEARCH_DESCRIPTION_CHARS;
  if (response.items.length === 0) {
    return `No results for "${response.metadata.query}". Try a broader or rephrased query.`;
  }
  const blocks = response.items.map((item, index) => {
    const lines = [`${index + 1}. ${item.title.trim() || item.url}`, item.url];
    const description = compactDescription(item.description, maxChars);
    if (description) lines.push(description);
    if (item.lastModifiedDate) lines.push(`Modified: ${item.lastModifiedDate}`);
    return lines.join("\n");
  });
  return [
    `${response.items.length} result${response.items.length === 1 ? "" : "s"} for "${response.metadata.query}":`,
    "",
    blocks.join("\n\n")
  ].join("\n");
}

function compactDescription(
  description: string | undefined,
  maxChars: number
): string | undefined {
  if (!description) return undefined;
  const compact = description.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
