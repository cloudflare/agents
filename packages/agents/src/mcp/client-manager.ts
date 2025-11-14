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
import { DurableObjectOAuthClientProvider } from "./do-oauth-client-provider";

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

/**
 * Options for registering an MCP server
 */
export type RegisterServerOptions = {
  url: string;
  name: string;
  callbackUrl: string;
  client?: ConstructorParameters<typeof Client>[1];
  transport?: MCPTransportOptions;
  authUrl?: string;
  clientId?: string;
};

/**
 * Options for connecting to an MCP server
 */
export type ConnectServerOptions = {
  oauthCode?: string;
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
   * Get the storage adapter instance
   * @internal
   */
  get storage(): MCPStorageAdapter {
    return this._storage;
  }

  /**
   * Create an auth provider for a server
   * @internal
   */
  private createAuthProvider(
    serverId: string,
    callbackUrl: string,
    clientName: string,
    clientId?: string
  ): AgentsOAuthProvider {
    const authProvider = new DurableObjectOAuthClientProvider(
      this._storage,
      clientName,
      callbackUrl
    );
    authProvider.serverId = serverId;
    if (clientId) {
      authProvider.clientId = clientId;
    }
    return authProvider;
  }

  /**
   * Restore MCP server connections from storage
   * This method is called on Agent initialization to restore previously connected servers
   *
   * @param clientName Name to use for OAuth client (typically the agent instance name)
   */
  async restoreConnectionsFromStorage(clientName: string): Promise<void> {
    const servers = this._storage.listServers();

    if (!servers || servers.length === 0) {
      return;
    }

    for (const server of servers) {
      const existingConn = this.mcpConnections[server.id];

      // Skip if connection already exists and is in a good state
      if (existingConn) {
        if (existingConn.connectionState === "ready") {
          console.warn(
            `[MCPClientManager] Server ${server.id} already has a ready connection. Skipping recreation.`
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

      const needsOAuth = !!server.auth_url;
      const parsedOptions: MCPServerOptions | null = server.server_options
        ? JSON.parse(server.server_options)
        : null;

      const authProvider = this.createAuthProvider(
        server.id,
        server.callback_url,
        clientName,
        server.client_id ?? undefined
      );

      this.registerServer(server.id, {
        url: server.server_url,
        name: server.name,
        callbackUrl: server.callback_url,
        client: parsedOptions?.client ?? {},
        transport: {
          ...(parsedOptions?.transport ?? {}),
          type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
          authProvider
        },
        authUrl: server.auth_url ?? undefined,
        clientId: server.client_id ?? undefined
      });

      if (needsOAuth) {
        // OAuth server - just set state to authenticating (wait for OAuth flow)
        if (this.mcpConnections[server.id]) {
          this.mcpConnections[server.id].connectionState = "authenticating";
        }
      } else {
        // Non-OAuth server - connect immediately
        await this.connectToServer(server.id).catch((error) => {
          console.error(`Error restoring ${server.id}:`, error);
        });
      }
    }
  }

  /**
   * Register an MCP server connection without connecting
   * Creates the connection object, sets up observability, and saves to storage
   *
   * @param id Server ID
   * @param options Registration options including URL, name, callback URL, and connection config
   * @returns Server ID
   */
  registerServer(id: string, options: RegisterServerOptions): string {
    // Skip if connection already exists
    if (this.mcpConnections[id]) {
      return id;
    }

    const normalizedTransport = {
      ...options.transport,
      type: options.transport?.type ?? ("auto" as TransportType)
    };

    this.mcpConnections[id] = new MCPClientConnection(
      new URL(options.url),
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
    const store = new DisposableStore();
    const existing = this._connectionDisposables.get(id);
    if (existing) existing.dispose();
    this._connectionDisposables.set(id, store);
    store.add(
      this.mcpConnections[id].onObservabilityEvent((event) => {
        this._onObservabilityEvent.fire(event);
      })
    );

    // Save to storage
    this._storage.saveServer({
      id,
      name: options.name,
      server_url: options.url,
      callback_url: options.callbackUrl,
      client_id: options.clientId ?? null,
      auth_url: options.authUrl ?? null,
      server_options: JSON.stringify({
        client: options.client,
        transport: options.transport
      })
    });

    return id;
  }

  /**
   * Connect to an already registered MCP server
   * Updates storage with auth URL and client ID after connection
   *
   * @param id Server ID
   * @param options Connection options (e.g., OAuth code for completing OAuth flow)
   * @returns Auth URL if OAuth is required, undefined otherwise
   */
  async connectToServer(
    id: string,
    options?: ConnectServerOptions
  ): Promise<{
    authUrl?: string;
    clientId?: string;
  }> {
    const conn = this.mcpConnections[id];
    if (!conn) {
      throw new Error(
        `Server ${id} is not registered. Call registerServer() first.`
      );
    }

    // Handle OAuth completion if we have a code
    if (options?.oauthCode) {
      try {
        await conn.completeAuthorization(options.oauthCode);
        await conn.establishConnection();
      } catch (error) {
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          displayMessage: `Failed to complete OAuth reconnection for ${id}`,
          payload: {
            url: conn.url.toString(),
            transport: conn.options.transport.type ?? "auto",
            state: conn.connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now(),
          id
        });
        throw error;
      }
      return {};
    }

    // Initialize connection
    await conn.init();

    // If connection is in authenticating state, return auth URL for OAuth flow
    const authUrl = conn.options.transport.authProvider?.authUrl;

    if (
      conn.connectionState === "authenticating" &&
      authUrl &&
      conn.options.transport.authProvider?.redirectUrl
    ) {
      const clientId = conn.options.transport.authProvider?.clientId;

      // Update storage with auth URL and client ID
      const serverRow = this._storage.listServers().find((s) => s.id === id);
      if (serverRow) {
        this._storage.saveServer({
          ...serverRow,
          auth_url: authUrl,
          client_id: clientId ?? null
        });
      }

      return {
        authUrl,
        clientId
      };
    }

    // Fire connected event for non-OAuth connections that reached ready state
    if (conn.connectionState === "ready") {
      this._onConnected.fire(id);
    }

    return {};
  }

  /**
   * Refresh the in-memory callback URL cache from storage
   */
  private async _refreshCallbackUrlCache(): Promise<void> {
    const servers = this._storage.listServers();
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
    const servers = this._storage.listServers();

    console.log(servers);
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
      this._storage.clearOAuthCredentials(serverId);
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
   * Check if all MCP connections are in a stable state (ready or authenticating)
   * Useful to call before getAITools() to avoid race conditions
   *
   * @returns Object with ready status and list of connections not ready
   */
  areConnectionsReady(): { ready: boolean; pendingConnections: string[] } {
    const pendingConnections: string[] = [];

    for (const [id, conn] of Object.entries(this.mcpConnections)) {
      if (
        conn.connectionState !== "ready" &&
        conn.connectionState !== "authenticating"
      ) {
        pendingConnections.push(id);
      }
    }

    return {
      ready: pendingConnections.length === 0,
      pendingConnections
    };
  }

  /**
   * @returns a set of tools that you can use with the AI SDK
   */
  getAITools(): ToolSet {
    if (!this.jsonSchema) {
      throw new Error("jsonSchema not initialized.");
    }

    // Warn if tools are being read from non-ready connections
    for (const [id, conn] of Object.entries(this.mcpConnections)) {
      if (
        conn.connectionState !== "ready" &&
        conn.connectionState !== "authenticating"
      ) {
        console.warn(
          `[getAITools] WARNING: Reading tools from connection ${id} in state "${conn.connectionState}". Tools may not be loaded yet.`
        );
      }
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
