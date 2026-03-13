/**
 * Secure fetch wrapper with allow-list enforcement
 *
 * This module provides a fetch wrapper that:
 * 1. Enforces URL allow-list at the fetch layer (not subject to parsing)
 * 2. Handles redirects manually to check each redirect target against the allow-list
 * 3. Provides timeout support
 */

import { isPrivateIp, isUrlAllowed, validateAllowList } from "./allow-list";
import type { DnsLookupResult } from "./types";
import {
  type FetchResult,
  type HttpMethod,
  MethodNotAllowedError,
  NetworkAccessDeniedError,
  type NetworkConfig,
  RedirectNotAllowedError,
  ResponseTooLargeError,
  TooManyRedirectsError
} from "./types";

// DNS resolution for private IP check.
// Dynamically imports node:dns so the module doesn't fail to load on
// runtimes that lack it (Workers without nodejs_compat, browsers).
async function dnsLookupAll(hostname: string): Promise<DnsLookupResult[]> {
  const { lookup } = await import("node:dns");
  return new Promise<DnsLookupResult[]>((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

const DEFAULT_MAX_REDIRECTS = 20;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_SIZE = 10485760; // 10MB
const DEFAULT_ALLOWED_METHODS: HttpMethod[] = ["GET", "HEAD"];

/**
 * HTTP methods that should not have a body
 */
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Redirect status codes
 */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface SecureFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  followRedirects?: boolean;
  /** Override timeout for this request (capped at global timeout) */
  timeoutMs?: number;
}

/**
 * Type for the secure fetch function
 */
export type SecureFetch = (
  url: string,
  options?: SecureFetchOptions
) => Promise<FetchResult>;

/**
 * Creates a secure fetch function that enforces the allow-list.
 */
export function createSecureFetch(config: NetworkConfig): SecureFetch {
  // Fail fast on invalid allow-list entries
  if (!config.dangerouslyAllowFullInternetAccess) {
    const errors = validateAllowList(config.allowedUrlPrefixes ?? []);
    if (errors.length > 0) {
      throw new Error(`Invalid network allow-list:\n${errors.join("\n")}`);
    }
  }

  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseSize = config.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
  const allowedMethods = config.dangerouslyAllowFullInternetAccess
    ? ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
    : (config.allowedMethods ?? DEFAULT_ALLOWED_METHODS);
  // Default to denying private ranges in production
  const denyPrivateRanges =
    config.denyPrivateRanges ??
    (typeof process !== "undefined" && process.env?.NODE_ENV === "production");
  const resolveDns = config._dnsResolve ?? dnsLookupAll;

  /**
   * Checks if a URL is allowed by the configuration.
   * @throws NetworkAccessDeniedError if the URL is not allowed
   */
  async function checkAllowed(url: string): Promise<void> {
    // Private IP check runs BEFORE the full-access bypass so that
    // dangerouslyAllowFullInternetAccess never allows reaching
    // internal/loopback addresses.
    if (denyPrivateRanges) {
      try {
        const parsed = new URL(url);
        // Lexical check (fast path: catches IP literals and localhost)
        if (isPrivateIp(parsed.hostname)) {
          throw new NetworkAccessDeniedError(
            url,
            "private/loopback IP address blocked"
          );
        }
        // DNS resolution check (catches domains resolving to private IPs).
        // Skip for IP literals — they were already checked lexically above
        // and dns.lookup would just return the same address.
        const hostname = parsed.hostname;
        const isDomainName = /[a-zA-Z]/.test(hostname);
        if (isDomainName) {
          try {
            const addresses = await resolveDns(hostname);
            for (const { address } of addresses) {
              if (isPrivateIp(address)) {
                throw new NetworkAccessDeniedError(
                  url,
                  "hostname resolves to private/loopback IP address"
                );
              }
            }
          } catch (dnsErr) {
            if (dnsErr instanceof NetworkAccessDeniedError) throw dnsErr;
            // ENOTFOUND means the domain doesn't exist — it can't resolve
            // to a private IP, so it's safe to let the fetch fail naturally.
            const code = (dnsErr as NodeJS.ErrnoException)?.code;
            if (code === "ENOTFOUND" || code === "ENODATA") {
              // Domain doesn't exist; no rebinding risk
            } else {
              // Unexpected DNS error: fail closed (block)
              throw new NetworkAccessDeniedError(
                url,
                "DNS resolution failed for private IP check"
              );
            }
          }
        }
      } catch (e) {
        if (e instanceof NetworkAccessDeniedError) throw e;
        // Invalid URL will be caught by isUrlAllowed below
      }
    }

    if (config.dangerouslyAllowFullInternetAccess) {
      return;
    }

    if (!isUrlAllowed(url, config.allowedUrlPrefixes ?? [])) {
      throw new NetworkAccessDeniedError(url);
    }
  }

  /**
   * Checks if an HTTP method is allowed by the configuration.
   * @throws MethodNotAllowedError if the method is not allowed
   */
  function checkMethodAllowed(method: string): void {
    if (config.dangerouslyAllowFullInternetAccess) {
      return;
    }

    const upperMethod = method.toUpperCase();
    if (!allowedMethods.includes(upperMethod as HttpMethod)) {
      throw new MethodNotAllowedError(upperMethod, allowedMethods);
    }
  }

  /**
   * Performs a fetch with allow-list enforcement and manual redirect handling.
   */
  async function secureFetch(
    url: string,
    options: SecureFetchOptions = {}
  ): Promise<FetchResult> {
    const method = options.method?.toUpperCase() ?? "GET";

    // Check if URL and method are allowed
    await checkAllowed(url);
    checkMethodAllowed(method);

    let currentUrl = url;
    let redirectCount = 0;
    const followRedirects = options.followRedirects ?? true;

    // Use per-request timeout if specified, but cap at global timeout
    const effectiveTimeout =
      options.timeoutMs !== undefined
        ? Math.min(options.timeoutMs, timeoutMs)
        : timeoutMs;

    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        const fetchOptions: RequestInit = {
          method,
          headers: options.headers,
          signal: controller.signal,
          redirect: "manual" // Handle redirects manually to check allow-list
        };

        // Only include body for methods that support it
        if (options.body && !BODYLESS_METHODS.has(method)) {
          fetchOptions.body = options.body;
        }

        // undici (Node.js fetch) lazily compiles its WASM HTTP parser
        // on first use, which accesses WebAssembly — a blocked global.
        const response = await fetch(currentUrl, fetchOptions);

        // Check for redirects
        if (REDIRECT_CODES.has(response.status) && followRedirects) {
          const location = response.headers.get("location");
          if (!location) {
            // No location header, return the response as-is
            return await responseToResult(
              response,
              currentUrl,
              maxResponseSize
            );
          }

          // Resolve relative URLs
          const redirectUrl = new URL(location, currentUrl).href;

          // Check redirect target against allow-list and private IP ranges
          try {
            await checkAllowed(redirectUrl);
          } catch {
            throw new RedirectNotAllowedError(redirectUrl);
          }

          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new TooManyRedirectsError(maxRedirects);
          }

          currentUrl = redirectUrl;
          continue;
        }

        return await responseToResult(response, currentUrl, maxResponseSize);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  return secureFetch;
}

/**
 * Converts a Response to a FetchResult, enforcing response size limits.
 */
async function responseToResult(
  response: Response,
  url: string,
  maxResponseSize: number
): Promise<FetchResult> {
  // Use null-prototype to prevent prototype pollution via malicious response headers
  const headers: Record<string, string> = Object.create(null);
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Fast path: check Content-Length header
  if (maxResponseSize > 0) {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!Number.isNaN(size) && size > maxResponseSize) {
        throw new ResponseTooLargeError(maxResponseSize);
      }
    }
  }

  // Read body with size tracking
  let body: string;
  if (maxResponseSize > 0 && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maxResponseSize) {
        reader.cancel();
        throw new ResponseTooLargeError(maxResponseSize);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    body = chunks.join("");
  } else {
    body = await response.text();
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url
  };
}
