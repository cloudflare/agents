// Polyfill WebSocket status code constants for environments that don't have them
// in order to support libraries that expect standards-compatible WebSocket
// implementations (e.g. PartySocket)

import type {
  Connection,
  ConnectionSetStateFn,
  ConnectionState
} from "./types";

if (!("OPEN" in WebSocket)) {
  const WebSocketStatus = {
    // @ts-expect-error
    CONNECTING: WebSocket.READY_STATE_CONNECTING,
    // @ts-expect-error
    OPEN: WebSocket.READY_STATE_OPEN,
    // @ts-expect-error
    CLOSING: WebSocket.READY_STATE_CLOSING,
    // @ts-expect-error
    CLOSED: WebSocket.READY_STATE_CLOSED
  };

  Object.assign(WebSocket, WebSocketStatus);
  // @ts-expect-error
  Object.assign(WebSocket.prototype, WebSocketStatus);
}

/**
 * Store both platform attachments and user attachments in different namespaces
 */
type ConnectionAttachments = {
  __pk: {
    id: string;
    tags: string[];
    uri?: string;
  };
  __user?: unknown;
};

function tryGetPartyServerMeta(
  ws: WebSocket
): ConnectionAttachments["__pk"] | null {
  try {
    // Avoid AttachmentCache.get() here: hibernated sockets accepted outside
    // PartyServer can have an attachment without a __pk namespace.
    const attachment = WebSocket.prototype.deserializeAttachment.call(
      ws
    ) as unknown;
    if (!attachment || typeof attachment !== "object") {
      return null;
    }
    if (!("__pk" in attachment)) {
      return null;
    }
    const pk = (attachment as ConnectionAttachments).__pk as unknown;
    if (!pk || typeof pk !== "object") {
      return null;
    }
    const { id, tags } = pk as {
      id?: unknown;
      tags?: unknown;
    };
    if (typeof id !== "string") {
      return null;
    }
    const { uri } = pk as { uri?: unknown };
    return {
      id,
      tags: Array.isArray(tags) ? tags : [],
      uri: typeof uri === "string" ? uri : undefined
    } satisfies ConnectionAttachments["__pk"];
  } catch {
    return null;
  }
}

export function isPartyServerWebSocket(ws: WebSocket): boolean {
  return tryGetPartyServerMeta(ws) !== null;
}

/**
 * Cache websocket attachments to avoid having to rehydrate them on every property access.
 */
class AttachmentCache {
  #cache = new WeakMap<WebSocket, ConnectionAttachments>();

  get(ws: WebSocket): ConnectionAttachments {
    let attachment = this.#cache.get(ws);
    if (!attachment) {
      attachment = WebSocket.prototype.deserializeAttachment.call(
        ws
      ) as ConnectionAttachments;
      if (attachment !== undefined) {
        this.#cache.set(ws, attachment);
      } else {
        throw new Error(
          "Missing websocket attachment. This is most likely an issue in PartyServer, please open an issue at https://github.com/cloudflare/partykit/issues"
        );
      }
    }

    return attachment;
  }

  set(ws: WebSocket, attachment: ConnectionAttachments) {
    this.#cache.set(ws, attachment);
    WebSocket.prototype.serializeAttachment.call(ws, attachment);
  }
}

const attachments = new AttachmentCache();
const connections = new WeakSet<Connection>();
const isWrapped = (ws: WebSocket): ws is Connection => {
  return connections.has(ws as Connection);
};

/**
 * Wraps a WebSocket with Connection fields that rehydrate the
 * socket attachments lazily only when requested.
 */
