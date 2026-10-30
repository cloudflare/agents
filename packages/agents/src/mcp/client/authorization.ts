import {
  authorizationExhaustedMessage,
  completeRound,
  parseAuthorizationRounds,
  requestedScope,
  startRound
} from "./authorization-rounds";
import { MCPConnectionState, type MCPClientConnection } from "./connection";
import type { McpClientContext } from "./context";
import {
  type AgentMcpOAuthProvider,
  DurableObjectOAuthClientProvider
} from "./do-oauth-client-provider";
import {
  isUnauthorized,
  MCPAuthorizationRequiredError,
  MCPConnectionNotFoundError,
  toErrorMessage
} from "./errors";
import {
  consumeStaleState,
  exchangeAuthorizationCode,
  isOAuthCallbackFor,
  isRedeemableState,
  type MCPClientOAuthCallbackConfig,
  parseOAuthCallback,
  serverIdFromState,
  usableAuthUrl
} from "./oauth-callback";
import { ServerLaneCancelledError } from "./server-lanes";
import type { MCPServerRow } from "./storage";
import type { ServerStatus } from "./status";
import type { MCPOAuthCallbackResult } from "./types";

/** What entering `authenticating` produced. */
type AuthContinuation =
  | {
      readonly _tag: "authenticating";
      readonly authUrl: string;
      readonly clientId?: string;
    }
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "exhausted"; readonly error: string };

/**
 * Everything about authorization links: building OAuth providers, putting a
 * server into `authenticating` with a link (within the step-up round
 * limit), completing OAuth callbacks, turning a request's 401 or step-up
 * into `MCPAuthorizationRequiredError`.
 *
 * A waiting server keeps the link it was given until someone reconnects it.
 * Whether that link still works is up to the authorization server; the
 * callback reports it when it does not. Only a link whose callback was
 * already redeemed is never shown again.
 */
export class AuthorizationController {
  /**
   * The OAuth state each server's callback last redeemed. The provider keeps
   * that link in memory afterwards; it must never be shown again.
   */
  private readonly spentStates = new Map<string, string>();
  /**
   * Step-ups started on a live session, by server: the connection and the
   * state it was in. The session keeps working on its current grant while
   * the user decides, and goes back to that state if they decline.
   */
  private readonly liveStepUps = new Map<
    string,
    {
      readonly conn: MCPClientConnection;
      readonly stateBefore: MCPConnectionState;
    }
  >();
  private callbackConfig: MCPClientOAuthCallbackConfig | undefined;

  constructor(
    private readonly ctx: McpClientContext,
    private readonly status: ServerStatus
  ) {}

  // Providers

  /** Build the OAuth provider for a server that has a callback URL. */
  createProvider(
    serverId: string,
    callbackUrl: string,
    clientName: string,
    clientId?: string
  ): AgentMcpOAuthProvider {
    const provider =
      this.ctx.createAuthProvider?.(callbackUrl) ??
      new DurableObjectOAuthClientProvider(
        this.ctx.storage,
        clientName,
        callbackUrl
      );
    provider.serverId = serverId;
    if (clientId) provider.clientId = clientId;
    return provider;
  }

  /** Rebuild a server's provider from its stored row, as restore does. */
  providerFromRow(
    row: MCPServerRow | undefined
  ): AgentMcpOAuthProvider | undefined {
    if (!row?.callback_url) return undefined;
    return this.createProvider(
      row.id,
      row.callback_url,
      this.ctx.name,
      row.client_id ?? undefined
    );
  }

  /**
   * Clear a server's saved OAuth state. This only deletes local state; it
   * does not revoke tokens at the OAuth provider.
   */
  async clearStorage(
    serverId: string,
    provider: AgentMcpOAuthProvider
  ): Promise<void> {
    try {
      if (provider instanceof DurableObjectOAuthClientProvider) {
        await provider.clearServerStorage();
      } else {
        await provider.invalidateCredentials?.("all");
      }
    } catch (error) {
      console.warn(
        `[MCPClientManager] Failed to clear OAuth credentials for ${serverId}:`,
        error
      );
    }
  }

