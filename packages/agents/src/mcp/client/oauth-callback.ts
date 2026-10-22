/**
 * The OAuth callback leg of the MCP client: recognizing a callback request,
 * parsing it, checking and consuming its `state` nonce, exchanging its code
 * inside the PKCE verifier scope of that state, and rendering the response.
 * Connection state transitions stay with the manager.
 */

import type { MCPClientConnection } from "./connection";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type { MCPServerRow } from "./storage";

/** Configures how the manager answers an OAuth callback request. */
export type MCPClientOAuthCallbackConfig = {
  /** Redirect target after a successful callback. */
  successRedirect?: string;
  /** Redirect target after a failed callback; `error` is appended. */
  errorRedirect?: string;
  /** Build the response yourself; takes precedence over the redirects. */
  customHandler?: (result: MCPClientOAuthResult) => Response;
};

/** Outcome of an OAuth callback request. */
export type MCPClientOAuthResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | {
      serverId?: string;
      authSuccess: false;
      /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
      authError: string;
    };

/** A callback request, parsed far enough to find its connection. */
export type ParsedOAuthCallback =
  | {
      readonly _tag: "callback";
      readonly serverId: string;
      readonly state: string;
      readonly params: URLSearchParams;
    }
  | {
      readonly _tag: "invalid";
      readonly serverId?: string;
      readonly state?: string;
      readonly error: string;
    };

/** Server id embedded in an OAuth `state` of the form `{nonce}.{serverId}`. */
export function serverIdFromState(state: string | null): string | null {
  if (!state) return null;
  const parts = state.split(".");
  return parts.length === 2 ? parts[1] : null;
}

/**
 * Whether a request is an OAuth callback for one of the stored servers: a
 * `GET` whose `state` names a server and whose origin and path match that
 * server's registered callback URL, so unrelated requests carrying a
 * `state` parameter are left alone.
 */
export function isOAuthCallbackFor(
  request: Request,
  servers: readonly MCPServerRow[]
): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  const serverId = serverIdFromState(url.searchParams.get("state"));
  if (!serverId) return false;
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

/** Parse a callback request and find the server and connection it targets. */
export function parseOAuthCallback(
  request: Request,
  lookup: {
    readonly hasServer: (id: string) => boolean;
    readonly hasConnection: (id: string) => boolean;
  }
): ParsedOAuthCallback {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (!state) {
    return { _tag: "invalid", error: "Unauthorized: no state provided" };
  }
  const serverId = serverIdFromState(state);
  if (!serverId) {
    return {
      _tag: "invalid",
      error:
        "No serverId found in state parameter. Expected format: {nonce}.{serverId}"
    };
  }
  if (!code && !error) {
    return {
      _tag: "invalid",
      serverId,
      state,
      error: "Unauthorized: no code provided"
    };
  }
  if (!lookup.hasServer(serverId)) {
    return {
      _tag: "invalid",
      serverId,
      error: `No server found with id "${serverId}". Was the request matched with \`isCallbackRequest()\`?`
    };
  }
  if (!lookup.hasConnection(serverId)) {
    return {
      _tag: "invalid",
      serverId,
      error: `No connection found for serverId "${serverId}".`
    };
  }
  return { _tag: "callback", serverId, state, params: url.searchParams };
}

/** Whether the provider will still redeem `state` for this server. */
export async function isRedeemableState(
  serverId: string,
  authProvider: AgentMcpOAuthProvider,
  state: string
): Promise<boolean> {
  authProvider.serverId = serverId;
  try {
    return (await authProvider.checkState(state)).valid;
  } catch {
    return false;
  }
}

/**
 * `authUrl` when it can still complete an OAuth flow: an absolute http(s)
 * URL whose `state` nonce the provider will redeem. A URL without a `state`
 * parameter is returned as is, since there is nothing to check it against.
 * Undefined for a missing provider, a malformed URL, or a state that expired
 * or was already redeemed.
 */
export async function redeemableAuthUrl(
  serverId: string,
  authUrl: string | null | undefined,
  authProvider: AgentMcpOAuthProvider | undefined
): Promise<string | undefined> {
  if (!authUrl || !authProvider) return undefined;
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const state = url.searchParams.get("state");
  if (!state) return authUrl;
  return (await isRedeemableState(serverId, authProvider, state))
    ? authUrl
    : undefined;
}

/**
 * Consume the state of a callback that arrived after its flow was already
 * accepted (a duplicate or stale popup), so it cannot be replayed. Verifier
 * cleanup is left to the active completion path.
 */
export async function consumeStaleState(
  serverId: string,
  authProvider: AgentMcpOAuthProvider,
  state: string
): Promise<void> {
  authProvider.serverId = serverId;
  try {
    const stateValidation = await authProvider.checkState(state);
    if (!stateValidation.valid) {
      console.warn(
        `[MCPClientManager] Ignoring stale OAuth callback with invalid state for server "${serverId}": ${
          stateValidation.error ?? "Invalid state"
        }`
      );
      return;
    }
    await authProvider.consumeState(state);
  } catch (cleanupError) {
    console.warn(
      `[MCPClientManager] Failed to clean up stale OAuth callback state for server "${serverId}":`,
      cleanupError
    );
  }
}

/**
 * Exchange a callback's authorization code on the connection, inside the
 * PKCE verifier scope of its state, then delete that verifier. A completion
 * error wins over a cleanup error.
 */
export async function exchangeAuthorizationCode(
  serverId: string,
  conn: MCPClientConnection,
  authProvider: AgentMcpOAuthProvider,
  state: string,
  params: URLSearchParams
): Promise<void> {
  const exchange = async () => {
    let completeError: unknown;
    let cleanupError: unknown;

    try {
      await conn.completeAuthorization(params, { alreadyAccepted: true });
    } catch (error) {
      completeError = error;
    }

    try {
      await authProvider.deleteCodeVerifier();
    } catch (deleteError) {
      cleanupError = deleteError;
    }

    if (completeError) {
      if (cleanupError) {
        console.warn(
          `[MCPClientManager] Failed to clean up OAuth code verifier for server "${serverId}":`,
          cleanupError
        );
      }
      throw completeError;
    }
    if (cleanupError) throw cleanupError;
  };

  if (authProvider.runWithCodeVerifierState) {
    await authProvider.runWithCodeVerifierState(state, exchange);
    return;
  }
  await exchange();
}

/** The response for a handled callback, per the configured handler or redirects. */
export function oauthCallbackResponse(
  result: MCPClientOAuthResult,
  request: Request,
  config: MCPClientOAuthCallbackConfig | undefined
): Response {
  if (config?.customHandler) return config.customHandler(result);

  const baseOrigin = new URL(request.url).origin;
  const redirect = result.authSuccess
    ? config?.successRedirect
    : config?.errorRedirect;
  if (!redirect) return Response.redirect(baseOrigin);

  try {
    const target = new URL(redirect, baseOrigin);
    if (!result.authSuccess) {
      target.searchParams.set("error", result.authError);
    }
    return Response.redirect(target);
  } catch (error) {
    console.error("Invalid OAuth callback redirect URL:", redirect, error);
    return Response.redirect(baseOrigin);
  }
}
