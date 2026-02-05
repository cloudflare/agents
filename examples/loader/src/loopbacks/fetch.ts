import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Props passed to the FetchLoopback via ctx.exports
 */
export interface FetchLoopbackProps {
  sessionId: string;
  /**
   * Allowed URL prefixes. Requests to URLs not starting with these will be rejected.
   * If empty, all URLs are blocked by default.
   */
  allowedPrefixes?: string[];
  /**
   * Allowed HTTP methods. Defaults to ["GET", "HEAD"].
   */
  allowedMethods?: string[];
  /**
   * Whether to log all requests. Defaults to true.
   */
  logRequests?: boolean;
}

/**
 * Result from a fetch request
 */
export interface FetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  redirected: boolean;
}

/**
 * Error result when fetch is blocked
 */
export interface FetchError {
  error: string;
  code: "URL_NOT_ALLOWED" | "METHOD_NOT_ALLOWED" | "FETCH_FAILED";
  url?: string;
  method?: string;
}

/**
 * Request log entry
 */
export interface FetchLogEntry {
  timestamp: number;
  sessionId: string;
  url: string;
  method: string;
  status: number | null;
  allowed: boolean;
  error?: string;
  duration: number;
}

/**
 * FetchLoopback - Provides controlled HTTP fetch to dynamic workers
 *
 * This loopback allows dynamic workers to make HTTP requests, but with
 * security controls:
 * - URL allowlist: only requests to allowed prefixes are permitted
 * - Method restrictions: only allowed methods (default GET/HEAD) are permitted
 * - Request logging: all requests are logged for audit
 *
 * Usage from dynamic worker:
 *   const result = await env.FETCH.request("https://api.example.com/data");
 *   console.log(result.body);
 *
 * Note: The method is named "request" instead of "fetch" because "fetch" is
 * a reserved method on Service bindings in the Workers runtime.
 */
export class FetchLoopback extends WorkerEntrypoint<Env, FetchLoopbackProps> {
  // Request log (shared across all instances for this session)
  private static requestLogs: Map<string, FetchLogEntry[]> = new Map();

  // Default allowed prefixes (empty = block all by default)
  private static readonly DEFAULT_ALLOWED_PREFIXES: string[] = [
    // Common safe APIs - can be extended via props
    "https://api.github.com/",
    "https://raw.githubusercontent.com/",
    "https://registry.npmjs.org/",
    "https://cdn.jsdelivr.net/",
    "https://unpkg.com/"
  ];

  // Default allowed methods
  private static readonly DEFAULT_ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS"];

  /**
   * Get the allowed URL prefixes
   */
  private getAllowedPrefixes(): string[] {
    return (
      this.ctx.props.allowedPrefixes ?? FetchLoopback.DEFAULT_ALLOWED_PREFIXES
    );
  }

  /**
   * Get the allowed HTTP methods
   */
  private getAllowedMethods(): string[] {
    return (
      this.ctx.props.allowedMethods ?? FetchLoopback.DEFAULT_ALLOWED_METHODS
    ).map((m) => m.toUpperCase());
  }

  /**
   * Check if a URL is allowed
   */
  private isUrlAllowed(url: string): boolean {
    const prefixes = this.getAllowedPrefixes();
    if (prefixes.length === 0) {
      return false; // Block all if no prefixes configured
    }
    return prefixes.some((prefix) => url.startsWith(prefix));
  }

  /**
   * Check if a method is allowed
   */
  private isMethodAllowed(method: string): boolean {
    return this.getAllowedMethods().includes(method.toUpperCase());
  }

  /**
   * Log a request
   */
  private logRequest(entry: FetchLogEntry): void {
    if (this.ctx.props.logRequests === false) {
      return;
    }

    const sessionId = this.ctx.props.sessionId;
    let logs = FetchLoopback.requestLogs.get(sessionId);
    if (!logs) {
      logs = [];
      FetchLoopback.requestLogs.set(sessionId, logs);
    }
    logs.push(entry);

    // Keep only last 100 entries per session
    if (logs.length > 100) {
      logs.shift();
    }
  }

