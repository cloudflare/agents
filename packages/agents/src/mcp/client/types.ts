import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import type { RetryOptions } from "../../retries";
import type { McpClientOptions } from "../types";
import type { MCPConnectionState, MCPTransportOptions } from "./connection";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type { MCPReconnectOptions } from "./jobs";
import type { PersistedMcpServerOptions } from "./storage";

export type MCPServerOptions = PersistedMcpServerOptions;

/** Result of an OAuth callback request. */
export type MCPOAuthCallbackResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | { serverId?: string; authSuccess: false; authError: string };

/** Options for registering an MCP server. */
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
 * @internal Where a server ended up after `connectAndDiscover()`,
 * `settleServer()` or `reconnectServer()`: ready, waiting for the user to
 * authorize (with the link when one is usable), failed in a named phase, or
 * removed meanwhile.
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

/** Dependencies used by `MCPClientManager` across Durable Object wakes. */
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
