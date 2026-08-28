import { RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  Connection,
  ConnectionContext,
  ConnectionSetStateFn,
  ConnectionState,
  LifecycleHostContextScope
} from "../lifecycle";
import type { WebSocketHandlers } from "./options";
import type {
  TransportClientEvents,
  TransportMessage
} from "./transport-protocol";

export type CapnWebSessionHandlers = {
  send(message: TransportMessage): Promise<void>;
  dispose(): void | Promise<void>;
};

/**
 * Framework-owned session root exposed to the browser over a Cap'n Web
 * transport session. It carries exactly one method — the message pipe —
 * so the transport stays a drop-in replacement for a plain WebSocket:
 * every frame travels through it unchanged.
 *
 * Cap'n Web invokes methods directly on this instance, so it must never
 * be wrapped in a Proxy — private-field access would throw with a Proxy
 * receiver as `this`.
 */
export class CapnWebSessionRoot extends RpcTarget {
  readonly #handlers: CapnWebSessionHandlers;
  #disposed = false;

  constructor(handlers: CapnWebSessionHandlers) {
    super();
    this.#handlers = handlers;
  }

  async __cf_agent_send(message: TransportMessage): Promise<void> {
    if (this.#disposed) {
      throw new Error("Transport session is closed");
    }
    await this.#handlers.send(message);
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.#handlers.dispose();
  }
}

export type CapnWebConnectionOptions = {
  id: string;
  uri: string;
  tags: string[];
  send(message: TransportMessage): void;
  close(code?: number, reason?: string): void;
};

class CapnWebConnection extends EventTarget {
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  readonly id: string;
  readonly uri: string;
  tags: readonly string[];
  state: ConnectionState<unknown> = null;
  readyState: number = WebSocket.OPEN;
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  url: string;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly #send: CapnWebConnectionOptions["send"];
  readonly #close: CapnWebConnectionOptions["close"];

  constructor(options: CapnWebConnectionOptions) {
    super();
    this.id = options.id;
    this.uri = options.uri;
    this.url = options.uri;
    this.tags = options.tags;
    this.#send = options.send;
    this.#close = options.close;
  }

  send(message: TransportMessage): void {
    if (this.readyState !== WebSocket.OPEN) {
      throw new TypeError("WebSocket send() after close");
    }
    this.#send(message);
  }

