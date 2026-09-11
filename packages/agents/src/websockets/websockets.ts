import { RpcTarget } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { nanoid } from "nanoid";
import {
  LifecycleCapability,
  type CapabilityWebSocketUpgradeContext,
  type Connection,
  type ConnectionSetStateFn,
  type ConnectionState,
  type LifecycleRouteContext
} from "../lifecycle";
import {
  ConnectionManager,
  createConnection,
  isManagedWebSocket,
  prepareTags
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
import { reciprocateClose } from "./close";
import {
  isWebSocketsRouteMessage,
  type BridgedConnectionEntry,
  type BridgedConnectionLink
} from "./bridged";

/** One connection whose socket another Lifecycle Object owns. */
type BridgedRecord = {
  readonly connection: Connection;
  link: BridgedConnectionLink;
  uri: string | null;
  tags: readonly string[];
  state: unknown;
};

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
 * A capability that owns sockets on another Lifecycle Object (dynamic
 * agents' parent holds its children's sockets) bridges them in through
 * this capability's route: `bridged:*` messages present each remote
 * socket as a connection the handlers and `getConnections()` see like
 * any other. A routed (child) Lifecycle owns no platform sockets, so
 * there the bridged connections are the only ones.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class WebSockets extends LifecycleCapability {
  readonly #handlers: WebSocketHandlers | undefined;
  readonly #getConnectionTags: WebSocketsOptions["getConnectionTags"];
  readonly #callablesTarget: RpcTarget | undefined;
  #manager: ConnectionManager | undefined;
  readonly #bridged = new Map<string, BridgedRecord>();

  constructor(options: WebSocketsOptions = {}) {
    super("websockets");
    this.#handlers = options.handlers;
    this.#getConnectionTags = options.getConnectionTags;
    this.#callablesTarget = options.callables
      ? this.#buildCallablesTarget(options.callables)
      : undefined;
  }

  // ── Lifecycle capability hooks ─────────────────────────────────────────

  /** Claim callables RPC upgrades and, with handlers, plain upgrades. */
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

  /** Present sockets another Lifecycle Object owns as local connections. */
  async onRoute({ payload }: LifecycleRouteContext): Promise<void> {
    if (!isWebSocketsRouteMessage(payload)) {
      throw new Error("Unknown WebSockets route message");
    }
    switch (payload.type) {
      case "bridged:sync": {
        if (payload.reset) {
          const keep = new Set(payload.connections.map(({ meta }) => meta.id));
          for (const id of this.#bridged.keys()) {
            if (!keep.has(id)) this.#bridged.delete(id);
          }
        }
        for (const entry of payload.connections) this.#bridgedRecord(entry);
        return;
      }
      case "bridged:connect": {
        const record = this.#bridgedRecord(payload);
        const { connection } = record;
        const ctx = { request: payload.request };
        const tags = prepareTags(
          connection.id,
          this.#getConnectionTags
            ? await this.#getConnectionTags(connection, ctx)
            : []
        );
        record.tags = tags;
        record.link.setTags(tags);
        await this.lifecycle.runInHostContext(
          () => this.#handlers?.onConnect?.(connection, ctx),
          { connection, request: payload.request }
        );
        return;
      }
      case "bridged:message": {
        const { connection } = this.#bridgedRecord(payload);
        await this.lifecycle.runInHostContext(
          () => this.#handlers?.onMessage?.(connection, payload.message),
          { connection }
        );
        return;
      }
      case "bridged:close": {
        const { connection } = this.#bridgedRecord(payload);
        try {
          await this.lifecycle.runInHostContext(
            () =>
              this.#handlers?.onClose?.(
                connection,
                payload.code,
                payload.reason,
                payload.wasClean
              ),
            { connection }
          );
        } finally {
          this.#bridged.delete(connection.id);
        }
        return;
      }
    }
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

  /**
   * Open connections this capability presents, optionally by tag: the
   * sockets it accepted (none on a routed Lifecycle, which owns no
   * platform sockets) and the connections bridged in from their owner.
   */
  *getConnections<TState = unknown>(
    tag?: string
  ): IterableIterator<Connection<TState>> {
    if (!this.lifecycle.routes.source) {
      yield* this.#connectionManager.getConnections<TState>(tag);
    }
    for (const record of this.#bridged.values()) {
      if (tag === undefined || record.tags.includes(tag)) {
        yield record.connection as Connection<TState>;
      }
    }
  }

  /** One connection this capability presents, by id. */
  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    const accepted = this.lifecycle.routes.source
      ? undefined
      : this.#connectionManager.getConnection<TState>(id);
    return (
      accepted ?? (this.#bridged.get(id)?.connection as Connection<TState>)
    );
  }

  get #connectionManager(): ConnectionManager {
    this.#manager ??= new ConnectionManager(this.lifecycle.sockets);
    return this.#manager;
  }

  /** The record for a bridged connection, created or refreshed from its owner's view. */
  #bridgedRecord({ meta, link }: BridgedConnectionEntry): BridgedRecord {
    const existing = this.#bridged.get(meta.id);
    if (existing) {
      existing.link = link;
      existing.uri = meta.uri;
      existing.tags = meta.tags;
      existing.state = meta.state;
      return existing;
    }
    const record = {
      link,
      uri: meta.uri,
      tags: meta.tags,
      state: meta.state
    } as BridgedRecord;
    (record as { connection: Connection }).connection = createBridgedConnection(
      meta.id,
      record
    );
    this.#bridged.set(meta.id, record);
    return record;
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

/**
 * A `Connection` over a socket another object owns. Every property is
 * configurable, like an accepted connection's, so a host may redefine
 * `state`/`setState` to project its own view; `state` reads the owner's
 * latest snapshot and `setState` writes through the link.
 */
function createBridgedConnection(
  id: string,
  record: Omit<BridgedRecord, "connection">
): Connection {
  const connection = {
    readyState: WebSocket.OPEN,
    send(message: WebSocketMessage) {
      record.link.send(message);
    },
    close(code?: number, reason?: string) {
      record.link.close(code, reason);
    },
    addEventListener() {},
    removeEventListener() {}
  };
  Object.defineProperties(connection, {
    id: { configurable: true, enumerable: true, value: id },
    uri: {
      configurable: true,
      enumerable: true,
      get: () => record.uri
    },
    tags: {
      configurable: true,
      enumerable: true,
      get: () => record.tags
    },
    state: {
      configurable: true,
      enumerable: true,
      get: () => (record.state ?? null) as ConnectionState<unknown>
    },
    setState: {
      configurable: true,
      writable: true,
      value: function setState<T>(next: T | ConnectionSetStateFn<T>) {
        const state =
          next instanceof Function
            ? next(record.state as ConnectionState<T>)
            : next;
        record.state = state ?? null;
        record.link.setState(record.state);
        return record.state as ConnectionState<T>;
      }
    }
  });
  return connection as unknown as Connection;
}
