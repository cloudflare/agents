/**
 * MCP server-management capability (Layer 1): the Agent-side glue around
 * `MCPClientManager` — registering and removing servers, snapshotting
 * server state for clients, broadcasting protocol updates, restoring
 * RPC-backed servers after hibernation, and the OAuth callback flow.
 *
 * The MCP client machinery itself (connections, storage rows in
 * `cf_agents_mcp_servers`, OAuth code exchange) lives in
 * `../mcp/client.ts`. The `Agent` class owns the `mcp` manager field and
 * the overridable `createMcpOAuthProvider` hook, and delegates its
 * `addMcpServer()`/`removeMcpServer()`/`getMcpServers()` methods here;
 * the capability talks to the agent only through the narrow
 * {@link McpServersHost} slice.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { nanoid } from "nanoid";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import { normalizeServerId } from "../mcp/client";
import type { MCPClientManager, MCPClientOAuthResult } from "../mcp/client";
import { MCPConnectionState } from "../mcp/client-connection";
import { RPC_DO_PREFIX } from "../mcp/rpc";
import type { AgentMcpOAuthProvider } from "../mcp/do-oauth-client-provider";
import type { TransportType } from "../mcp/types";
import type { RetryOptions } from "../retries";
import { MessageType } from "../types";
import { camelCaseToKebabCase } from "../utils";
import type { McpAgent } from "../mcp";
import type {
  AddMcpServerOptions,
  AddRpcMcpServerOptions,
  MCPServersState
} from "../index";

/** Max length for error strings broadcast to clients. */
const MAX_ERROR_STRING_LENGTH = 500;

/**
 * Sanitize an error string before broadcasting to clients.
 * MCP error strings may contain untrusted content from external OAuth
 * providers — truncate and strip control characters to limit XSS risk.
 */
// Regex to match C0 control characters (except \t, \n, \r) and DEL.
const CONTROL_CHAR_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- intentionally matching control chars for sanitization
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g"
);

function sanitizeErrorString(error: string | null): string | null {
  if (error === null) return null;
  // Strip control characters (keep printable ASCII + common unicode)
  let sanitized = error.replace(CONTROL_CHAR_RE, "");
  if (sanitized.length > MAX_ERROR_STRING_LENGTH) {
    sanitized = sanitized.substring(0, MAX_ERROR_STRING_LENGTH) + "...";
  }
  return sanitized;
}

/** The slice of the agent the MCP server-management capability needs. */
export interface McpServersHost {
  /** The agent's MCP client manager (constructed and owned by the agent). */
  mcp: MCPClientManager;
  /** The agent's env, scanned to resolve Durable Object binding names. */
  env(): Record<string, unknown>;
  /** The agent's instance name (storage scope + default callback URL). */
  agentInstanceName(): string;
  /** The agent's class name (default OAuth callback URL construction). */
  agentClassName(): string;
  /** The resolved `sendIdentityOnConnect` static option. */
  sendIdentityOnConnect(): boolean;
  /** Overridable hook — closes over `agent.createMcpOAuthProvider`. */
  createOAuthProvider(callbackUrl: string): AgentMcpOAuthProvider;
  /** Send a protocol frame to every protocol-speaking connection. */
  broadcastProtocol(msg: string): void;
}

export class AgentMcpServers {
  private readonly _host: McpServersHost;

  constructor(host: McpServersHost) {
    this._host = host;
  }

