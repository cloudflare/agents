import type { Connection, WSMessage } from "../lifecycle";

/** The arguments a handler passed to `close()`, as given. */
type CloseArgs = readonly [code?: number, reason?: string];

/** What a hibernating connection's connect sequence left behind. */
type ConnectOutcome =
  | { readonly _tag: "open" }
  | {
      readonly _tag: "closed";
      /** Every frame sent before the close, in order. */
      readonly frames: readonly WSMessage[];
      readonly close: CloseArgs;
    };

/**
 * Run a hibernating connection's connect sequence and build its upgrade
 * response.
 *
 * The sequence runs before the 101 response exists. A hibernating socket
 * closed at that point sends its Close frame, but the runtime does not end
 * the connection until the socket has received a message, so a real client
 * never sees `close`. When the sequence closes the connection, the client
 * gets a fresh non-hibernating socket instead, carrying the same frames and
 * the same close. The hibernating socket's own client end is completed
 * in-process, so the host still gets its close wake and `onClose` runs.
 *
 * @param connection - The accepted hibernating connection.
 * @param client - The client end of the connection's `WebSocketPair`.
 * @param connect - The connect sequence; may send to and close `connection`.
 * @returns The 101 response to hand back to the client.
 */
export async function connectHibernatingSocket(
  connection: Connection,
  client: WebSocket,
  connect: () => Promise<void>
): Promise<Response> {
  const outcome = await recordConnect(connection, client, connect);
  if (outcome._tag === "open") {
    return new Response(null, { status: 101, webSocket: client });
  }
  const replacement = new WebSocketPair();
  const server = replacement[1];
  server.accept();
  for (const frame of outcome.frames) server.send(frame);
  server.close(...outcome.close);
  return new Response(null, { status: 101, webSocket: replacement[0] });
}

/**
 * Run `connect` while recording what it sends and whether it closes the
 * connection. Sends and the close still reach the socket as usual, so
 * `readyState`, `getConnections()` and send-after-close behave the same.
 */
async function recordConnect(
  connection: Connection,
  client: WebSocket,
  connect: () => Promise<void>
): Promise<ConnectOutcome> {
  const frames: WSMessage[] = [];
  let close: CloseArgs | undefined;
  Object.defineProperties(connection, {
    send: {
      configurable: true,
      value(message: WSMessage) {
        WebSocket.prototype.send.call(connection, message);
        frames.push(copyFrame(message));
      }
    },
    close: {
      configurable: true,
      value(...args: CloseArgs) {
        WebSocket.prototype.close.call(connection, ...args);
        close ??= args;
      }
    }
  });
  try {
    await connect();
  } finally {
    // Back to the prototype's methods: the recording is for this window
    // only, and the connection outlives it.
    Reflect.deleteProperty(connection, "send");
    Reflect.deleteProperty(connection, "close");
    if (close !== undefined) completeClose(client);
  }
  return close === undefined
    ? { _tag: "open" }
    : { _tag: "closed", frames, close };
}

/**
 * Finish the close handshake on a client end that will never reach a
 * client, so the runtime delivers the host's close wake and forgets the
 * socket.
 */
function completeClose(client: WebSocket): void {
  client.accept();
  client.addEventListener(
    "close",
    (event) => {
      try {
        client.close(event.code, event.reason);
      } catch {
        // Already answered by the runtime's automatic close reply.
      }
    },
    { once: true }
  );
}

/** Copy a binary frame, which the caller may reuse after `send()`. */
function copyFrame(message: WSMessage): WSMessage {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return message.slice(0);
  return new Uint8Array(
    message.buffer,
    message.byteOffset,
    message.byteLength
  ).slice();
}
