/**
 * Gated Fetch — WorkerEntrypoint that gates sandbox outbound requests.
 *
 * Each secret is tied to specific allowed hosts. The token is injected
 * via WorkerEntrypoint props (never exposed to sandbox code).
 *
 * Pattern from cloudflare-mcp: token in props, hostname validation,
 * automatic Authorization header injection.
 *
 * The sandbox writes: fetch("https://api.github.com/...")
 * The entrypoint: checks host is allowed → injects auth → forwards request.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

/** A secret tied to specific hosts with a specific auth header format. */
export interface SecretBinding {
  /** The secret value (e.g. GitHub PAT) */
  token: string;
  /** Hosts this secret is allowed on */
  hosts: string[];
  /** Header format. Default: "token {token}" */
  headerFormat?: string;
  /** Header name. Default: "Authorization" */
  headerName?: string;
}

export interface GatedFetchProps {
  secrets: SecretBinding[];
}

function matchesHost(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // .github.com
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}

export class GatedFetchEntrypoint extends WorkerEntrypoint<Env, GatedFetchProps> {
  async fetch(request: Request): Promise<Response> {
    const { secrets } = this.ctx.props;
    let hostname: string;
    try {
      hostname = new URL(request.url).hostname;
    } catch {
      return new Response("Invalid URL", { status: 400 });
    }

    // Find the secret binding that matches this host
    const binding = secrets.find((s) =>
      s.hosts.some((h) => matchesHost(hostname, h))
    );

    // If no binding matches, check if ANY secret allows this host
    const anyAllowed = secrets.some((s) =>
      s.hosts.some((h) => matchesHost(hostname, h))
    );

    if (!anyAllowed) {
      return new Response(
        JSON.stringify({
          error: `Blocked: ${hostname} is not in the allowed hosts list`
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }

    // Build new request with injected auth
    const headers = new Headers(request.headers);

    if (binding) {
      const headerName = binding.headerName ?? "Authorization";
      const format = binding.headerFormat ?? "token {token}";
      const value = format.replace("{token}", binding.token);

      // Only inject if the request doesn't already have this header
      if (!headers.has(headerName)) {
        headers.set(headerName, value);
      }
    }

    return fetch(request.url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: request.redirect
    });
  }
}