  /**
   * Connect to a new MCP server over HTTP (SSE / Streamable HTTP) or RPC
   * (Durable Object binding). Implementation behind the `addMcpServer`
   * overloads on `Agent`.
   */
  async add<T extends McpAgent>(
    serverName: string,
    urlOrBinding: string | DurableObjectNamespace<T>,
    callbackHostOrOptions?:
      | string
      | AddMcpServerOptions
      | AddRpcMcpServerOptions,
    agentsPrefix?: string,
    options?: {
      client?: ConstructorParameters<typeof Client>[1];
      transport?: {
        headers?: HeadersInit;
        type?: TransportType;
      };
    }
  ): Promise<
    | {
        id: string;
        state: typeof MCPConnectionState.AUTHENTICATING;
        authUrl: string;
      }
    | {
        id: string;
        state: typeof MCPConnectionState.READY;
        authUrl?: undefined;
      }
  > {
    const isHttpTransport = typeof urlOrBinding === "string";
    const normalizedUrl = isHttpTransport
      ? new URL(urlOrBinding).href
      : undefined;

    // Extract and normalize a caller-supplied stable id, if any. The same
    // option field is accepted on both the HTTP and RPC option shapes.
    let requestedId: string | undefined;
    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null &&
      typeof (callbackHostOrOptions as { id?: unknown }).id === "string"
    ) {
      const rawId = (callbackHostOrOptions as { id: string }).id;
      requestedId = normalizeServerId(rawId);
    }

    const allServers = this._host.mcp.listServers();

    const existingServer = allServers.find(
      (s) =>
        s.name === serverName &&
        (!isHttpTransport || new URL(s.server_url).href === normalizedUrl)
    );

    if (requestedId) {
      // Collision check 1: a caller-supplied id may only re-resolve to an
      // existing server when the (name, url) also matches. Otherwise storage
      // (INSERT OR REPLACE on id) would silently overwrite the existing row.
      const idConflict = allServers.find((s) => {
        if (s.id !== requestedId) return false;
        if (s.name !== serverName) return true;
        if (isHttpTransport) {
          return new URL(s.server_url).href !== normalizedUrl;
        }
        return false;
      });
      if (idConflict) {
        throw new Error(
          `MCP server id "${requestedId}" is already in use by server "${idConflict.name}" (${idConflict.server_url}). ` +
            `Stable ids must be unique per (name, url).`
        );
      }

      // JIT-migrate: the same (name, url) is already registered under a
      // different id (typically an auto-generated nanoid from a previous
      // call that didn't supply `id`). This is the natural upgrade path —
      // a user adds `{ id: "github" }` to an existing `addMcpServer` call.
      // Rename the existing row + connection + OAuth keys to the new id in
      // place so the caller's contract ("the id I get back is the id I
      // asked for") holds and no stale storage rows are left behind.
      if (existingServer && existingServer.id !== requestedId) {
        await this._host.mcp.migrateServerId(
          existingServer.id,
          requestedId,
          this._host.agentInstanceName()
        );
        existingServer.id = requestedId;
      }
    }

    if (existingServer && this._host.mcp.mcpConnections[existingServer.id]) {
      const conn = this._host.mcp.mcpConnections[existingServer.id];
      if (
        conn.connectionState === MCPConnectionState.AUTHENTICATING &&
        conn.options.transport.authProvider?.authUrl
      ) {
        return {
          id: existingServer.id,
          state: MCPConnectionState.AUTHENTICATING,
          authUrl: conn.options.transport.authProvider.authUrl
        };
      }
      if (conn.connectionState === MCPConnectionState.FAILED) {
        throw new Error(
          `MCP server "${serverName}" is in failed state: ${conn.connectionError}`
        );
      }
      return { id: existingServer.id, state: MCPConnectionState.READY };
    }

