import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  Connection,
  ConnectionContext,
  ConnectionSetStateFn,
  ConnectionState,
  LifecycleHostContextScope
} from "../lifecycle";
import {
  buildCallablesRoot,
  type CallableMethod
} from "./callables-target";
import type { WebSocketHandlers } from "./options";
import {
  CAPNWEB_TRANSPORT_SEND,
  type TransportClientEvents,
  type TransportMessage
} from "./transport-protocol";

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
 * Create a non-hibernating connection with the public Connection contract.
 * Unlike the capability's hibernating connections it exists only in memory
 * and disappears with the isolate.
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

/** One live Cap'n Web transport session and its connection facade. */
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
  /** Native methods exposed beside the framework message pipe. */
  readonly callables: ReadonlyMap<string, CallableMethod>;
  /** Invoke one native method inside capability policy and host context. */
  readonly invokeCallable: (
    name: string,
    method: CallableMethod,
    args: unknown[],
    connection: Connection
  ) => Promise<unknown>;
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
 * Accept a unified Cap'n Web Agent session.
 *
 * One root exposes the reserved framework message pipe and every configured
 * native callable. State, identity, chat, and arbitrary messages use the
 * pipe. `useAgent().call` and `.stub` invoke the native methods directly on
 * this same session.
 *
 * The session uses a plain in-memory `WebSocketPair`, so it keeps the Durable
 * Object pinned and does not survive hibernation.
 *
 * @param options - Handlers, callables, dispatch, and registry supplied by
 * the capability.
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

  const rootMethods = new Map<string, CallableMethod>();
  rootMethods.set(CAPNWEB_TRANSPORT_SEND, {
    streaming: false,
    invoke: async (message: unknown) => {
      await dispatch(
        () => handlers.onMessage?.(connection, message as TransportMessage),
        { connection }
      );
    }
  });
  for (const [name, method] of options.callables) {
    rootMethods.set(name, {
      streaming: method.streaming,
      invoke: (...args) =>
        options.invokeCallable(name, method, args, connection)
    });
  }
  const root = buildCallablesRoot(rootMethods, () => void dispose());

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
    (event) => {
      if (disposed) return;
      wasClean = false;
      const error =
        event instanceof ErrorEvent
          ? (event.error ?? new Error(event.message))
          : new Error("Cap'n Web transport socket error");
      void dispatch(() => handlers.onError?.(connection, error), {
        connection
      })
        .catch((handlerError: unknown) => {
          console.error("Cap'n Web onError handler failed:", handlerError);
        })
        .finally(() => dispose());
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
