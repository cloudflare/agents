import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Props passed to the BraveSearchLoopback via ctx.exports
 */
export interface BraveSearchLoopbackProps {
  sessionId: string;
  apiKey: string;
}

/**
 * Individual web search result
 */
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  extraSnippets?: string[];
  age?: string;
  language?: string;
}

/**
 * News article result
 */
export interface NewsResult {
  title: string;
  url: string;
  description: string;
  age: string;
  source: {
    name: string;
    url?: string;
    favicon?: string;
  };
}

/**
 * Response from a web search
 */
export interface BraveWebSearchResponse {
  query: string;
  results: WebSearchResult[];
  totalResults?: number;
}

/**
 * Response from a news search
 */
export interface BraveNewsSearchResponse {
  query: string;
  results: NewsResult[];
}

/**
 * Error result from Brave Search
 */
export interface BraveSearchError {
  error: string;
  code: "API_ERROR" | "RATE_LIMITED" | "INVALID_QUERY";
  status?: number;
}

/**
 * Search log entry for auditing
 */
export interface SearchLogEntry {
  timestamp: number;
  sessionId: string;
  query: string;
  type: "web" | "news";
  resultsCount: number;
  duration: number;
  error?: string;
}

/**
 * Freshness filter options
 * - pd: past day (24 hours)
 * - pw: past week (7 days)
 * - pm: past month (31 days)
 * - py: past year
 */
export type FreshnessFilter = "pd" | "pw" | "pm" | "py";

/**
 * BraveSearchLoopback - Provides web search capabilities via Brave Search API
 *
 * This loopback allows the agent to search the web for current information,
 * documentation, tutorials, and other resources.
 *
 * Features:
 * - Web search with freshness filtering
 * - News search for current events
 * - Extra snippets for more context
 * - Request logging for audit
 *
 * API Documentation: https://api.search.brave.com/app/documentation
 */
export class BraveSearchLoopback extends WorkerEntrypoint<
  Env,
  BraveSearchLoopbackProps
