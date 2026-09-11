import { RpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  Connection,
  ConnectionContext,
  ConnectionSetStateFn,
  ConnectionState
} from "../lifecycle";
import {
  CAPNWEB_TRANSPORT_SEND,
  type TransportClientEvents,
  type TransportMessage
} from "./transport-protocol";

/**
 * A non-hibernating connection with the public `Connection` contract,
 * backed by a Cap'n Web session instead of a hibernating socket. It lives
 * only in memory and disappears with the isolate.
 */
class CapnWebConnection extends EventTarget {
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  readyState: number = WebSocket.OPEN;
  state: ConnectionState<unknown> = null;
  tags: readonly string[] = [];

  constructor(
    readonly id: string,
    readonly uri: string,
    private readonly pipe: {
      send(message: TransportMessage): void;
      close(code?: number, reason?: string): void;
    }
  ) {
    super();
  }

  send(message: TransportMessage): void {
    if (this.readyState !== WebSocket.OPEN) {
      throw new TypeError("WebSocket send() after close");
    }
    this.pipe.send(message);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    this.pipe.close(code, reason);
  }

  setState<T = unknown>(
    next: T | ConnectionSetStateFn<T> | null
  ): ConnectionState<T> {
    const state =
      typeof next === "function"
        ? (next as ConnectionSetStateFn<T>)(this.state as ConnectionState<T>)
        : next;
    this.state = state as ConnectionState<unknown>;
    return state as ConnectionState<T>;
  }
}

/** The host's session root: exactly one method, the frame pipe. */
class Pipe extends RpcTarget {
  constructor(
    private readonly deliver: (message: TransportMessage) => Promise<void>
  ) {
    super();
  }

  [CAPNWEB_TRANSPORT_SEND](message: TransportMessage): Promise<void> {
    return this.deliver(message);
  }
}

/** One live transport session. */
export type CapnWebSession = {
  readonly connection: Connection;
  /** Tear the session down; runs the close handler once. */
  dispose(): void;
};

/** What the capability supplies to run one session. */
export type CapnWebSessionOptions = {
  readonly request: Request;
  readonly connectionId: string;
  readonly tags: (
    connection: Connection,
    ctx: ConnectionContext
  ) => string[] | Promise<string[]>;
  readonly onConnect: (
    connection: Connection,
    ctx: ConnectionContext
  ) => Promise<void>;
  readonly onMessage: (
    connection: Connection,
    message: TransportMessage
  ) => Promise<void>;
  readonly onClose: (
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ) => Promise<void>;
  readonly onError: (connection: Connection, error: unknown) => Promise<void>;
  /**
   * Called once the connection exists, before `onConnect`, so it is already
   * visible in `getConnections()` while the connect handler runs — the same
   * ordering as a hibernating socket, which is accepted before `onConnect`.
   */
  readonly onOpen: (session: CapnWebSession) => void;
  /** Called exactly once when the session ends, before `onClose`. */
  readonly onDispose: (session: CapnWebSession) => void;
};

/**
 * Accept a Cap'n Web transport upgrade.
 *
 * The client's frames arrive through the pipe method and are handed to
 * `onMessage`; the host's frames go out through the client's `message`
 * callback. The socket is a plain in-memory `WebSocketPair`, so it pins
 * the Durable Object and does not survive hibernation.
 */
export async function openCapnWebSession(
  options: CapnWebSessionOptions
): Promise<{ response: Response; session: CapnWebSession }> {
  const { request, connectionId } = options;
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();

  let client: RpcStub<TransportClientEvents> | undefined;
  let closed = false;
  let close = { code: 1000, reason: "", wasClean: true };

  const connection = new CapnWebConnection(connectionId, request.url, {
    send: (message) => {
      void client?.message(message).catch((error: unknown) => {
        if (!closed) console.error("Cap'n Web frame delivery failed:", error);
      });
    },
    close: (code = 1000, reason = "") => {
      close = { code, reason, wasClean: true };
      try {
        server.close(code, reason);
      } catch {
        // Already closing; finish() below still runs the close handler.
      }
      void finish();
    }
  }) as unknown as Connection & CapnWebConnection;

  const session: CapnWebSession = {
    connection,
    dispose: () => connection.close(1001, "Session replaced")
  };

  const finish = async () => {
    if (closed) return;
    closed = true;
    connection.readyState = WebSocket.CLOSED;
    try {
      client?.[Symbol.dispose]();
    } catch {
      // The session already ended with the socket.
    }
    options.onDispose(session);
    await options.onClose(connection, close.code, close.reason, close.wasClean);
  };

  client = newWebSocketRpcSession<TransportClientEvents>(
    server,
    new Pipe((message) => options.onMessage(connection, message))
  );

  server.addEventListener(
    "close",
    (event) => {
      close = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      };
      void finish();
    },
    { once: true }
  );
  server.addEventListener(
    "error",
    (event) => {
      if (closed) return;
      close = { ...close, wasClean: false };
      const error =
        event instanceof ErrorEvent
          ? (event.error ?? new Error(event.message))
          : new Error("Cap'n Web transport socket error");
      void options
        .onError(connection, error)
        .catch((handlerError: unknown) => {
          console.error("Cap'n Web onError handler failed:", handlerError);
        })
        .finally(finish);
    },
    { once: true }
  );

  const ctx = { request };
  connection.tags = [
    connectionId,
    ...(await options.tags(connection, ctx)).filter((t) => t !== connectionId)
  ];
  options.onOpen(session);
  try {
    await options.onConnect(connection, ctx);
  } catch (error) {
    connection.close(1011, "onConnect failed");
    throw error;
  }

  return {
    response: new Response(null, { status: 101, webSocket: pair[1] }),
    session
  };
}