  /**
   * Make an HTTP request with security controls
   *
   * Note: Named "request" instead of "fetch" because "fetch" is a reserved
   * method on Service bindings in the Workers runtime.
   *
   * @param urlInput - The URL to fetch
   * @param options - Fetch options (method, headers, body)
   * @returns FetchResult on success, FetchError on failure
   */
  async request(
    urlInput: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {}
  ): Promise<FetchResult | FetchError> {
    const startTime = Date.now();
    // Ensure URL is a string (RPC serialization may alter types)
    const url = String(urlInput);
    const method = (options.method ?? "GET").toUpperCase();
    const sessionId = this.ctx.props.sessionId;

    // Check URL allowlist
    if (!this.isUrlAllowed(url)) {
      const error: FetchError = {
        error: `URL not in allowlist: ${url}`,
        code: "URL_NOT_ALLOWED",
        url
      };

      this.logRequest({
        timestamp: startTime,
        sessionId,
        url,
        method,
        status: null,
        allowed: false,
        error: error.error,
        duration: Date.now() - startTime
      });

      return error;
    }

    // Check method allowlist
    if (!this.isMethodAllowed(method)) {
      const error: FetchError = {
        error: `Method not allowed: ${method}. Allowed: ${this.getAllowedMethods().join(", ")}`,
        code: "METHOD_NOT_ALLOWED",
        method
      };

      this.logRequest({
        timestamp: startTime,
        sessionId,
        url,
        method,
        status: null,
        allowed: false,
        error: error.error,
        duration: Date.now() - startTime
      });

      return error;
    }

    // Perform the fetch
    try {
      const response = await fetch(url, {
        method,
        headers: options.headers,
        body: options.body
      });

      // Convert headers to plain object
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Read body as text (limit size for safety)
      const body = await response.text();

      const result: FetchResult = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        body:
          body.length > 1_000_000
            ? `${body.slice(0, 1_000_000)}...[truncated]`
            : body,
        url: response.url,
        redirected: response.redirected
      };

      this.logRequest({
        timestamp: startTime,
        sessionId,
        url,
        method,
        status: response.status,
        allowed: true,
        duration: Date.now() - startTime
      });

      return result;
    } catch (e) {
      const error: FetchError = {
        error: e instanceof Error ? e.message : String(e),
        code: "FETCH_FAILED",
        url
      };

      this.logRequest({
        timestamp: startTime,
        sessionId,
        url,
        method,
        status: null,
        allowed: true,
        error: error.error,
        duration: Date.now() - startTime
      });

      return error;
    }
  }

  /**
   * Convenience method for GET requests
   */
  async get(
    url: string,
    headers?: Record<string, string>
  ): Promise<FetchResult | FetchError> {
    return this.request(url, { method: "GET", headers });
  }

  /**
   * Convenience method for HEAD requests
   */
  async head(
    url: string,
    headers?: Record<string, string>
  ): Promise<FetchResult | FetchError> {
    return this.request(url, { method: "HEAD", headers });
  }

  /**
   * Get the request log for this session
   */
  async getLog(): Promise<FetchLogEntry[]> {
    return FetchLoopback.requestLogs.get(this.ctx.props.sessionId) ?? [];
  }

  /**
   * Clear the request log for this session
   */
  async clearLog(): Promise<void> {
    FetchLoopback.requestLogs.delete(this.ctx.props.sessionId);
  }

  /**
   * Get the current configuration
   */
  async getConfig(): Promise<{
    allowedPrefixes: string[];
    allowedMethods: string[];
    logRequests: boolean;
  }> {
    return {
      allowedPrefixes: this.getAllowedPrefixes(),
      allowedMethods: this.getAllowedMethods(),
      logRequests: this.ctx.props.logRequests !== false
    };
  }
}
