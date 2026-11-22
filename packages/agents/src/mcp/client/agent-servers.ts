/**
 * The Agent's MCP server API: `addMcpServer()`, `reconnectMcpServer()` and
 * the server state it broadcasts. Plain functions over `MCPClientManager`;
 * Agent passes the few things only it knows (its name and class, whether
 * it sends its identity, its OAuth provider factory).
 */

import type {
  Prompt,
  Resource,
  ServerCapabilities,
  Tool
} from "@modelcontextprotocol/client";
import { nanoid } from "nanoid";
import { getCurrentAgent } from "../../lifecycle/current-agent";
import type { RetryOptions } from "../../retries";
import { camelCaseToKebabCase } from "../../utils";
import { RPC_DO_PREFIX, type McpRpcAgent } from "../rpc";
import type { McpClientOptions, TransportType } from "../types";
import { MCPConnectionState } from "./connection";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type { MCPClientManager } from "./manager";
import type { MCPServerSettlement } from "./types";
import { normalizeServerId } from "./url-policy";
import type { MCPServerRow } from "./storage";

export type MCPServersState = {
  servers: {
    [id: string]: MCPServer;
  };
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
};

export type MCPServer = {
  name: string;
  server_url: string;
  auth_url: string | null;
  // This state is specifically about the temporary process of getting a token (if needed).
  // Scope outside of that can't be relied upon because when the DO sleeps, there's no way
  // to communicate a change to a non-ready state.
  state: MCPConnectionState;
  /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
  error: string | null;
  instructions: string | null;
  capabilities: ServerCapabilities | null;
};

/**
 * Options for adding an MCP server
 */
export type AddMcpServerOptions = {
  /**
   * Optional caller-supplied stable server id. When provided, this id is used
   * for storage, restore, and tool-name namespacing instead of a generated
   * `nanoid`. The value is normalized via {@link normalizeServerId} — for
   * connector-style integrations this lets `addMcpServer` keep producing
   * keys like `tool_github_create_pull_request`.
   *
   * Throws if an existing server already uses the same (normalized) id but a
   * different name or url.
   */
  id?: string;
  /** OAuth callback host (auto-derived from request if omitted) */
  callbackHost?: string;
  /**
   * Custom callback URL path — bypasses the default `/agents/{class}/{name}/callback` construction.
   * Required when `sendIdentityOnConnect` is `false` to prevent leaking the instance name.
   * When set, the callback URL becomes `{callbackHost}/{callbackPath}`.
   * The developer must route this path to the agent instance via `getAgentByName`.
   * Should be a plain path (e.g., `/mcp-callback`) — do not include query strings or fragments.
   */
  callbackPath?: string;
  /** Agents routing prefix (default: "agents") */
  agentsPrefix?: string;
  /** MCP client options */
  client?: McpClientOptions;
  /** Transport options */
  transport?: {
    /** Custom headers for authentication (e.g., bearer tokens, CF Access) */
    headers?: HeadersInit;
    /** Transport type: "sse", "streamable-http", or "auto" (default) */
    type?: TransportType;
    /**
     * Compatibility escape hatch for a trusted legacy authorization server
     * whose RFC 8414 issuer does not match its metadata discovery URL.
     * Security-weakening; leave false unless the server is explicitly known.
     */
    skipIssuerMetadataValidation?: boolean;
  };
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Options for adding an MCP server via RPC (Durable Object binding)
 */
export type AddRpcMcpServerOptions = {
  /**
   * Optional caller-supplied stable server id. When provided, this id is used
   * for storage, restore, and tool-name namespacing instead of a generated
   * `nanoid`. The value is normalized via {@link normalizeServerId}.
   *
   * Throws if an existing server already uses the same (normalized) id but a
   * different name or url.
   */
  id?: string;
  /** Props to pass to the McpAgent instance */
  props?: Record<string, unknown>;
};

/** What `addMcpServer` resolves with for an HTTP or RPC server. */
export type AddMcpServerResult =
  | {
      id: string;
      state: typeof MCPConnectionState.AUTHENTICATING;
      authUrl: string;
    }
  | {
      id: string;
      state: typeof MCPConnectionState.READY;
      authUrl?: undefined;
    };

/** What `addMcpServer` needs from the Agent that calls it. */
export type AgentMcpServerHost = {
  readonly manager: MCPClientManager;
  readonly env: object;
  /** The Agent's instance name. */
  readonly agentName: string;
  /** The Agent's exported class name. */
  readonly agentClassName: string;
  /** When false, a callback URL must not carry the instance name. */
  readonly sendIdentityOnConnect: boolean;
  readonly createAuthProvider: (callbackUrl: string) => AgentMcpOAuthProvider;
};

/** How `addMcpServer` reports connect and discovery outcomes for one server. */
type McpConnectContext = {
  /** Server name used in error messages. */
  readonly name: string;
  /** Server URL used in error messages. */
  readonly url: string;
  /** Whether an OAuth callback URL is configured for the server. */
  readonly oauth: "available" | "unavailable";
};

/** Max length for error strings broadcast to clients. */
const MAX_ERROR_STRING_LENGTH = 500;

// C0 control characters (except \t, \n, \r) and DEL.
const CONTROL_CHAR_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- intentionally matching control chars for sanitization
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g"
);

