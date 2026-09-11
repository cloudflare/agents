import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import {
  CAPNWEB_TRANSPORT_SEND,
  capnWebTransportUrl,
  type TransportClientEvents,
  type TransportHostPipe,
  type TransportMessage
} from "./transport-protocol";

/** Local root the host calls to deliver frames. */
class Inbox extends RpcTarget implements TransportClientEvents {
  constructor(private readonly socket: CapnWebSocket) {
    super();
  }

  message(value: TransportMessage): void {
    this.socket.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

/**
 * A WebSocket-shaped client for the Cap'n Web connection transport.
 *
 * It has the constructor, `readyState`, `send()`, `close()`, and events of
 * a `WebSocket`, so PartySocket (and therefore `useAgent` and
 * `AgentClient`) can drive it as a drop-in socket implementation and keep
 * owning reconnection, buffering, and backoff. Frames sent here travel
 * through the host's pipe method; frames from the host arrive as
 * `message` events.
 *
 * @experimental The transport is experimental.
 */
export class CapnWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readyState = CapnWebSocket.CONNECTING;
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  readonly #socket: WebSocket;
  readonly #root: RpcStub<TransportHostPipe>;

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = capnWebTransportUrl(url);
    this.#socket = protocols
      ? new WebSocket(this.url, protocols)
      : new WebSocket(this.url);
    this.#root = newWebSocketRpcSession<TransportHostPipe>(
      this.#socket,
      new Inbox(this)
    );
    this.#socket.addEventListener("open", () => {
      this.readyState = CapnWebSocket.OPEN;
      this.protocol = this.#socket.protocol;
      this.dispatchEvent(new Event("open"));
    });
    this.#socket.addEventListener("close", (event) => {
      this.readyState = CapnWebSocket.CLOSED;
      this.dispatchEvent(
        new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        })
      );
    });
    this.#socket.addEventListener("error", () => {
      this.dispatchEvent(new Event("error"));
    });
  }

  override dispatchEvent(event: Event): boolean {
    const handler = Reflect.get(this, `on${event.type}`) as unknown;
    if (typeof handler === "function") Reflect.apply(handler, this, [event]);
    return super.dispatchEvent(event);
  }

  /**
   * Invoke one of the host's native callables on the session root. The
   * result keeps Cap'n Web semantics: an `RpcTarget` arrives as a live
   * stub, a `ReadableStream` streams, and chained calls pipeline.
   */
  invoke(method: string, args: unknown[]): Promise<unknown> {
    if (this.readyState !== CapnWebSocket.OPEN) {
      return Promise.reject(new Error("Connection closed"));
    }
    const root = this.#root as unknown as Record<string, unknown>;
    const remote = root[method];
    if (typeof remote !== "function") {
      return Promise.reject(new Error(`Method ${method} does not exist`));
    }
    // Cap'n Web returns an RpcPromise; awaiting it settles to the value
    // (a stub for RpcTarget results). Resolve through a plain Promise so
    // callers hold nothing exotic.
    return Promise.resolve(Reflect.apply(remote, root, args));
  }

  send(data: TransportMessage): void {
    if (this.readyState !== CapnWebSocket.OPEN) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    void this.#root[CAPNWEB_TRANSPORT_SEND](data).catch(() => {
      this.dispatchEvent(new Event("error"));
    });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= CapnWebSocket.CLOSING) return;
    this.readyState = CapnWebSocket.CLOSING;
    try {
      this.#root[Symbol.dispose]();
    } catch {
      // The session is already gone; closing the socket is enough.
    }
    this.#socket.close(code, reason);
  }
}

/**
 * A `CapnWebSocket` subclass that reports each instance it constructs.
 * PartySocket instantiates the class it is given; this is how a client
 * gets hold of the live socket to call `invoke()` without reaching into
 * PartySocket internals.
 */
export function boundCapnWebSocket(
  onCreate: (socket: CapnWebSocket) => void
): typeof CapnWebSocket {
  return class BoundCapnWebSocket extends CapnWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      onCreate(this);
    }
  };
}

/** Legacy `{ onChunk, onDone, onError }` or `{ timeout, stream }` options. */
export type NativeCallOptions = {
  readonly stream?: {
    onChunk?: (chunk: unknown) => void;
    onDone?: (finalValue: unknown) => void;
    onError?: (error: string) => void;
  };
  readonly timeout?: number;
};

/**
 * Run one native call with the same timeout and stream-callback contract
 * `call()` has on the JSON wire. A `ReadableStream` result is drained
 * into the stream callbacks when they are given; otherwise it is returned
 * as is. Any other value, stubs included, passes straight through.
 */
export async function nativeCall<T>(
  socket: CapnWebSocket,
  method: string,
  args: unknown[],
  options: NativeCallOptions,
  defaultTimeout: number
): Promise<T> {
  const { stream, timeout } = options;
  const effectiveTimeout =
    timeout !== undefined ? timeout : stream ? undefined : defaultTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invocation = socket.invoke(method, args);
  const raced = effectiveTimeout
    ? Promise.race([
        invocation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `RPC call to ${method} timed out after ${effectiveTimeout}ms`
                )
              ),
            effectiveTimeout
          );
        })
      ])
    : invocation;
  try {
    const result = await raced;
    if (stream && result instanceof ReadableStream) {
      for await (const chunk of result) stream.onChunk?.(chunk);
      stream.onDone?.(undefined);
      return undefined as T;
    }
    return result as T;
  } catch (error) {
    stream?.onError?.(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
