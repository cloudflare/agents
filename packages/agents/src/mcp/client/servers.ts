import type { DiscoverResult } from "@modelcontextprotocol/client";
import { DisposableStore } from "../../core/events";
import { type RetryOptions, tryN } from "../../retries";
import { RPC_DO_PREFIX } from "../rpc";
import type { McpClientOptions, TransportType } from "../types";
import type { AuthorizationController } from "./authorization";
import {
  MCPClientConnection,
  MCPConnectionState,
  type MCPDiscoveryResult,
  type MCPTransportOptions
} from "./connection";
import type { McpClientContext } from "./context";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type { ElicitationHandlers } from "./elicitation";
import { toErrorMessage } from "./errors";
import type { McpJobs } from "./jobs";
import { resolveRpcTransport } from "./rpc";
import { ServerLaneCancelledError } from "./server-lanes";
import { needsPerson } from "./server-store";
import type { ServerStatus } from "./status";
import {
  decodeMcpServerOptions,
  encodeMcpServerOptions,
  type MCPServerRow
} from "./storage";
import type {
  MCPConnectionResult,
  MCPDiscoverResult,
  MCPServerSettlement,
  RegisterServerOptions
} from "./types";
import { isBlockedUrl } from "./url-policy";

/**
 * The manager's public connection methods. Internal paths call through
 * them, so a subclass that overrides one (or a test that spies on it) sees
 * every connect and discovery, not only the ones callers start.
 */
