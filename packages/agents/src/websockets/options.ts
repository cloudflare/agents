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
   * Connection handlers for WebSocket clients. The capability accepts and
   * tracks every WebSocket upgrade either way; handlers add behavior on
   * connect, message, close and error.
   */
  readonly handlers?: WebSocketHandlers;

  /**
   * An `RpcTarget` whose prototype methods are the host's complete remote
   * interface, reached through `useAgent().call` and `.stub`. On the
   * `cf-websocket` wire they are answered as JSON `rpc` frames. On the
   * `capnweb` wire they are native Cap'n Web methods on the session root:
   * an `RpcTarget` result becomes a live stub, a `ReadableStream` streams,
   * and calls pipeline. Methods run through the host invocation boundary
   * with the calling connection in scope. `Agent` answers its own
   * decorated methods on the JSON wire and does not set this.
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
