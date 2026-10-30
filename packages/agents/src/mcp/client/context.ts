import type { Emitter } from "../../core/events";
import type { MCPObservabilityEvent } from "../../observability/mcp";
import type { MCPClientConnection } from "./connection";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import type { McpServerStore } from "./server-store";
import type { ServerLanes } from "./server-lanes";

/**
 * What every controller of an `MCPClientManager` shares: the live
 * connections, the durable server catalog, the per-server lanes connection
 * work runs in, and the manager's events. The manager builds one and hands
 * it to each controller; nothing else is shared between them.
 */
export type McpClientContext = {
  /** MCP client implementation name sent during negotiation. */
  readonly name: string;
  /** MCP client implementation version sent during negotiation. */
  readonly version: string;
  /** Live connections by server id. The manager's `mcpConnections`. */
  readonly connections: Record<string, MCPClientConnection>;
  /** The durable server catalog in this object's storage. */
  readonly store: McpServerStore;
  /** This object's key-value storage, where OAuth state lives. */
  readonly storage: DurableObjectStorage;
  /** One queue of connection work per server. */
  readonly lanes: ServerLanes;
  /** Runtime bindings for restoring RPC servers. */
  readonly env: Cloudflare.Env | undefined;
  /** A caller-supplied OAuth provider factory, when configured. */
  readonly createAuthProvider:
    | ((callbackUrl: string) => AgentMcpOAuthProvider)
    | undefined;
  /** Connection-level and manager-level observability events. */
  readonly observability: Emitter<MCPObservabilityEvent>;
  /** Tell listeners a server's state changed. */
  stateChanged(): void;
};
