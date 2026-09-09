import { RpcTarget } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type CapabilityWebSocketUpgradeContext,
  type Connection,
  type ConnectionSetStateFn,
  type ConnectionState
} from "../lifecycle";
import {
  ConnectionManager,
  createConnection,
  isManagedWebSocket
} from "./connection";
import {
  buildCallablesRoot,
  exposableMethods,
  type CallableInvoker
} from "./callables-target";
import type {
  WebSocketHandlers,
  WebSocketMessage,
  WebSocketsOptions
} from "./options";
import { isCallablesRpcUpgrade } from "./protocol";
import { openCapnWebSession, type CapnWebSession } from "./transport";
import { isCapnWebTransportUpgrade } from "./transport-protocol";

/**
 * Reserved close codes the runtime synthesizes when there was no real
 * Close frame from the peer (1005 NoStatusReceived, 1006 AbnormalClosure,
 * 1015 TLSHandshake). They cannot appear in an outgoing Close frame, and
 * there is no peer left to receive a reciprocation.
 */
function isReservedCloseCode(code: number): boolean {
  return code === 1005 || code === 1006 || code === 1015;
}

/**
 * Reciprocate a peer-initiated Close frame to complete the handshake, as
 * the Hibernation API contract requires. Best-effort: swallows errors
 * from already-closed sockets or invalid codes/reasons, and skips
 * reciprocation entirely for reserved codes (dead transport).
 */
function reciprocateClose(ws: WebSocket, code: number, reason: string): void {
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
    // Already closed, oversize reason, or another unrecoverable
    // invariant — the handshake is either done or out of our control.
  }
}