  // Links

  /**
   * Move a connection to `authenticating` on the link its provider holds.
   * Every path that ends up waiting for the user (connect, discovery, and a
   * request that hits a scope step-up or a failed refresh) goes through
   * here, so the saved `auth_url`, the connection state and the broadcast
   * always agree, and the OAuth callback finds the connection in the state
   * it completes from.
   *
   * Changes nothing when the provider holds no usable link. Records a
   * permanent failure instead of a link once the server has asked for the
   * same authorization past the round limit.
   */
  enterAuthenticating(id: string, conn: MCPClientConnection): AuthContinuation {
    if (this.ctx.connections[id] !== conn) return { _tag: "unavailable" };
    const provider = conn.options.transport.authProvider;
    const authUrl = provider?.authUrl;
    if (!provider || !authUrl || !provider.redirectUrl) {
      return { _tag: "unavailable" };
    }
    // The provider still holds the link whose callback was just redeemed:
    // the server rejected the tokens it produced, and no new flow started.
    if (this.isSpent(id, authUrl)) return { _tag: "unavailable" };

    const round = startRound(
      parseAuthorizationRounds(this.ctx.store.authorizationRounds(id)),
      requestedScope(authUrl),
      Date.now()
    );
    if (round._tag === "exhausted") {
      const error = authorizationExhaustedMessage(round.rounds, round.scope);
      this.status.stop(id, "authorization-exhausted", error);
      return { _tag: "exhausted", error };
    }

    const clientId = provider.clientId;
    this.ctx.store.setAuthContinuation(id, authUrl, clientId);
    this.ctx.store.setAuthorizationRounds(id, round.rounds);
    this.ctx.store.clearFailure(id);
    conn.connectionState = MCPConnectionState.AUTHENTICATING;
    this.ctx.observability.fire({
      type: "mcp:client:authorize",
      payload: { serverId: id, authUrl, clientId },
      timestamp: Date.now()
    });
    this.ctx.stateChanged();
    return { _tag: "authenticating", authUrl, clientId };
  }

  /** Why a 401 left no link to show, for the recorded failure. */
  noLinkReason(id: string, conn: MCPClientConnection): string {
    const provider = conn.options.transport.authProvider;
    if (provider?.authUrl && this.isSpent(id, provider.authUrl)) {
      return "The server still answers 401 after a completed authorization";
    }
    if (!provider?.redirectUrl) {
      return "The server requires authorization, but no OAuth callback is configured to ask the user. Pass callbackHost to addMcpServer(), or a callbackUrl when registering the server.";
    }
    return "OAuth configuration incomplete: the OAuth provider produced no authorization URL";
  }

  /** The link a waiting server was given: the live one, else the stored one. */
  pendingLink(id: string, conn: MCPClientConnection): string | undefined {
    return (
      usableAuthUrl(conn.options.transport.authProvider?.authUrl) ??
      usableAuthUrl(this.ctx.store.get(id)?.auth_url)
    );
  }

  /** Forget a server's link and step-up budget, for an explicit reconnect. */
  forget(id: string): void {
    this.ctx.store.clearAuthUrl(id);
    this.ctx.store.setAuthorizationRounds(id, undefined);
    this.liveStepUps.delete(id);
  }

  private isLiveStepUp(id: string, conn: MCPClientConnection): boolean {
    return this.liveStepUps.get(id)?.conn === conn;
  }

  /**
   * The user declined a step-up: the session still holds its earlier grant,
   * so go back to where it was instead of failing the server. The next
   * request that needs the scope asks again.
   */
  private declineStepUp(
    serverId: string,
    conn: MCPClientConnection,
    error: string
  ): MCPOAuthCallbackResult {
    const stepUp = this.liveStepUps.get(serverId);
    this.liveStepUps.delete(serverId);
    this.ctx.store.clearAuthUrl(serverId);
    conn.connectionState = stepUp?.stateBefore ?? MCPConnectionState.READY;
    conn.connectionError = null;
    this.ctx.stateChanged();
    return { serverId, authSuccess: false, authError: error };
  }