    // RPC transport path: second argument is a DurableObjectNamespace
    if (typeof urlOrBinding !== "string") {
      const rpcOpts = callbackHostOrOptions as
        | AddRpcMcpServerOptions
        | undefined;

      const normalizedName = serverName.toLowerCase().replace(/\s+/g, "-");

      // Prefer the caller-supplied stable id, falling back to the existing
      // server's id (for restore-through-addMcpServer), then to a generated id.
      const reconnectId = requestedId ?? existingServer?.id;
      const { id } = await this._host.mcp.connect(
        `${RPC_DO_PREFIX}${normalizedName}`,
        {
          reconnect: reconnectId ? { id: reconnectId } : undefined,
          transport: {
            type: "rpc" as TransportType,
            namespace:
              urlOrBinding as unknown as DurableObjectNamespace<McpAgent>,
            name: normalizedName,
            props: rpcOpts?.props
          }
        }
      );

      const conn = this._host.mcp.mcpConnections[id];
      if (conn && conn.connectionState === MCPConnectionState.CONNECTED) {
        const discoverResult = await this._host.mcp.discoverIfConnected(id);
        if (discoverResult && !discoverResult.success) {
          throw new Error(
            `Failed to discover MCP server capabilities: ${discoverResult.error}`
          );
        }
      } else if (conn && conn.connectionState === MCPConnectionState.FAILED) {
        throw new Error(
          `Failed to connect to MCP server "${serverName}" via RPC: ${conn.connectionError}`
        );
      }

      const bindingName = this._findBindingNameForNamespace(
        urlOrBinding as unknown as DurableObjectNamespace<McpAgent>
      );
      if (bindingName) {
        this._host.mcp.saveRpcServerToStorage(
          id,
          serverName,
          normalizedName,
          bindingName,
          rpcOpts?.props
        );
      }

      return { id, state: MCPConnectionState.READY };
    }

    // HTTP transport path
    const httpOptions = callbackHostOrOptions as
      | string
      | AddMcpServerOptions
      | undefined;

    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions:
      | {
          client?: ConstructorParameters<typeof Client>[1];
          transport?: {
            headers?: HeadersInit;
            type?: TransportType;
          };
          retry?: RetryOptions;
        }
      | undefined;

    let resolvedCallbackPath: string | undefined;