export const createLazyConnection = (
  ws: WebSocket | Connection
): Connection => {
  if (isWrapped(ws)) {
    return ws;
  }

  // if state was set on the socket before initializing the connection,
  // capture it here so we can persist it again
  let initialState;
  if ("state" in ws) {
    initialState = ws.state;
    delete ws.state;
  }

  const connection = Object.defineProperties(ws, {
    id: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.id;
      }
    },
    uri: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.uri ?? null;
      }
    },
    tags: {
      configurable: true,
      get() {
        // Default to [] for connections accepted before tags were stored
        return attachments.get(ws).__pk.tags ?? [];
      }
    },
    socket: {
      configurable: true,
      get() {
        return ws;
      }
    },
    state: {
      configurable: true,
      get() {
        return ws.deserializeAttachment() as ConnectionState<unknown>;
      }
    },
    setState: {
      configurable: true,
      value: function setState<T>(setState: T | ConnectionSetStateFn<T>) {
        let state: T;
        if (setState instanceof Function) {
          state = setState((this as Connection<T>).state);
        } else {
          state = setState;
        }

        ws.serializeAttachment(state);
        return state as ConnectionState<T>;
      }
    },

    deserializeAttachment: {
      configurable: true,
      value: function deserializeAttachment<T = unknown>() {
        const attachment = attachments.get(ws);
        return (attachment.__user ?? null) as T;
      }
    },

    serializeAttachment: {
      configurable: true,
      value: function serializeAttachment<T = unknown>(attachment: T) {
        const setting = {
          ...attachments.get(ws),
          __user: attachment ?? null
        };

        attachments.set(ws, setting);
      }
    }
  }) as Connection;

  if (initialState) {
    connection.setState(initialState);
  }

  connections.add(connection);
  return connection;
};

class HibernatingConnectionIterator<T> implements IterableIterator<
  Connection<T>
> {
  private index = 0;
  private sockets: WebSocket[] | undefined;
  constructor(
    private state: DurableObjectState,
    private tag?: string
  ) {}

  [Symbol.iterator](): IterableIterator<Connection<T>> {
    return this;
  }

  next(): IteratorResult<Connection<T>, number | undefined> {
    const sockets =
      this.sockets ?? (this.sockets = this.state.getWebSockets(this.tag));

    let socket: WebSocket;
    while ((socket = sockets[this.index++])) {
      // only yield open sockets to match non-hibernating behaviour
      if (socket.readyState === WebSocket.OPEN) {
        // Durable Objects hibernation APIs allow storing arbitrary sockets via
        // `state.acceptWebSocket()`. Those sockets won't have PartyServer's
        // `__pk` attachment namespace and must be ignored.
        if (!isPartyServerWebSocket(socket)) {
          continue;
        }
        const value = createLazyConnection(socket) as Connection<T>;
        return { done: false, value };
      }
    }

    // reached the end of the iteratee
    return { done: true, value: undefined };
  }
}

/**
 * Deduplicate and validate connection tags.
 * Returns the final tag array (always includes the connection id as the first tag).
 */
function prepareTags(connectionId: string, userTags: string[]): string[] {
  const tags = [connectionId, ...userTags.filter((t) => t !== connectionId)];

  // validate tags against documented restrictions
  // https://developers.cloudflare.com/durable-objects/api/hibernatable-websockets-api/#state-methods-for-websockets
  if (tags.length > 10) {
    throw new Error(
      "A connection can only have 10 tags, including the default id tag."
    );
  }

  for (const tag of tags) {
    if (typeof tag !== "string") {
      throw new Error(`A connection tag must be a string. Received: ${tag}`);
    }
    if (tag === "") {
      throw new Error("A connection tag must not be an empty string.");
    }
    if (tag.length > 256) {
      throw new Error("A connection tag must not exceed 256 characters");
    }
  }

  return tags;
}

export interface ConnectionManager {
  getCount(): number;
  getConnection<TState>(id: string): Connection<TState> | undefined;
  getConnections<TState>(tag?: string): IterableIterator<Connection<TState>>;
  accept(connection: Connection, options: { tags: string[] }): Connection;
}

/**
 * When not using hibernation, we track active connections manually.
 */
export class InMemoryConnectionManager<TState> implements ConnectionManager {
  #connections: Map<string, Connection> = new Map();
  tags: WeakMap<Connection, string[]> = new WeakMap();

  getCount() {
    return this.#connections.size;
  }

  getConnection<T = TState>(id: string) {
    return this.#connections.get(id) as Connection<T> | undefined;
  }

  *getConnections<T = TState>(tag?: string): IterableIterator<Connection<T>> {
    if (!tag) {
      for (const connection of this.#connections.values()) {
        if (connection.readyState === WebSocket.OPEN) {
          // SAFETY: Connection state is caller-defined metadata. This mirrors
          // getConnection<T>() and does not alter the underlying WebSocket.
          yield connection as Connection<T>;
        }
      }
      return;
    }

    // simulate DurableObjectState.getWebSockets(tag) behaviour
    for (const connection of this.#connections.values()) {
      const connectionTags = this.tags.get(connection) ?? [];
      if (connectionTags.includes(tag)) {
        yield connection as Connection<T>;
      }
    }
  }