  private isSpent(id: string, authUrl: string): boolean {
    const spent = this.spentStates.get(id);
    return spent !== undefined && stateOf(authUrl) === spent;
  }

  // Requests

  /**
   * Run a request on an established connection and surface mid-session
   * re-authorization.
   *
   * A request can fail after connect with `403 insufficient_scope` (scope
   * step-up) or a `401` whose refresh fails. The SDK then hands a new link
   * to the provider and throws `UnauthorizedError`. Left as is, nobody sees
   * that link, and its callback is ignored as stale because the connection
   * is still `ready`. Enter `authenticating` with it instead, as the connect
   * path does, and throw `MCPAuthorizationRequiredError`.
   */
  async recoverRequest<T>(
    serverId: string,
    request: (conn: MCPClientConnection) => Promise<T>
  ): Promise<T> {
    const conn = this.ctx.connections[serverId];
    if (!conn) throw new MCPConnectionNotFoundError(serverId);
    // Waiting for authorization with no session to fall back on: the
    // request cannot run, and the answer is the link the server waits on.
    if (
      conn.connectionState === MCPConnectionState.AUTHENTICATING &&
      !this.isLiveStepUp(serverId, conn)
    ) {
      const authUrl = this.pendingLink(serverId, conn);
      if (authUrl) {
        throw new MCPAuthorizationRequiredError(serverId, authUrl, {
          clientId: conn.options.transport.authProvider?.clientId
        });
      }
    }
    const authUrlBefore = conn.options.transport.authProvider?.authUrl;
    try {
      return await request(conn);
    } catch (error) {
      throw (
        (await this.authorizationRequired(
          serverId,
          conn,
          error,
          authUrlBefore
        )) ?? error
      );
    }
  }

  private async authorizationRequired(
    serverId: string,
    conn: MCPClientConnection,
    error: unknown,
    authUrlBefore: string | undefined
  ): Promise<MCPAuthorizationRequiredError | undefined> {
    // Only take over an established connection. While a callback is being
    // processed (`connecting`, `discovering`) or after a failure, leave the
    // state machine alone and rethrow.
    const canTakeOver = () => {
      if (this.ctx.connections[serverId] !== conn) return false;
      const state = conn.connectionState;
      return (
        state === MCPConnectionState.READY ||
        state === MCPConnectionState.CONNECTED ||
        state === MCPConnectionState.AUTHENTICATING
      );
    };
    if (!canTakeOver() || !isUnauthorized(error)) return undefined;

    // Only a link set while this request ran counts; an unchanged one is
    // left over from an earlier flow. A changed one may still belong to a
    // flow another request started and the user already completed, so its
    // state must also be redeemable.
    const provider = conn.options.transport.authProvider;
    const authUrl = provider?.authUrl;
    if (!provider || !authUrl || authUrl === authUrlBefore) return undefined;
    const stateBefore = conn.connectionState;
    if (!(await isLive(serverId, authUrl, provider))) return undefined;
    // Nothing may have moved while the check ran.
    if (
      !canTakeOver() ||
      conn.connectionState !== stateBefore ||
      provider.authUrl !== authUrl
    ) {
      return undefined;
    }

    const auth = this.enterAuthenticating(serverId, conn);
    // An exhausted server is now failed; the caller gets the original error.
    if (auth._tag !== "authenticating") return undefined;
    if (stateBefore !== MCPConnectionState.AUTHENTICATING) {
      this.liveStepUps.set(serverId, { conn, stateBefore });
    }
    return new MCPAuthorizationRequiredError(serverId, auth.authUrl, {
      clientId: auth.clientId,
      cause: error
    });
  }

  // Callbacks

  configureCallback(config: MCPClientOAuthCallbackConfig): void {
    this.callbackConfig = config;
  }

  getCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this.callbackConfig;
  }

  /** Whether a request is an OAuth callback for one of these servers. */
  isCallback(request: Request): boolean {
    return isOAuthCallbackFor(request, this.ctx.store.list());
  }

  /**
   * Complete the OAuth flow a callback belongs to: verify its state,
   * exchange its code, and leave the connection ready to reconnect. A
   * callback for a flow already accepted is consumed as a stale success;
   * one whose state cannot be verified changes nothing.
   */
  async handleCallback(request: Request): Promise<MCPOAuthCallbackResult> {
    const serverId = serverIdFromState(
      new URL(request.url).searchParams.get("state")
    );
    if (!serverId) return this.completeCallback(request);
    return this.ctx.lanes
      .run(serverId, () => this.completeCallback(request))
      .catch((error) => {
        // Removed while this callback waited for earlier work.
        if (error instanceof ServerLaneCancelledError) {
          return removedDuringAuthorization(serverId);
        }
        throw error;
      });
  }

  private async completeCallback(
    request: Request
  ): Promise<MCPOAuthCallbackResult> {
    const callback = parseOAuthCallback(request, {
      hasServer: (id) => this.ctx.store.get(id) !== undefined,
      hasConnection: (id) => this.ctx.connections[id] !== undefined
    });

    if (callback._tag === "invalid") {
      const conn = callback.serverId
        ? this.ctx.connections[callback.serverId]
        : undefined;
      if (!callback.serverId || !conn) {
        return {
          serverId: callback.serverId,
          authSuccess: false,
          authError: callback.error
        };
      }
      const provider = conn.options.transport.authProvider;
      if (isPastAuthorization(conn)) {
        if (callback.state && provider) {
          await consumeStaleState(callback.serverId, provider, callback.state);
        }
        return this.staleSuccess(callback.serverId, conn);
      }
      // Only a callback carrying a genuine state nonce may fail the
      // connection; a stray one must not alter the state machine.
      if (
        callback.state &&
        provider &&
        !(await isRedeemableState(callback.serverId, provider, callback.state))
      ) {
        return ignoreUnverified(callback.serverId, callback.error);
      }
      if (this.ctx.connections[callback.serverId] !== conn) {
        return removedDuringAuthorization(callback.serverId);
      }
      return this.fail(callback.serverId, callback.error);
    }

    const { serverId, state, params } = callback;
    const conn = this.ctx.connections[serverId];
    try {
      const provider = conn.options.transport.authProvider;
      if (!provider) {
        throw new Error(
          "Trying to finalize authentication for a server connection without an authProvider"
        );
      }
      provider.serverId = serverId;

      // Check first and consume later, so an attacker cannot burn a valid
      // state before the real callback arrives.
      const validation = await provider.checkState(state);
      if (!validation.valid) {
        if (isPastAuthorization(conn)) {
          await consumeStaleState(serverId, provider, state);
          return this.staleSuccess(serverId, conn);
        }
        return ignoreUnverified(
          serverId,
          params.get("error_description") ??
            params.get("error") ??
            validation.error ??
            "Invalid state"
        );
      }

      // A stale popup can complete after another callback already exchanged
      // tokens: succeed, but consume its state so it cannot be replayed.
      if (isPastAuthorization(conn)) {
        await consumeStaleState(serverId, provider, state);
        return this.staleSuccess(serverId, conn);
      }

      if (
        conn.connectionState !== MCPConnectionState.AUTHENTICATING &&
        conn.connectionState !== MCPConnectionState.FAILED
      ) {
        throw new Error(
          `Failed to authenticate from "${conn.connectionState}" state`
        );
      }

      // The user declined a step-up: the session keeps its current grant.
      const declined = params.get("error");
      if (declined && this.isLiveStepUp(serverId, conn)) {
        await consumeStaleState(serverId, provider, state);
        return this.declineStepUp(serverId, conn, declined);
      }

      // A genuine callback can recover a flow that previously failed.
      conn.connectionState = MCPConnectionState.CONNECTING;
      // Forget the link before redeeming it. If the isolate dies during the
      // exchange, a later wake reconnects instead of restoring a spent link.
      this.ctx.store.clearAuthUrl(serverId);
      this.liveStepUps.delete(serverId);
      this.spentStates.set(serverId, state);
      await provider.consumeState(state);
      await exchangeAuthorizationCode(serverId, conn, provider, state, params);
      if (this.ctx.connections[serverId] !== conn) {
        // Removed while the code was exchanged: the tokens just saved
        // outlived removeServer's cleanup, so clear them again.
        await this.clearStorage(serverId, provider);
        return removedDuringAuthorization(serverId);
      }
      this.status.saveSession(serverId, conn);
      this.ctx.store.setAuthorizationRounds(
        serverId,
        completeRound(
          parseAuthorizationRounds(this.ctx.store.authorizationRounds(serverId))
        )
      );
      const result = this.success(serverId, conn);
      this.ctx.stateChanged();
      return result;
    } catch (error) {
      // A server removed (and maybe re-registered) meanwhile is not ours to
      // fail: the replacement keeps its own state and pending link.
      if (this.ctx.connections[serverId] !== conn) {
        return removedDuringAuthorization(serverId);
      }
      return this.fail(serverId, toErrorMessage(error));
    }
  }

  /**
   * The user denied the authorization or its code could not be exchanged.
   * Recorded, so a later wake does not start another flow nobody asked for.
   */
  private fail(serverId: string, error: string): MCPOAuthCallbackResult {
    this.liveStepUps.delete(serverId);
    if (this.ctx.store.get(serverId)) {
      this.status.stop(serverId, "authorization-failed", error);
    } else if (this.ctx.connections[serverId]) {
      this.ctx.connections[serverId].connectionState =
        MCPConnectionState.FAILED;
      this.ctx.connections[serverId].connectionError = error;
      this.ctx.stateChanged();
    }
    return { serverId, authSuccess: false, authError: error };
  }

  /**
   * Success for a callback whose flow was already accepted, unless the
   * server was removed while its state was cleaned up.
   */
  private staleSuccess(
    serverId: string,
    conn: MCPClientConnection
  ): MCPOAuthCallbackResult {
    if (this.ctx.connections[serverId] !== conn) {
      return removedDuringAuthorization(serverId);
    }
    return this.success(serverId, conn);
  }

  private success(
    serverId: string,
    conn: MCPClientConnection
  ): MCPOAuthCallbackResult {
    this.ctx.store.clearAuthUrl(serverId);
    conn.connectionError = null;
    return { serverId, authSuccess: true };
  }
}

