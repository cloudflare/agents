import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import {
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_SEND,
  CAPNWEB_TRANSPORT_VALUE,
  type TransportClientEvents,
  type TransportMessage
} from "./transport-protocol";

type RemoteStub = ReturnType<typeof newWebSocketRpcSession>;

type Session = {
  readonly socket: WebSocket;
  readonly root: RemoteStub;
};

type SessionWaiter = {
  resolve(session: Session): void;
  reject(error: Error): void;
};

type ValueProvider<T> = T | (() => T | Promise<T>);

export type CapnWebAgentClientOptions = {
  /** Fully resolved socket URL, including query parameters and `_pk`. */
  url: string;
  id: string;
  protocols?: ValueProvider<string | string[] | null>;
  shouldReconnectOnClose(event: CloseEvent): boolean;
  minReconnectionDelay?: number;
  maxReconnectionDelay?: number;
};

/** Local Cap'n Web target the server calls to deliver Agent messages. */
class ClientEvents extends RpcTarget implements TransportClientEvents {
  readonly #client: CapnWebAgentClient;

  constructor(client: CapnWebAgentClient) {
    super();
    this.#client = client;
  }

  message(value: TransportMessage): void {
    this.#client.receive(value);
  }
}

/**
 * Single-socket Cap'n Web message pipe with a WebSocket-shaped surface.
 *
 * This is deliberately *only* a transport: `send()` forwards Agent
 * protocol frames to the server and incoming frames surface as
 * `message` events, so every existing consumer of the socket — state
 * sync, identity, RPC frames, chat — works unchanged. The server-side
 * connection is non-hibernating.
 */
export class CapnWebAgentClient extends EventTarget {
  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  readonly id: string;
  readonly url: string;
  readonly #options: CapnWebAgentClientOptions;
  #session: Session | undefined;
  #waiters = new Set<SessionWaiter>();
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #retryCount = 0;
  #explicitlyClosed = false;
  #generation = 0;

  readyState: number = WebSocket.CLOSED;
  shouldReconnect = false;
  protocol = "";
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  extensions = "";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(options: CapnWebAgentClientOptions) {
    super();
    this.#options = options;
    this.id = options.id;
    const url = new URL(options.url);
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    this.url = url.toString();
  }

  connect(): void {
    if (
      this.readyState === WebSocket.CONNECTING ||
      this.readyState === WebSocket.OPEN
    ) {
      return;
    }
    this.#explicitlyClosed = false;
    this.shouldReconnect = true;
    this.#retryCount = 0;
    this.#open();
  }

  reconnect(code = 1000, reason = "Reconnecting"): void {
    this.#explicitlyClosed = false;
    this.shouldReconnect = true;
    this.#retryCount = 0;
    this.#generation += 1;
    this.#disposeSession(code, reason);
    this.#open();
  }

  close(code = 1000, reason = ""): void {
    this.#explicitlyClosed = true;
    this.shouldReconnect = false;
    this.#generation += 1;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#disposeSession(code, reason);
    this.#rejectWaiters(new Error("Connection closed"));
  }