/**
 * Opt-in WebSocket support for Lifecycle Objects.
 *
 * Lifecycle itself does not model WebSockets — hosts that want them
 * install this capability, which owns the connection subsystem end to
 * end: it claims upgrades, accepts hibernating sockets, dispatches
 * `onConnect`/`onMessage`/`onClose` inside the host invocation
 * boundary, reciprocates close handshakes, and answers
 * `getConnections()`/`getConnection()`.
 *
 * ```ts
 * class Room extends DurableObject<Env> {
 *   readonly webSockets = new WebSockets({
 *     handlers: {
 *       onConnect: (connection) => connection.send("welcome"),
 *       onMessage: (connection, message) => { ... },
 *       onClose: (connection, code) => { ... }
 *     },
 *     callables: new RoomCallables()
 *   });
 *   readonly lifecycle = Lifecycle.install(this).use(this.webSockets);
 * }
 * ```
 *
 * Connections speak one of two wire transports, chosen by the client:
 *
 * - **Hibernating WebSocket** (default): plain frames; idle clients
 *   survive Durable Object eviction.
 * - **Cap'n Web** (`?__agents_transport=capnweb`): the same frames
 *   travel over a single Cap'n Web RPC session. The connection is
 *   non-hibernating — the Durable Object stays pinned while it is open.
 *
 * The handlers are transport-agnostic: both kinds of connection
 * dispatch the same `onConnect`/`onMessage`/`onClose` and appear in
 * `getConnections()`.
 *
 * `callables` exposes an `RpcTarget`'s prototype methods to remote
 * callers over a Cap'n Web session claimed from `?__agents_rpc=capnweb`
 * upgrades. Methods run through the host invocation boundary, may
 * return a `ReadableStream` to stream results, and emit
 * `rpc`/`rpc:error` capability events. Callable sessions are
 * non-hibernating: while a client holds one open, the Durable Object
 * stays pinned in memory.
 *
 * There is no separate browser client: against an `Agent`, the
 * `useAgent` hook's `stub`/`call` reach the same interface over the
 * protocol socket. A plain host's endpoint is reached with capnweb
 * directly — `newWebSocketRpcSession(new WebSocket(callablesRpcUrl(url)))`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class WebSockets extends LifecycleCapability {
  readonly #handlers: WebSocketHandlers | undefined;
  readonly #getConnectionTags: WebSocketsOptions["getConnectionTags"];
  readonly #callablesTarget: RpcTarget | undefined;
  readonly #capnWebSessions = new Map<string, CapnWebSession>();
  #manager: ConnectionManager | undefined;

  constructor(options: WebSocketsOptions = {}) {
    super("websockets");
    this.#handlers = options.handlers;
    this.#getConnectionTags = options.getConnectionTags;
    this.#callablesTarget = options.callables
      ? this.#buildCallablesTarget(options.callables)
      : undefined;
  }

  // ── Lifecycle capability hooks ─────────────────────────────────────────

  /** Claim callables RPC upgrades and, with handlers, connection upgrades. */
  onWebSocketUpgrade({
    request
  }: CapabilityWebSocketUpgradeContext):
    | Promise<Response>
    | Response
    | undefined {
    if (isCallablesRpcUpgrade(request)) {
      if (!this.#callablesTarget) return undefined;
      return newWorkersWebSocketRpcResponse(request, this.#callablesTarget);
    }
    if (!this.#handlers) return undefined;
    if (isCapnWebTransportUpgrade(request)) {
      return this.#acceptCapnWebSession(request);
    }
    return this.#acceptConnection(request);
  }

  /** Dispatch a platform message wake for a capability-owned socket. */
  async onWebSocketMessage(
    ws: WebSocket,
    message: WebSocketMessage
  ): Promise<boolean> {
    if (!isManagedWebSocket(ws)) return false;
    const connection = createConnection(ws);
    await this.lifecycle.runInHostContext(
      () => this.#handlers?.onMessage?.(connection, message),
      { connection }
    );
    return true;
  }

  /** Dispatch and reciprocate a close wake for an owned socket. */
  async onWebSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<boolean> {
    if (!isManagedWebSocket(ws)) return false;
    const connection = createConnection(ws);
    try {
      await this.lifecycle.runInHostContext(
        () => this.#handlers?.onClose?.(connection, code, reason, wasClean),
        { connection }
      );
    } finally {
      reciprocateClose(ws, code, reason);
    }
    return true;
  }

  /** Dispatch an error wake for an owned socket. */
  async onWebSocketError(ws: WebSocket, error: unknown): Promise<boolean> {
    if (!isManagedWebSocket(ws)) return false;
    const connection = createConnection(ws);
    await this.lifecycle.runInHostContext(
      () => this.#handlers?.onError?.(connection, error),
      { connection }
    );
    return true;
  }

  /**
   * Close every owned connection during explicit host destruction. The
   * capability owns its sockets' lifetimes, so it also owns tearing
   * them down.
   */
  dispose(): void {
    for (const connection of this.getConnections()) {
      try {
        connection.close(1001, "Durable Object destroyed");
      } catch {
        // Already closed or mid-handshake — nothing left to tear down.
      }
    }
  }

  // ── Connections ────────────────────────────────────────────────────────

  /** Open connections on either transport, optionally by tag. */
  *getConnections<TState = unknown>(
    tag?: string
  ): IterableIterator<Connection<TState>> {
    for (const { managed } of this.#capnWebSessions.values()) {
      const connection = managed.connection;
      if (connection.readyState !== WebSocket.OPEN) continue;
      if (!tag || connection.tags.includes(tag)) {
        yield connection as Connection<TState>;
      }
    }
    yield* this.#connectionManager.getConnections<TState>(tag);
  }

  /** One connection on either transport, by id. */
  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    const capnWeb = this.#capnWebSessions.get(id)?.managed.connection;
    if (capnWeb && capnWeb.readyState === WebSocket.OPEN) {
      return capnWeb as Connection<TState>;
    }
    return this.#connectionManager.getConnection<TState>(id);
  }

  get #connectionManager(): ConnectionManager {
    this.#manager ??= new ConnectionManager(this.lifecycle.sockets);
    return this.#manager;
  }

  async #acceptConnection(request: Request): Promise<Response> {
    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    const url = new URL(request.url);
    // `||`, not `??`: an empty `?_pk=` value must fall back to a
    // generated id — an empty connection id would later throw in tag
    // validation and reject the upgrade.
    const connectionId = url.searchParams.get("_pk") || nanoid();

    let connection: Connection = Object.assign(serverWebSocket, {
      id: connectionId,
      uri: request.url,
      tags: [] as string[],
      state: null as unknown as ConnectionState<unknown>,
      setState<T = unknown>(setState: T | ConnectionSetStateFn<T>) {
        // Pre-accept shim: hold state on the socket until accept()
        // persists it into the hibernation attachment.
        const state =
          setState instanceof Function
            ? setState(this.state as ConnectionState<T>)
            : setState;
        this.state = state as ConnectionState<T>;
        return this.state as ConnectionState<T>;
      }
    });

    const ctx = { request };
    const tags = this.#getConnectionTags
      ? await this.#getConnectionTags(connection, ctx)
      : [];

    // Hibernating WebSockets remain connected while the object is evicted.
    connection = this.#connectionManager.accept(connection, { tags });
    await this.lifecycle.runInHostContext(
      () => this.#handlers?.onConnect?.(connection, ctx),
      { connection, request }
    );

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }

  // ── Cap'n Web connection transport ─────────────────────────────────────

  /**
   * Accept a Cap'n Web transport upgrade. The transport module owns the
   * session mechanics; the capability supplies its handlers, tags,
   * host-boundary dispatch, and session registry.
   */
  async #acceptCapnWebSession(request: Request): Promise<Response> {
    // `||`, not `??`: an empty `?_pk=` value must fall back to a
    // generated id, matching the hibernating accept path.
    const connectionId =
      new URL(request.url).searchParams.get("_pk") || nanoid();
    // A reconnect reusing the id replaces the previous session.
    this.#capnWebSessions.get(connectionId)?.session[Symbol.dispose]();

    return openCapnWebSession({
      request,
      connectionId,
      handlers: this.#handlers ?? {},
      getTags: this.#getConnectionTags,
      dispatch: (fn, scope) => this.lifecycle.runInHostContext(fn, scope),
      register: (session) => this.#capnWebSessions.set(connectionId, session),
      unregister: (session) => {
        if (this.#capnWebSessions.get(connectionId) === session) {
          this.#capnWebSessions.delete(connectionId);
        }
      }
    });
  }

  // ── Callables ──────────────────────────────────────────────────────────

  /**
   * Wrap a callables target for serving: every exposable method
   * dispatches through the host invocation boundary and emits
   * `rpc`/`rpc:error` events.
   */
  #buildCallablesTarget(target: RpcTarget): RpcTarget {
    const dispatching = new Map<string, CallableInvoker>();
    for (const [name, invoke] of exposableMethods(target)) {
      dispatching.set(name, (...args) =>
        this.#dispatchCallable(name, () => invoke(...args))
      );
    }
    return buildCallablesRoot(dispatching);
  }

  async #dispatchCallable(
    name: string,
    invoke: () => unknown
  ): Promise<unknown> {
    // Throws with installation guidance when the capability was never
    // installed with Lifecycle.use().
    const services = this.lifecycle;
    try {
      const result = await services.runInHostContext(invoke);
      services.events.emit("rpc", {
        method: name,
        streaming: result instanceof ReadableStream
      });
      return result;
    } catch (error) {
      services.events.emit("rpc:error", {
        method: name,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