> {
  // Search log (shared across all instances for this session)
  private static searchLogs: Map<string, SearchLogEntry[]> = new Map();

  // API base URL
  private static readonly API_BASE = "https://api.search.brave.com/res/v1";

  /**
   * Log a search request
   */
  private logSearch(entry: SearchLogEntry): void {
    const sessionId = this.ctx.props.sessionId;
    let logs = BraveSearchLoopback.searchLogs.get(sessionId);
    if (!logs) {
      logs = [];
      BraveSearchLoopback.searchLogs.set(sessionId, logs);
    }
    logs.push(entry);

    // Keep only last 50 entries per session
    if (logs.length > 50) {
      logs.shift();
    }
  }

  /**
   * Make a request to the Brave Search API
   */
  private async makeRequest(
    endpoint: string,
    params: URLSearchParams
  ): Promise<Response> {
    const url = `${BraveSearchLoopback.API_BASE}${endpoint}?${params}`;

    return fetch(url, {
      headers: {
        "X-Subscription-Token": this.ctx.props.apiKey,
        Accept: "application/json"
      }
    });
  }

  /**
   * Search the web for relevant pages
   *
   * @param query - The search query
   * @param options - Search options
   * @returns Web search results or error
   */
  async search(
    query: string,
    options?: {
      /** Number of results (1-20, default: 10) */
      count?: number;
      /** Filter by freshness: pd=day, pw=week, pm=month, py=year */
      freshness?: FreshnessFilter;
      /** 2-letter country code for localized results */
      country?: string;
      /** Get extra excerpts from each result */
      extraSnippets?: boolean;
      /** Search result offset for pagination */
      offset?: number;
    }
  ): Promise<BraveWebSearchResponse | BraveSearchError> {
    const startTime = Date.now();
    const sessionId = this.ctx.props.sessionId;

    if (!query || query.trim().length === 0) {
      return {
        error: "Query cannot be empty",
        code: "INVALID_QUERY"
      };
    }

    const params = new URLSearchParams({
      q: query.trim()
    });

    if (options?.count) {
      params.set("count", String(Math.min(Math.max(1, options.count), 20)));
    }
    if (options?.freshness) {
      params.set("freshness", options.freshness);
    }
    if (options?.country) {
      params.set("country", options.country.toUpperCase());
    }
    if (options?.extraSnippets) {
      params.set("extra_snippets", "true");
    }
    if (options?.offset) {
      params.set("offset", String(options.offset));
    }

    try {
      const response = await this.makeRequest("/web/search", params);

      if (!response.ok) {
        const errorText = await response.text();

        this.logSearch({
          timestamp: startTime,
          sessionId,
          query,
          type: "web",
          resultsCount: 0,
          duration: Date.now() - startTime,
          error: `HTTP ${response.status}: ${errorText}`
        });

        if (response.status === 429) {
          return {
            error: "Rate limited. Please wait before making more requests.",
            code: "RATE_LIMITED",
            status: 429
          };
        }

        return {
          error: `API error: ${response.status} ${response.statusText}`,
          code: "API_ERROR",
          status: response.status
        };
      }

      const data = (await response.json()) as {
        web?: {
          results?: Array<{
            title: string;
            url: string;
            description: string;
            extra_snippets?: string[];
            age?: string;
            language?: string;
          }>;
          total?: number;
        };
      };

      const results: WebSearchResult[] = (data.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
        extraSnippets: r.extra_snippets,
        age: r.age,
        language: r.language
      }));

      this.logSearch({
        timestamp: startTime,
        sessionId,
        query,
        type: "web",
        resultsCount: results.length,
        duration: Date.now() - startTime
      });

      return {
        query,
        results,
        totalResults: data.web?.total
      };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);

      this.logSearch({
        timestamp: startTime,
        sessionId,
        query,
        type: "web",
        resultsCount: 0,
        duration: Date.now() - startTime,
        error: errorMessage
      });

      return {
        error: errorMessage,
        code: "API_ERROR"
      };
    }
  }

  /**
   * Search for recent news articles
   *
   * @param query - The search query
   * @param options - Search options
   * @returns News search results or error
   */
  async news(
    query: string,
    options?: {
      /** Number of results (1-20, default: 10) */
      count?: number;
      /** Filter by freshness: pd=day, pw=week, pm=month, py=year */
      freshness?: FreshnessFilter;
      /** 2-letter country code for localized results */
      country?: string;
    }
  ): Promise<BraveNewsSearchResponse | BraveSearchError> {
    const startTime = Date.now();
    const sessionId = this.ctx.props.sessionId;

    if (!query || query.trim().length === 0) {
      return {
        error: "Query cannot be empty",
        code: "INVALID_QUERY"
      };
    }

    const params = new URLSearchParams({
      q: query.trim()
    });

    if (options?.count) {
      params.set("count", String(Math.min(Math.max(1, options.count), 20)));
    }
    if (options?.freshness) {
      params.set("freshness", options.freshness);
    }
    if (options?.country) {
      params.set("country", options.country.toUpperCase());
    }

    try {
      const response = await this.makeRequest("/news/search", params);

      if (!response.ok) {
        const errorText = await response.text();

        this.logSearch({
          timestamp: startTime,
          sessionId,
          query,
          type: "news",
          resultsCount: 0,
          duration: Date.now() - startTime,
          error: `HTTP ${response.status}: ${errorText}`
        });

        if (response.status === 429) {
          return {
            error: "Rate limited. Please wait before making more requests.",
            code: "RATE_LIMITED",
            status: 429
          };
        }

        return {
          error: `API error: ${response.status} ${response.statusText}`,
          code: "API_ERROR",
          status: response.status
        };
      }

      const data = (await response.json()) as {
        results?: Array<{
          title: string;
          url: string;
          description: string;
          age: string;
          meta_url?: {
            hostname?: string;
            favicon?: string;
          };
        }>;
      };

      const results: NewsResult[] = (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
        age: r.age,
        source: {
          name: r.meta_url?.hostname ?? new URL(r.url).hostname,
          url: r.url,
          favicon: r.meta_url?.favicon
        }
      }));

      this.logSearch({
        timestamp: startTime,
        sessionId,
        query,
        type: "news",
        resultsCount: results.length,
        duration: Date.now() - startTime
      });

      return {
        query,
        results
      };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);

      this.logSearch({
        timestamp: startTime,
        sessionId,
        query,
        type: "news",
        resultsCount: 0,
        duration: Date.now() - startTime,
        error: errorMessage
      });

      return {
        error: errorMessage,
        code: "API_ERROR"
      };
    }
  }

  /**
   * Get the search log for this session
   */
  async getLog(): Promise<SearchLogEntry[]> {
    return BraveSearchLoopback.searchLogs.get(this.ctx.props.sessionId) ?? [];
  }

  /**
   * Clear the search log for this session
   */
  async clearLog(): Promise<void> {
    BraveSearchLoopback.searchLogs.delete(this.ctx.props.sessionId);
  }
}