  /**
   * Send one Agent protocol frame. Mirrors PartySocket buffering: a
   * frame sent while disconnected waits for the next session (and is
   * dropped with an `error` event if the connection ends for good).
   */
  send(message: TransportMessage): boolean {
    const transmitted = this.readyState === WebSocket.OPEN;
    void this.#deliver(message).catch((error: unknown) => {
      this.#emitError(error);
    });
    return transmitted;
  }

  /** Dispatch one server-delivered frame as a `message` event. */
  receive(value: TransportMessage): void {
    const event = new MessageEvent("message", { data: value });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  async #deliver(message: TransportMessage): Promise<void> {
    const session = await this.#getSession();
    const sendMethod = Reflect.get(session.root, CAPNWEB_TRANSPORT_SEND) as (
      message: TransportMessage
    ) => Promise<void>;
    await Reflect.apply(sendMethod, session.root, [message]);
  }

  #open(): void {
    const generation = ++this.#generation;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.readyState = WebSocket.CONNECTING;
    void this.#resolveProtocols().then(
      (protocols) => {
        if (generation !== this.#generation || this.#explicitlyClosed) return;
        this.#openResolved(generation, protocols);
      },
      (error: unknown) => {
        if (generation !== this.#generation) return;
        this.#handleConnectionFailure(error);
      }
    );
  }

  #openResolved(generation: number, protocols: string | string[] | null): void {
    let socket: WebSocket;
    try {
      socket = protocols
        ? new WebSocket(this.url, protocols)
        : new WebSocket(this.url);
    } catch (error) {
      this.#handleConnectionFailure(error);
      return;
    }
    socket.binaryType = this.binaryType;
    const root = newWebSocketRpcSession(socket, new ClientEvents(this));
    const session: Session = { socket, root };
    this.#session = session;
    for (const waiter of this.#waiters) waiter.resolve(session);
    this.#waiters.clear();

    socket.addEventListener("open", (event) => {
      if (generation !== this.#generation) return;
      this.readyState = WebSocket.OPEN;
      this.protocol = socket.protocol;
      this.#retryCount = 0;
      this.onopen?.(event);
      this.dispatchEvent(new Event("open"));
    });
    socket.addEventListener("error", (event) => {
      if (generation !== this.#generation) return;
      this.#emitError(event);
    });
    socket.addEventListener("close", (event) => {
      if (generation !== this.#generation) return;
      this.readyState = WebSocket.CLOSED;
      this.#session = undefined;
      this.shouldReconnect =
        !this.#explicitlyClosed && this.#options.shouldReconnectOnClose(event);
      if (!this.shouldReconnect) {
        this.#rejectWaiters(
          new Error(
            event.reason
              ? `Connection closed: ${event.reason}`
              : `Connection closed with code ${event.code}`
          )
        );
      }
      this.onclose?.(event);
      this.dispatchEvent(
        new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        })
      );
      if (this.shouldReconnect) this.#scheduleReconnect();
    });
  }

  #handleConnectionFailure(error: unknown): void {
    this.readyState = WebSocket.CLOSED;
    this.#emitError(error);
    if (!this.#explicitlyClosed && this.shouldReconnect) {
      this.#scheduleReconnect();
      return;
    }
    this.#rejectWaiters(
      error instanceof Error ? error : new Error("Connection failed")
    );
  }

  async #resolveProtocols(): Promise<string | string[] | null> {
    const provided = this.#options.protocols;
    const value = typeof provided === "function" ? await provided() : provided;
    return value ?? null;
  }

  #scheduleReconnect(): void {
    const minimum = this.#options.minReconnectionDelay ?? 500;
    const maximum = this.#options.maxReconnectionDelay ?? 10_000;
    const delay = Math.min(maximum, minimum * 2 ** this.#retryCount++);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  #disposeSession(code: number, reason: string): void {
    const session = this.#session;
    // The close listener is generation-guarded, so an explicit dispose
    // must clear the session bookkeeping itself — the listener won't run.
    this.#session = undefined;
    this.readyState = WebSocket.CLOSED;
    if (!session) return;
    try {
      session.root[Symbol.dispose]();
    } catch {
      session.socket.close(code, reason);
    }
  }

  #getSession(): Session | Promise<Session> {
    if (this.#explicitlyClosed) {
      return Promise.reject(new Error("Connection closed"));
    }
    if (this.#session) return this.#session;
    // Park until the next session opens; rejected if the connection
    // fails terminally (explicit close, terminal close code, or a
    // connection failure with reconnection disabled).
    return new Promise<Session>((resolve, reject) => {
      this.#waiters.add({ resolve, reject });
    });
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  #emitError(_cause: unknown): void {
    // Always dispatch a fresh event: re-dispatching a foreign Event
    // that is still being dispatched (e.g. the socket's own error
    // event) throws, silently skipping every listener.
    const event = new Event("error");
    this.onerror?.(event);
    this.dispatchEvent(event);
  }
}
