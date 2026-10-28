import type {
  CacheableRequestOptions,
  CallToolRequest,
  CallToolRequestOptions,
  Client,
  GetPromptRequest,
  ReadResourceRequest,
  RequestOptions
} from "@modelcontextprotocol/client";
import { Emitter, type Event } from "../../core/events";
import { LifecycleCapability } from "../../lifecycle/capability";
import type { CapabilityRequestContext } from "../../lifecycle/capability-runner";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome
} from "../../lifecycle/job-queue";
import type { MCPObservabilityEvent } from "../../observability/mcp";
import { RPC_DO_PREFIX } from "../rpc";
import { MCPAIToolConverter, type MCPAIToolSet } from "./ai-tools";
import { AuthorizationController } from "./authorization";
import {
  filterConnections,
  getNamespacedData,
  type NamespacedData
} from "./catalog";
import type { MCPClientConnection } from "./connection";
import type { McpClientContext } from "./context";
import { ElicitationHandlers } from "./elicitation";
import {
  callV2Tool,
  type CallToolSchemaOrOptions,
  type LegacyCallToolResultSchema
} from "./invoker";
import {
  AUTH_EXPIRY_JOB,
  CONNECT_JOB,
  makeReconnectPolicy,
  McpJobs,
  parseAuthExpiryJobPayload,
  parseConnectJobPayload
} from "./jobs";
import { legacyConnect, type LegacyConnectOptions } from "./legacy-connect";
import {
  type MCPClientOAuthCallbackConfig,
  oauthCallbackResponse
} from "./oauth-callback";
import { McpServerStore } from "./server-store";
import { ServerLaneCancelledError, ServerLanes } from "./server-lanes";
import { ServerController } from "./servers";
import { ServerStatus } from "./status";
import {
  encodeMcpServerOptions,
  ensureMcpServerTable,
  type MCPServerRow
} from "./storage";
import type {
  MCPClientElicitationHandlers,
  MCPClientManagerOptions,
  MCPConnectionResult,
  MCPDiscoverResult,
  MCPOAuthCallbackResult,
  MCPServerFilter,
  MCPServerSettlement,
  RegisterServerOptions
} from "./types";

const MCP_SCHEMA_VERSION_KEY = "cf_agents:mcp_schema_version";
const CURRENT_MCP_SCHEMA_VERSION = 1;

/**
 * A Durable Object capability that persists and aggregates MCP client
 * connections. Install it on any Lifecycle, or use `agent.mcp` on an Agent.
 *
 * The manager is the public API and the Lifecycle hooks. Behind it:
 * - {@link ServerController}: each server's connection life, and what
 *   happens after a failure
 * - {@link AuthorizationController}: authorization links, OAuth callbacks
 *   and re-authorization during requests
 * - {@link McpJobs}: the durable reconnect and link-expiry jobs
 */
export class MCPClientManager extends LifecycleCapability {
  public mcpConnections: Record<string, MCPClientConnection> = {};

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

  private readonly _lanes = new ServerLanes();
  private _isRestored = false;
  #store: McpServerStore | undefined;
  private readonly aiTools = new MCPAIToolConverter();
  private didWarnAboutUnstableGetAITools = false;

  private readonly ctx: McpClientContext;
  private readonly jobs: McpJobs;
  private readonly status: ServerStatus;
  private readonly elicitation: ElicitationHandlers;
  private readonly authorization: AuthorizationController;
  private readonly servers: ServerController;

  /**
   * Construct a reusable Durable Object MCP client capability.
   *
   * @param name - MCP client implementation name sent during negotiation.
   * @param version - MCP client implementation version sent during negotiation.
   * @param options - Optional runtime bindings and OAuth configuration.
   */
  constructor(
    private readonly _name: string,
    version: string,
    options: MCPClientManagerOptions = {}
  ) {
    super("mcp");
    const manager = this;
    const ctx: McpClientContext = {
      name: _name,
      version,
      get connections() {
        return manager.mcpConnections;
      },
      get store() {
        manager.#store ??= new McpServerStore(manager.lifecycle.storage);
        return manager.#store;
      },
      get storage() {
        return manager.lifecycle.storage;
      },
      lanes: this._lanes,
      env: options.env,
      createAuthProvider: options.createAuthProvider,
      observability: this._onObservabilityEvent,
      // Outside any lane, so a listener that starts connection work queues
      // it instead of running it inside the work that changed the state.
      stateChanged: () =>
        this._lanes.outside(() => this._onServerStateChanged.fire())
    };
    this.jobs = new McpJobs(
      () => this.lifecycle.jobs,
      makeReconnectPolicy(options.reconnect)
    );
    this.status = new ServerStatus(ctx, this.jobs);
    this.elicitation = new ElicitationHandlers(ctx);
    this.authorization = new AuthorizationController(
      ctx,
      this.jobs,
      this.status
    );
    this.servers = new ServerController(
      ctx,
      this.jobs,
      this.status,
      this.authorization,
      this.elicitation,
      {
        connectToServer: (id) => this.connectToServer(id),
        discoverIfConnected: (...args) => this.discoverIfConnected(...args)
      }
    );
    this.ctx = ctx;
  }