/**
 * Sanitize an error string before broadcasting to clients. MCP error
 * strings may contain untrusted content from external OAuth providers, so
 * strip control characters and truncate.
 */
function sanitizeErrorString(error: string | null): string | null {
  if (error === null) return null;
  let sanitized = error.replace(CONTROL_CHAR_RE, "");
  if (sanitized.length > MAX_ERROR_STRING_LENGTH) {
    sanitized = sanitized.substring(0, MAX_ERROR_STRING_LENGTH) + "...";
  }
  return sanitized;
}

function contextFor(server: MCPServerRow): McpConnectContext {
  return {
    name: server.name,
    url: server.server_url,
    oauth: server.callback_url ? "available" : "unavailable"
  };
}

/** Connect to an MCP server by URL or Durable Object binding. */
export async function addMcpServer<T extends McpRpcAgent>(
  host: AgentMcpServerHost,
  serverName: string,
  urlOrBinding: string | DurableObjectNamespace<T>,
  callbackHostOrOptions?: string | AddMcpServerOptions | AddRpcMcpServerOptions,
  agentsPrefix?: string,
  options?: Pick<AddMcpServerOptions, "client" | "transport">
): Promise<AddMcpServerResult> {
  const { manager } = host;
  const isHttpTransport = typeof urlOrBinding === "string";
  const normalizedUrl = isHttpTransport
    ? new URL(urlOrBinding).href
    : undefined;

  // A caller-supplied stable id; the field exists on both option shapes.
  let requestedId: string | undefined;
  if (
    typeof callbackHostOrOptions === "object" &&
    callbackHostOrOptions !== null &&
    typeof (callbackHostOrOptions as { id?: unknown }).id === "string"
  ) {
    requestedId = normalizeServerId(
      (callbackHostOrOptions as { id: string }).id
    );
  }

  const allServers = manager.listServers();
  const existingServer = allServers.find(
    (s) =>
      s.name === serverName &&
      (!isHttpTransport || new URL(s.server_url).href === normalizedUrl)
  );

  if (requestedId) {
    // A caller-supplied id may only re-resolve to an existing server when
    // the (name, url) also matches; otherwise INSERT OR REPLACE on id would
    // overwrite the existing row.
    const idConflict = allServers.find((s) => {
      if (s.id !== requestedId) return false;
      if (s.name !== serverName) return true;
      if (isHttpTransport) return new URL(s.server_url).href !== normalizedUrl;
      return false;
    });
    if (idConflict) {
      throw new Error(
        `MCP server id "${requestedId}" is already in use by server "${idConflict.name}" (${idConflict.server_url}). ` +
          `Stable ids must be unique per (name, url).`
      );
    }

    // The same (name, url) under a different id, usually a generated one
    // from a call without `id`: rename it in place, so the id returned is
    // the id asked for and no stale rows stay behind.
    if (existingServer && existingServer.id !== requestedId) {
      await manager.migrateServerId(
        existingServer.id,
        requestedId,
        host.agentName
      );
      existingServer.id = requestedId;
    }
  }

  if (existingServer && manager.mcpConnections[existingServer.id]) {
    // Work already queued for it (restore, an OAuth callback, a concurrent
    // add) runs first, so a half-connected server is never reported ready.
    return mcpServerResult(
      existingServer.id,
      await manager.settleServer(existingServer.id),
      { ...contextFor(existingServer), name: serverName }
    );
  }

  if (typeof urlOrBinding !== "string") {
    return addRpcServer(
      host,
      serverName,
      urlOrBinding as unknown as DurableObjectNamespace<McpRpcAgent>,
      callbackHostOrOptions as AddRpcMcpServerOptions | undefined,
      requestedId ?? existingServer?.id
    );
  }

  const httpOptions = callbackHostOrOptions as
    | string
    | AddMcpServerOptions
    | undefined;
  let callbackHost: string | undefined;
  let callbackPath: string | undefined;
  let prefix: string;
  let resolved:
    | Pick<AddMcpServerOptions, "client" | "transport" | "retry">
    | undefined;
  if (typeof httpOptions === "object" && httpOptions !== null) {
    callbackHost = httpOptions.callbackHost;
    callbackPath = httpOptions.callbackPath;
    prefix = httpOptions.agentsPrefix ?? "agents";
    resolved = {
      client: httpOptions.client,
      transport: httpOptions.transport,
      retry: httpOptions.retry
    };
  } else {
    callbackHost = httpOptions;
    prefix = agentsPrefix ?? "agents";
    resolved = options;
  }

  if (!host.sendIdentityOnConnect && callbackHost && !callbackPath) {
    throw new Error(
      "callbackPath is required in addMcpServer options when sendIdentityOnConnect is false — " +
        "the default callback URL would expose the instance name. " +
        "Provide a callbackPath and route the callback request to this agent via getAgentByName."
    );
  }

  // Derive the callback host from the current request or connection.
  if (!callbackHost) {
    const { request, connection } = getCurrentAgent();
    const source = request?.url ?? connection?.uri;
    if (source) {
      const url = new URL(source);
      callbackHost = `${url.protocol}//${url.host}`;
    }
  }

  // Needed for OAuth, optional for servers without it.
  let callbackUrl: string | undefined;
  if (callbackHost) {
    const normalizedHost = callbackHost.replace(/\/$/, "");
    callbackUrl = callbackPath
      ? `${normalizedHost}/${callbackPath.replace(/^\//, "")}`
      : `${normalizedHost}/${prefix}/${camelCaseToKebabCase(host.agentClassName)}/${host.agentName}/callback`;
  }

  const id = requestedId ?? existingServer?.id ?? nanoid(8);
  let authProvider: AgentMcpOAuthProvider | undefined;
  if (callbackUrl) {
    authProvider = host.createAuthProvider(callbackUrl);
    authProvider.serverId = id;
  }

  const url = normalizedUrl ?? urlOrBinding;
  await manager.registerServer(id, {
    url,
    name: serverName,
    callbackUrl,
    client: resolved?.client,
    transport: {
      // Static credentials for servers without OAuth (an API key, or a
      // server behind Cloudflare Access).
      headers: resolved?.transport?.headers,
      authProvider,
      type: resolved?.transport?.type ?? "auto",
      skipIssuerMetadataValidation:
        resolved?.transport?.skipIssuerMetadataValidation
    },
    retry: resolved?.retry
  });

  // The server stays in storage on failure so the caller can retry.
  return mcpServerResult(id, await manager.connectAndDiscover(id), {
    name: serverName,
    url,
    oauth: callbackUrl ? "available" : "unavailable"
  });
}