export type ConnectionEntryPoints = {
  connectToServer(id: string): Promise<MCPConnectionResult>;
  discoverIfConnected(
    id: string,
    options?: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult | undefined>;
};

/**
 * The life of each server: register, connect, discover, restore on wake,
 * settle for `addMcpServer()`, reconnect on request, close, remove, rename.
 *
 * All of it runs in the server's lane, one operation at a time. After every
 * failed connect or discovery, {@link afterFailure} is the one place that
 * decides what happens next: retry later, or stop with a recorded reason.
 */
export class ServerController {
  private readonly disposables = new Map<string, DisposableStore>();

  constructor(
    private readonly ctx: McpClientContext,
    private readonly jobs: McpJobs,
    private readonly status: ServerStatus,
    private readonly authorization: AuthorizationController,
    private readonly elicitation: ElicitationHandlers,
    private readonly entry: ConnectionEntryPoints
  ) {}

  // Registering

  /** Create the connection and save the server, without connecting. */
  register(id: string, options: RegisterServerOptions): void {
    assertAllowedUrl(options.url);
    const authProvider =
      options.transport?.authProvider ??
      (options.callbackUrl
        ? this.authorization.createProvider(
            id,
            options.callbackUrl,
            this.ctx.name,
            options.clientId
          )
        : undefined);
    if (authProvider) {
      authProvider.serverId = id;
      if (options.clientId) authProvider.clientId = options.clientId;
    }

    this.createConnection(id, options.url, {
      client: options.client,
      transport: {
        ...options.transport,
        authProvider,
        type: options.transport?.type ?? ("auto" as TransportType)
      }
    });

    this.ctx.store.save({
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
        capabilities: this.elicitation.capabilities()
      })
    });
    // Registering again is a fresh start for the server.
    this.ctx.store.clearFailure(id);
    this.ctx.store.setAuthorizationRounds(id, undefined);
    this.ctx.stateChanged();
  }

  /**
   * Create the in-memory connection, or return the one that exists, and
   * pipe its events to the manager. Does not save anything.
   */
  createConnection(
    id: string,
    url: string,
    options: {
      client?: McpClientOptions;
      transport: MCPTransportOptions;
      discoverResult?: DiscoverResult;
    }
  ): MCPClientConnection {
    const existing = this.ctx.connections[id];
    if (existing) return existing;

    // Stored servers re-advertise the capabilities saved on their row;
    // fresh registrations rely on the handlers. The stamp is read without
    // clearing, so a wake that never handshakes does not burn it.
    const capabilitySeed = this.ctx.store.options(id)?.capabilities;
    const conn = new MCPClientConnection(
      new URL(url),
      { name: this.ctx.name, version: this.ctx.version },
      {
        client: options.client ?? {},
        transport: {
          ...options.transport,
          type: options.transport?.type ?? ("auto" as TransportType)
        },
        elicitationHandlers: this.elicitation.scopedTo(id),
        capabilitySeed,
        discoverResult: options.discoverResult
      }
    );
    this.ctx.connections[id] = conn;

    const store = new DisposableStore();
    this.disposables.get(id)?.dispose();
    this.disposables.set(id, store);
    store.add(
      conn.onObservabilityEvent((event) => this.ctx.observability.fire(event))
    );
    store.add(conn.onListChanged(() => this.ctx.stateChanged()));

    if (capabilitySeed) {
      // The first successful handshake uses the seed up. Only deploys that
      // stopped configuring handlers clear the stamp; with handlers
      // configured, each configure call re-stamps it.
      const seedClear = conn.onObservabilityEvent((event) => {
        if (
          event.type !== "mcp:client:connect" ||
          event.payload.state !== MCPConnectionState.CONNECTED
        ) {
          return;
        }
        seedClear.dispose();
        if (this.elicitation.configured || !conn.options.capabilitySeed) {
          return;
        }
        // The row may have been renamed while the handshake was in flight.
        const currentId = this.idOf(conn);
        if (currentId) this.ctx.store.clearCapabilities(currentId);
      });
      store.add(seedClear);
    }
    return conn;
  }

  // Connecting

  /**
   * One connect attempt, in the server's lane. The manager's
   * `connectToServer()`.
   */
  connect(id: string): Promise<MCPConnectionResult> {
    return this.ctx.lanes.run(id, () => this.connectInLane(id));
  }

  private async connectInLane(id: string): Promise<MCPConnectionResult> {
    const conn = this.ctx.connections[id];
    if (!conn) {
      throw new Error(
        `Server ${id} is not registered. Call registerServer() first.`
      );
    }
    // Automatic paths never reach a server with a recorded failure, so this
    // is an explicit reconnect: forget why it stopped, including an
    // exhausted step-up budget.
    if (this.ctx.store.failure(id)) {
      this.ctx.store.clearFailure(id);
      this.ctx.store.setAuthorizationRounds(id, undefined);
    }

    const error = await conn.init();
    if (this.ctx.connections[id] !== conn) {
      // Removed or replaced while connecting: nothing from this attempt may
      // reach the catalog or a newer connection under the same id.
      await conn.close().catch(() => {});
      return {
        state: MCPConnectionState.FAILED,
        error: `Server ${id} was removed while connecting`
      };
    }
    this.status.saveSession(id, conn);
    this.ctx.stateChanged();

    switch (conn.connectionState) {
      case MCPConnectionState.FAILED:
        return {
          state: MCPConnectionState.FAILED,
          error: error ?? "Unknown connection error"
        };
      case MCPConnectionState.AUTHENTICATING: {
        const auth = this.authorization.enterAuthenticating(id, conn);
        switch (auth._tag) {
          case "authenticating":
            return {
              state: MCPConnectionState.AUTHENTICATING,
              authUrl: auth.authUrl,
              clientId: auth.clientId
            };
          case "exhausted":
            return { state: MCPConnectionState.FAILED, error: auth.error };
          case "unavailable":
            // A 401 nothing here can answer with a link: retrying gets the
            // same 401, so automatic reconnects stop.
            conn.accessRefused = true;
            return {
              state: MCPConnectionState.FAILED,
              error: this.authorization.noLinkReason(id, conn)
            };
        }
      }
      case MCPConnectionState.CONNECTED:
        return { state: MCPConnectionState.CONNECTED };
      default:
        return {
          state: MCPConnectionState.FAILED,
          error: `Unexpected connection state after init: ${conn.connectionState}`
        };
    }
  }

  /**
   * Discover a connected server, in its lane. The manager's
   * `discoverIfConnected()`.
   */
  discover(
    id: string,
    options: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult | undefined> {
    return this.ctx.lanes.run(id, () => this.discoverInLane(id, options));
  }

  private async discoverInLane(
    id: string,
    options: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult | undefined> {
    const conn = this.ctx.connections[id];
    if (!conn) {
      this.ctx.observability.fire({
        type: "mcp:client:discover",
        payload: {},
        timestamp: Date.now()
      });
      return undefined;
    }

    const result = await conn.discover(options);
    if (this.ctx.connections[id] !== conn) {
      // Removed or replaced while discovering; leave storage alone.
      return discoverResult(conn, result);
    }
    if (!result.success && result.reason === "stale-session") {
      return this.recoverStaleSession(conn, id, options);
    }
    if (result.success) this.status.ready(id);
    // A 401 during discovery (initialize open, catalogs protected) waits for
    // the user exactly like a 401 at connect.
    const auth =
      conn.connectionState === MCPConnectionState.AUTHENTICATING
        ? this.authorization.enterAuthenticating(id, conn)
        : undefined;
    this.ctx.stateChanged();
    return discoverResult(conn, result, auth);
  }

  /** A resumed session the server forgot: start a fresh one and discover. */
  private async recoverStaleSession(
    conn: MCPClientConnection,
    id: string,
    options: { timeoutMs?: number }
  ): Promise<MCPDiscoverResult> {
    conn.clearResumedSession();
    this.ctx.store.setSession(id);

    let connected: MCPConnectionResult;
    try {
      connected = await this.entry.connectToServer(id);
    } catch (error) {
      return {
        success: false,
        error: toErrorMessage(error),
        state: conn.connectionState
      };
    }
    if (connected.state === MCPConnectionState.AUTHENTICATING) {
      // The fresh session needs the user: keep the link it produced.
      return {
        success: false,
        error: "The server requires authorization",
        state: conn.connectionState,
        authUrl: connected.authUrl,
        clientId: connected.clientId
      };
    }
    if (connected.state !== MCPConnectionState.CONNECTED) {
      return {
        success: false,
        error: connected.error,
        state: conn.connectionState
      };
    }
    const result = await conn.discover(options);
    this.ctx.stateChanged();
    return discoverResult(conn, result);
  }

  /**
   * Connect and discover as one unit of lane work, then act on the outcome
   * through {@link afterFailure}. `quick` first retries short blips in place
   * with the server's retry options.
   */
  private bringUp(
    id: string,
    retries: "quick" | "single"
  ): Promise<MCPServerSettlement> {
    return this.ctx.lanes.run(id, async (): Promise<MCPServerSettlement> => {
      let connected: MCPConnectionResult;
      try {
        connected =
          retries === "quick"
            ? await this.connectWithRetry(id, this.ctx.store.options(id)?.retry)
            : await this.entry.connectToServer(id);
      } catch (error) {
        connected = {
          state: MCPConnectionState.FAILED,
          error: toErrorMessage(error)
        };
      }
      const settlement: MCPServerSettlement =
        connected.state === MCPConnectionState.CONNECTED
          ? await this.settleDiscovery(id)
          : connected.state === MCPConnectionState.AUTHENTICATING
            ? {
                state: MCPConnectionState.AUTHENTICATING,
                authUrl: connected.authUrl
              }
            : this.failed(id, "connect", connected.error);
      if (settlement.state === MCPConnectionState.FAILED) {
        this.afterFailure(id, settlement);
      }
      return settlement;
    });
  }

  private async settleDiscovery(id: string): Promise<MCPServerSettlement> {
    const discovered = await this.entry.discoverIfConnected(id);
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
      return this.failed(
        id,
        "discover",
        discovered?.error ?? "connection not found"
      );
    }
    return { state: MCPConnectionState.READY };
  }

  /** A failed settlement, marked refused when the connection was refused. */
  private failed(
    id: string,
    phase: "connect" | "discover",
    error: string
  ): MCPServerSettlement {
    return {
      state: MCPConnectionState.FAILED,
      phase,
      error,
      ...(this.ctx.connections[id]?.accessRefused && { refused: true as const })
    };
  }

  /**
   * After a failed connect or discovery: retry later when the failure may
   * pass (the network, a 5xx, a timeout, a temporarily unavailable
   * authorization server), or stop and record it when authorization was
   * refused, since every retry would get the same answer.
   */
  private afterFailure(
    id: string,
    settlement: { readonly error: string; readonly refused?: true }
  ): void {
    if (!this.ctx.connections[id] || !this.ctx.store.get(id)) return;
    // Already stopped for a recorded reason (the step-up limit, say).
    if (this.ctx.store.failure(id)) return;
    if (settlement.refused) {
      this.status.stop(
        id,
        "authorization-failed",
        `Authorization was refused: ${settlement.error}. Reconnect the server once it can be authorized.`
      );
      return;
    }
    const { gaveUpAfter } = this.jobs.scheduleReconnect(id, settlement.error);
    if (gaveUpAfter !== undefined) {
      this.status.stop(
        id,
        "reconnect-exhausted",
        `Stopped reconnecting after ${gaveUpAfter} attempts: ${settlement.error}`
      );
      return;
    }
    // Show why while the reconnect waits, as a wake does, and tell clients.
    this.ctx.connections[id].connectionError = settlement.error;
    this.ctx.stateChanged();
  }

  private async connectWithRetry(
    id: string,
    retry?: RetryOptions
  ): Promise<MCPConnectionResult> {
    try {
      return await tryN(
        retry?.maxAttempts ?? 3,
        async () => {
          const result = await this.entry.connectToServer(id);
          // A refusal gets the same answer on every attempt.
          if (
            result.state === MCPConnectionState.FAILED &&
            !this.ctx.connections[id]?.accessRefused
          ) {
            throw new ConnectRetryError(result);
          }
          return result;
        },
        {
          baseDelayMs: retry?.baseDelayMs ?? 500,
          maxDelayMs: retry?.maxDelayMs ?? 5000
        }
      );
    } catch (error) {
      if (error instanceof ConnectRetryError) return error.result;
      throw error;
    }
  }

  // What the manager and the Agent call

  /** Connect and discover a registered server. */
  connectAndDiscover(id: string): Promise<MCPServerSettlement> {
    return removedIfCancelled(this.bringUp(id, "single"));
  }

  /**
   * Bring a registered server to a settled state once the work queued for
   * it has run, for `addMcpServer()`: a ready server stays ready, a link
   * that still works keeps waiting, a dead link is replaced, a connected
   * server is discovered, and a server that is not connected is connected,
   * at most once per first backoff step. A server stopped for a reason only
   * a person can fix is reported as failed; retrying it is reconnect()'s job.
   */
  settle(id: string): Promise<MCPServerSettlement> {
    return removedIfCancelled(
      this.ctx.lanes.run(id, async (): Promise<MCPServerSettlement> => {
        const conn = this.ctx.connections[id];
        if (!conn) return { state: "removed" };
        switch (conn.connectionState) {
          case MCPConnectionState.READY:
            return { state: MCPConnectionState.READY };
          case MCPConnectionState.FAILED: {
            // Apps call addMcpServer() from onStart, onConnect and request
            // handlers. Retry what can pass, at most once per first backoff
            // step, and leave what only a person can fix to reconnect().
            const failure = this.ctx.store.failure(id);
            const error = conn.connectionError ?? "Connection failed";
            if (failure && needsPerson(failure)) {
              return {
                state: MCPConnectionState.FAILED,
                phase: "connect",
                error: `${error} Call reconnectMcpServer("${id}") to try again.`
              };
            }
            const failedAt =
              failure?.at ?? this.jobs.pendingReconnect(id)?.failedAt;
            if (this.jobs.tooSoonToRetry(failedAt)) {
              return {
                state: MCPConnectionState.FAILED,
                phase: "connect",
                error
              };
            }
            return this.connectAndDiscover(id);
          }
          case MCPConnectionState.CONNECTED: {
            const settlement = await this.settleDiscovery(id);
            if (settlement.state === MCPConnectionState.FAILED) {
              this.afterFailure(id, settlement);
            }
            return settlement;
          }
          case MCPConnectionState.AUTHENTICATING: {
            const authUrl = await this.authorization.usableLink(id, conn);
            if (authUrl) {
              return { state: MCPConnectionState.AUTHENTICATING, authUrl };
            }
            // The link can no longer complete: start a fresh flow.
            return this.connectAndDiscover(id);
          }
          case MCPConnectionState.CONNECTING:
          case MCPConnectionState.DISCOVERING:
            // Nothing queued is driving it any more, so drive it.
            return this.connectAndDiscover(id);
        }
      })
    );
  }

  /**
   * Try a server again because someone asked: forget a recorded failure,
   * its link and step-up budget, drop pending jobs, and connect now. The
   * only path that retries a failed server on demand.
   */
  reconnect(id: string): Promise<MCPServerSettlement> {
    return removedIfCancelled(
      this.ctx.lanes.run(id, async () => {
        if (!this.ctx.connections[id]) return { state: "removed" as const };
        this.ctx.store.clearFailure(id);
        this.authorization.forget(id);
        this.jobs.cancelReconnect(id);
        return this.connectAndDiscover(id);
      })
    );
  }

  /** Connect and discover after an OAuth callback, in the background. */
  establish(id: string): Promise<void> {
    return this.ctx.lanes.run(id, async () => {
      const conn = this.ctx.connections[id];
      if (!conn) {
        this.ctx.observability.fire({
          type: "mcp:client:preconnect",
          payload: { serverId: id },
          timestamp: Date.now()
        });
        return;
      }
      // Already discovering or ready: nothing to do.
      if (
        conn.connectionState !== MCPConnectionState.DISCOVERING &&
        conn.connectionState !== MCPConnectionState.READY
      ) {
        await this.bringUp(id, "quick");
        this.ctx.stateChanged();
      }
      this.ctx.observability.fire({
        type: "mcp:client:connect",
        payload: {
          url: conn.url.toString(),
          transport: conn.options.transport.type || "unknown",
          state: conn.connectionState
        },
        timestamp: Date.now()
      });
    });
  }

  // Waking

  /**
   * Rebuild the connections of stored HTTP servers on wake. A server with a
   * recorded failure stays failed, a waiting flow keeps waiting while its
   * link works, a server with a reconnect scheduled waits for it, and the
   * rest connect in the background.
   *
   * @param clientName - Durable Object identity used to scope OAuth state.
   */
  async restore(clientName: string): Promise<void> {
    for (const server of this.ctx.store.list()) {
      if (server.server_url.startsWith(RPC_DO_PREFIX)) continue;
      if (!(await this.dropStaleConnection(server.id))) continue;

      const options = decodeMcpServerOptions(server.server_options);
      const authProvider: AgentMcpOAuthProvider | undefined =
        server.callback_url
          ? this.authorization.createProvider(
              server.id,
              server.callback_url,
              clientName,
              server.client_id ?? undefined
            )
          : undefined;
      const conn = this.createConnection(server.id, server.server_url, {
        client: options?.client ?? {},
        transport: {
          ...(options?.transport ?? {}),
          type: options?.transport?.type ?? ("auto" as TransportType),
          authProvider
        },
        discoverResult: options?.discoverResult
      });

      if (this.showRecordedFailure(server, conn)) continue;
      if (server.auth_url) {
        await this.authorization.resumeLink(server, conn, server.auth_url);
        continue;
      }
      if (this.waitForScheduledReconnect(server.id, conn)) continue;
      this.connectInBackground(server.id);
    }
  }

  /**
   * Rebuild stored RPC servers. Like HTTP servers they connect in the
   * background: startup has a 30s budget a slow `McpAgent` must not hold.
   */
  restoreRpc(): void {
    for (const server of this.ctx.store.listRpc()) {
      if (this.ctx.connections[server.id]) continue;
      const resolved = resolveRpcTransport(this.ctx.env, server);
      if (resolved._tag === "unresolved") {
        console.warn(
          `[MCPClientManager] Cannot restore RPC MCP server "${server.name}": ${resolved.reason}`
        );
        continue;
      }
      const conn = this.createConnection(server.id, server.server_url, {
        transport: resolved.transport
      });
      if (this.showRecordedFailure(server, conn)) continue;
      if (this.waitForScheduledReconnect(server.id, conn)) continue;
      this.connectInBackground(server.id);
    }
  }

  /**
   * Leave a live connection alone (ready, or a flow in progress), or close
   * a failed one so it can be rebuilt. Returns whether to rebuild.
   */
  private async dropStaleConnection(id: string): Promise<boolean> {
    const existing = this.ctx.connections[id];
    if (!existing) return true;
    switch (existing.connectionState) {
      case MCPConnectionState.READY:
        console.warn(
          `[MCPClientManager] Server ${id} already has a ready connection. Skipping recreation.`
        );
        return false;
      case MCPConnectionState.AUTHENTICATING:
      case MCPConnectionState.CONNECTING:
      case MCPConnectionState.DISCOVERING:
        return false;
      case MCPConnectionState.FAILED:
        try {
          await existing.close();
        } catch (error) {
          console.warn(
            `[MCPClientManager] Error closing failed connection ${id}:`,
            error
          );
        } finally {
          this.forgetConnection(id);
        }
        return true;
      default:
        return true;
    }
  }

  /** Show a recorded failure on a rebuilt connection. */
  private showRecordedFailure(
    server: MCPServerRow,
    conn: MCPClientConnection
  ): boolean {
    const failure = this.ctx.store.failure(server.id);
    if (!failure) return false;
    conn.connectionState = MCPConnectionState.FAILED;
    conn.connectionError = failure.message;
    return true;
  }

  /**
   * A server with a reconnect scheduled waits for it instead of connecting
   * on every wake, so the backoff holds. Shows the last error meanwhile.
   */
  private waitForScheduledReconnect(
    id: string,
    conn: MCPClientConnection
  ): boolean {
    const pending = this.jobs.pendingReconnect(id);
    if (!pending) return false;
    conn.connectionState = MCPConnectionState.FAILED;
    conn.connectionError = pending.error;
    return true;
  }

  private connectInBackground(id: string): void {
    void this.bringUp(id, "quick").catch((error) => {
      if (error instanceof ServerLaneCancelledError) return;
      console.error(`[MCPClientManager] Error restoring ${id}:`, error);
    });
  }

  /**
   * The `connect` job: one reconnect attempt. Skips when another path
   * already moved the server on: removed, connected, waiting for
   * authorization, or stopped with a recorded failure.
   */
  async runReconnect(id: string): Promise<void> {
    await this.ctx.lanes
      .run(id, async () => {
        const conn = this.ctx.connections[id];
        if (!conn || !this.ctx.store.get(id)) return;
        if (this.ctx.store.failure(id)) return;
        if (
          conn.connectionState === MCPConnectionState.READY ||
          conn.connectionState === MCPConnectionState.AUTHENTICATING
        ) {
          return;
        }
        await this.bringUp(id, "single");
      })
      .catch((error) => {
        // Removed while this attempt was queued: nothing left to reconnect.
        if (!(error instanceof ServerLaneCancelledError)) throw error;
      });
  }

  // Closing and removing

  /** Close a server's connection and cancel its queued work. */
  async close(id: string): Promise<void> {
    const conn = this.ctx.connections[id];
    if (!conn) throw new Error(`Connection with id "${id}" does not exist.`);
    conn.cancelDiscovery();
    // Queued work for a closed server would only reconnect it.
    this.ctx.lanes.forget(id);
    try {
      await conn.close();
    } finally {
      this.forgetConnection(id);
    }
  }

  /** Close every connection, keeping the servers stored. */
  async closeAll(): Promise<void> {
    const ids = Object.keys(this.ctx.connections);
    this.ctx.lanes.forgetAll();
    for (const id of ids) this.ctx.connections[id].cancelDiscovery();
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await this.ctx.connections[id].close();
        } finally {
          this.forgetConnection(id);
        }
      })
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Failed to close one or more MCP connections"
      );
    }
  }

  /** Close a server's connection and delete it with its OAuth state. */
  async remove(id: string): Promise<void> {
    const conn = this.ctx.connections[id];
    let authProvider = conn?.options.transport.authProvider;
    if (!authProvider) {
      // A user-supplied provider factory can throw; that must not stop the
      // server from being removed.
      try {
        authProvider = this.authorization.providerFromRow(
          this.ctx.store.get(id)
        );
      } catch (error) {
        console.warn(
          `[MCPClientManager] Failed to create auth provider for ${id}:`,
          error
        );
      }
    }
    if (conn) await this.close(id).catch(() => {});
    if (authProvider) await this.authorization.clearStorage(id, authProvider);
    this.jobs.cancelAll(id);
    this.ctx.store.remove(id);
    this.ctx.stateChanged();
  }

  /**
   * Rename a server's id everywhere it is a key: its row, its connection,
   * its provider, its OAuth storage keys and its pending jobs. A no-op when
   * the ids match; throws when `newId` is taken.
   */
  async migrate(
    oldId: string,
    newId: string,
    clientName: string
  ): Promise<void> {
    if (oldId === newId) return;
    // Restore work closes over oldId; drain it before renaming.
    await this.ctx.lanes.idle(oldId);

    const renamed = this.ctx.store.rename(oldId, newId);
    if (renamed === "missing") {
      this.renameConnection(oldId, newId);
      return;
    }
    if (renamed === "collision") {
      throw new Error(
        `Cannot migrate MCP server id "${oldId}" → "${newId}": new id is already in use.`
      );
    }
    await this.renameOAuthKeys(
      `/${clientName}/${oldId}/`,
      `/${clientName}/${newId}/`
    );
    this.renameConnection(oldId, newId);
    this.jobs.move(oldId, newId);
    this.ctx.stateChanged();
  }

  /**
   * Move the provider's storage keys to the new id. Best-effort: the row is
   * already renamed, so a failure here is logged, not thrown.
   */
  private async renameOAuthKeys(
    oldPrefix: string,
    newPrefix: string
  ): Promise<void> {
    try {
      const keys = await this.ctx.storage.list({ prefix: oldPrefix });
      if (keys.size === 0) return;
      const writes: Record<string, unknown> = {};
      for (const [oldKey, value] of keys) {
        writes[newPrefix + oldKey.slice(oldPrefix.length)] = value;
      }
      await this.ctx.storage.put(writes);
      await this.ctx.storage.delete([...keys.keys()]);
    } catch (error) {
      console.warn(
        `[MCPClientManager] OAuth key migration ${oldPrefix} → ${newPrefix} failed:`,
        error
      );
    }
  }

  private renameConnection(oldId: string, newId: string): void {
    const conn = this.ctx.connections[oldId];
    if (conn) {
      this.ctx.connections[newId] = conn;
      delete this.ctx.connections[oldId];
      const authProvider = conn.options.transport.authProvider;
      if (authProvider) authProvider.serverId = newId;
      // The elicitation handler closes over the old id. With no handlers
      // there is nothing to rescope, and configuring would wipe the
      // connection's restored capability seed.
      const scoped = this.elicitation.scopedTo(newId);
      if (scoped) conn.configureElicitationHandlers(scoped);
    }
    const disposables = this.disposables.get(oldId);
    if (disposables) {
      this.disposables.set(newId, disposables);
      this.disposables.delete(oldId);
    }
  }

  /** Drop a closed connection and its session; the server stays stored. */
  private forgetConnection(id: string): void {
    this.ctx.store.setSession(id);
    this.disposables.get(id)?.dispose();
    this.disposables.delete(id);
    delete this.ctx.connections[id];
  }

  private idOf(conn: MCPClientConnection): string | undefined {
    return Object.keys(this.ctx.connections).find(
      (key) => this.ctx.connections[key] === conn
    );
  }
}

/** Throw for a URL the SSRF policy blocks. */
export function assertAllowedUrl(url: string): void {
  if (isBlockedUrl(url)) {
    throw new Error(
      `Blocked URL: ${url} — MCP client connections to private/internal addresses are not allowed`
    );
  }
}

/** Report work cancelled by removal as a removed server. */
async function removedIfCancelled(
  work: Promise<MCPServerSettlement>
): Promise<MCPServerSettlement> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ServerLaneCancelledError) return { state: "removed" };
    throw error;
  }
}

function discoverResult(
  conn: MCPClientConnection,
  result: MCPDiscoveryResult,
  auth?: ReturnType<AuthorizationController["enterAuthenticating"]>
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

/** Converts a resolved connection failure into a retry signal. */
class ConnectRetryError extends Error {
  constructor(readonly result: MCPConnectionResult) {
    super("MCP connection attempt failed");
  }
}
