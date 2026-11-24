/**
 * Rules for the identifiers and URLs the MCP client manager accepts: stable
 * server ids, and the URL policy that keeps HTTP connections off private
 * and internal networks.
 */

import {
  validateRedirect,
  validateUrl,
  type UrlPolicy,
  type UrlValidation
} from "../../web/url-policy";
import type { TransportFetch } from "./authorization-turns";

/** Maximum length of a normalized MCP server id. */
export const MCP_SERVER_ID_MAX_LENGTH = 64;

/**
 * Normalize a caller-supplied MCP server id into a stable, storage- and
 * tool-name-safe form.
 *
 * The id is surfaced in several places where the character set matters:
 *  - as the primary key in the `cf_agents_mcp_servers` SQLite table
 *  - embedded in AI SDK tool names as `` `tool_${id.replace(/-/g, "")}_${tool}` ``
 *    (tool names must match `/^[A-Za-z0-9_]+$/`)
 *  - as a key on the `mcpConnections` map and OAuth provider storage
 *
 * Rules:
 *  1. Lowercase.
 *  2. Replace any run of disallowed characters with a single `-`.
 *  3. Collapse repeated `-` and trim leading/trailing `-`/`_`.
 *  4. Prefix with `id-` if the result is empty or doesn't start with a letter.
 *  5. Truncate to {@link MCP_SERVER_ID_MAX_LENGTH} characters.
 *
 * @example
 * normalizeServerId("my-supplied-id");  // "my-supplied-id"
 * normalizeServerId("GitHub MCP!");     // "github-mcp"
 * normalizeServerId("42-things");       // "id-42-things"
 */
export function normalizeServerId(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(
      `normalizeServerId: expected string, got ${typeof input}`
    );
  }

  let id = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (id.length === 0 || !/^[a-z]/.test(id)) {
    id = `id-${id}`.replace(/-+$/g, "");
  }

  if (id.length > MCP_SERVER_ID_MAX_LENGTH) {
    id = id.slice(0, MCP_SERVER_ID_MAX_LENGTH).replace(/-+$/g, "");
  }

  return id;
}

/**
 * The hosts an MCP client may reach: the web tools' policy, with loopback
 * allowed so a client can reach a server on the same machine during local
 * development. Server URLs had no length limit before this policy, so none
 * is added.
 */
const MCP_URL_POLICY: UrlPolicy = {
  allowLoopback: true,
  maxUrlLength: Number.MAX_SAFE_INTEGER
};

/** The most redirects followed for one request, as `fetch` does. */
const MAX_REDIRECTS = 20;

/** Throw for a server URL the policy refuses. */
export function assertAllowedUrl(url: string): void {
  allowedUrl(url, validateUrl(url, MCP_URL_POLICY));
}

/**
 * Wrap a transport's `fetch` so every request it sends, and every redirect
 * it follows, goes only to a URL the policy allows. A request that asks
 * `fetch` to follow redirects is followed here one hop at a time, each hop
 * checked, as `fetch` would follow it.
 */
export function fetchWithinUrlPolicy(
  base: TransportFetch = fetch
): TransportFetch {
  return async (input, init) => {
    let url = allowedUrl(
      String(input),
      validateUrl(String(input), MCP_URL_POLICY)
    );
    if (init?.redirect === "manual" || init?.redirect === "error") {
      return base(url, init);
    }
    let request: RequestInit = { ...init, redirect: "manual" };
    for (let hops = 0; ; hops++) {
      const response = await base(url, request);
      const location = response.headers.get("location");
      if (!isRedirect(response.status) || location === null) return response;
      if (hops === MAX_REDIRECTS) {
        throw new Error(
          `${url.origin} redirected more than ${MAX_REDIRECTS} times`
        );
      }
      const next = allowedUrl(
        location,
        validateRedirect(location, url, MCP_URL_POLICY)
      );
      await response.body?.cancel();
      request = redirectedRequest(request, response.status, url, next);
      url = next;
    }
  };
}

function allowedUrl(url: string, checked: UrlValidation): URL {
  if (checked.ok) return checked.url;
  throw new Error(
    `Blocked URL: ${url} — MCP client connections to private/internal addresses are not allowed (${checked.message})`
  );
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

/**
 * The request `fetch` sends after a redirect: 303, and 301 or 302 after a
 * POST, become a GET without a body; credentials are not sent to another
 * origin.
 */
function redirectedRequest(
  request: RequestInit,
  status: number,
  from: URL,
  to: URL
): RequestInit {
  const method = (request.method ?? "GET").toUpperCase();
  const toGet =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  const headers = new Headers(request.headers);
  if (toGet) {
    for (const name of [
      "content-type",
      "content-length",
      "content-encoding",
      "content-language",
      "content-location"
    ]) {
      headers.delete(name);
    }
  }
  if (from.origin !== to.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }
  return toGet
    ? { ...request, method: "GET", body: undefined, headers }
    : { ...request, headers };
}