async function addRpcServer(
  host: AgentMcpServerHost,
  serverName: string,
  namespace: DurableObjectNamespace<McpRpcAgent>,
  options: AddRpcMcpServerOptions | undefined,
  reconnectId: string | undefined
): Promise<AddMcpServerResult> {
  const { manager } = host;
  const normalizedName = serverName.toLowerCase().replace(/\s+/g, "-");
  const { id } = await manager.connect(`${RPC_DO_PREFIX}${normalizedName}`, {
    reconnect: reconnectId ? { id: reconnectId } : undefined,
    transport: {
      type: "rpc" as TransportType,
      namespace,
      name: normalizedName,
      props: options?.props
    }
  });

  const conn = manager.mcpConnections[id];
  if (conn && conn.connectionState === MCPConnectionState.CONNECTED) {
    const discovered = await manager.discoverIfConnected(id);
    if (discovered && !discovered.success) {
      throw new Error(
        `Failed to discover MCP server capabilities: ${discovered.error}`
      );
    }
  } else if (conn && conn.connectionState === MCPConnectionState.FAILED) {
    throw new Error(
      `Failed to connect to MCP server "${serverName}" via RPC: ${conn.connectionError}`
    );
  }

  const bindingName = Object.entries(host.env as Record<string, unknown>).find(
    ([, value]) => value === namespace
  )?.[0];
  if (bindingName) {
    manager.saveRpcServerToStorage(
      id,
      serverName,
      normalizedName,
      bindingName,
      options?.props
    );
  }
  return { id, state: MCPConnectionState.READY };
}

