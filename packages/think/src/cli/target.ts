/**
 * Browser-safe, IO-free helpers for turning loose connection inputs (a remote
 * `url` or a local `host`, an agent id, an instance, a token, extra query
 * params) into the concrete `{ host, protocol, basePath, query }` an
 * `AgentClient`/`useAgent` needs.
 *
 * This module is deliberately dependency-free so it can be imported by both the
 * Node-side runtime CLI (`connect.ts`) and the browser Studio app. The
 * manifest-aware resolution (friendly agent ids/aliases) lives in `connect.ts`;
 * everything here is pure string math.
 */

/**
 * Mirror the default `routeAgentRequest` segment derivation so a raw agent name
 * (e.g. a class name) maps to the same route the server exposes.
 */
export function camelCaseToKebabCase(str: string): string {
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}

/** Normalize a route prefix to a slash-free segment (default `agents`). */
export function normalizeRoutePrefix(routePrefix?: string): string {
  const trimmed = (routePrefix ?? "/agents").replace(/^\/+|\/+$/g, "");
  return trimmed || "agents";
}

export interface DeriveWsTargetInput {
  /** Agent id/alias or raw route segment. */
  agent: string;
  /** Agent instance name. Defaults to `default`. */
  instance?: string;
  /** Remote origin, e.g. `https://app.example.com` (implies `wss`). */
  url?: string;
  /** Local host[:port]. Defaults to `localhost:5173` (Vite). */
  host?: string;
  /** Override the derived protocol. */
  protocol?: string;
  /** Bearer-style token sent as the `token` query param. */
  token?: string;
  /** Extra query params, either `key=value` strings or a record. */
  query?: string[] | Record<string, string>;
  /** Override the route prefix (default `agents`). */
  routePrefix?: string;
  /**
   * When `true`, `agent` is already a canonical route segment (e.g. a manifest
   * id resolved by the server) and is used verbatim (only URL-encoded).
   * Otherwise it is kebab-cased to match default `routeAgentRequest` behavior.
   */
  canonicalAgent?: boolean;
}

export interface WsTarget {
  host: string;
  protocol: "ws" | "wss";
  /** URL pathname without a leading slash, suitable for `basePath`. */
  basePath: string;
  query: Record<string, string>;
  instance: string;
  /** The route segment used for the agent (canonical or kebab-cased). */
  segment: string;
}

function parseQuery(
  query: string[] | Record<string, string> | undefined,
  token: string | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (token) result.token = token;
  if (!query) return result;
  if (Array.isArray(query)) {
    for (const pair of query) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        throw new Error(`Invalid query "${pair}" (expected key=value).`);
      }
      result[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return result;
  }
  for (const [key, value] of Object.entries(query)) {
    result[key] = value;
  }
  return result;
}

/**
 * Resolve host/protocol/basePath/query from loose inputs. Pure (no IO), so it
 * is safe in the browser and trivially unit-testable.
 */
export function deriveWsTarget(input: DeriveWsTargetInput): WsTarget {
  const instance = input.instance?.trim() || "default";
  const prefix = normalizeRoutePrefix(input.routePrefix);

  let host: string;
  let protocol: "ws" | "wss";
  if (input.url) {
    let origin: URL;
    try {
      origin = new URL(input.url);
    } catch {
      throw new Error(`Invalid url "${input.url}" (expected a full origin).`);
    }
    if (!origin.host) {
      throw new Error(
        `Invalid url "${input.url}" (missing host — include a scheme, e.g. https://host).`
      );
    }
    host = origin.host;
    protocol =
      input.protocol === "ws" || input.protocol === "wss"
        ? input.protocol
        : origin.protocol === "https:" || origin.protocol === "wss:"
          ? "wss"
          : "ws";
  } else {
    host = input.host?.trim() || "localhost:5173";
    protocol = input.protocol === "wss" ? "wss" : "ws";
  }

  const segment = input.canonicalAgent
    ? input.agent
    : camelCaseToKebabCase(input.agent);

  const basePath = [
    prefix,
    encodeURIComponent(segment),
    encodeURIComponent(instance)
  ].join("/");

  return {
    host,
    protocol,
    basePath,
    query: parseQuery(input.query, input.token),
    instance,
    segment
  };
}
