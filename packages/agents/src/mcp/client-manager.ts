import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  GetPromptRequest,
  Prompt,
  ReadResourceRequest,
  Resource,
  ResourceTemplate,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import { nanoid } from "nanoid";
import { Emitter, type Event, DisposableStore } from "../core/events";
import type { MCPObservabilityEvent } from "../observability/mcp";
import {
  MCPClientConnection,
  type MCPTransportOptions
} from "./client-connection";
import { toErrorMessage } from "./errors";
import type { TransportType } from "./types";
import type { MCPStorageAdapter, MCPServerRow } from "./client-storage";
import type { AgentsOAuthProvider } from "./do-oauth-client-provider";

/**
 * Options that can be stored in the server_options column
 * This is what gets JSON.stringify'd and stored in the database
 */
export type MCPServerOptions = {
  client?: ConstructorParameters<typeof Client>[1];
  transport?: {
    headers?: HeadersInit;
    type?: TransportType;
  };
};

export type MCPClientOAuthCallbackConfig = {
  successRedirect?: string;
  errorRedirect?: string;
  customHandler?: (result: MCPClientOAuthResult) => Response;
};

export type MCPClientOAuthResult = {
  serverId: string;
  authSuccess: boolean;
  authError?: string;
};

export type MCPClientManagerOptions = {
  storage: MCPStorageAdapter;
};

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  private _didWarnAboutUnstableGetAITools = false;
  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;
  private _connectionDisposables = new Map<string, DisposableStore>();
  private _storage: MCPStorageAdapter;

  // In-memory cache of callback URLs to avoid DB queries on every request
  private _callbackUrlCache: Set<string> | null = null;

  private readonly _onObservabilityEvent = new Emitter<MCPObservabilityEvent>();
  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
    this._onObservabilityEvent.event;

  private readonly _onConnected = new Emitter<string>();
  public readonly onConnected: Event<string> = this._onConnected.event;

  /**
   * @param _name Name of the MCP client
   * @param _version Version of the MCP Client
   * @param options Storage adapter for persisting MCP server state
   */
  constructor(
    private _name: string,
    private _version: string,
    options: MCPClientManagerOptions
  ) {
    this._storage = options.storage;

    // Create the storage instance
    this._storage.create();
  }

  jsonSchema: typeof import("ai").jsonSchema | undefined;

  /**
   * Restore MCP server connections from storage
   * This method is called on Agent initialization to restore previously connected servers
   *
   * @param createAuthProvider Factory function to create OAuth provider instances
   * @param reconnectServer Function to reconnect to a server (for non-OAuth servers)
   */
  async restoreConnectionsFromStorage(
    createAuthProvider: (
      serverId: string,
      callbackUrl: string,
      clientId?: string
    ) => AgentsOAuthProvider,
    reconnectServer: (
      serverId: string,
      serverName: string,
      serverUrl: string,
      callbackUrl: string,
      clientId: string | null,
      serverOptions: MCPServerOptions | null
    ) => Promise<void>
  ): Promise<void> {
    const servers = await Promise.resolve(this._storage.listServers());

    if (!servers || servers.length === 0) {
      return;
    }

    for (const server of servers) {
      const needsOAuth = !!server.auth_url;

      if (needsOAuth) {
        const existingConn = this.mcpConnections[server.id];

        // Skip if connection already exists and is in a good state
        if (existingConn) {
          if (existingConn.connectionState === "ready") {
            // Connection already ready, skip recreation. This means auth_url wasn't properly cleared.
            console.warn(
              `[MCPClientManager] Server ${server.id} already has a ready connection but auth_url still exists in DB. Skipping recreation.`
            );
            continue;
          }

          // Don't interrupt in-flight OAuth or connections
          if (
            existingConn.connectionState === "authenticating" ||
            existingConn.connectionState === "connecting" ||
            existingConn.connectionState === "discovering"
          ) {
            // Let the existing flow complete
            continue;
          }

          // If failed, we'll recreate below
        }

        const authProvider = createAuthProvider(
          server.id,
          server.callback_url,
          server.client_id ?? undefined
        );

        const parsedOptions: MCPServerOptions | null = server.server_options
          ? JSON.parse(server.server_options)
          : null;

        const conn = new MCPClientConnection(
          new URL(server.server_url),
          {
            name: this._name,
            version: this._version
          },
          {
            client: parsedOptions?.client ?? {},
            transport: {
              ...(parsedOptions?.transport ?? {}),
              type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
              authProvider
            }
          }
        );

        conn.connectionState = "authenticating";

        // Set up observability
        const store = new DisposableStore();
        const existing = this._connectionDisposables.get(server.id);
        if (existing) existing.dispose();
        this._connectionDisposables.set(server.id, store);
        store.add(
          conn.onObservabilityEvent((event) => {
            this._onObservabilityEvent.fire(event);
          })
        );

        this.mcpConnections[server.id] = conn;
      } else {
        // Non-OAuth server
        const existingConn = this.mcpConnections[server.id];

        // Skip if connection already exists and is working or in-flight
        if (existingConn) {
          if (
            existingConn.connectionState === "ready" ||
            existingConn.connectionState === "connecting" ||
            existingConn.connectionState === "discovering"
          ) {
            // Connection already established or in progress
            continue;
          }
          // If failed, we'll recreate below
        }

        const parsedOptions: MCPServerOptions | null = server.server_options
          ? JSON.parse(server.server_options)
          : null;

        reconnectServer(
          server.id,
          server.name,
          server.server_url,
          server.callback_url,
          server.client_id,
          parsedOptions
        ).catch((error) => {
          console.error(`Error restoring ${server.id}:`, error);
        });
      }
    }
  }

  /**
   * Connect to and register an MCP server
   *
   * @param transportConfig Transport config
   * @param clientConfig Client config
   * @param capabilities Client capabilities (i.e. if the client supports roots/sampling)
   */
  async connect(
    url: string,
    options: {
      // Allows you to reconnect to a server (in the case of an auth reconnect)
      reconnect?: {
        // server id
        id: string;
        oauthClientId?: string;
        oauthCode?: string;
      };
      // we're overriding authProvider here because we want to be able to access the auth URL
      transport?: MCPTransportOptions;
      client?: ConstructorParameters<typeof Client>[1];
    } = {}
  ): Promise<{
    id: string;
    authUrl?: string;
    clientId?: string;
  }> {
    /* Late initialization of jsonSchemaFn */
    /**
     * We need to delay loading ai sdk, because putting it in module scope is
     * causing issues with startup time.
     * The only place it's used is in getAITools, which only matters after
     * .connect() is called on at least one server.
     * So it's safe to delay loading it until .connect() is called.
     */
    await this.ensureJsonSchema();

    const id = options.reconnect?.id ?? nanoid(8);

    if (options.transport?.authProvider) {
      options.transport.authProvider.serverId = id;
      // reconnect with auth
      if (options.reconnect?.oauthClientId) {
        options.transport.authProvider.clientId =
          options.reconnect?.oauthClientId;
      }
    }

    // During OAuth reconnect, reuse existing connection to preserve state
    if (!options.reconnect?.oauthCode || !this.mcpConnections[id]) {
      const normalizedTransport = {
        ...options.transport,
        type: options.transport?.type ?? ("auto" as TransportType)
      };

      this.mcpConnections[id] = new MCPClientConnection(
        new URL(url),
        {
          name: this._name,
          version: this._version
        },
        {
          client: options.client ?? {},
          transport: normalizedTransport
        }
      );

      // Pipe connection-level observability events to the manager-level emitter
      // and track the subscription for cleanup.
      const store = new DisposableStore();
      // If we somehow already had disposables for this id, clear them first
      const existing = this._connectionDisposables.get(id);
      if (existing) existing.dispose();
      this._connectionDisposables.set(id, store);
      store.add(
        this.mcpConnections[id].onObservabilityEvent((event) => {
          this._onObservabilityEvent.fire(event);
        })
      );
    }

    // Initialize connection first
    await this.mcpConnections[id].init();

    // Handle OAuth completion if we have a reconnect code
    if (options.reconnect?.oauthCode) {
      try {
        await this.mcpConnections[id].completeAuthorization(
          options.reconnect.oauthCode
        );
        await this.mcpConnections[id].establishConnection();
      } catch (error) {
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          displayMessage: `Failed to complete OAuth reconnection for ${id} for ${url}`,
          payload: {
            url: url,
            transport: options.transport?.type ?? "auto",
            state: this.mcpConnections[id].connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now(),
          id
        });
        // Re-throw to signal failure to the caller
        throw error;
      }
    }

    // If connection is in authenticating state, return auth URL for OAuth flow
    const authUrl = options.transport?.authProvider?.authUrl;
    if (
      this.mcpConnections[id].connectionState === "authenticating" &&
      authUrl &&
      options.transport?.authProvider?.redirectUrl
    ) {
      return {
        authUrl,
        clientId: options.transport?.authProvider?.clientId,
        id
      };
    }

    return {
      id
    };
  }

  /**
   * Refresh the in-memory callback URL cache from storage
   */
  private async _refreshCallbackUrlCache(): Promise<void> {
    const servers = await Promise.resolve(this._storage.listServers());
    this._callbackUrlCache = new Set(
      servers.filter((s) => s.callback_url).map((s) => s.callback_url)
    );
  }

  /**
   * Invalidate the callback URL cache so it will be refreshed on next check
   */
  private _invalidateCallbackUrlCache(): void {
    this._callbackUrlCache = null;
  }

  async isCallbackRequest(req: Request): Promise<boolean> {
    if (req.method !== "GET") {
      return false;
    }

    // Quick heuristic check: most callback URLs contain "/callback"
    // This avoids DB queries for obviously non-callback requests
    if (!req.url.includes("/callback")) {
      return false;
    }

    // Lazily populate cache on first check
    if (this._callbackUrlCache === null) {
      await this._refreshCallbackUrlCache();
    }

    // Check cache first for quick lookup
    for (const callbackUrl of this._callbackUrlCache!) {
      if (req.url.startsWith(callbackUrl)) {
        return true;
      }
    }

    return false;
  }

  async handleCallbackRequest(req: Request) {
    const url = new URL(req.url);

    // Find the matching server from database
    const servers = await Promise.resolve(this._storage.listServers());
    const matchingServer = servers.find((server: MCPServerRow) => {
      return server.callback_url && req.url.startsWith(server.callback_url);
    });

    if (!matchingServer) {
      throw new Error(
        `No callback URI match found for the request url: ${req.url}. Was the request matched with \`isCallbackRequest()\`?`
      );
    }

    const serverId = matchingServer.id;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    // Handle OAuth error responses from the provider
    if (error) {
      return {
        serverId,
        authSuccess: false,
        authError: errorDescription || error
      };
    }

    if (!code) {
      throw new Error("Unauthorized: no code provided");
    }
    if (!state) {
      throw new Error("Unauthorized: no state provided");
    }

    if (this.mcpConnections[serverId] === undefined) {
      throw new Error(`Could not find serverId: ${serverId}`);
    }

    // If connection is already ready, this is likely a duplicate callback
    if (this.mcpConnections[serverId].connectionState === "ready") {
      // Already authenticated and ready, treat as success
      return {
        serverId,
        authSuccess: true
      };
    }

    if (this.mcpConnections[serverId].connectionState !== "authenticating") {
      throw new Error(
        `Failed to authenticate: the client is in "${this.mcpConnections[serverId].connectionState}" state, expected "authenticating"`
      );
    }

    const conn = this.mcpConnections[serverId];
    if (!conn.options.transport.authProvider) {
      throw new Error(
        "Trying to finalize authentication for a server connection without an authProvider"
      );
    }

    // Get clientId from auth provider (stored during redirectToAuthorization) or fallback to state for backward compatibility
    const clientId = conn.options.transport.authProvider.clientId || state;

    // Set the OAuth credentials
    conn.options.transport.authProvider.clientId = clientId;
    conn.options.transport.authProvider.serverId = serverId;

    try {
      await conn.completeAuthorization(code);

      // Clear both callback_url and auth_url in a single DB operation to prevent malicious second callbacks
      await Promise.resolve(this._storage.clearOAuthCredentials(serverId));

      // Invalidate cache since callback URLs changed
      this._invalidateCallbackUrlCache();

      return {
        serverId,
        authSuccess: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        serverId,
        authSuccess: false,
        authError: errorMessage
      };
    }
  }

  /**
   * Establish connection in the background after OAuth completion
   * This method is called asynchronously and doesn't block the OAuth callback response
   * @param serverId The server ID to establish connection for
   */
  async establishConnection(serverId: string): Promise<void> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:preconnect",
        displayMessage: `Connection not found for serverId: ${serverId}`,
        payload: { serverId },
        timestamp: Date.now(),
        id: nanoid()
      });
      return;
    }

    try {
      await conn.establishConnection();
      this._onConnected.fire(serverId);
    } catch (error) {
      const url = conn.url.toString();
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        displayMessage: `Failed to establish connection to server ${serverId} with url ${url}`,
        payload: {
          url,
          transport: conn.options.transport.type ?? "auto",
          state: conn.connectionState,
          error: toErrorMessage(error)
        },
        timestamp: Date.now(),
        id: nanoid()
      });
    }
  }

  /**
   * Configure OAuth callback handling
   * @param config OAuth callback configuration
   */
  configureOAuthCallback(config: MCPClientOAuthCallbackConfig): void {
    this._oauthCallbackConfig = config;
  }

  /**
   * Get the current OAuth callback configuration
   * @returns The current OAuth callback configuration
   */
  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this._oauthCallbackConfig;
  }

  /**
   * @returns namespaced list of tools
   */
  listTools(): NamespacedData["tools"] {
    return getNamespacedData(this.mcpConnections, "tools");
  }

  async ensureJsonSchema() {
    if (!this.jsonSchema) {
      const { jsonSchema } = await import("ai");
      this.jsonSchema = jsonSchema;
    }
  }

  /**
   * @returns a set of tools that you can use with the AI SDK
   */
  getAITools(): ToolSet {
    if (!this.jsonSchema) {
      throw new Error("jsonSchema not initialized.");
    }
    return Object.fromEntries(
      getNamespacedData(this.mcpConnections, "tools").map((tool) => {
        return [
          `tool_${tool.serverId.replace(/-/g, "")}_${tool.name}`,
          {
            description: tool.description,
            execute: async (args) => {
              const result = await this.callTool({
                arguments: args,
                name: tool.name,
                serverId: tool.serverId
              });
              if (result.isError) {
                // @ts-expect-error TODO we should fix this
                throw new Error(result.content[0].text);
              }
              return result;
            },
            inputSchema: this.jsonSchema!(tool.inputSchema as JSONSchema7),
            outputSchema: tool.outputSchema
              ? this.jsonSchema!(tool.outputSchema as JSONSchema7)
              : undefined
          }
        ];
      })
    );
  }

  /**
   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version
   * @returns a set of tools that you can use with the AI SDK
   */
  unstable_getAITools(): ToolSet {
    if (!this._didWarnAboutUnstableGetAITools) {
      this._didWarnAboutUnstableGetAITools = true;
      console.warn(
        "unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version."
      );
    }
    return this.getAITools();
  }

  /**
   * Closes all connections to MCP servers
   */
  async closeAllConnections() {
    const ids = Object.keys(this.mcpConnections);
    await Promise.all(
      ids.map(async (id) => {
        await this.mcpConnections[id].client.close();
      })
    );
    // Dispose all per-connection subscriptions
    for (const id of ids) {
      const store = this._connectionDisposables.get(id);
      if (store) store.dispose();
      this._connectionDisposables.delete(id);
      delete this.mcpConnections[id];
    }
  }

  /**
   * Closes a connection to an MCP server
   * @param id The id of the connection to close
   */
  async closeConnection(id: string) {
    if (!this.mcpConnections[id]) {
      throw new Error(`Connection with id "${id}" does not exist.`);
    }
    await this.mcpConnections[id].client.close();
    delete this.mcpConnections[id];

    const store = this._connectionDisposables.get(id);
    if (store) store.dispose();
    this._connectionDisposables.delete(id);
  }

  /**
   * Save an MCP server configuration to storage
   */
  saveServer(server: {
    id: string;
    name: string;
    server_url: string;
    client_id?: string | null;
    auth_url?: string | null;
    callback_url: string;
    server_options?: string | null;
  }): void {
    if (this._storage) {
      this._storage.saveServer({
        id: server.id,
        name: server.name,
        server_url: server.server_url,
        client_id: server.client_id ?? null,
        auth_url: server.auth_url ?? null,
        callback_url: server.callback_url,
        server_options: server.server_options ?? null
      });
      // Invalidate cache since callback URLs may have changed
      this._invalidateCallbackUrlCache();
    }
  }

  /**
   * Remove an MCP server from storage
   */
  removeServer(serverId: string): void {
    if (this._storage) {
      this._storage.removeServer(serverId);
      // Invalidate cache since callback URLs may have changed
      this._invalidateCallbackUrlCache();
    }
  }

  /**
   * List all MCP servers from storage
   */
  listServers() {
    if (this._storage) {
      return this._storage.listServers();
    }
    return [];
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      await this.closeAllConnections();
    } finally {
      // Dispose manager-level emitters
      this._onConnected.dispose();
      this._onObservabilityEvent.dispose();

      // Drop the storage table
      this._storage.destroy();
    }
  }

  /**
   * @returns namespaced list of prompts
   */
  listPrompts(): NamespacedData["prompts"] {
    return getNamespacedData(this.mcpConnections, "prompts");
  }

  /**
   * @returns namespaced list of tools
   */
  listResources(): NamespacedData["resources"] {
    return getNamespacedData(this.mcpConnections, "resources");
  }

  /**
   * @returns namespaced list of resource templates
   */
  listResourceTemplates(): NamespacedData["resourceTemplates"] {
    return getNamespacedData(this.mcpConnections, "resourceTemplates");
  }

  /**
   * Namespaced version of callTool
   */
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ) {
    const unqualifiedName = params.name.replace(`${params.serverId}.`, "");
    return this.mcpConnections[params.serverId].client.callTool(
      {
        ...params,
        name: unqualifiedName
      },
      resultSchema,
      options
    );
  }

  /**
   * Namespaced version of readResource
   */
  readResource(
    params: ReadResourceRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.readResource(
      params,
      options
    );
  }

  /**
   * Namespaced version of getPrompt
   */
  getPrompt(
    params: GetPromptRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.getPrompt(
      params,
      options
    );
  }
}

type NamespacedData = {
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
  resourceTemplates: (ResourceTemplate & { serverId: string })[];
};

export function getNamespacedData<T extends keyof NamespacedData>(
  mcpClients: Record<string, MCPClientConnection>,
  type: T
): NamespacedData[T] {
  const sets = Object.entries(mcpClients).map(([name, conn]) => {
    return { data: conn[type], name };
  });

  const namespacedData = sets.flatMap(({ name: serverId, data }) => {
    return data.map((item) => {
      return {
        ...item,
        // we add a serverId so we can easily pull it out and send the tool call to the right server
        serverId
      };
    });
  });

  return namespacedData as NamespacedData[T]; // Type assertion needed due to TS limitations with conditional return types
}
