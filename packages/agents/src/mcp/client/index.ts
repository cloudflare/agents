import type {
  CallToolRequest,
  CallToolRequestOptions,
  CacheableRequestOptions,
  Client,
  ClientCapabilities,
  DiscoverResult,
  ElicitRequest,
  ElicitResult,
  GetPromptRequest,
  Prompt,
  ReadResourceRequest,
  RequestOptions,
  Resource,
  ResourceTemplateType as ResourceTemplate,
  Tool
} from "@modelcontextprotocol/client";
export type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
export {
  RPC_DO_PREFIX,
  RPCClientTransport,
  type McpRpcAgent,
  type RPCClientTransportOptions
} from "../rpc";
export type {
  MCPElicitationHandler,
  MCPElicitationHandlers
} from "./connection";
export type { McpClientOptions } from "../types";
export {
  MCPAuthorizationRequiredError,
  MCPConnectionNotFoundError
} from "./errors";
import { type RetryOptions, tryN } from "../../retries";
import { nanoid } from "nanoid";
import { Emitter, type Event, DisposableStore } from "../../core/events";
import type { MCPObservabilityEvent } from "../../observability/mcp";
import {
  elicitationCapabilitiesFromHandlers,
  MCPClientConnection,
  MCPConnectionState,
  type MCPDiscoveryResult,
  type MCPElicitationHandlers,
  type MCPTransportOptions
} from "./connection";
import {
  callV2Tool,
  type CallToolSchemaOrOptions,
  type LegacyCallToolResultSchema
} from "./invoker";
import {
  isUnauthorized,
  MCPAuthorizationRequiredError,
  MCPConnectionNotFoundError,
  toErrorMessage
} from "./errors";
import { resolveRpcTransport } from "./rpc";
import { RPC_DO_PREFIX } from "../rpc";
import type { McpClientOptions, TransportType } from "../types";
import {
  decodeMcpServerOptions,
  encodeMcpServerOptions,
  ensureMcpServerTable,
  type MCPServerRow,
  type PersistedMcpServerOptions
} from "./storage";
import { MCPAIToolConverter, type MCPAIToolSet } from "./ai-tools";
export type { MCPAITool, MCPAIToolSet } from "./ai-tools";
import { isBlockedUrl } from "./url-policy";
import { McpServerStore } from "./server-store";
import { ServerLaneCancelledError, ServerLanes } from "./server-lanes";
import {
  authorizationExhaustedMessage,
  completeRound,
  parseAuthorizationRounds,
  requestedScope,
  startRound
} from "./authorization-rounds";
import type { StoredServerFailure } from "./server-store";
import {
  AUTH_EXPIRY_JOB,
  AUTHORIZATION_EXPIRED_MESSAGE,
  AUTHORIZATION_LINK_TTL_MS,
  authExpiryJobId,
  CONNECT_JOB,
  connectJobId,
  makeReconnectPolicy,
  nextReconnect,
  parseAuthExpiryJobPayload,
  parseConnectJobPayload,
  type AuthExpiryJobPayload,
  type ConnectJobPayload,
  type MCPReconnectOptions,
  type ReconnectPolicy
} from "./reconnect-policy";
export type { MCPReconnectOptions } from "./reconnect-policy";
import {
  consumeStaleState,
  exchangeAuthorizationCode,
  isOAuthCallbackFor,
  isRedeemableState,
  oauthCallbackResponse,
  parseOAuthCallback,
  redeemableAuthUrl,
  serverIdFromState,
  type MCPClientOAuthCallbackConfig
} from "./oauth-callback";
export type {
  MCPClientOAuthCallbackConfig,
  MCPClientOAuthResult
} from "./oauth-callback";
export { MCP_SERVER_ID_MAX_LENGTH, normalizeServerId } from "./url-policy";
import { LifecycleCapability } from "../../lifecycle/capability";
import type { CapabilityRequestContext } from "../../lifecycle/capability-runner";
import type {
  LifecycleJob,
  LifecycleJobContext,
  LifecycleJobOutcome,
  LifecycleJobPushOptions
} from "../../lifecycle/job-queue";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import { DurableObjectOAuthClientProvider } from "./do-oauth-client-provider";

export type MCPServerOptions = PersistedMcpServerOptions;

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
  callbackUrl?: string;
  client?: McpClientOptions;
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
 * @internal Where a server ended up after `connectAndDiscover()` or
 * `settleServer()`: ready, waiting for the user to authorize (with the link
 * when one is usable), failed in a named phase, or removed meanwhile.
 */
export type MCPServerSettlement =
  | { readonly state: typeof MCPConnectionState.READY }
  | {
      readonly state: typeof MCPConnectionState.AUTHENTICATING;
      readonly authUrl: string | undefined;
    }
  | {
      readonly state: typeof MCPConnectionState.FAILED;
      readonly phase: "connect" | "discover";
      readonly error: string;
      /**
       * Authorization was refused in a way retrying cannot change: a 401 no
       * link could answer, a 403, or a refusing OAuth error.
       */
      readonly refused?: true;
    }
  | { readonly state: "removed" };

/** What entering `authenticating` produced. */
type AuthContinuation =
  | {
      readonly _tag: "authenticating";
      readonly authUrl: string;
      readonly clientId?: string;
    }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "exhausted"; readonly error: string };

/** Options for the deprecated {@link MCPClientManager.connect}. */
type LegacyConnectOptions = {
  /** Reconnect an existing server id, optionally completing OAuth with a code. */
  reconnect?: {
    id: string;
    oauthClientId?: string;
    oauthCode?: string;
  };
  /** Transport options, including the OAuth provider whose auth URL is read. */
  transport?: MCPTransportOptions;
  /** MCP SDK client options. */
  client?: McpClientOptions;
};

/** Result for a callback whose server was removed while it was handled. */
function removedDuringAuthorization(serverId: string): MCPOAuthCallbackResult {
  return {
    serverId,
    authSuccess: false,
    authError: `Server ${serverId} was removed during authorization`
  };
}

/** Converts a resolved connection failure into a retry signal. */
class ConnectRetryError extends Error {
  constructor(readonly result: MCPConnectionResult) {
    super("MCP connection attempt failed");
  }
}

/**
 * Result of discovering server capabilities.
 * success indicates whether discovery completed successfully.
 * state is the current connection state at time of return.
 * error is present when success is false.
 * authUrl is present when discovery needs the user to authorize: the server
 * answered a catalog request with 401 and the connection is `authenticating`.
 */
export type MCPDiscoverResult = {
  success: boolean;
  state: MCPConnectionState;
  error?: string;
  /** Authorization URL to send the user to, when `state` is `authenticating`. */
  authUrl?: string;
  /** OAuth client id for `authUrl`, when known. */
  clientId?: string;
};

export type MCPClientElicitationHandler = (
  request: ElicitRequest,
  serverId: string,
  /** Aborts when the originating MCP operation is cancelled. */
  signal?: AbortSignal
) => Promise<ElicitResult>;

export type MCPClientElicitationHandlers = {
  form?: MCPClientElicitationHandler;
  url?: MCPClientElicitationHandler;
};

const MCP_SCHEMA_VERSION_KEY = "cf_agents:mcp_schema_version";
const CURRENT_MCP_SCHEMA_VERSION = 1;

/** Dependencies used by {@link MCPClientManager} across Durable Object wakes. */
export type MCPClientManagerOptions = {
  /**
   * Runtime bindings used to restore persisted RPC MCP connections.
   * Required when the durable catalog contains `rpc://` servers.
   */
  readonly env?: Cloudflare.Env;

  /** Construct the OAuth provider used for a persisted HTTP server. */
  readonly createAuthProvider?: (callbackUrl: string) => AgentMcpOAuthProvider;

  /** Backoff and give-up limits for durable reconnects after failures. */
  readonly reconnect?: MCPReconnectOptions;
};

/**
 * Filter options for scoping tools, prompts, resources, and resource templates
 * to a subset of connected MCP servers. All specified criteria are AND'd together.
 */
export type MCPServerFilter = {
  /** Include only connections matching this server ID (or IDs). */
  serverId?: string | string[];
  /** Include only connections whose stored name matches (or is in) this value. */
  serverName?: string | string[];
  /** Include only connections currently in this state (or states). */
  state?: MCPConnectionState | MCPConnectionState[];
};

/**
 * A Durable Object capability that persists and aggregates MCP client
 * connections. Install it on any Lifecycle, or use `agent.mcp` on an Agent.
 */
