/**
 * Network configuration types
 *
 * Network access is disabled by default. To enable network access (e.g., for curl),
 * you must explicitly configure allowed URLs.
 */

/**
 * DNS lookup result used for private IP resolution checks
 */
export interface DnsLookupResult {
  address: string;
  family: number;
}

/**
 * HTTP methods that can be allowed
 */
export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "OPTIONS";

/**
 * Configuration for network access
 */
export interface NetworkConfig {
  /**
   * List of allowed URL prefixes. Each entry must be a full origin (scheme + host),
   * optionally followed by a path prefix:
   * - An origin: "https://api.example.com" - allows all paths on this origin
   * - An origin + path prefix: "https://api.example.com/v1/" - allows only paths starting with /v1/
   *
   * The check is performed on the full URL, so "https://api.example.com/v1" will allow:
   * - https://api.example.com/v1
   * - https://api.example.com/v1/users
   * - https://api.example.com/v1/users/123
   *
   * But NOT:
   * - https://api.example.com/v2/users
   * - https://api.example.org/v1/users (different origin)
   *
   * Invalid entries (missing scheme, missing host, relative paths) will throw an error.
   */
  allowedUrlPrefixes?: string[];

  /**
   * List of allowed HTTP methods. Defaults to ["GET", "HEAD"] for safety.
   * dangerouslyAllowFullInternetAccess to enables all methods.
   */
  allowedMethods?: HttpMethod[];

  /**
   * Bypass the allow-list and allow all URLs and methods.
   * DANGEROUS: Only use this in trusted environments.
   */
  dangerouslyAllowFullInternetAccess?: boolean;

  /**
   * Maximum number of redirects to follow (default: 20)
   */
  maxRedirects?: number;

  /**
   * Request timeout in milliseconds (default: 30000)
   */
  timeoutMs?: number;

  /**
   * Maximum response body size in bytes (default: 10MB).
   * Responses larger than this will be rejected with ResponseTooLargeError.
   */
  maxResponseSize?: number;

  /**
   * Reject URLs with private/loopback IP addresses as hostnames.
   * Performs both lexical hostname checks and DNS resolution to catch
   * domains that resolve to private IPs (e.g., DNS rebinding attacks).
   * Useful for mitigating SSRF attacks. Default: false (opt-in).
   *
   * When enabled, the private IP check is enforced even when
   * `dangerouslyAllowFullInternetAccess` is true, ensuring that
   * internal/loopback addresses are never reachable.
   */
  denyPrivateRanges?: boolean;

  /**
   * @internal Override DNS resolution for testing.
   * When set, used instead of the default `dns.lookup` for the
   * denyPrivateRanges DNS rebinding check.
   */
  _dnsResolve?: (hostname: string) => Promise<DnsLookupResult[]>;
}

/**
 * Result of a network fetch operation
 */
export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

/**
 * Error thrown when a URL is not allowed
 */
export class NetworkAccessDeniedError extends Error {
  constructor(url: string, reason?: string) {
    const detail = reason ?? "URL not in allow-list";
    super(`Network access denied: ${detail}: ${url}`);
    this.name = "NetworkAccessDeniedError";
  }
}

/**
 * Error thrown when too many redirects occur
 */
export class TooManyRedirectsError extends Error {
  constructor(maxRedirects: number) {
    super(`Too many redirects (max: ${maxRedirects})`);
    this.name = "TooManyRedirectsError";
  }
}

/**
 * Error thrown when a redirect target is not allowed
 */
export class RedirectNotAllowedError extends Error {
  constructor(url: string) {
    super(`Redirect target not in allow-list: ${url}`);
    this.name = "RedirectNotAllowedError";
  }
}

/**
 * Error thrown when an HTTP method is not allowed
 */
export class MethodNotAllowedError extends Error {
  constructor(method: string, allowedMethods: string[]) {
    super(
      `HTTP method '${method}' not allowed. Allowed methods: ${allowedMethods.join(
        ", "
      )}`
    );
    this.name = "MethodNotAllowedError";
  }
}

/**
 * Error thrown when a response body exceeds the maximum allowed size
 */
export class ResponseTooLargeError extends Error {
  constructor(maxSize: number) {
    super(`Response body too large (max: ${maxSize} bytes)`);
    this.name = "ResponseTooLargeError";
  }
}
