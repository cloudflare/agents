import path from "node:path";
import { AgentClient } from "agents/client";
import type {
  ThinkFrameworkAgent,
  ThinkFrameworkManifest
} from "../framework/manifest";
import { resolveThinkManifest } from "../framework/project";
import { deriveWsTarget } from "./target";

type ManifestAgents = Pick<ThinkFrameworkManifest, "agents">;

function findTopLevelAgent(
  manifest: ManifestAgents,
  agent: string
): ThinkFrameworkAgent | undefined {
  return manifest.agents.find(
    (entry) =>
      entry.kind === "top-level" &&
      (entry.id === agent ||
        entry.bindingName === agent ||
        entry.className === agent ||
        entry.aliases.includes(agent))
  );
}

/** Options shared by the runtime CLI commands (`chat` and `state`). */
export interface ConnectOptions {
  /** Manifest agent id/alias (e.g. `support`) or a raw route segment. */
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
  /** Extra query params as `key=value` strings (repeatable). */
  query?: string[];
  /** Project root used to discover the Think manifest. Defaults to cwd. */
  root?: string;
  /** Override the Think route prefix. */
  routePrefix?: string;
}

/** A fully-resolved connection target — pure, derived without any IO. */
export interface ResolvedTarget {
  host: string;
  protocol: "ws" | "wss";
  /** URL pathname without a leading slash, suitable for `AgentClient.basePath`. */
  basePath: string;
  query: Record<string, string>;
  /** The agent identifier the user asked for (manifest id or raw segment). */
  agent: string;
  instance: string;
  /** Whether `agent` matched an entry in the supplied manifest. */
  matchedManifest: boolean;
}

export interface ResolveTargetInput extends ConnectOptions {
  manifest?: ManifestAgents | null;
}

/**
 * Resolve target/URL/auth details from CLI options. Pure (no IO) so it can be
 * unit-tested with a synthetic manifest. The manifest, when supplied, lets the
 * CLI accept friendly agent ids/aliases and honor a custom route prefix; when
 * the agent isn't found we treat it as a literal route segment (kebab-cased to
 * match the default `routeAgentRequest` behavior) so the CLI also works against
 * an arbitrary deployed worker. The browser-safe URL/query math lives in
 * {@link deriveWsTarget}; this layer only adds manifest awareness.
 */
export function resolveTarget(input: ResolveTargetInput): ResolvedTarget {
  const topLevel = input.manifest
    ? findTopLevelAgent(input.manifest, input.agent)
    : undefined;
  const matchedManifest = topLevel !== undefined;

  // Manifest match → use the canonical route id (the server resolves ids,
  // aliases, binding names, and class names back to the agents class segment).
  // Otherwise treat the input as a literal segment, kebab-cased to match the
  // default `routeAgentRequest` behavior.
  const derived = deriveWsTarget({
    agent: topLevel ? topLevel.id : input.agent,
    canonicalAgent: topLevel !== undefined,
    instance: input.instance,
    url: input.url,
    host: input.host,
    protocol: input.protocol,
    token: input.token,
    query: input.query,
    routePrefix: input.routePrefix
  });

  return {
    host: derived.host,
    protocol: derived.protocol,
    basePath: derived.basePath,
    query: derived.query,
    agent: input.agent,
    instance: derived.instance,
    matchedManifest
  };
}

async function loadManifest(
  root: string | undefined,
  routePrefix: string | undefined
): Promise<ThinkFrameworkManifest | null> {
  try {
    return await resolveThinkManifest(
      { routePrefix },
      path.resolve(root ?? process.cwd())
    );
  } catch {
    // Best-effort: outside a Think project the manifest can't be discovered,
    // so the CLI falls back to treating the agent as a raw route segment.
    return null;
  }
}

export interface ThinkConnection {
  client: AgentClient;
  target: ResolvedTarget;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Resolve once the client receives its identity handshake, or reject after
 * `timeoutMs` (covers unreachable hosts, which otherwise retry silently).
 */
export function waitForClientReady(
  client: AgentClient,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms connecting to the agent. ` +
            "Check the host/url, that the dev server or worker is running, and the token."
        )
      );
    }, timeoutMs);
    client.ready.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * Resolve a target (loading the local manifest when present) and open a
 * connected {@link AgentClient} backed by Node's global `WebSocket`.
 */
export async function connectToThinkAgent(
  options: ConnectOptions
): Promise<ThinkConnection> {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") {
    throw new Error(
      "No global WebSocket found. The `think` runtime CLI requires Node.js 24+ " +
        "(which provides a built-in WebSocket)."
    );
  }

  const manifest = await loadManifest(options.root, options.routePrefix);
  const target = resolveTarget({ ...options, manifest });

  const client = new AgentClient({
    agent: target.agent,
    name: target.instance,
    basePath: target.basePath,
    host: target.host,
    protocol: target.protocol,
    query: target.query,
    WebSocket: WebSocketImpl as unknown as typeof WebSocket
  });

  return { client, target };
}
