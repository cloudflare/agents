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

function tryGetManagedWebSocketMeta(
  ws: WebSocket
): ConnectionAttachments["__pk"] | null {
  try {
    // Avoid AttachmentCache.get() here: externally accepted sockets
    // can have an attachment without the managed __pk namespace.
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

export function isManagedWebSocket(ws: WebSocket): boolean {
  return tryGetManagedWebSocketMeta(ws) !== null;
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
        throw new Error("Missing managed WebSocket lifecycle attachment");
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
    state: {
      configurable: true,
      get() {
        const attachment = attachments.get(ws);
        return (attachment.__user ?? null) as ConnectionState<unknown>;
      }
    },
    setState: {
      configurable: true,
      value: function setState<T>(setState: T | ConnectionSetStateFn<T>) {
        const state =
          setState instanceof Function
            ? setState((this as Connection<T>).state)
            : setState;
        attachments.set(ws, {
          ...attachments.get(ws),
          __user: state ?? null
        });
        return state as ConnectionState<T>;
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
      // Only yield open sockets.
      if (socket.readyState === WebSocket.OPEN) {
        // Durable Objects hibernation APIs allow storing arbitrary sockets via
        // `state.acceptWebSocket()`. Ignore sockets without our attachment.
        if (!isManagedWebSocket(socket)) {
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

/** The platform-backed manager for hibernating WebSockets. */
export class HibernatingConnectionManager<TState = unknown> {
  constructor(private controller: DurableObjectState) {}

  getConnection<T = TState>(id: string) {
    // TODO: Should we cache the connections?
    const sockets = this.controller.getWebSockets(id);
    const matching = sockets.filter((ws) => {
      return tryGetManagedWebSocketMeta(ws)?.id === id;
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
    attachments.set(connection, {
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
