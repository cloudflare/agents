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
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { type RetryOptions, tryN } from "../retries";
import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import { nanoid } from "nanoid";
import { Emitter, type Event, DisposableStore } from "../core/events";
import type { MCPObservabilityEvent } from "../observability/mcp";
import {
  MCPClientConnection,
  MCPConnectionState,
  type MCPTransportOptions
} from "./client-connection";
import { toErrorMessage } from "./errors";
import type { TransportType } from "./types";
import type { MCPServerRow } from "./client-storage";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import { DurableObjectOAuthClientProvider } from "./do-oauth-client-provider";

const defaultClientOptions: ConstructorParameters<typeof Client>[1] = {
  jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
};

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
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Result of an OAuth callback request
 */
export type MCPOAuthCallbackResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | { serverId?: string; authSuccess: false; authError: string };

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
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Result of attempting to connect to an MCP server.
 * Discriminated union ensures error is present only on failure.
 */
export type MCPConnectionResult =
  | {
      state: typeof MCPConnectionState.FAILED;
      error: string;
    }
  | {
      state: typeof MCPConnectionState.AUTHENTICATING;
      authUrl: string;
      clientId?: string;
    }
  | {
      state: typeof MCPConnectionState.CONNECTED;
    };

/**
 * Result of discovering server capabilities.
 * success indicates whether discovery completed successfully.
 * state is the current connection state at time of return.
 * error is present when success is false.
 */
export type MCPDiscoverResult = {
  success: boolean;
  state: MCPConnectionState;
  error?: string;
};

export type MCPClientOAuthCallbackConfig = {
  successRedirect?: string;
  errorRedirect?: string;
  customHandler?: (result: MCPClientOAuthResult) => Response;
};

export type MCPClientOAuthResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | {
      serverId?: string;
      authSuccess: false;
      /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
      authError: string;
    };