  close(code?: number, reason?: string): void {
    if (
      this.readyState === WebSocket.CLOSING ||
      this.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    this.readyState = WebSocket.CLOSING;
    this.#close(code, reason);
  }

  setState<T = unknown>(
    stateOrFn: T | ConnectionSetStateFn<T> | null
  ): ConnectionState<T> {
    const next =
      typeof stateOrFn === "function"
        ? (stateOrFn as ConnectionSetStateFn<T>)(
            this.state as ConnectionState<T>
          )
        : stateOrFn;
    this.state = next as ConnectionState<unknown>;
    return next as ConnectionState<T>;
  }

  markClosed(): void {
    this.readyState = WebSocket.CLOSED;
  }

  setTags(tags: string[]): void {
    this.tags = tags;
  }
}

export type ManagedCapnWebConnection = {
  readonly connection: Connection;
  markClosed(): void;
  setTags(tags: string[]): void;
};

/**
 * Create a non-hibernating connection with the public Connection
 * contract. Unlike the capability's hibernating connections it exists
 * only in memory and disappears with the isolate.
 */
export function createCapnWebConnection(
  options: CapnWebConnectionOptions
): ManagedCapnWebConnection {
  const connection = new CapnWebConnection(options);
  return {
    connection: connection as unknown as Connection,
    markClosed: () => connection.markClosed(),
    setTags: (tags) => connection.setTags(tags)
  };
}

/** One live Cap'n Web transport session and its connection façade. */
export type CapnWebSession = {
  readonly managed: ManagedCapnWebConnection;
  readonly session: Disposable;
};

/** Everything the capability supplies to open one transport session. */
export type OpenCapnWebSessionOptions = {
  /** The claimed upgrade request. */
  readonly request: Request;
  /** Connection id (`_pk` or generated); the caller replaced any prior session. */
  readonly connectionId: string;
  /** Connection handlers, dispatched per event. */
  readonly handlers: WebSocketHandlers;
  /** Tags attached to the connection, when configured. */
  readonly getTags:
    | ((
        connection: Connection,
        ctx: ConnectionContext
      ) => string[] | Promise<string[]>)
    | undefined;
  /** Enter the host invocation boundary for one handler callback. */
  readonly dispatch: (
    fn: () => unknown,
    scope: LifecycleHostContextScope
  ) => Promise<unknown>;
  /** Record the live session under its connection id. */
  readonly register: (session: CapnWebSession) => void;
  /** Drop the session if it is still the registered one. */
  readonly unregister: (session: CapnWebSession) => void;
};

/**
 * Accept a Cap'n Web transport upgrade and run its session.
 *
 * The session root carries exactly one method — the message pipe — so
 * the capability's handlers are transport-agnostic; only the wire and
 * the connection's lifetime differ (the session is a plain in-memory
 * WebSocketPair, so it keeps the Durable Object pinned and does not
 * survive hibernation).
 *
 * @param options - Handlers, dispatch, and registry supplied by the capability.
 * @returns The 101 upgrade response carrying the client socket.
 */
export async function openCapnWebSession(
  options: OpenCapnWebSessionOptions
): Promise<Response> {
  const { request, connectionId, handlers, dispatch } = options;
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();

  let session: RpcStub<TransportClientEvents> | undefined;
  let registered: CapnWebSession | undefined;
  let closeCode = 1000;
  let closeReason = "Cap'n Web session closed";
  let wasClean = true;
  let disposed = false;

  const managed = createCapnWebConnection({
    id: connectionId,
    uri: request.url,
    tags: [],
    send: (message) => {
      if (!session) throw new Error("Transport session is not initialized");
      void session.message(message).catch((error: unknown) => {
        if (!disposed) {
          console.error("Failed to deliver Cap'n Web frame:", error);
        }
      });
    },
    close: (code, reason) => {
      closeCode = code ?? 1000;
      closeReason = reason ?? "Connection closed";
      // Close the raw socket so the client observes the requested
      // code/reason; fall back to disposing the RPC session when the
      // code is outside the range WebSocket.close accepts.
      try {
        server.close(closeCode, closeReason);
      } catch {
        session?.[Symbol.dispose]();
      }
      void dispose();
    }
  });
  const connection = managed.connection;
  const ctx = { request };
  const userTags = options.getTags
    ? await options.getTags(connection, ctx)
    : [];
  managed.setTags([
    connectionId,
    ...userTags.filter((tag) => tag !== connectionId)
  ]);

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (registered) options.unregister(registered);
    managed.markClosed();
    await dispatch(
      () => handlers.onClose?.(connection, closeCode, closeReason, wasClean),
      { connection }
    );
  };

  const root = new CapnWebSessionRoot({
    send: async (message) => {
      await dispatch(() => handlers.onMessage?.(connection, message), {
        connection
      });
    },
    dispose
  });

  session = newWebSocketRpcSession<TransportClientEvents>(server, root);
  registered = { managed, session };
  options.register(registered);

  server.addEventListener(
    "close",
    (event) => {
      closeCode = event.code;
      closeReason = event.reason;
      wasClean = event.wasClean;
      void dispose();
    },
    { once: true }
  );
  server.addEventListener(
    "error",
    () => {
      wasClean = false;
      void dispose();
    },
    { once: true }
  );

  try {
    await dispatch(() => handlers.onConnect?.(connection, ctx), {
      connection,
      request
    });
  } catch (error) {
    session[Symbol.dispose]();
    await dispose();
    throw error;
  }

  return new Response(null, { status: 101, webSocket: pair[1] });
}