  // Lifecycle hooks

  /** Restore persisted HTTP and RPC connections before the host handles work. */
  async onStart(): Promise<void> {
    const schemaVersion =
      (await this.lifecycle.storage.get<number>(MCP_SCHEMA_VERSION_KEY)) ?? 0;
    if (schemaVersion < CURRENT_MCP_SCHEMA_VERSION) {
      ensureMcpServerTable(this.lifecycle.storage);
      await this.lifecycle.storage.put(
        MCP_SCHEMA_VERSION_KEY,
        CURRENT_MCP_SCHEMA_VERSION
      );
    }
    await this.restoreConnectionsFromStorage(this._name);
    this.servers.restoreRpc();
    this.ctx.stateChanged();
  }

  /** Intercept a registered MCP OAuth callback request. */
  async onRequest(
    context: CapabilityRequestContext
  ): Promise<Response | undefined> {
    const { request } = context;
    if (!this.isCallbackRequest(request)) return undefined;

    const result = await this.handleCallbackRequest(request);
    if (result.authSuccess) {
      void this.establishConnection(result.serverId).catch((error) => {
        if (error instanceof ServerLaneCancelledError) return;
        console.error(
          "[MCPClientManager] Connection establishment after OAuth failed:",
          error
        );
      });
    }
    return oauthCallbackResponse(
      result,
      request,
      this.getOAuthCallbackConfig()
    );
  }

  /** Run one of this manager's durable jobs: a reconnect or a link expiry. */
  async onJob(
    context: LifecycleJobContext
  ): Promise<LifecycleJobOutcome | void> {
    const { job } = context;
    switch (job.fn) {
      case CONNECT_JOB: {
        const payload = parseConnectJobPayload(job.payload);
        if (payload && !this.jobs.isRescheduled(job)) {
          await this.servers.runReconnect(payload.serverId);
        }
        return;
      }
      case AUTH_EXPIRY_JOB: {
        const payload = parseAuthExpiryJobPayload(job.payload);
        if (!payload) return;
        const rescheduleAt = await this.authorization.runLinkExpiry(payload);
        return rescheduleAt ? { rescheduleAt } : undefined;
      }
      default:
        console.warn(
          `[MCPClientManager] Dropping job ${job.id} with unknown fn "${job.fn}"`
        );
    }
  }