export type MCPClientManagerOptions = {
  storage: DurableObjectStorage;
};

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  private _didWarnAboutUnstableGetAITools = false;
  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;
  private _connectionDisposables = new Map<string, DisposableStore>();
  private _storage: DurableObjectStorage;
  private _isRestored = false;

  /** @internal Protected for testing purposes. */
  protected readonly _onObservabilityEvent =
    new Emitter<MCPObservabilityEvent>();
  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
    this._onObservabilityEvent.event;

  private readonly _onServerStateChanged = new Emitter<void>();
  /**
   * Event that fires whenever any MCP server state changes (registered, connected, removed, etc.)
   * This is useful for broadcasting server state to clients.
   */
  public readonly onServerStateChanged: Event<void> =
    this._onServerStateChanged.event;

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
    if (!options.storage) {
      throw new Error(
        "MCPClientManager requires a valid DurableObjectStorage instance"
      );
    }
    this._storage = options.storage;
  }

  // SQL helper - runs a query and returns results as array
  private sql<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return [...this._storage.sql.exec<T>(query, ...bindings)];
  }

  // Storage operations
  private saveServerToStorage(server: MCPServerRow): void {
    this.sql(
      `INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      server.id,
      server.name,
      server.server_url,
      server.client_id ?? null,
      server.auth_url ?? null,
      server.callback_url,
      server.server_options ?? null
    );
  }

  private removeServerFromStorage(serverId: string): void {
    this.sql("DELETE FROM cf_agents_mcp_servers WHERE id = ?", serverId);
  }

  private getServersFromStorage(): MCPServerRow[] {
    return this.sql<MCPServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers"
    );
  }

  /**
   * Get the retry options for a server from stored server_options
   */
  private getServerRetryOptions(serverId: string): RetryOptions | undefined {
    const rows = this.sql<MCPServerRow>(
      "SELECT server_options FROM cf_agents_mcp_servers WHERE id = ?",
      serverId
    );
    if (!rows.length || !rows[0].server_options) return undefined;
    const parsed: MCPServerOptions = JSON.parse(rows[0].server_options);
    return parsed.retry;
  }

  private clearServerAuthUrl(serverId: string): void {
    this.sql(
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?",
      serverId
    );
  }

  private failConnection(
    serverId: string,
    error: string
  ): MCPOAuthCallbackResult {
    this.clearServerAuthUrl(serverId);
    if (this.mcpConnections[serverId]) {
      this.mcpConnections[serverId].connectionState = MCPConnectionState.FAILED;
      this.mcpConnections[serverId].connectionError = error;
    }
    this._onServerStateChanged.fire();
    return { serverId, authSuccess: false, authError: error };
  }

  jsonSchema: typeof import("ai").jsonSchema | undefined;

  /**
   * Create an auth provider for a server
   * @internal
   */
  private createAuthProvider(
    serverId: string,
    callbackUrl: string,
    clientName: string,
    clientId?: string
  ): AgentMcpOAuthProvider {
    if (!this._storage) {
      throw new Error(
        "Cannot create auth provider: storage is not initialized"
      );
    }
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
    if (this._isRestored) {
      return;
    }

    const servers = this.getServersFromStorage();

    if (!servers || servers.length === 0) {
      this._isRestored = true;
      return;
    }

    for (const server of servers) {
      const existingConn = this.mcpConnections[server.id];

      // Skip if connection already exists and is in a good state
      if (existingConn) {
        if (existingConn.connectionState === MCPConnectionState.READY) {
          console.warn(
            `[MCPClientManager] Server ${server.id} already has a ready connection. Skipping recreation.`
          );
          continue;
        }

        // Don't interrupt in-flight OAuth or connections
        if (
          existingConn.connectionState === MCPConnectionState.AUTHENTICATING ||
          existingConn.connectionState === MCPConnectionState.CONNECTING ||
          existingConn.connectionState === MCPConnectionState.DISCOVERING
        ) {
          // Let the existing flow complete
          continue;
        }

        // If failed, clean up the old connection before recreating
        if (existingConn.connectionState === MCPConnectionState.FAILED) {
          try {
            await existingConn.client.close();
          } catch (error) {
            console.warn(
              `[MCPClientManager] Error closing failed connection ${server.id}:`,
              error
            );
          }
          delete this.mcpConnections[server.id];
          this._connectionDisposables.get(server.id)?.dispose();
          this._connectionDisposables.delete(server.id);
        }
      }

      const parsedOptions: MCPServerOptions | null = server.server_options
        ? JSON.parse(server.server_options)
        : null;

      const authProvider = this.createAuthProvider(
        server.id,
        server.callback_url,
        clientName,
        server.client_id ?? undefined
      );

      // Create the in-memory connection object (no need to save to storage - we just read from it!)
      const conn = this.createConnection(server.id, server.server_url, {
        client: parsedOptions?.client ?? {},
        transport: {
          ...(parsedOptions?.transport ?? {}),
          type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
          authProvider
        }
      });

      // If auth_url exists, OAuth flow is in progress - set state and wait for callback
      if (server.auth_url) {
        conn.connectionState = MCPConnectionState.AUTHENTICATING;
        continue;
      }

      // Start connection in background (don't await) to avoid blocking the DO
      this._restoreServer(server.id, parsedOptions?.retry);
    }

    this._isRestored = true;
  }

  /**
   * Internal method to restore a single server connection and discovery
   */
  private async _restoreServer(
    serverId: string,
    retry?: RetryOptions
  ): Promise<void> {
    // Always try to connect - the connection logic will determine if OAuth is needed
    // If stored OAuth tokens are valid, connection will succeed automatically
    // If tokens are missing/invalid, connection will fail with Unauthorized
    // and state will be set to "authenticating"
    const maxAttempts = retry?.maxAttempts ?? 3;
    const baseDelayMs = retry?.baseDelayMs ?? 500;
    const maxDelayMs = retry?.maxDelayMs ?? 5000;

    const connectResult = await tryN(
      maxAttempts,
      async () => this.connectToServer(serverId),
      { baseDelayMs, maxDelayMs }
    ).catch((error) => {
      console.error(
        `Error connecting to ${serverId} after ${maxAttempts} attempts:`,
        error
      );
      return null;
    });

    if (connectResult?.state === MCPConnectionState.CONNECTED) {
      const discoverResult = await this.discoverIfConnected(serverId);
      if (discoverResult && !discoverResult.success) {
        console.error(`Error discovering ${serverId}:`, discoverResult.error);
      }
    }
  }

  /**
   * Connect to and register an MCP server
   *
   * @deprecated This method is maintained for backward compatibility.
   * For new code, use registerServer() and connectToServer() separately.
   *
   * @param url Server URL
   * @param options Connection options
   * @returns Object with server ID, auth URL (if OAuth), and client ID (if OAuth)
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

    // Initialize connection first. this will try connect
    await this.mcpConnections[id].init();

    // Handle OAuth completion if we have a reconnect code
    if (options.reconnect?.oauthCode) {
      try {
        await this.mcpConnections[id].completeAuthorization(
          options.reconnect.oauthCode
        );

        // Reinitialize connection
        await this.mcpConnections[id].init();
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
      this.mcpConnections[id].connectionState ===
        MCPConnectionState.AUTHENTICATING &&
      authUrl &&
      options.transport?.authProvider?.redirectUrl
    ) {
      return {
        authUrl,
        clientId: options.transport?.authProvider?.clientId,
        id
      };
    }

    // If connection is connected, discover capabilities
    const discoverResult = await this.discoverIfConnected(id);
    if (discoverResult && !discoverResult.success) {
      throw new Error(
        `Failed to discover server capabilities: ${discoverResult.error}`
      );
    }

    return {
      id
    };
  }

  /**
   * Create an in-memory connection object and set up observability
   * Does NOT save to storage - use registerServer() for that
   * @returns The connection object (existing or newly created)
   */
  private createConnection(
    id: string,
    url: string,
    options: {
      client?: ConstructorParameters<typeof Client>[1];
      transport: MCPTransportOptions;
    }
  ): MCPClientConnection {
    // Return existing connection if already exists
    if (this.mcpConnections[id]) {
      return this.mcpConnections[id];
    }

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
        client: { ...defaultClientOptions, ...options.client },
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

    return this.mcpConnections[id];
  }

  /**
   * Register an MCP server connection without connecting
   * Creates the connection object, sets up observability, and saves to storage
   *
   * @param id Server ID
   * @param options Registration options including URL, name, callback URL, and connection config
   * @returns Server ID
   */
  async registerServer(
    id: string,
    options: RegisterServerOptions
  ): Promise<string> {
    // Create the in-memory connection
    this.createConnection(id, options.url, {
      client: options.client,
      transport: {
        ...options.transport,
        type: options.transport?.type ?? ("auto" as TransportType)
      }
    });

    // Save to storage (exclude authProvider since it's recreated during restore)
    const { authProvider: _, ...transportWithoutAuth } =
      options.transport ?? {};
    this.saveServerToStorage({
      id,
      name: options.name,
      server_url: options.url,
      callback_url: options.callbackUrl,
      client_id: options.clientId ?? null,
      auth_url: options.authUrl ?? null,
      server_options: JSON.stringify({
        client: options.client,
        transport: transportWithoutAuth,
        retry: options.retry
      })
    });

    this._onServerStateChanged.fire();

    return id;
  }

  /**
   * Connect to an already registered MCP server and initialize the connection.
   *
   * For OAuth servers, returns `{ state: "authenticating", authUrl, clientId? }`.
   * The user must complete the OAuth flow via the authUrl, which triggers a
   * callback handled by `handleCallbackRequest()`.
   *
   * For non-OAuth servers, establishes the transport connection and returns
   * `{ state: "connected" }`. Call `discoverIfConnected()` afterwards to
   * discover capabilities and transition to "ready" state.
   *
   * @param id Server ID (must be registered first via registerServer())
   * @returns Connection result with current state and OAuth info (if applicable)
   */
  async connectToServer(id: string): Promise<MCPConnectionResult> {
    const conn = this.mcpConnections[id];
    if (!conn) {
      throw new Error(
        `Server ${id} is not registered. Call registerServer() first.`
      );
    }

    const error = await conn.init();
    this._onServerStateChanged.fire();

    switch (conn.connectionState) {
      case MCPConnectionState.FAILED:
        return {
          state: conn.connectionState,
          error: error ?? "Unknown connection error"
        };

      case MCPConnectionState.AUTHENTICATING: {
        const authUrl = conn.options.transport.authProvider?.authUrl;
        const redirectUrl = conn.options.transport.authProvider?.redirectUrl;

        if (!authUrl || !redirectUrl) {
          return {
            state: MCPConnectionState.FAILED,
            error: `OAuth configuration incomplete: missing ${!authUrl ? "authUrl" : "redirectUrl"}`
          };
        }

        const clientId = conn.options.transport.authProvider?.clientId;

        // Update storage with auth URL and client ID
        const servers = this.getServersFromStorage();
        const serverRow = servers.find((s) => s.id === id);
        if (serverRow) {
          this.saveServerToStorage({
            ...serverRow,
            auth_url: authUrl,
            client_id: clientId ?? null
          });
          // Broadcast again so clients receive the auth_url
          this._onServerStateChanged.fire();
        }

        return {
          state: conn.connectionState,
          authUrl,
          clientId
        };
      }

      case MCPConnectionState.CONNECTED:
        return { state: conn.connectionState };

      default:
        return {
          state: MCPConnectionState.FAILED,
          error: `Unexpected connection state after init: ${conn.connectionState}`
        };
    }
  }

  private extractServerIdFromState(state: string | null): string | null {
    if (!state) return null;
    const parts = state.split(".");
    return parts.length === 2 ? parts[1] : null;
  }

  isCallbackRequest(req: Request): boolean {
    if (req.method !== "GET") {
      return false;
    }

    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const serverId = this.extractServerIdFromState(state);
    if (!serverId) {
      return false;
    }

    // Match by server ID AND verify the request origin + pathname matches the registered callback URL.
    // This prevents unrelated GET requests with a `state` param from being intercepted.
    const servers = this.getServersFromStorage();
    return servers.some((server) => {
      if (server.id !== serverId) return false;
      try {
        const storedUrl = new URL(server.callback_url);
        return (
          storedUrl.origin === url.origin && storedUrl.pathname === url.pathname
        );
      } catch {
        return false;
      }
    });
  }

  private validateCallbackRequest(
    req: Request
  ):
    | { valid: true; serverId: string; code: string; state: string }
    | { valid: false; serverId?: string; error: string } {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    // Early validation - return errors because we can't identify the connection
    if (!state) {
      return {
        valid: false,
        error: "Unauthorized: no state provided"
      };
    }

    const serverId = this.extractServerIdFromState(state);
    if (!serverId) {
      return {
        valid: false,
        error:
          "No serverId found in state parameter. Expected format: {nonce}.{serverId}"
      };
    }

    if (error) {
      return {
        serverId: serverId,
        valid: false,
        error: errorDescription || error
      };
    }

    if (!code) {
      return {
        serverId: serverId,
        valid: false,
        error: "Unauthorized: no code provided"
      };
    }

    const servers = this.getServersFromStorage();
    const serverExists = servers.some((server) => server.id === serverId);
    if (!serverExists) {
      return {
        serverId: serverId,
        valid: false,
        error: `No server found with id "${serverId}". Was the request matched with \`isCallbackRequest()\`?`
      };
    }

    if (this.mcpConnections[serverId] === undefined) {
      return {
        serverId: serverId,
        valid: false,
        error: `No connection found for serverId "${serverId}".`
      };
    }

    return {
      valid: true,
      serverId,
      code: code,
      state: state
    };
  }

  async handleCallbackRequest(req: Request): Promise<MCPOAuthCallbackResult> {
    const validation = this.validateCallbackRequest(req);

    if (!validation.valid) {
      if (validation.serverId && this.mcpConnections[validation.serverId]) {
        return this.failConnection(validation.serverId, validation.error);
      }

      return {
        serverId: validation.serverId,
        authSuccess: false,
        authError: validation.error
      };
    }

    const { serverId, code, state } = validation;
    const conn = this.mcpConnections[serverId]; // We have a valid connection - all errors from here should fail the connection

    try {
      if (!conn.options.transport.authProvider) {
        throw new Error(
          "Trying to finalize authentication for a server connection without an authProvider"
        );
      }

      const authProvider = conn.options.transport.authProvider;
      authProvider.serverId = serverId;

      // Two-phase state validation: check first (non-destructive), consume later
      // This prevents DoS attacks where attacker consumes valid state before legitimate callback
      const stateValidation = await authProvider.checkState(state);
      if (!stateValidation.valid) {
        throw new Error(stateValidation.error || "Invalid state");
      }

      // Already authenticated - just return success
      if (
        conn.connectionState === MCPConnectionState.READY ||
        conn.connectionState === MCPConnectionState.CONNECTED
      ) {
        this.clearServerAuthUrl(serverId);
        return { serverId, authSuccess: true };
      }

      if (conn.connectionState !== MCPConnectionState.AUTHENTICATING) {
        throw new Error(
          `Failed to authenticate: the client is in "${conn.connectionState}" state, expected "authenticating"`
        );
      }

      await authProvider.consumeState(state);
      await conn.completeAuthorization(code);
      await authProvider.deleteCodeVerifier();
      this.clearServerAuthUrl(serverId);
      conn.connectionError = null;
      this._onServerStateChanged.fire();

      return { serverId, authSuccess: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failConnection(serverId, message);
    }
  }

  /**
   * Discover server capabilities if connection is in CONNECTED or READY state.
   * Transitions to DISCOVERING then READY (or CONNECTED on error).
   * Can be called to refresh server capabilities (e.g., from a UI refresh button).
   *
   * If called while a previous discovery is in-flight for the same server,
   * the previous discovery will be aborted.
   *
   * @param serverId The server ID to discover
   * @param options Optional configuration
   * @param options.timeoutMs Timeout in milliseconds (default: 30000)
   * @returns Result with current state and optional error, or undefined if connection not found
   */
  async discoverIfConnected(
    serverId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MCPDiscoverResult | undefined> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        displayMessage: `Connection not found for ${serverId}`,
        payload: {},
        timestamp: Date.now(),
        id: nanoid()
      });
      return undefined;
    }

    // Delegate to connection's discover method which handles cancellation and timeout
    const result = await conn.discover(options);
    this._onServerStateChanged.fire();

    return {
      ...result,
      state: conn.connectionState
    };
  }

  /**
   * Establish connection in the background after OAuth completion
   * This method connects to the server and discovers its capabilities
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

    // Skip if already discovering or ready - prevents duplicate work
    if (
      conn.connectionState === MCPConnectionState.DISCOVERING ||
      conn.connectionState === MCPConnectionState.READY
    ) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        displayMessage: `establishConnection skipped for ${serverId}, already in ${conn.connectionState} state`,
        payload: {
          url: conn.url.toString(),
          transport: conn.options.transport.type || "unknown",
          state: conn.connectionState
        },
        timestamp: Date.now(),
        id: nanoid()
      });
      return;
    }

    const retry = this.getServerRetryOptions(serverId);
    const maxAttempts = retry?.maxAttempts ?? 3;
    const baseDelayMs = retry?.baseDelayMs ?? 500;
    const maxDelayMs = retry?.maxDelayMs ?? 5000;

    const connectResult = await tryN(
      maxAttempts,
      async () => this.connectToServer(serverId),
      { baseDelayMs, maxDelayMs }
    );
    this._onServerStateChanged.fire();

    if (connectResult.state === MCPConnectionState.CONNECTED) {
      await this.discoverIfConnected(serverId);
    }

    this._onObservabilityEvent.fire({
      type: "mcp:client:connect",
      displayMessage: `establishConnection completed for ${serverId}, final state: ${conn.connectionState}`,
      payload: {
        url: conn.url.toString(),
        transport: conn.options.transport.type || "unknown",
        state: conn.connectionState
      },
      timestamp: Date.now(),
      id: nanoid()
    });
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

  /**
   * Lazy-loads the jsonSchema function from the AI SDK.
   *
   * This defers importing the "ai" package until it's actually needed, which helps reduce
   * initial bundle size and startup time. The jsonSchema function is required for converting
   * MCP tools into AI SDK tool definitions via getAITools().
   *
   * @internal This method is for internal use only. It's automatically called before operations
   * that need jsonSchema (like getAITools() or OAuth flows). External consumers should not need
   * to call this directly.
   */
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

    // Warn if tools are being read from non-ready connections
    for (const [id, conn] of Object.entries(this.mcpConnections)) {
      if (
        conn.connectionState !== MCPConnectionState.READY &&
        conn.connectionState !== MCPConnectionState.AUTHENTICATING
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
                const content = result.content as
                  | Array<{ type: string; text?: string }>
                  | undefined;
                const textContent = content?.[0];
                const message =
                  textContent?.type === "text" && textContent.text
                    ? textContent.text
                    : "Tool call failed";
                throw new Error(message);
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
   * Closes all active in-memory connections to MCP servers.
   *
   * Note: This only closes the transport connections - it does NOT remove
   * servers from storage. Servers will still be listed and their callback
   * URLs will still match incoming OAuth requests.
   *
   * Use removeServer() instead if you want to fully clean up a server
   * (closes connection AND removes from storage).
   */
  async closeAllConnections() {
    const ids = Object.keys(this.mcpConnections);

    // Cancel all in-flight discoveries
    for (const id of ids) {
      this.mcpConnections[id].cancelDiscovery();
    }

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

    // Cancel any in-flight discovery
    this.mcpConnections[id].cancelDiscovery();

    await this.mcpConnections[id].client.close();
    delete this.mcpConnections[id];

    const store = this._connectionDisposables.get(id);
    if (store) store.dispose();
    this._connectionDisposables.delete(id);
  }

  /**
   * Remove an MCP server - closes connection if active and removes from storage.
   */
  async removeServer(serverId: string): Promise<void> {
    if (this.mcpConnections[serverId]) {
      try {
        await this.closeConnection(serverId);
      } catch (_e) {
        // Ignore errors when closing
      }
    }
    this.removeServerFromStorage(serverId);
    this._onServerStateChanged.fire();
  }

  /**
   * List all MCP servers from storage
   */
  listServers(): MCPServerRow[] {
    return this.getServersFromStorage();
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      await this.closeAllConnections();
    } finally {
      // Dispose manager-level emitters
      this._onServerStateChanged.dispose();
      this._onObservabilityEvent.dispose();
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