export class MCPClientManager extends LifecycleCapability {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  private readonly _aiTools = new MCPAIToolConverter();
  private _didWarnAboutUnstableGetAITools = false;
  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;
  private _connectionDisposables = new Map<string, DisposableStore>();
  private readonly _env: Cloudflare.Env | undefined;
  private readonly _createAuthProviderFn:
    | ((callbackUrl: string) => AgentMcpOAuthProvider)
    | undefined;
  #servers: McpServerStore | undefined;
  private readonly _reconnect: ReconnectPolicy;
  private _isRestored = false;
  private readonly _lanes = new ServerLanes();
  private _elicitationHandlers?: MCPClientElicitationHandlers;

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
   * Notify state listeners outside any lane, so a listener that starts
   * connection work queues it instead of running it inside the work that
   * changed the state.
   */
  private fireServerStateChanged(): void {
    this._lanes.outside(() => this._onServerStateChanged.fire());
  }

  /**
   * Construct a reusable Durable Object MCP client capability.
   *
   * @param _name - MCP client implementation name sent during negotiation.
   * @param _version - MCP client implementation version sent during negotiation.
   * @param options - Optional runtime bindings and OAuth configuration.
   */
  constructor(
    private readonly _name: string,
    private readonly _version: string,
    options: MCPClientManagerOptions = {}
  ) {
    super("mcp");
    this._env = options.env;
    this._createAuthProviderFn = options.createAuthProvider;
    this._reconnect = makeReconnectPolicy(options.reconnect);
  }

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
    this.restoreRpcConnections();
    this.fireServerStateChanged();
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
        if (payload) await this._runConnectJob(job, payload);
        return;
      }
      case AUTH_EXPIRY_JOB: {
        const payload = parseAuthExpiryJobPayload(job.payload);
        return payload ? this._runAuthExpiryJob(payload) : undefined;
      }
      default:
        console.warn(
          `[MCPClientManager] Dropping job ${job.id} with unknown fn "${job.fn}"`
        );
    }
  }

  /**
   * One durable reconnect attempt. Skips when another path already moved
   * the server on: it was rescheduled, removed, connected, is waiting for
   * authorization, or has a recorded failure.
   */
  private async _runConnectJob(
    job: LifecycleJob,
    payload: ConnectJobPayload
  ): Promise<void> {
    const current = this.lifecycle.jobs.get(job.id);
    if (current && current.time > Date.now()) return;
    const { serverId } = payload;
    await this._lanes
      .run(serverId, async () => {
        const conn = this.mcpConnections[serverId];
        if (!conn || !this._servers.get(serverId)) return;
        if (this._servers.failure(serverId)) return;
        if (
          conn.connectionState === MCPConnectionState.READY ||
          conn.connectionState === MCPConnectionState.AUTHENTICATING
        ) {
          return;
        }
        await this._bringUp(serverId, "single");
      })
      .catch((error) => {
        // Removed while this attempt was queued: nothing left to reconnect.
        if (!(error instanceof ServerLaneCancelledError)) throw error;
      });
  }

  /**
   * End an OAuth flow whose link expired unused: the server becomes failed
   * with a recorded reason, so neither this isolate nor a later wake mints a
   * new link nobody asked for. A link the provider will still redeem (a
   * custom provider with a longer lifetime) is checked again later.
   */
  private async _runAuthExpiryJob(
    payload: AuthExpiryJobPayload
  ): Promise<LifecycleJobOutcome | void> {
    const { serverId, authUrl } = payload;
    const row = this._servers.get(serverId);
    if (!row || row.auth_url !== authUrl) return;
    const conn = this.mcpConnections[serverId];
    const provider =
      conn?.options.transport.authProvider ??
      this.authProviderFromStorage(serverId);
    if (provider && (await this.authLinkIsLive(serverId, authUrl, provider))) {
      return { rescheduleAt: Date.now() + AUTHORIZATION_LINK_TTL_MS };
    }
    await this._lanes.run(serverId, async () => {
      if (this._servers.get(serverId)?.auth_url !== authUrl) return;
      this.recordFailure(
        serverId,
        "authorization-expired",
        AUTHORIZATION_EXPIRED_MESSAGE
      );
    });
  }

  /** Whether an authorization link's `state` can still be redeemed. */
  private async authLinkIsLive(
    serverId: string,
    authUrl: string,
    authProvider: AgentMcpOAuthProvider
  ): Promise<boolean> {
    let state: string | null;
    try {
      state = new URL(authUrl).searchParams.get("state");
    } catch {
      return false;
    }
    return state ? isRedeemableState(serverId, authProvider, state) : false;
  }

  /**
   * Mark a server failed for a reason that stops automatic attempts, and
   * record it so later wakes show the same failure. Clears any pending link
   * and reconnect; only an explicit reconnect clears the failure.
   */
  private recordFailure(
    serverId: string,
    reason: StoredServerFailure["reason"],
    message: string
  ): void {
    this._servers.clearAuthUrl(serverId);
    this._servers.setFailure(serverId, { reason, message, at: Date.now() });
    this.cancelJob(connectJobId(serverId));
    this.cancelJob(authExpiryJobId(serverId));
    const conn = this.mcpConnections[serverId];
    if (conn) {
      conn.connectionState = MCPConnectionState.FAILED;
      conn.connectionError = message;
    }
    this.fireServerStateChanged();
  }

  /** Cancel one of this manager's jobs when it exists. */
  private cancelJob(id: string): void {
    if (!this.lifecycle.jobs.get(id)) return;
    void this.lifecycle.jobs.cancel(id).catch((error) => {
      console.warn(`[MCPClientManager] Failed to cancel job ${id}:`, error);
    });
  }

  /** Push one of this manager's jobs, logging instead of throwing. */
  private pushJob(options: LifecycleJobPushOptions): void {
    void this.lifecycle.jobs.push(options).catch((error) => {
      console.warn(
        `[MCPClientManager] Failed to schedule job ${options.id}:`,
        error
      );
    });
  }

  /** Expire a server's authorization link once its lifetime has passed. */
  private armAuthExpiry(serverId: string, authUrl: string): void {
    this.pushJob({
      id: authExpiryJobId(serverId),
      fn: AUTH_EXPIRY_JOB,
      time: Date.now() + AUTHORIZATION_LINK_TTL_MS,
      payload: { serverId, authUrl } satisfies AuthExpiryJobPayload,
      retry: { maxAttempts: 1 }
    });
  }

  /**
   * After a failed connect or discovery: retry later when the failure may
   * pass (the network, a 5xx, a timeout, a temporarily unavailable
   * authorization server), or stop and record it when authorization was
   * refused, since every retry would get the same answer.
   */
  private afterFailure(
    serverId: string,
    settlement: { readonly error: string; readonly refused?: true }
  ): void {
    // Already stopped for a recorded reason (the step-up limit, say).
    if (this._servers.failure(serverId)) return;
    if (settlement.refused) {
      this.recordFailure(
        serverId,
        "authorization-failed",
        `Authorization was refused: ${settlement.error}. Reconnect the server once it can be authorized.`
      );
      return;
    }
    this.scheduleReconnect(serverId, settlement.error);
  }

  /**
   * Schedule the next durable reconnect after a failed attempt, or give up
   * once the policy's window has passed.
   */
  private scheduleReconnect(serverId: string, error: string): void {
    const conn = this.mcpConnections[serverId];
    if (!conn || !this._servers.get(serverId)) return;
    // A recorded failure is terminal until an explicit reconnect.
    if (this._servers.failure(serverId)) return;
    const now = Date.now();
    const decision = nextReconnect(
      this._reconnect,
      parseConnectJobPayload(
        this.lifecycle.jobs.get(connectJobId(serverId))?.payload
      ),
      serverId,
      error,
      now
    );
    if (decision._tag === "give-up") {
      this.recordFailure(
        serverId,
        "reconnect-exhausted",
        `Stopped reconnecting after ${decision.attempts} attempts: ${error}`
      );
      return;
    }
    this.pushJob({
      id: connectJobId(serverId),
      fn: CONNECT_JOB,
      time: decision.time,
      payload: decision.payload,
      retry: { maxAttempts: 1 },
      // One attempt can wait out a connect and a discovery timeout.
      hungTimeoutSeconds: 120
    });
  }

  /** A server reached ready: forget its failures and pending reconnect. */
  private onServerReady(serverId: string): void {
    this._servers.clearFailure(serverId);
    const conn = this.mcpConnections[serverId];
    if (conn) conn.connectionError = null;
    this.cancelJob(connectJobId(serverId));
  }

  /**
   * A server with a reconnect already scheduled waits for it instead of
   * connecting on every wake, so the backoff holds. Shows the last error
   * meanwhile. Returns whether one was pending.
   */
  private awaitScheduledReconnect(
    serverId: string,
    conn: MCPClientConnection
  ): boolean {
    const pending = parseConnectJobPayload(
      this.lifecycle.jobs.get(connectJobId(serverId))?.payload
    );
    if (!pending) return false;
    conn.connectionState = MCPConnectionState.FAILED;
    conn.connectionError = pending.error;
    return true;
  }

  /** Carry a server's pending jobs over to its new id. */
  private moveJobs(oldId: string, newId: string): void {
    const connect = this.lifecycle.jobs.get(connectJobId(oldId));
    const connectPayload = parseConnectJobPayload(connect?.payload);
    if (connect && connectPayload) {
      this.pushJob({
        id: connectJobId(newId),
        fn: CONNECT_JOB,
        time: connect.time,
        payload: { ...connectPayload, serverId: newId },
        retry: { maxAttempts: 1 },
        hungTimeoutSeconds: 120
      });
    }
    const expiry = this.lifecycle.jobs.get(authExpiryJobId(oldId));
    const expiryPayload = parseAuthExpiryJobPayload(expiry?.payload);
    if (expiry && expiryPayload) {
      this.pushJob({
        id: authExpiryJobId(newId),
        fn: AUTH_EXPIRY_JOB,
        time: expiry.time,
        payload: { ...expiryPayload, serverId: newId },
        retry: { maxAttempts: 1 }
      });
    }
    this.cancelJob(connectJobId(oldId));
    this.cancelJob(authExpiryJobId(oldId));
  }

  /**
   * Scope the manager-level elicitation handler to a single connection.
   * Returns undefined when no handler is configured so the connection keeps
   * its default throwing behavior.
   */
  private scopedElicitationHandlers(
    serverId: string
  ): MCPElicitationHandlers | undefined {
    const handlers = this._elicitationHandlers;
    if (!handlers) return undefined;

    const form = handlers.form;
    const url = handlers.url;
    return {
      form: form
        ? (request, signal) =>
            signal ? form(request, serverId, signal) : form(request, serverId)
        : undefined,
      url: url
        ? (request, signal) =>
            signal ? url(request, serverId, signal) : url(request, serverId)
        : undefined
    };
  }

  /** The durable server catalog in this object's storage. */
  private get _servers(): McpServerStore {
    this.#servers ??= new McpServerStore(this.lifecycle.storage);
    return this.#servers;
  }

  /**
   * Rename a server's id, in-place, across every place the id is used as a
   * key. Used to JIT-migrate servers that were originally registered under an
   * auto-generated nanoid to a caller-supplied stable id (see
   * `Agent.addMcpServer`'s `{ id }` option).
   *
   * Migrates:
   *  - the `cf_agents_mcp_servers` row (primary key)
   *  - the in-memory `mcpConnections` map key
   *  - the connection disposables map key
   *  - the attached `authProvider.serverId`, if any
   *  - OAuth-related storage keys under `/{clientName}/{oldId}/...`
   *
   * Safe to call when no OAuth keys exist (RPC / bearer-token HTTP servers).
   * If `oldId === newId` this is a no-op. If a row already exists under
   * `newId`, throws — the caller is expected to have verified uniqueness.
   *
   * @internal Exposed for `Agent.addMcpServer` JIT-migration.
   */
  async migrateServerId(
    oldId: string,
    newId: string,
    clientName: string
  ): Promise<void> {
    if (oldId === newId) return;

    // Restore work closes over oldId. Drain it before renaming, including
    // replacement work registered while an earlier task settles.
    await this._lanes.idle(oldId);

    // 1. Storage: rename the SQL row.
    const renamed = this._servers.rename(oldId, newId);
    if (renamed === "missing") {
      // Nothing in storage to rename; just rename the in-memory connection if any.
      this._renameInMemoryConnection(oldId, newId);
      return;
    }
    if (renamed === "collision") {
      throw new Error(
        `Cannot migrate MCP server id "${oldId}" → "${newId}": new id is already in use.`
      );
    }

    // 2. OAuth-related storage keys. The DurableObjectOAuthClientProvider
    //    keys everything under `/{clientName}/{serverId}/...`. Other servers
    //    won't have any keys with this prefix, so the list will be empty and
    //    this is a no-op for them.
    const oldPrefix = `/${clientName}/${oldId}/`;
    const newPrefix = `/${clientName}/${newId}/`;
    try {
      const keys = await this.lifecycle.storage.list({ prefix: oldPrefix });
      if (keys.size > 0) {
        const writes: Record<string, unknown> = {};
        const deletes: string[] = [];
        for (const [oldKey, value] of keys) {
          const newKey = newPrefix + oldKey.slice(oldPrefix.length);
          writes[newKey] = value;
          deletes.push(oldKey);
        }
        await this.lifecycle.storage.put(writes);
        await this.lifecycle.storage.delete(deletes);
      }
    } catch (error) {
      // Best-effort: storage rename failures shouldn't break the SQL-level
      // rename that already succeeded. Log and continue.
      console.warn(
        `[MCPClientManager] OAuth key migration ${oldPrefix} → ${newPrefix} failed:`,
        error
      );
    }

    // 3. In-memory connection + disposables + authProvider.
    this._renameInMemoryConnection(oldId, newId);

    // 4. Pending reconnect and link-expiry jobs.
    this.moveJobs(oldId, newId);

    this.fireServerStateChanged();
  }

  private _renameInMemoryConnection(oldId: string, newId: string): void {
    if (oldId === newId) return;

    const conn = this.mcpConnections[oldId];
    if (conn) {
      this.mcpConnections[newId] = conn;
      delete this.mcpConnections[oldId];
      const authProvider = conn.options.transport.authProvider;
      if (authProvider) {
        authProvider.serverId = newId;
      }
      // The elicitation handler closes over the server id it was created
      // with — rescope it so elicitation requests report the new id. With no
      // handlers there is nothing to rescope, and configuring would wipe the
      // connection's restored capability seed.
      const scoped = this.scopedElicitationHandlers(newId);
      if (scoped) {
        conn.configureElicitationHandlers(scoped);
      }
    }

    const disposables = this._connectionDisposables.get(oldId);
    if (disposables) {
      this._connectionDisposables.set(newId, disposables);
      this._connectionDisposables.delete(oldId);
    }
  }

  private filterConnections(
    filter?: MCPServerFilter
  ): Record<string, MCPClientConnection> {
    if (!filter) return this.mcpConnections;

    const serverIds = filter.serverId
      ? Array.isArray(filter.serverId)
        ? filter.serverId
        : [filter.serverId]
      : undefined;

    const serverNames = filter.serverName
      ? Array.isArray(filter.serverName)
        ? filter.serverName
        : [filter.serverName]
      : undefined;

    const states = filter.state
      ? Array.isArray(filter.state)
        ? filter.state
        : [filter.state]
      : undefined;

    let nameMatchedIds: Set<string> | undefined;
    if (serverNames) {
      const servers = this._servers.list();
      nameMatchedIds = new Set(
        servers.filter((s) => serverNames.includes(s.name)).map((s) => s.id)
      );
    }

    return Object.fromEntries(
      Object.entries(this.mcpConnections).filter(([id, conn]) => {
        if (serverIds && !serverIds.includes(id)) return false;
        if (nameMatchedIds && !nameMatchedIds.has(id)) return false;
        if (states && !states.includes(conn.connectionState)) return false;
        return true;
      })
    );
  }

  /** Persist the connection's resumable session, or clear a stale one. */
  private persistSession(id: string, conn: MCPClientConnection): void {
    const { sessionId, protocolVersion, discoverResult } = conn;
    this._servers.setSession(
      id,
      sessionId && protocolVersion
        ? { id: sessionId, protocolVersion, discoverResult }
        : undefined
    );
  }

  private failConnection(
    serverId: string,
    error: string
  ): MCPOAuthCallbackResult {
    this._servers.clearAuthUrl(serverId);
    this.cancelJob(authExpiryJobId(serverId));
    if (this.mcpConnections[serverId]) {
      this.mcpConnections[serverId].connectionState = MCPConnectionState.FAILED;
      this.mcpConnections[serverId].connectionError = error;
    }
    this.fireServerStateChanged();
    return { serverId, authSuccess: false, authError: error };
  }

  private isAuthAcceptedConnection(conn: MCPClientConnection): boolean {
    return (
      conn.connectionState === MCPConnectionState.READY ||
      conn.connectionState === MCPConnectionState.CONNECTED ||
      conn.connectionState === MCPConnectionState.CONNECTING ||
      conn.connectionState === MCPConnectionState.DISCOVERING
    );
  }

  /**
   * Success for a callback whose flow was already accepted, unless the
   * server was removed while its state was cleaned up.
   */
  private staleCallbackSuccess(
    serverId: string,
    conn: MCPClientConnection
  ): MCPOAuthCallbackResult {
    if (this.mcpConnections[serverId] !== conn) {
      return removedDuringAuthorization(serverId);
    }
    return this.oauthCallbackSuccess(serverId, conn);
  }

  private oauthCallbackSuccess(
    serverId: string,
    conn: MCPClientConnection
  ): MCPOAuthCallbackResult {
    this._servers.clearAuthUrl(serverId);
    this.cancelJob(authExpiryJobId(serverId));
    conn.connectionError = null;
    return { serverId, authSuccess: true };
  }

  private ignoreUnverifiedCallback(
    serverId: string,
    error: string
  ): MCPOAuthCallbackResult {
    console.warn(
      `[MCPClientManager] Ignoring OAuth callback with unverified state for server "${serverId}": ${error}`
    );
    return { serverId, authSuccess: false, authError: error };
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
  ): AgentMcpOAuthProvider {
    const authProvider = new DurableObjectOAuthClientProvider(
      this.lifecycle.storage,
      clientName,
      callbackUrl
    );
    authProvider.serverId = serverId;
    if (clientId) {
      authProvider.clientId = clientId;
    }
    return authProvider;
  }

  /** Get saved RPC servers from storage (servers with `rpc://` URLs). */
  getRpcServersFromStorage(): MCPServerRow[] {
    return this._servers.listRpc();
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
    this._servers.save({
      id,
      name,
      server_url: `${RPC_DO_PREFIX}${normalizedName}`,
      client_id: null,
      auth_url: null,
      callback_url: "",
      server_options: encodeMcpServerOptions({
        bindingName,
        props,
        capabilities: this.advertisedHandlerCapabilities()
      })
    });
  }

  /**
   * Restore persisted HTTP MCP connections.
   *
   * @param clientName - Durable Object identity used to scope OAuth state.
   */
  async restoreConnectionsFromStorage(clientName: string): Promise<void> {
    if (this._isRestored) {
      return;
    }

    const servers = this._servers.list();

    if (!servers || servers.length === 0) {
      this._isRestored = true;
      return;
    }

    for (const server of servers) {
      if (server.server_url.startsWith(RPC_DO_PREFIX)) {
        continue;
      }

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
            await existingConn.close();
          } catch (error) {
            console.warn(
              `[MCPClientManager] Error closing failed connection ${server.id}:`,
              error
            );
          } finally {
            this.cleanupClosedConnection(server.id);
          }
        }
      }

      const parsedOptions = decodeMcpServerOptions(server.server_options);

      let authProvider: AgentMcpOAuthProvider | undefined;
      if (server.callback_url) {
        authProvider = this._createAuthProviderFn
          ? this._createAuthProviderFn(server.callback_url)
          : this.createAuthProvider(
              server.id,
              server.callback_url,
              clientName,
              server.client_id ?? undefined
            );
        authProvider.serverId = server.id;
        if (server.client_id) {
          authProvider.clientId = server.client_id;
        }
      }

      // Create the in-memory connection object (no need to save to storage - we just read from it!)
      const conn = this.createConnection(server.id, server.server_url, {
        client: parsedOptions?.client ?? {},
        transport: {
          ...(parsedOptions?.transport ?? {}),
          type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
          authProvider
        },
        discoverResult: parsedOptions?.discoverResult
      });

      // A recorded failure stopped automatic attempts; only an explicit
      // reconnect clears it.
      const failure = this._servers.failure(server.id);
      if (failure) {
        conn.connectionState = MCPConnectionState.FAILED;
        conn.connectionError = failure.message;
        continue;
      }

      if (server.auth_url) {
        // An OAuth flow is waiting for its callback while its link can still
        // complete it.
        if (await redeemableAuthUrl(server.id, server.auth_url, authProvider)) {
          conn.connectionState = MCPConnectionState.AUTHENTICATING;
          // Flows saved before link expiry was tracked get their job now.
          if (!this.lifecycle.jobs.get(authExpiryJobId(server.id))) {
            this.armAuthExpiry(server.id, server.auth_url);
          }
          continue;
        }
        // Otherwise the link expired unused: a callback clears auth_url
        // before it redeems the state, so a dead link here was never
        // completed. Record that instead of minting a link nobody asked for.
        this.recordFailure(
          server.id,
          "authorization-expired",
          AUTHORIZATION_EXPIRED_MESSAGE
        );
        continue;
      }

      if (this.awaitScheduledReconnect(server.id, conn)) continue;

      // Connect in the background so startup does not wait on the network;
      // waitForConnections() observes the queued work.
      this.restoreInBackground(server.id);
    }

    this._isRestored = true;
  }

  /** Connect a restored server in the background, retrying durably. */
  private restoreInBackground(serverId: string): void {
    void this._bringUp(serverId, "quick").catch((error) => {
      if (error instanceof ServerLaneCancelledError) return;
      console.error(`[MCPClientManager] Error restoring ${serverId}:`, error);
    });
  }

  /**
   * Restore persisted RPC connections. Like HTTP servers they reconnect in
   * the background: startup has a 30s budget, and a slow `McpAgent` must not
   * hold it.
   */
  private restoreRpcConnections(): void {
    for (const server of this._servers.listRpc()) {
      if (this.mcpConnections[server.id]) continue;
      const resolved = resolveRpcTransport(this._env, server);
      if (resolved._tag === "unresolved") {
        console.warn(
          `[MCPClientManager] Cannot restore RPC MCP server "${server.name}": ${resolved.reason}`
        );
        continue;
      }
      const conn = this.createConnection(server.id, server.server_url, {
        transport: resolved.transport
      });
      const failure = this._servers.failure(server.id);
      if (failure) {
        conn.connectionState = MCPConnectionState.FAILED;
        conn.connectionError = failure.message;
        continue;
      }
      if (this.awaitScheduledReconnect(server.id, conn)) continue;
      this.restoreInBackground(server.id);
    }
  }

  /**
   * @internal Connect a registered server and discover its capabilities, as
   * one unit of lane work. A failure schedules a durable reconnect.
   */
  connectAndDiscover(id: string): Promise<MCPServerSettlement> {
    return this.removedIfCancelled(this._bringUp(id, "single"));
  }

  /**
   * Connect a server, discover it, and act on the outcome: a failure
   * schedules the next durable reconnect (or gives up), while ready and
   * authenticating clear the pending reconnect on their own transitions.
   * `quick` first retries short blips in place with the server's retry
   * options.
   */
  private _bringUp(
    id: string,
    retries: "quick" | "single"
  ): Promise<MCPServerSettlement> {
    return this._lanes.run(id, async (): Promise<MCPServerSettlement> => {
      let connected: MCPConnectionResult;
      try {
        connected =
          retries === "quick"
            ? await this._connectWithRetry(id, this._servers.options(id)?.retry)
            : await this.connectToServer(id);
      } catch (error) {
        connected = {
          state: MCPConnectionState.FAILED,
          error: toErrorMessage(error)
        };
      }
      const settlement: MCPServerSettlement =
        connected.state === MCPConnectionState.CONNECTED
          ? await this._settleDiscovery(id)
          : connected.state === MCPConnectionState.AUTHENTICATING
            ? {
                state: MCPConnectionState.AUTHENTICATING,
                authUrl: connected.authUrl
              }
            : {
                state: MCPConnectionState.FAILED,
                phase: "connect",
                error: connected.error,
                ...(this.mcpConnections[id]?.accessRefused && {
                  refused: true as const
                })
              };
      if (settlement.state === MCPConnectionState.FAILED) {
        this.afterFailure(id, settlement);
      }
      return settlement;
    });
  }

  /**
   * @internal Bring an already-registered server to a settled state once the
   * work queued for it has run: a ready server stays ready, a flow whose
   * link still works keeps waiting, a server left connected is discovered,
   * and anything else, including a failed server, is connected again.
   */
  settleServer(id: string): Promise<MCPServerSettlement> {
    return this.removedIfCancelled(this._settleServer(id));
  }

  /** Report queued work cancelled by removal as a removed server. */
  private async removedIfCancelled(
    work: Promise<MCPServerSettlement>
  ): Promise<MCPServerSettlement> {
    try {
      return await work;
    } catch (error) {
      if (error instanceof ServerLaneCancelledError)
        return { state: "removed" };
      throw error;
    }
  }

  private _settleServer(id: string): Promise<MCPServerSettlement> {
    return this._lanes.run(id, async (): Promise<MCPServerSettlement> => {
      const conn = this.mcpConnections[id];
      if (!conn) return { state: "removed" };
      switch (conn.connectionState) {
        case MCPConnectionState.READY:
          return { state: MCPConnectionState.READY };
        case MCPConnectionState.FAILED:
          // An explicit reconnect: forget why it stopped and try now.
          this._servers.clearFailure(id);
          this._servers.setAuthorizationRounds(id, undefined);
          this.cancelJob(connectJobId(id));
          return this.connectAndDiscover(id);
        case MCPConnectionState.CONNECTED: {
          const settlement = await this._settleDiscovery(id);
          if (settlement.state === MCPConnectionState.FAILED) {
            this.afterFailure(id, settlement);
          }
          return settlement;
        }
        case MCPConnectionState.AUTHENTICATING: {
          const provider = conn.options.transport.authProvider;
          const authUrl =
            (await redeemableAuthUrl(id, provider?.authUrl, provider)) ??
            (await redeemableAuthUrl(
              id,
              this._servers.get(id)?.auth_url,
              provider
            ));
          if (authUrl) {
            return { state: MCPConnectionState.AUTHENTICATING, authUrl };
          }
          // The pending link can no longer complete; start a fresh flow.
          return this.connectAndDiscover(id);
        }
        case MCPConnectionState.CONNECTING:
        case MCPConnectionState.DISCOVERING:
          // Nothing queued is driving it any more, so drive it.
          return this.connectAndDiscover(id);
      }
    });
  }

  private async _settleDiscovery(id: string): Promise<MCPServerSettlement> {
    const discovered = await this.discoverIfConnected(id);
    if (discovered?.state === MCPConnectionState.AUTHENTICATING) {
      // Initialize was open but the catalogs need OAuth.
      if (discovered.authUrl) {
        return {
          state: MCPConnectionState.AUTHENTICATING,
          authUrl: discovered.authUrl
        };
      }
      // A 401 no link can answer: asking again gets the same answer.
      return {
        state: MCPConnectionState.FAILED,
        phase: "discover",
        error: discovered.error ?? "The server requires authorization",
        refused: true
      };
    }
    if (!discovered?.success) {
      return {
        state: MCPConnectionState.FAILED,
        phase: "discover",
        error: discovered?.error ?? "connection not found",
        ...(this.mcpConnections[id]?.accessRefused && {
          refused: true as const
        })
      };
    }
    return { state: MCPConnectionState.READY };
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
    if (pending.length === 0) {
      return;
    }
    if (options?.timeout != null && options.timeout <= 0) {
      return;
    }
    const settled = Promise.allSettled(pending);
    if (options?.timeout != null && options.timeout > 0) {
      let timerId: ReturnType<typeof setTimeout>;
      const timer = new Promise<void>((resolve) => {
        timerId = setTimeout(resolve, options.timeout);
      });
      await Promise.race([settled, timer]);
      clearTimeout(timerId!);
    } else {
      await settled;
    }
  }

  private async _connectWithRetry(
    serverId: string,
    retry?: RetryOptions
  ): Promise<MCPConnectionResult> {
    const maxAttempts = retry?.maxAttempts ?? 3;
    const baseDelayMs = retry?.baseDelayMs ?? 500;
    const maxDelayMs = retry?.maxDelayMs ?? 5000;

    try {
      return await tryN(
        maxAttempts,
        async () => {
          const result = await this.connectToServer(serverId);
          // A refusal gets the same answer on every attempt.
          if (
            result.state === MCPConnectionState.FAILED &&
            !this.mcpConnections[serverId]?.accessRefused
          ) {
            throw new ConnectRetryError(result);
          }
          return result;
        },
        { baseDelayMs, maxDelayMs }
      );
    } catch (error) {
      if (error instanceof ConnectRetryError) {
        return error.result;
      }
      throw error;
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
    options: LegacyConnectOptions = {}
  ): Promise<{
    id: string;
    authUrl?: string;
    clientId?: string;
  }> {
    const id = options.reconnect?.id ?? nanoid(8);
    return this._lanes.run(id, () => this._connectLegacy(id, url, options));
  }

  private async _connectLegacy(
    id: string,
    url: string,
    options: LegacyConnectOptions
  ): Promise<{
    id: string;
    authUrl?: string;
    clientId?: string;
  }> {
    if (options.transport?.authProvider) {
      options.transport.authProvider.serverId = id;
      // reconnect with auth
      if (options.reconnect?.oauthClientId) {
        options.transport.authProvider.clientId =
          options.reconnect?.oauthClientId;
      }
    }

    if (isBlockedUrl(url)) {
      throw new Error(
        `Blocked URL: ${url} — MCP client connections to private/internal addresses are not allowed`
      );
    }

    // During OAuth reconnect, reuse existing connection to preserve state;
    // otherwise drop any existing connection and rebuild it.
    if (!options.reconnect?.oauthCode || !this.mcpConnections[id]) {
      const replaced = this.mcpConnections[id];
      if (replaced) {
        delete this.mcpConnections[id];
        // Once removed from the map, nothing else can close this transport.
        await replaced.close().catch(() => {});
        this._servers.setSession(id);
      }
      this.createConnection(id, url, {
        client: options.client,
        transport: options.transport ?? {}
      });
    }

    // Initialize connection first. this will try connect
    await this.mcpConnections[id].init();

    // Handle OAuth completion if we have a reconnect code
    if (options.reconnect?.oauthCode) {
      try {
        const authProvider =
          this.mcpConnections[id].options.transport.authProvider;
        let completeError: unknown;
        try {
          await this.mcpConnections[id].completeAuthorization(
            options.reconnect.oauthCode
          );
        } catch (error) {
          completeError = error;
        }

        try {
          await authProvider?.deleteCodeVerifier();
        } catch (cleanupError) {
          console.warn(
            `[MCPClientManager] Failed to clean up OAuth code verifier for server "${id}":`,
            cleanupError
          );
        }

        if (completeError) {
          throw completeError;
        }

        // Reinitialize connection
        await this.mcpConnections[id].init();
      } catch (error) {
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          payload: {
            url: url,
            transport: options.transport?.type ?? "auto",
            state: this.mcpConnections[id].connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now()
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
      client?: McpClientOptions;
      transport: MCPTransportOptions;
      discoverResult?: DiscoverResult;
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

    // Stored servers re-advertise the capabilities persisted on their row
    // (see MCPServerOptions.capabilities); fresh registrations have no row
    // yet and rely on the handlers below. The stamp is read without
    // clearing so a wake that never handshakes (OAuth still pending, isolate
    // death before connect) doesn't burn it — it is consumed at first use,
    // once a seeded handshake completes.
    const capabilitySeed = this._servers.options(id)?.capabilities;

    this.mcpConnections[id] = new MCPClientConnection(
      new URL(url),
      {
        name: this._name,
        version: this._version
      },
      {
        client: options.client ?? {},
        transport: normalizedTransport,
        elicitationHandlers: this.scopedElicitationHandlers(id),
        capabilitySeed,
        discoverResult: options.discoverResult
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
    store.add(
      this.mcpConnections[id].onListChanged(() => {
        this.fireServerStateChanged();
      })
    );

    if (capabilitySeed) {
      const conn = this.mcpConnections[id];
      // Every handshake reports its success through this event, so it marks
      // the seed's first use. The burn only targets deploys that stopped
      // configuring handlers: a session with handlers configured owns the
      // row stamps (each configure call re-stamps them, and re-registering
      // a server writes a fresh one), and configureElicitationHandlers
      // drops the in-memory seed on live connections — either way a fresh
      // stamp meant for the next wake is never wiped here.
      const seedClear = conn.onObservabilityEvent((event) => {
        if (
          event.type !== "mcp:client:connect" ||
          event.payload.state !== MCPConnectionState.CONNECTED
        ) {
          return;
        }
        seedClear.dispose();
        if (this._elicitationHandlers || !conn.options.capabilitySeed) return;
        // migrateServerId may have renamed the row while the handshake was
        // in flight — clear under the connection's current id.
        const currentId = Object.keys(this.mcpConnections).find(
          (key) => this.mcpConnections[key] === conn
        );
        if (currentId) {
          this._servers.clearCapabilities(currentId);
        }
      });
      store.add(seedClear);
    }

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
    if (isBlockedUrl(options.url)) {
      throw new Error(
        `Blocked URL: ${options.url} — MCP client connections to private/internal addresses are not allowed`
      );
    }

    const authProvider =
      options.transport?.authProvider ??
      (options.callbackUrl
        ? (this._createAuthProviderFn?.(options.callbackUrl) ??
          this.createAuthProvider(
            id,
            options.callbackUrl,
            this._name,
            options.clientId
          ))
        : undefined);
    if (authProvider) {
      authProvider.serverId = id;
      if (options.clientId) authProvider.clientId = options.clientId;
    }

    // Create the in-memory connection.
    this.createConnection(id, options.url, {
      client: options.client,
      transport: {
        ...options.transport,
        authProvider,
        type: options.transport?.type ?? ("auto" as TransportType)
      }
    });

    this._servers.save({
      id,
      name: options.name,
      server_url: options.url,
      callback_url: options.callbackUrl ?? "",
      client_id: options.clientId ?? null,
      auth_url: options.authUrl ?? null,
      server_options: encodeMcpServerOptions({
        client: options.client,
        transport: options.transport,
        retry: options.retry,
        capabilities: this.advertisedHandlerCapabilities()
      })
    });
    // Registering again is a fresh start for the server.
    this._servers.clearFailure(id);
    this._servers.setAuthorizationRounds(id, undefined);

    this.fireServerStateChanged();

    return id;
  }

  /**
   * Move a connection to `authenticating` on the authorization URL its
   * provider holds. Every path that ends up waiting for the user — connect,
   * discovery, and a request that hits a scope step-up or a failed refresh —
   * goes through here, so the persisted `auth_url`, the connection state and
   * the broadcast always agree, and the OAuth callback finds the connection
   * in the state it completes from.
   *
   * Leaves the connection untouched when the provider holds no usable
   * authorization URL. When the server keeps asking for the same
   * authorization past the retry limit, records a permanent failure
   * instead of showing another link.
   */
  private enterAuthenticating(
    id: string,
    conn: MCPClientConnection
  ): AuthContinuation {
    if (this.mcpConnections[id] !== conn) return { _tag: "unavailable" };
    const authUrl = conn.options.transport.authProvider?.authUrl;
    if (!authUrl || !conn.options.transport.authProvider?.redirectUrl) {
      return { _tag: "unavailable" };
    }
    const round = startRound(
      parseAuthorizationRounds(this._servers.authorizationRounds(id)),
      requestedScope(authUrl),
      Date.now()
    );
    if (round._tag === "exhausted") {
      const error = authorizationExhaustedMessage(round.rounds, round.scope);
      this.recordFailure(id, "authorization-exhausted", error);
      return { _tag: "exhausted", error };
    }
    const auth = this.persistAuthContinuation(id, conn);
    if (!auth) return { _tag: "unavailable" };
    this._servers.setAuthorizationRounds(id, round.rounds);
    conn.connectionState = MCPConnectionState.AUTHENTICATING;
    this._servers.clearFailure(id);
    this.cancelJob(connectJobId(id));
    this.armAuthExpiry(id, auth.authUrl);
    this.fireServerStateChanged();
    return { _tag: "authenticating", ...auth };
  }

  /** Persist and emit an OAuth continuation produced by connect or discovery. */
  private persistAuthContinuation(
    id: string,
    conn: MCPClientConnection
  ): { authUrl: string; clientId?: string } | undefined {
    const authProvider = conn.options.transport.authProvider;
    const authUrl = authProvider?.authUrl;
    if (!authUrl || !authProvider.redirectUrl) return undefined;

    const clientId = authProvider.clientId;
    this._servers.setAuthContinuation(id, authUrl, clientId);

    this._onObservabilityEvent.fire({
      type: "mcp:client:authorize",
      payload: { serverId: id, authUrl, clientId },
      timestamp: Date.now()
    });
    return { authUrl, clientId };
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
    return this._lanes.run(id, () => this._connectToServer(id));
  }

  private async _connectToServer(id: string): Promise<MCPConnectionResult> {
    const conn = this.mcpConnections[id];
    if (!conn) {
      throw new Error(
        `Server ${id} is not registered. Call registerServer() first.`
      );
    }
    // Automatic paths never reach a server with a recorded failure, so this
    // is an explicit reconnect: forget why it stopped.
    this._servers.clearFailure(id);

    const error = await conn.init();
    if (this.mcpConnections[id] !== conn) {
      // Removed or replaced while connecting: nothing from this attempt may
      // reach the catalog or a newer connection under the same id.
      await conn.close().catch(() => {});
      return {
        state: MCPConnectionState.FAILED,
        error: `Server ${id} was removed while connecting`
      };
    }
    this.persistSession(id, conn);
    this.fireServerStateChanged();

    switch (conn.connectionState) {
      case MCPConnectionState.FAILED:
        return {
          state: conn.connectionState,
          error: error ?? "Unknown connection error"
        };

      case MCPConnectionState.AUTHENTICATING: {
        // Broadcasts again once auth_url is durable so clients can serve it.
        const auth = this.enterAuthenticating(id, conn);
        switch (auth._tag) {
          case "authenticating":
            return {
              state: MCPConnectionState.AUTHENTICATING,
              authUrl: auth.authUrl,
              clientId: auth.clientId
            };
          case "exhausted":
            return { state: MCPConnectionState.FAILED, error: auth.error };
          case "unavailable": {
            // A 401 nothing here can answer with a link: retrying gets the
            // same 401, so automatic reconnects stop.
            conn.accessRefused = true;
            const provider = conn.options.transport.authProvider;
            return {
              state: MCPConnectionState.FAILED,
              error: `OAuth configuration incomplete: missing ${
                !provider?.authUrl ? "authUrl" : "redirectUrl"
              }`
            };
          }
        }
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

  /** Whether a request is an OAuth callback for one of this manager's servers. */
  isCallbackRequest(req: Request): boolean {
    return isOAuthCallbackFor(req, this._servers.list());
  }

  /**
   * Complete the OAuth flow a callback request belongs to: verify its state,
   * exchange its code, and leave the connection ready to reconnect. A
   * callback for a flow that was already accepted is consumed as a stale
   * success; one whose state cannot be verified changes nothing.
   */
  async handleCallbackRequest(req: Request): Promise<MCPOAuthCallbackResult> {
    const serverId = serverIdFromState(
      new URL(req.url).searchParams.get("state")
    );
    if (!serverId) return this._handleCallbackRequest(req);
    return this._lanes
      .run(serverId, () => this._handleCallbackRequest(req))
      .catch((error) => {
        // Removed while this callback waited for earlier work.
        if (error instanceof ServerLaneCancelledError) {
          return removedDuringAuthorization(serverId);
        }
        throw error;
      });
  }

  private async _handleCallbackRequest(
    req: Request
  ): Promise<MCPOAuthCallbackResult> {
    const callback = parseOAuthCallback(req, {
      hasServer: (id) => this._servers.get(id) !== undefined,
      hasConnection: (id) => this.mcpConnections[id] !== undefined
    });

    if (callback._tag === "invalid") {
      const conn = callback.serverId
        ? this.mcpConnections[callback.serverId]
        : undefined;
      if (!callback.serverId || !conn) {
        return {
          serverId: callback.serverId,
          authSuccess: false,
          authError: callback.error
        };
      }
      const authProvider = conn.options.transport.authProvider;
      if (this.isAuthAcceptedConnection(conn)) {
        if (callback.state && authProvider) {
          await consumeStaleState(
            callback.serverId,
            authProvider,
            callback.state
          );
        }
        return this.staleCallbackSuccess(callback.serverId, conn);
      }
      // Only a callback carrying a genuine state nonce may fail the
      // connection; a stray or invalid callback must not alter the
      // connection state machine.
      if (
        callback.state &&
        authProvider &&
        !(await isRedeemableState(
          callback.serverId,
          authProvider,
          callback.state
        ))
      ) {
        return this.ignoreUnverifiedCallback(callback.serverId, callback.error);
      }
      if (this.mcpConnections[callback.serverId] !== conn) {
        return removedDuringAuthorization(callback.serverId);
      }
      return this.failConnection(callback.serverId, callback.error);
    }

    const { serverId, state, params } = callback;
    // A connection exists from here on; every error fails it.
    const conn = this.mcpConnections[serverId];

    try {
      const authProvider = conn.options.transport.authProvider;
      if (!authProvider) {
        throw new Error(
          "Trying to finalize authentication for a server connection without an authProvider"
        );
      }
      authProvider.serverId = serverId;

      // Two-phase state validation: check first (non-destructive), consume
      // later, so an attacker cannot burn a valid state before the real
      // callback arrives.
      const stateValidation = await authProvider.checkState(state);
      if (!stateValidation.valid) {
        if (this.isAuthAcceptedConnection(conn)) {
          await consumeStaleState(serverId, authProvider, state);
          return this.staleCallbackSuccess(serverId, conn);
        }
        // Same rule as the invalid branch above: a callback whose nonce
        // cannot be verified must not alter the connection state machine.
        return this.ignoreUnverifiedCallback(
          serverId,
          params.get("error_description") ??
            params.get("error") ??
            stateValidation.error ??
            "Invalid state"
        );
      }

      // A stale popup can complete after another callback already exchanged
      // tokens. Treat it as success, but consume its state so it cannot be
      // replayed.
      if (this.isAuthAcceptedConnection(conn)) {
        await consumeStaleState(serverId, authProvider, state);
        return this.staleCallbackSuccess(serverId, conn);
      }

      if (
        conn.connectionState !== MCPConnectionState.AUTHENTICATING &&
        conn.connectionState !== MCPConnectionState.FAILED
      ) {
        throw new Error(
          `Failed to authenticate from "${conn.connectionState}" state`
        );
      }

      // A genuine callback can recover a flow that previously entered FAILED.
      conn.connectionState = MCPConnectionState.CONNECTING;
      // Forget the link before redeeming it. If the isolate dies during the
      // exchange, a later wake reconnects (with the saved tokens, or into a
      // fresh flow) instead of restoring a link whose state is spent.
      this._servers.clearAuthUrl(serverId);
      this.cancelJob(authExpiryJobId(serverId));
      await authProvider.consumeState(state);
      await exchangeAuthorizationCode(
        serverId,
        conn,
        authProvider,
        state,
        params
      );
      if (this.mcpConnections[serverId] !== conn) {
        // Removed while the code was exchanged: the tokens just saved
        // outlived removeServer's cleanup, so clear them again.
        await this.clearOAuthStorage(serverId, authProvider);
        return removedDuringAuthorization(serverId);
      }
      this.persistSession(serverId, conn);
      this._servers.setAuthorizationRounds(
        serverId,
        completeRound(
          parseAuthorizationRounds(this._servers.authorizationRounds(serverId))
        )
      );
      const result = this.oauthCallbackSuccess(serverId, conn);
      this.fireServerStateChanged();
      return result;
    } catch (err) {
      // A server removed (and maybe re-registered) meanwhile is not ours to
      // fail: the replacement keeps its own state and pending link.
      if (this.mcpConnections[serverId] !== conn) {
        return removedDuringAuthorization(serverId);
      }
      return this.failConnection(serverId, toErrorMessage(err));
    }
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
    return this._lanes.run(serverId, () =>
      this._discoverIfConnected(serverId, options)
    );
  }

  private async _discoverIfConnected(
    serverId: string,
    options: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult | undefined> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        payload: {},
        timestamp: Date.now()
      });
      return undefined;
    }

    // Delegate to connection's discover method which handles cancellation and timeout
    const result = await conn.discover(options);
    if (this.mcpConnections[serverId] !== conn) {
      // Removed or replaced while discovering; leave storage alone.
      return this._toDiscoverResult(conn, result);
    }
    if (!result.success && result.reason === "stale-session") {
      return this._recoverStaleSession(conn, serverId, options);
    }
    if (result.success) this.onServerReady(serverId);
    // A 401 during discovery (initialize open, catalogs protected) leaves the
    // connection waiting for the user, exactly like a 401 at connect.
    const auth =
      conn.connectionState === MCPConnectionState.AUTHENTICATING
        ? this.enterAuthenticating(serverId, conn)
        : undefined;
    this.fireServerStateChanged();

    return this._toDiscoverResult(conn, result, auth);
  }

  private _toDiscoverResult(
    conn: MCPClientConnection,
    result: MCPDiscoveryResult,
    auth?: AuthContinuation
  ): MCPDiscoverResult {
    if (result.success) return { success: true, state: conn.connectionState };
    return {
      success: false,
      error: auth?._tag === "exhausted" ? auth.error : result.error,
      state: conn.connectionState,
      ...(auth?._tag === "authenticating" && {
        authUrl: auth.authUrl,
        clientId: auth.clientId
      })
    };
  }

  private async _recoverStaleSession(
    conn: MCPClientConnection,
    serverId: string,
    options: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult> {
    conn.clearResumedSession();
    this._servers.setSession(serverId);

    let connectResult: MCPConnectionResult;
    try {
      connectResult = await this.connectToServer(serverId);
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
        state: conn.connectionState
      };
    }

    if (connectResult.state !== MCPConnectionState.CONNECTED) {
      return {
        success: false,
        error:
          connectResult.state === MCPConnectionState.FAILED
            ? connectResult.error
            : `Connection in ${connectResult.state} state after session re-initialization`,
        state: conn.connectionState
      };
    }

    const result = await conn.discover(options);
    this.fireServerStateChanged();

    return this._toDiscoverResult(conn, result);
  }

  /**
   * Establish connection in the background after OAuth completion.
   * This method connects to the server and discovers its capabilities.
   * The connection is automatically tracked so that `waitForConnections()`
   * will include it.
   * @param serverId The server ID to establish connection for
   */
  async establishConnection(serverId: string): Promise<void> {
    return this._lanes.run(serverId, () =>
      this._doEstablishConnection(serverId)
    );
  }

  private async _doEstablishConnection(serverId: string): Promise<void> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:preconnect",
        payload: { serverId },
        timestamp: Date.now()
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
        payload: {
          url: conn.url.toString(),
          transport: conn.options.transport.type || "unknown",
          state: conn.connectionState
        },
        timestamp: Date.now()
      });
      return;
    }

    await this._bringUp(serverId, "quick");
    this.fireServerStateChanged();

    this._onObservabilityEvent.fire({
      type: "mcp:client:connect",
      payload: {
        url: conn.url.toString(),
        transport: conn.options.transport.type || "unknown",
        state: conn.connectionState
      },
      timestamp: Date.now()
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
    this._elicitationHandlers =
      handlers && (handlers.form || handlers.url) ? handlers : undefined;
    this.persistAdvertisedCapabilities();
    for (const [id, connection] of Object.entries(this.mcpConnections)) {
      connection.configureElicitationHandlers(
        this.scopedElicitationHandlers(id)
      );
    }
  }

  /** Client capabilities advertised from the currently configured handlers. */
  private advertisedHandlerCapabilities(): ClientCapabilities | undefined {
    const elicitation = elicitationCapabilitiesFromHandlers(
      this._elicitationHandlers
    );
    return elicitation ? { elicitation } : undefined;
  }

  /**
   * Record the handler-derived capabilities on every stored server row so a
   * restore after hibernation re-advertises them before the handlers
   * themselves are reconfigured.
   */
  private persistAdvertisedCapabilities(): void {
    this._servers.stampCapabilities(this.advertisedHandlerCapabilities());
  }

  /**
   * Get the current OAuth callback configuration
   * @returns The current OAuth callback configuration
   */
  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this._oauthCallbackConfig;
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of tools
   */
  listTools(filter?: MCPServerFilter): NamespacedData["tools"] {
    return getNamespacedData(this.filterConnections(filter), "tools");
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
    return this._aiTools.convert(this.filterConnections(filter), (params) =>
      this.callTool(params)
    );
  }

  /**
   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  unstable_getAITools(filter?: MCPServerFilter): MCPAIToolSet {
    if (!this._didWarnAboutUnstableGetAITools) {
      this._didWarnAboutUnstableGetAITools = true;
      console.warn(
        "unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version."
      );
    }
    return this.getAITools(filter);
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
  private cleanupClosedConnection(id: string): void {
    this._servers.setSession(id);

    const store = this._connectionDisposables.get(id);
    if (store) store.dispose();
    this._connectionDisposables.delete(id);

    delete this.mcpConnections[id];
  }

  async closeAllConnections() {
    const ids = Object.keys(this.mcpConnections);

    // Clear all pending connection tracking
    this._lanes.forgetAll();

    // Cancel all in-flight discoveries
    for (const id of ids) {
      this.mcpConnections[id].cancelDiscovery();
    }

    const results = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await this.mcpConnections[id].close();
        } finally {
          this.cleanupClosedConnection(id);
        }
      })
    );

    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Failed to close one or more MCP connections"
      );
    }
  }

  /**
   * Closes a connection to an MCP server
   * @param id The id of the connection to close
   */
  async closeConnection(id: string) {
    const connection = this.mcpConnections[id];
    if (!connection) {
      throw new Error(`Connection with id "${id}" does not exist.`);
    }

    // Cancel any in-flight discovery
    connection.cancelDiscovery();

    // Remove from pending so waitForConnections() doesn't block on a closed server
    this._lanes.forget(id);

    try {
      await connection.close();
    } finally {
      this.cleanupClosedConnection(id);
    }
  }

  /**
   * Remove an MCP server - closes connection if active and removes from storage.
   */
  async removeServer(serverId: string): Promise<void> {
    const connection = this.mcpConnections[serverId];
    let authProvider = connection?.options.transport.authProvider;
    if (!authProvider) {
      // A user-supplied provider factory can throw; that must not stop the
      // server from being removed.
      try {
        authProvider = this.authProviderFromStorage(serverId);
      } catch (error) {
        console.warn(
          `[MCPClientManager] Failed to create auth provider for ${serverId}:`,
          error
        );
      }
    }
    if (connection) {
      try {
        await this.closeConnection(serverId);
      } catch (_e) {
        // Ignore errors when closing
      }
    }
    if (authProvider) await this.clearOAuthStorage(serverId, authProvider);
    this.cancelJob(connectJobId(serverId));
    this.cancelJob(authExpiryJobId(serverId));
    this._servers.remove(serverId);
    this.fireServerStateChanged();
  }

  /**
   * Clear a server's saved OAuth state. This only deletes local state; it
   * does not revoke tokens at the OAuth provider.
   */
  private async clearOAuthStorage(
    serverId: string,
    authProvider: AgentMcpOAuthProvider
  ): Promise<void> {
    try {
      if (authProvider instanceof DurableObjectOAuthClientProvider) {
        await authProvider.clearServerStorage();
      } else {
        await authProvider.invalidateCredentials?.("all");
      }
    } catch (error) {
      console.warn(
        `[MCPClientManager] Failed to clear OAuth credentials for ${serverId}:`,
        error
      );
    }
  }

  /**
   * Rebuild a server's auth provider from its stored row, as restore does,
   * for a server with no live connection.
   */
  private authProviderFromStorage(
    serverId: string
  ): AgentMcpOAuthProvider | undefined {
    const server = this._servers.get(serverId);
    if (!server?.callback_url) return undefined;
    const authProvider = this._createAuthProviderFn
      ? this._createAuthProviderFn(server.callback_url)
      : this.createAuthProvider(
          server.id,
          server.callback_url,
          this._name,
          server.client_id ?? undefined
        );
    authProvider.serverId = server.id;
    if (server.client_id) {
      authProvider.clientId = server.client_id;
    }
    return authProvider;
  }

  /**
   * List all MCP servers from storage
   */
  listServers(): MCPServerRow[] {
    return this._servers.list();
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      await this.closeAllConnections();
    } finally {
      // Dispose manager-level emitters.
      this._onServerStateChanged.dispose();
      this._onObservabilityEvent.dispose();
    }
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of prompts
   */
  listPrompts(filter?: MCPServerFilter): NamespacedData["prompts"] {
    return getNamespacedData(this.filterConnections(filter), "prompts");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resources
   */
  listResources(filter?: MCPServerFilter): NamespacedData["resources"] {
    return getNamespacedData(this.filterConnections(filter), "resources");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resource templates
   */
  listResourceTemplates(
    filter?: MCPServerFilter
  ): NamespacedData["resourceTemplates"] {
    return getNamespacedData(
      this.filterConnections(filter),
      "resourceTemplates"
    );
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
    const unqualifiedName = mcpParams.name.replace(`${serverId}.`, "");
    return this.withAuthorizationRecovery(serverId, (conn) =>
      callV2Tool(
        conn.client,
        { ...mcpParams, name: unqualifiedName },
        schemaOrOptions,
        options
      )
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
    return this.withAuthorizationRecovery(serverId, (conn) =>
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
    return this.withAuthorizationRecovery(serverId, (conn) =>
      conn.client.getPrompt(mcpParams, options)
    );
  }

  /**
   * Run a request on an established connection and surface mid-session
   * re-authorization.
   *
   * A request can fail after connect with `403 insufficient_scope` (scope
   * step-up) or a `401` whose refresh fails. The SDK transport then runs
   * `auth()`, which hands a new authorization URL to the provider and throws
   * `UnauthorizedError`. Left as is, nobody sees that URL, and a callback for
   * it is ignored as stale because the connection is still `ready`. Move the
   * connection to `authenticating` and persist the URL, as the connect path
   * does, so the normal OAuth callback exchanges the code and reconnects.
   */
  private async withAuthorizationRecovery<T>(
    serverId: string,
    request: (conn: MCPClientConnection) => Promise<T>
  ): Promise<T> {
    const conn = this.mcpConnections[serverId];
    if (!conn) throw new MCPConnectionNotFoundError(serverId);
    const authUrlBefore = conn.options.transport.authProvider?.authUrl;
    try {
      return await request(conn);
    } catch (error) {
      throw (
        (await this.requireReauthorization(
          serverId,
          conn,
          error,
          authUrlBefore
        )) ?? error
      );
    }
  }

  private async requireReauthorization(
    serverId: string,
    conn: MCPClientConnection,
    error: unknown,
    authUrlBefore: string | undefined
  ): Promise<MCPAuthorizationRequiredError | undefined> {
    // Only take over an established connection. While a callback is being
    // processed (`connecting`, `discovering`) or after a failure, leave the
    // state machine alone and rethrow.
    const canTakeOver = () => {
      if (this.mcpConnections[serverId] !== conn) return false;
      const state = conn.connectionState;
      return (
        state === MCPConnectionState.READY ||
        state === MCPConnectionState.CONNECTED ||
        state === MCPConnectionState.AUTHENTICATING
      );
    };
    if (!canTakeOver() || !isUnauthorized(error)) return undefined;

    // Only a URL set while this request ran counts; an unchanged one is left
    // over from an earlier flow. A changed one may still belong to a flow
    // that another request started and the user already completed, so also
    // require its state nonce to be redeemable: a link the callback would
    // reject is no use. A custom provider that reuses the same URL gets the
    // original error, as before.
    const authProvider = conn.options.transport.authProvider;
    const authUrl = authProvider?.authUrl;
    if (!authProvider || !authUrl || authUrl === authUrlBefore) {
      return undefined;
    }
    let nonce: string | null = null;
    try {
      nonce = new URL(authUrl).searchParams.get("state");
    } catch {
      return undefined;
    }
    const stateBefore = conn.connectionState;
    if (!nonce || !(await isRedeemableState(serverId, authProvider, nonce))) {
      return undefined;
    }
    // Nothing may have moved while the check ran: not the connection (a
    // callback may have completed) and not the URL that gets saved.
    if (
      !canTakeOver() ||
      conn.connectionState !== stateBefore ||
      authProvider.authUrl !== authUrl
    ) {
      return undefined;
    }

    const auth = this.enterAuthenticating(serverId, conn);
    // An exhausted server is now failed; the caller gets the original error.
    if (auth._tag !== "authenticating") return undefined;
    return new MCPAuthorizationRequiredError(serverId, auth.authUrl, {
      clientId: auth.clientId,
      cause: error
    });
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