  // Servers

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
    this.servers.register(id, options);
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
    return this.servers.connect(id);
  }

  /**
   * Discover server capabilities if connection is in CONNECTED or READY state.
   * Transitions to DISCOVERING then READY (or CONNECTED on error).
   * Can be called to refresh server capabilities (e.g., from a UI refresh button).
   *
   * Runs after any connection work already queued for the same server, so a
   * call made during another discovery waits for it and then refreshes again.
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
    return this.servers.discover(serverId, options);
  }

  /**
   * Establish connection in the background after OAuth completion.
   * This method connects to the server and discovers its capabilities.
   * The connection is automatically tracked so that `waitForConnections()`
   * will include it.
   * @param serverId The server ID to establish connection for
   */
  async establishConnection(serverId: string): Promise<void> {
    return this.servers.establish(serverId);
  }

  /**
   * @internal Connect a registered server and discover its capabilities, as
   * one unit of lane work. A failure schedules a durable reconnect.
   */
  connectAndDiscover(id: string): Promise<MCPServerSettlement> {
    return this.servers.connectAndDiscover(id);
  }

  /**
   * @internal Bring an already-registered server to a settled state once the
   * work queued for it has run, for `addMcpServer()`. Reconnects a server
   * that is not connected, except one only a person can fix.
   */
  settleServer(id: string): Promise<MCPServerSettlement> {
    return this.servers.settle(id);
  }

  /**
   * @internal Try a server again because someone asked: forget a recorded
   * failure and the step-up budget, drop pending jobs, and connect now.
   */
  reconnectServer(id: string): Promise<MCPServerSettlement> {
    return this.servers.reconnect(id);
  }

  /**
   * Restore persisted HTTP MCP connections. Runs once per wake.
   *
   * @param clientName - Durable Object identity used to scope OAuth state.
   */
  async restoreConnectionsFromStorage(clientName: string): Promise<void> {
    if (this._isRestored) return;
    await this.servers.restore(clientName);
    this._isRestored = true;
  }

  /**
   * Wait for all in-flight connection and discovery operations to settle.
   * This is useful when you need MCP tools to be available before proceeding,
   * e.g. before calling getAITools() after the agent wakes from hibernation.
   *
   * Returns once every pending connection has either connected and discovered,
   * failed, or timed out. Never rejects.
   *
   * @param options.timeout - Maximum time in milliseconds to wait.
   *   `0` returns immediately without waiting.
   *   `undefined` (default) waits indefinitely.
   */
  async waitForConnections(options?: { timeout?: number }): Promise<void> {
    const pending = this._lanes.pending();
    if (pending.length === 0) return;
    if (options?.timeout != null && options.timeout <= 0) return;
    const settled = Promise.allSettled(pending);
    if (options?.timeout == null) {
      await settled;
      return;
    }
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<void>((resolve) => {
      timerId = setTimeout(resolve, options.timeout);
    });
    await Promise.race([settled, timer]);
    clearTimeout(timerId);
  }

  /**
   * Rename a server's id, in-place, across every place the id is used as a
   * key: its row, its connection, its provider, its OAuth storage keys under
   * `/{clientName}/{oldId}/...`, and its pending jobs. Used to migrate a
   * server registered under an auto-generated id to a caller-supplied
   * stable id (see `Agent.addMcpServer`'s `{ id }` option).
   *
   * A no-op when `oldId === newId`. Throws when a row already exists under
   * `newId`; the caller is expected to have verified uniqueness.
   *
   * @internal Exposed for `Agent.addMcpServer` JIT-migration.
   */
  async migrateServerId(
    oldId: string,
    newId: string,
    clientName: string
  ): Promise<void> {
    return this.servers.migrate(oldId, newId, clientName);
  }

  /**
   * Closes a connection to an MCP server
   * @param id The id of the connection to close
   */
  async closeConnection(id: string): Promise<void> {
    return this.servers.close(id);
  }

  /**
   * Closes every in-memory connection. Servers stay stored, and their
   * callback URLs still match incoming OAuth requests; use removeServer()
   * to delete a server.
   */
  async closeAllConnections(): Promise<void> {
    return this.servers.closeAll();
  }

  /**
   * Remove an MCP server - closes connection if active and removes from storage.
   */
  async removeServer(serverId: string): Promise<void> {
    return this.servers.remove(serverId);
  }

  /**
   * List all MCP servers from storage
   */
  listServers(): MCPServerRow[] {
    return this.ctx.store.list();
  }

  /** Get saved RPC servers from storage (servers with `rpc://` URLs). */
  getRpcServersFromStorage(): MCPServerRow[] {
    return this.ctx.store.listRpc();
  }

  /**
   * Save an RPC server to storage for hibernation recovery.
   * The binding name is stored so this manager can resolve the namespace from
   * its runtime environment during restore.
   */
  saveRpcServerToStorage(
    id: string,
    name: string,
    normalizedName: string,
    bindingName: string,
    props?: Record<string, unknown>
  ): void {
    this.ctx.store.save({
      id,
      name,
      server_url: `${RPC_DO_PREFIX}${normalizedName}`,
      client_id: null,
      auth_url: null,
      callback_url: "",
      server_options: encodeMcpServerOptions({
        bindingName,
        props,
        capabilities: this.elicitation.capabilities()
      })
    });
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
    options: LegacyConnectOptions = {}
  ): Promise<{ id: string; authUrl?: string; clientId?: string }> {
    return legacyConnect(this.ctx, this.servers, this, url, options);
  }

  // OAuth

  /** Whether a request is an OAuth callback for one of this manager's servers. */
  isCallbackRequest(req: Request): boolean {
    return this.authorization.isCallback(req);
  }

  /**
   * Complete the OAuth flow a callback request belongs to: verify its state,
   * exchange its code, and leave the connection ready to reconnect. A
   * callback for a flow that was already accepted is consumed as a stale
   * success; one whose state cannot be verified changes nothing.
   */
  async handleCallbackRequest(req: Request): Promise<MCPOAuthCallbackResult> {
    return this.authorization.handleCallback(req);
  }

  /**
   * Configure OAuth callback handling
   * @param config OAuth callback configuration
   */
  configureOAuthCallback(config: MCPClientOAuthCallbackConfig): void {
    this.authorization.configureCallback(config);
  }

  /**
   * Get the current OAuth callback configuration
   * @returns The current OAuth callback configuration
   */
  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this.authorization.getCallbackConfig();
  }

  /**
   * Configure handling for server-initiated `elicitation/create` requests.
   *
   * The handler is held in memory only and applied to every MCP connection
   * created or restored by this manager. Call this before registering
   * connections when you want the initial MCP handshake to advertise
   * handler-driven form- and url-mode elicitation. Existing active connections
   * keep their negotiated capabilities until they reconnect.
   *
   * The advertised modes are persisted with each stored server, so
   * connections restored after hibernation re-advertise them at the handshake
   * even when this is called later in the wake-up (e.g. from onStart) — the
   * handlers attach to the live connections as soon as this runs.
   *
   * Pass undefined to clear the handler.
   *
   * @param handlers Elicitation handlers keyed by mode, each scoped with the server id that sent the request
   */
  configureElicitationHandlers(handlers?: MCPClientElicitationHandlers): void {
    this.elicitation.configure(handlers);
  }

  // Catalog and requests

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of tools
   */
  listTools(filter?: MCPServerFilter): NamespacedData["tools"] {
    return getNamespacedData(this.connectionsFor(filter), "tools");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of prompts
   */
  listPrompts(filter?: MCPServerFilter): NamespacedData["prompts"] {
    return getNamespacedData(this.connectionsFor(filter), "prompts");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resources
   */
  listResources(filter?: MCPServerFilter): NamespacedData["resources"] {
    return getNamespacedData(this.connectionsFor(filter), "resources");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resource templates
   */
  listResourceTemplates(
    filter?: MCPServerFilter
  ): NamespacedData["resourceTemplates"] {
    return getNamespacedData(this.connectionsFor(filter), "resourceTemplates");
  }

  /**
   * Convert connected MCP tools for the AI SDK. Converted schemas are reused
   * while a live connection retains the same catalog array and schema-source
   * identities; tool records and execute closures are rebuilt on every call.
   *
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  getAITools(filter?: MCPServerFilter): MCPAIToolSet {
    return this.aiTools.convert(this.connectionsFor(filter), (params) =>
      this.callTool(params)
    );
  }

  /**
   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  unstable_getAITools(filter?: MCPServerFilter): MCPAIToolSet {
    if (!this.didWarnAboutUnstableGetAITools) {
      this.didWarnAboutUnstableGetAITools = true;
      console.warn(
        "unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version."
      );
    }
    return this.getAITools(filter);
  }

  /**
   * Namespaced version of callTool
   */
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    options?: CallToolRequestOptions
  ): ReturnType<Client["callTool"]>;
  /**
   * @deprecated Prefer the v2 request-options overload. Explicit legacy result
   * schemas remain honored through the v2 SDK request funnel.
   */
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    resultSchema: LegacyCallToolResultSchema,
    options?: CallToolRequestOptions
  ): ReturnType<Client["callTool"]>;
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    schemaOrOptions?: CallToolSchemaOrOptions,
    options?: CallToolRequestOptions
  ): ReturnType<Client["callTool"]> {
    const { serverId, ...mcpParams } = params;
    const name = mcpParams.name.replace(`${serverId}.`, "");
    return this.authorization.recoverRequest(serverId, (conn) =>
      callV2Tool(conn.client, { ...mcpParams, name }, schemaOrOptions, options)
    );
  }

  /**
   * Namespaced version of readResource
   */
  readResource(
    params: ReadResourceRequest["params"] & { serverId: string },
    options?: CacheableRequestOptions
  ) {
    const { serverId, ...mcpParams } = params;
    return this.authorization.recoverRequest(serverId, (conn) =>
      conn.client.readResource(mcpParams, options)
    );
  }

  /**
   * Namespaced version of getPrompt
   */
  getPrompt(
    params: GetPromptRequest["params"] & { serverId: string },
    options?: RequestOptions
  ) {
    const { serverId, ...mcpParams } = params;
    return this.authorization.recoverRequest(serverId, (conn) =>
      conn.client.getPrompt(mcpParams, options)
    );
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      await this.closeAllConnections();
    } finally {
      this._onServerStateChanged.dispose();
      this._onObservabilityEvent.dispose();
    }
  }

  private connectionsFor(
    filter: MCPServerFilter | undefined
  ): Record<string, MCPClientConnection> {
    return filterConnections(
      this.mcpConnections,
      () => this.ctx.store.list(),
      filter
    );
  }
}