/** Try a registered server again; same result as `addMcpServer()`. */
export async function reconnectMcpServer(
  manager: MCPClientManager,
  id: string
): Promise<AddMcpServerResult> {
  const server = manager.listServers().find((s) => s.id === id);
  if (!server) throw new Error(`MCP server "${id}" is not registered`);
  return mcpServerResult(
    id,
    await manager.reconnectServer(id),
    contextFor(server)
  );
}

/** Translate where a server settled into `addMcpServer`'s result or error. */
function mcpServerResult(
  id: string,
  settlement: MCPServerSettlement,
  context: McpConnectContext
): AddMcpServerResult {
  switch (settlement.state) {
    case MCPConnectionState.READY:
      return { id, state: MCPConnectionState.READY };
    case MCPConnectionState.AUTHENTICATING:
      if (context.oauth === "unavailable") {
        throw new Error(
          "This MCP server requires OAuth authentication. " +
            "Provide callbackHost in addMcpServer options to enable the OAuth flow."
        );
      }
      if (!settlement.authUrl) {
        throw new Error("OAuth configuration incomplete: missing authUrl");
      }
      return {
        id,
        state: MCPConnectionState.AUTHENTICATING,
        authUrl: settlement.authUrl
      };
    case MCPConnectionState.FAILED:
      // The server stays in storage, failed until reconnectMcpServer().
      throw new Error(
        settlement.phase === "connect"
          ? `Failed to connect to MCP server at ${context.url}: ${settlement.error}`
          : `Failed to discover MCP server capabilities: ${settlement.error}`
      );
    case "removed":
      throw new Error(
        `MCP server "${context.name}" was removed while it was connecting`
      );
  }
}

/** The MCP state the Agent sends to clients. */
export function mcpServersState(manager: MCPClientManager): MCPServersState {
  const state: MCPServersState = {
    prompts: manager.listPrompts(),
    resources: manager.listResources(),
    servers: {},
    tools: manager.listTools()
  };
  for (const server of manager.listServers()) {
    const conn = manager.mcpConnections[server.id];
    // No connection but an auth_url: it is waiting for OAuth.
    const defaultState =
      !conn && server.auth_url ? "authenticating" : "not-connected";
    state.servers[server.id] = {
      auth_url: server.auth_url,
      capabilities: conn?.serverCapabilities ?? null,
      error: sanitizeErrorString(conn?.connectionError ?? null),
      instructions: conn?.instructions ?? null,
      name: server.name,
      server_url: server.server_url,
      state: conn?.connectionState ?? defaultState
    };
  }
  return state;
}