/** Whether a connection's flow was already accepted by a callback. */
function isPastAuthorization(conn: MCPClientConnection): boolean {
  return (
    conn.connectionState === MCPConnectionState.READY ||
    conn.connectionState === MCPConnectionState.CONNECTED ||
    conn.connectionState === MCPConnectionState.CONNECTING ||
    conn.connectionState === MCPConnectionState.DISCOVERING
  );
}

function ignoreUnverified(
  serverId: string,
  error: string
): MCPOAuthCallbackResult {
  console.warn(
    `[MCPClientManager] Ignoring OAuth callback with unverified state for server "${serverId}": ${error}`
  );
  return { serverId, authSuccess: false, authError: error };
}

/** Result for a callback whose server was removed while it was handled. */
function removedDuringAuthorization(serverId: string): MCPOAuthCallbackResult {
  return {
    serverId,
    authSuccess: false,
    authError: `Server ${serverId} was removed during authorization`
  };
}

/** Whether a link's `state` can still be redeemed. */
async function isLive(
  serverId: string,
  authUrl: string,
  provider: AgentMcpOAuthProvider
): Promise<boolean> {
  const state = stateOf(authUrl);
  return state ? isRedeemableState(serverId, provider, state) : false;
}

function stateOf(authUrl: string): string | null {
  try {
    return new URL(authUrl).searchParams.get("state");
  } catch {
    return null;
  }
}
