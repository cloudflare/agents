import type { RpcTarget } from "cloudflare:workers";
import type { Connection, ConnectionContext, WSMessage } from "../lifecycle";

/**
 * The part of a `State` capability the WebSockets capability uses. A
 * structural port, so any `State<T>` fits without a cast and the
 * capability never depends on the class itself.
 */
export type SyncedState = {
  /** Current state, or `undefined` when nothing is stored. */
  get(): unknown;
  /** Validate and persist a change; throws when the host rejects it. */
  set(nextState: never, source: Connection): void;
};

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
   * Whether a new connection gets the connect-time protocol frames —
   * identity (`cf_agent_identity`), then the current state when `state`
   * is set — and whether protocol frames reach it at all.
   *
   * - `true` (default): every connection.
   * - a function: decided per connection at accept time. `false` marks
   *   the connection no-protocol: it gets no protocol text frames, on
   *   connect or via `broadcastState()`, but can still send and receive
   *   ordinary messages and use callables. For binary-only clients.
   * - `false`: the host drives the connect sequence itself with
   *   `sendIdentity()` and `sendState()`, and applies client state frames
   *   with `applyStateFrame()` — `Agent` does this, since it must decide
   *   whether a connection belongs to a facet before any frame is sent.
   */
  readonly protocol?:
    | boolean
    | ((connection: Connection, ctx: ConnectionContext) => boolean);

  /**
   * Decide at accept time whether a connection is readonly. A readonly
   * connection's `cf_agent_state` frames are refused with
   * `cf_agent_state_error`; everything else works. Also settable later
   * with `setReadonly()`.
   */
  readonly readonly?: (
    connection: Connection,
    ctx: ConnectionContext
  ) => boolean;

  /**
   * A {@link SyncedState} — normally a `State` capability — to sync over
   * connections. The capability pushes the current value to each new
   * connection after identity and applies `cf_agent_state` frames a
   * client sends: a readonly connection is refused, and a change the
   * host's validator rejects is answered with `cf_agent_state_error`.
   * Broadcasting a change is the state owner's call — wire the `State`'s
   * `onChanged` to `broadcastState(source)`. Install the same instance on
   * the lifecycle so it owns storage and validation; without this option
   * state is never sent or accepted over connections.
   */
  readonly state?: SyncedState;

  /**
   * Tags attached to each accepted connection, queryable through
   * `getConnections(tag)`. The connection id is always the first tag.
   */
  readonly getConnectionTags?: (
    connection: Connection,
    ctx: ConnectionContext
  ) => string[] | Promise<string[]>;
}