    if (typeof httpOptions === "object" && httpOptions !== null) {
      resolvedCallbackHost = httpOptions.callbackHost;
      resolvedCallbackPath = httpOptions.callbackPath;
      resolvedAgentsPrefix = httpOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: httpOptions.client,
        transport: httpOptions.transport,
        retry: httpOptions.retry
      };
    } else {
      resolvedCallbackHost = httpOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    // Enforce callbackPath when sendIdentityOnConnect is false and callbackHost is provided
    if (
      !this._host.sendIdentityOnConnect() &&
      resolvedCallbackHost &&
      !resolvedCallbackPath
    ) {
      throw new Error(
        "callbackPath is required in addMcpServer options when sendIdentityOnConnect is false — " +
          "the default callback URL would expose the instance name. " +
          "Provide a callbackPath and route the callback request to this agent via getAgentByName."
      );
    }

    // Try to derive callbackHost from the current request or connection URI
    if (!resolvedCallbackHost) {
      const { request, connection } = agentContext.getStore() || {};
      if (request) {
        const requestUrl = new URL(request.url);
        resolvedCallbackHost = `${requestUrl.protocol}//${requestUrl.host}`;
      } else if (connection?.uri) {
        const connectionUrl = new URL(connection.uri);
        resolvedCallbackHost = `${connectionUrl.protocol}//${connectionUrl.host}`;
      }
    }

    // Build the callback URL if we have a host (needed for OAuth, optional for non-OAuth servers)
    let callbackUrl: string | undefined;
    if (resolvedCallbackHost) {
      const normalizedHost = resolvedCallbackHost.replace(/\/$/, "");
      callbackUrl = resolvedCallbackPath
        ? `${normalizedHost}/${resolvedCallbackPath.replace(/^\//, "")}`
        : `${normalizedHost}/${resolvedAgentsPrefix}/${camelCaseToKebabCase(this._host.agentClassName())}/${this._host.agentInstanceName()}/callback`;
    }

    const id = requestedId ?? nanoid(8);

    // Only create authProvider if we have a callbackUrl (needed for OAuth servers)
    let authProvider: AgentMcpOAuthProvider | undefined;
    if (callbackUrl) {
      authProvider = this._host.createOAuthProvider(callbackUrl);
      authProvider.serverId = id;
    }

    // Use the transport type specified in options, or default to "auto"
    const transportType: TransportType =
      resolvedOptions?.transport?.type ?? "auto";

    // allows passing through transport headers if necessary
    // this handles some non-standard bearer auth setups (i.e. MCP server behind CF access instead of OAuth)
    let headerTransportOpts: SSEClientTransportOptions = {};
    if (resolvedOptions?.transport?.headers) {
      headerTransportOpts = {
        eventSourceInit: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: resolvedOptions?.transport?.headers
            })
        },
        requestInit: {
          headers: resolvedOptions?.transport?.headers
        }
      };
    }

    // Register server (also saves to storage)
    await this._host.mcp.registerServer(id, {
      url: normalizedUrl!,
      name: serverName,
      callbackUrl,
      client: resolvedOptions?.client,
      transport: {
        ...headerTransportOpts,
        authProvider,
        type: transportType
      },
      retry: resolvedOptions?.retry
    });

    const result = await this._host.mcp.connectToServer(id);

    if (result.state === MCPConnectionState.FAILED) {
      // Server stays in storage so user can retry via connectToServer(id)
      throw new Error(
        `Failed to connect to MCP server at ${normalizedUrl}: ${result.error}`
      );
    }

    if (result.state === MCPConnectionState.AUTHENTICATING) {
      if (!callbackUrl) {
        throw new Error(
          "This MCP server requires OAuth authentication. " +
            "Provide callbackHost in addMcpServer options to enable the OAuth flow."
        );
      }
      return { id, state: result.state, authUrl: result.authUrl };
    }

    // State is CONNECTED - discover capabilities
    const discoverResult = await this._host.mcp.discoverIfConnected(id);

    if (discoverResult && !discoverResult.success) {
      // Server stays in storage - connection is still valid, user can retry discovery
      throw new Error(
        `Failed to discover MCP server capabilities: ${discoverResult.error}`
      );
    }

    return { id, state: MCPConnectionState.READY };
  }

  /** Remove a registered MCP server (and its connection/storage rows). */
  async remove(id: string): Promise<void> {
    await this._host.mcp.removeServer(id);
  }

  /** Snapshot the registered servers + discovered capabilities for clients. */
  getServers(): MCPServersState {
    const mcpState: MCPServersState = {
      prompts: this._host.mcp.listPrompts(),
      resources: this._host.mcp.listResources(),
      servers: {},
      tools: this._host.mcp.listTools()
    };

    const servers = this._host.mcp.listServers();

    if (servers && Array.isArray(servers) && servers.length > 0) {
      for (const server of servers) {
        const serverConn = this._host.mcp.mcpConnections[server.id];

        // Determine the default state when no connection exists
        let defaultState: "authenticating" | "not-connected" = "not-connected";
        if (!serverConn && server.auth_url) {
          // If there's an auth_url but no connection, it's waiting for OAuth
          defaultState = "authenticating";
        }

        mcpState.servers[server.id] = {
          auth_url: server.auth_url,
          capabilities: serverConn?.serverCapabilities ?? null,
          error: sanitizeErrorString(serverConn?.connectionError ?? null),
          instructions: serverConn?.instructions ?? null,
          name: server.name,
          server_url: server.server_url,
          state: serverConn?.connectionState ?? defaultState
        };
      }
    }

    return mcpState;
  }

  /** Broadcast the current MCP server state to protocol connections. */
  broadcast(): void {
    this._host.broadcastProtocol(
      JSON.stringify({
        mcp: this.getServers(),
        type: MessageType.CF_AGENT_MCP_SERVERS
      })
    );
  }

  /** Re-connect RPC (Durable Object binding) servers after hibernation. */
  async restoreRpcServers(): Promise<void> {
    const rpcServers = this._host.mcp.getRpcServersFromStorage();
    for (const server of rpcServers) {
      if (this._host.mcp.mcpConnections[server.id]) {
        continue;
      }

      const opts: { bindingName: string; props?: Record<string, unknown> } =
        server.server_options ? JSON.parse(server.server_options) : {};

      const namespace = this._host.env()[opts.bindingName] as
        | DurableObjectNamespace<McpAgent>
        | undefined;
      if (!namespace) {
        console.warn(
          `[Agent] Cannot restore RPC MCP server "${server.name}": binding "${opts.bindingName}" not found in env`
        );
        continue;
      }

      const normalizedName = server.server_url.replace(RPC_DO_PREFIX, "");

      try {
        await this._host.mcp.connect(`${RPC_DO_PREFIX}${normalizedName}`, {
          reconnect: { id: server.id },
          transport: {
            type: "rpc" as TransportType,
            namespace,
            name: normalizedName,
            props: opts.props
          }
        });

        const conn = this._host.mcp.mcpConnections[server.id];
        if (conn && conn.connectionState === MCPConnectionState.CONNECTED) {
          await this._host.mcp.discoverIfConnected(server.id);
        }
      } catch (error) {
        console.error(
          `[Agent] Error restoring RPC MCP server "${server.name}":`,
          error
        );
      }
    }
  }

  /**
   * Handle MCP OAuth callback request if it's an OAuth callback.
   *
   * This method encapsulates the entire OAuth callback flow:
   * 1. Checks if the request is an MCP OAuth callback
   * 2. Processes the OAuth code exchange
   * 3. Establishes the connection if successful
   * 4. Broadcasts MCP server state updates
   * 5. Returns the appropriate HTTP response
   *
   * @param request The incoming HTTP request
   * @returns Response if this was an OAuth callback, null otherwise
   */
  async handleOAuthCallback(request: Request): Promise<Response | null> {
    // Check if this is an OAuth callback request
    const isCallback = this._host.mcp.isCallbackRequest(request);
    if (!isCallback) {
      return null;
    }

    // Handle the OAuth callback (exchanges code for token, clears OAuth credentials from storage)
    // This fires onServerStateChanged event which triggers broadcast
    const result = await this._host.mcp.handleCallbackRequest(request);

    // If auth was successful, establish the connection in the background
    // (establishConnection handles retries internally using per-server retry config)
    if (result.authSuccess) {
      this._host.mcp.establishConnection(result.serverId).catch((error) => {
        console.error(
          "[Agent handleMcpOAuthCallback] Connection establishment failed:",
          error
        );
      });
    }

    this.broadcast();

    // Return the HTTP response for the OAuth callback
    return this._oauthCallbackResponse(result, request);
  }

  /**
   * Handle OAuth callback response using MCPClientManager configuration
   * @param result OAuth callback result
   * @param request The original request (needed for base URL)
   * @returns Response for the OAuth callback
   */
  private _oauthCallbackResponse(
    result: MCPClientOAuthResult,
    request: Request
  ): Response {
    const config = this._host.mcp.getOAuthCallbackConfig();

    // Use custom handler if configured
    if (config?.customHandler) {
      return config.customHandler(result);
    }

    const baseOrigin = new URL(request.url).origin;

    // Redirect to success URL if configured
    if (config?.successRedirect && result.authSuccess) {
      try {
        return Response.redirect(
          new URL(config.successRedirect, baseOrigin).href
        );
      } catch (e) {
        console.error(
          "Invalid successRedirect URL:",
          config.successRedirect,
          e
        );
        return Response.redirect(baseOrigin);
      }
    }

    // Redirect to error URL if configured
    if (config?.errorRedirect && !result.authSuccess) {
      try {
        const errorUrl = `${config.errorRedirect}?error=${encodeURIComponent(
          result.authError || "Unknown error"
        )}`;
        return Response.redirect(new URL(errorUrl, baseOrigin).href);
      } catch (e) {
        console.error("Invalid errorRedirect URL:", config.errorRedirect, e);
        return Response.redirect(baseOrigin);
      }
    }

    return Response.redirect(baseOrigin);
  }

  /** Reverse-lookup the env binding name for a DO namespace object. */
  private _findBindingNameForNamespace(
    namespace: DurableObjectNamespace<McpAgent>
  ): string | undefined {
    for (const [key, value] of Object.entries(this._host.env())) {
      if (value === namespace) {
        return key;
      }
    }
    return undefined;
  }
}
