import type { RpcTarget } from "cloudflare:workers";
import type { Connection, ConnectionContext, WSMessage } from "../lifecycle";

/** A frame delivered on a capability-owned WebSocket connection. */
export type WebSocketMessage = WSMessage;

/**
 * Connection handlers for the WebSockets capability. Handlers run inside
 * the host invocation boundary with the live connection in ambient
 * context (`getCurrentAgent().connection`).
 *
 * @experimental The API surface may change before stabilizing.
 */
export type WebSocketHandlers = {
  /** Handle a newly accepted hibernating WebSocket connection. */
  onConnect?(
    connection: Connection,
    ctx: ConnectionContext
  ): void | Promise<void>;
  /** Handle a message from a hibernating WebSocket connection. */
  onMessage?(
    connection: Connection,
    message: WebSocketMessage
  ): void | Promise<void>;
  /** Handle a closing hibernating WebSocket connection. */
  onClose?(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): void | Promise<void>;
  /** Handle a mid-connection WebSocket error. */
  onError?(connection: Connection, error: unknown): void | Promise<void>;
};

/**
 * Configuration for the WebSockets capability.
 *
 * @experimental The API surface may change before stabilizing.
 */
export interface WebSocketsOptions {
  /**
   * Connection handlers for WebSocket clients. When present, the
   * capability claims WebSocket upgrades and owns those connections end
   * to end. When absent, upgrades are declined.
   */
  readonly handlers?: WebSocketHandlers;

  /**
   * An `RpcTarget` whose prototype methods are the host's complete remote
   * interface, answered as `rpc` frames — what `useAgent().call` and
   * `.stub` send — on either transport. Methods run through the host
   * invocation boundary with the calling connection in scope, and may
   * return a `ReadableStream` to stream. `Agent` answers its own frames
   * and does not set this.
   */
  readonly callables?: RpcTarget;

  /**
   * Send the identity frame (`cf_agent_identity`) to each new connection,
   * so `useAgent` and `AgentClient` resolve `ready` against this host.
   * Defaults to `true`. `Agent` sends its own identity and passes `false`.
   */
  readonly identity?: boolean;

  /**
   * Tags attached to each accepted connection, queryable through
   * `getConnections(tag)`. The connection id is always the first tag.
   */
  readonly getConnectionTags?: (
    connection: Connection,
    ctx: ConnectionContext
  ) => string[] | Promise<string[]>;
}