  accept(connection: Connection, options: { tags: string[] }) {
    // Accept in half-open mode so PartyServer stays in control of the close
    // handshake. On compat dates >= 2026-04-07 the `web_socket_auto_reply_to_close`
    // flag otherwise makes the runtime send a reciprocal Close frame and tear
    // the socket down automatically — behind the back of our own close handling
    // (`handleCloseFromClient` already reciprocates via `closeQuietly`). That
    // auto-teardown is the WebSocket-proxying hazard called out in the flag
    // docs: because a PartyServer Durable Object sits on the server end of a
    // connection that the runtime tunnels back to the client, the auto-close
    // can fire through an already-severed tunnel and surface as a spurious
    // retryable "Network connection lost." rejection (e.g. when a Durable
    // Object is reset while a connection is still open). Half-open mode
    // restores the historical behavior our close handlers were written for;
    // `closeQuietly` still sends the reciprocal frame on every compat date.
    try {
      connection.accept({ allowHalfOpen: true });
    } catch {
      // Older runtime/shim builds may not accept the options argument. Falling
      // back to a bare accept() matches the pre-2026-04-07 behavior (no runtime
      // auto-reply), which PartyServer's manual close handling already covers.
      connection.accept();
    }

    // Preserve PartyServer's historical binary delivery contract. On compat
    // dates >= 2026-03-17 the `websocket_standard_binary_type` flag flips the
    // default server-side `binaryType` from "arraybuffer" to "blob", so binary
    // frames arrive as `Blob` instead of `ArrayBuffer` on this in-memory path.
    // Every PartyServer consumer (and the frameworks built on it, e.g.
    // Cloudflare Agents) has always received `ArrayBuffer`, so pin it back.
    // This is a no-op on older dates (already the default) and is corrective on
    // newer ones. Guarded because some runtime/shim builds may not expose a
    // settable `binaryType`. The hibernation path is unaffected (the
    // Hibernation API always delivers `ArrayBuffer`).
    try {
      connection.binaryType = "arraybuffer";
    } catch {
      // older runtimes may not allow setting binaryType here
    }

    const tags = prepareTags(connection.id, options.tags);

    this.#connections.set(connection.id, connection);
    this.tags.set(connection, tags);

    // Expose tags on the connection object itself
    Object.defineProperty(connection, "tags", {
      get: () => tags,
      configurable: true
    });

    const removeConnection = () => {
      this.#connections.delete(connection.id);
      connection.removeEventListener("close", removeConnection);
      connection.removeEventListener("error", removeConnection);
    };
    connection.addEventListener("close", removeConnection);
    connection.addEventListener("error", removeConnection);

    return connection;
  }
}

/**
 * When opting into hibernation, the platform tracks connections for us.
 */
export class HibernatingConnectionManager<TState> implements ConnectionManager {
  constructor(private controller: DurableObjectState) {}

  getCount() {
    // Only count sockets managed by PartyServer. Other hibernated sockets may
    // exist on the same Durable Object via `state.acceptWebSocket()`.
    let count = 0;
    for (const ws of this.controller.getWebSockets()) {
      if (isPartyServerWebSocket(ws)) count++;
    }
    return count;
  }

  getConnection<T = TState>(id: string) {
    // TODO: Should we cache the connections?
    const sockets = this.controller.getWebSockets(id);
    const matching = sockets.filter((ws) => {
      return tryGetPartyServerMeta(ws)?.id === id;
    });

    if (matching.length === 0) return undefined;
    if (matching.length === 1)
      return createLazyConnection(matching[0]) as Connection<T>;

    throw new Error(
      `More than one connection found for id ${id}. Did you mean to use getConnections(tag) instead?`
    );
  }

  getConnections<T = TState>(tag?: string | undefined) {
    return new HibernatingConnectionIterator<T>(this.controller, tag);
  }

  accept(connection: Connection, options: { tags: string[] }) {
    const tags = prepareTags(connection.id, options.tags);

    this.controller.acceptWebSocket(connection, tags);
    connection.serializeAttachment({
      __pk: {
        id: connection.id,
        tags,
        uri: connection.uri ?? undefined
      },
      __user: null
    });

    return createLazyConnection(connection);
  }
}
