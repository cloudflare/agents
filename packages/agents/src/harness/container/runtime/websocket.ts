/**
 * The server half of RFC 6455, for one kind of peer: the Durable Object,
 * which sends text messages and closes cleanly. Enough of the protocol for
 * that (handshake, masked client frames, fragmentation, ping, close) and
 * nothing else, so the daemon needs no dependencies and runs on the plain
 * Node in `cloudflare/debian-trixie`.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest message accepted. Restore messages are chunked well below this. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** One accepted WebSocket connection. */
export type ServerSocket = {
  send(text: string): void;
  close(code: number, reason: string): void;
};

/** What the server reports for a connection. */
export type ServerSocketHandlers = {
  message(text: string): void;
  /** The connection ended, from either side. Called once. */
  closed(): void;
};

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127]),
            (() => {
              const size = Buffer.alloc(8);
              size.writeBigUInt64BE(BigInt(length));
              return size;
            })()
          ]);
  return Buffer.concat([header, payload]);
}

/**
 * Complete the upgrade handshake and serve the connection.
 *
 * @param request - The upgrade request.
 * @param socket - The raw socket.
 * @param head - Bytes read past the request head.
 * @param handlers - Called for each message and on close.
 * @returns The connection, or undefined when the request was not a valid
 *   upgrade (the socket is destroyed).
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  handlers: ServerSocketHandlers
): ServerSocket | undefined {
  const key = request.headers["sec-websocket-key"];
  if (
    typeof key !== "string" ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    socket.destroy();
    return undefined;
  }
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let open = true;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    open = false;
    handlers.closed();
  };
  const write = (opcode: number, payload: Buffer) => {
    if (!open) return;
    socket.write(frame(opcode, payload));
  };
  const connection: ServerSocket = {
    send: (text) => write(OP_TEXT, Buffer.from(text, "utf8")),
    close: (code, reason) => {
      if (!open) return;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code);
      payload.write(reason, 2);
      write(OP_CLOSE, payload);
      open = false;
      socket.end();
    }
  };

  let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;

  const drain = () => {
    for (;;) {
      if (buffered.length < 2) return;
      const first = buffered[0] ?? 0;
      const second = buffered[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          connection.close(1009, "message too big");
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffered.length < offset + length) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] =
            (payload[i] ?? 0) ^ (buffered[maskOffset + (i % 4)] ?? 0);
        }
      }
      buffered = buffered.subarray(offset + length);

      switch (opcode) {
        case OP_TEXT:
        case OP_BINARY:
        case OP_CONTINUATION: {
          fragments.push(payload);
          fragmentBytes += payload.length;
          if (fragmentBytes > MAX_MESSAGE_BYTES) {
            connection.close(1009, "message too big");
            return;
          }
          if (fin) {
            const message = Buffer.concat(fragments).toString("utf8");
            fragments = [];
            fragmentBytes = 0;
            handlers.message(message);
          }
          break;
        }
        case OP_PING:
          write(OP_PONG, payload);
          break;
        case OP_PONG:
          break;
        case OP_CLOSE:
          if (open) {
            write(OP_CLOSE, payload.subarray(0, 2));
            open = false;
          }
          socket.end();
          end();
          return;
        default:
          connection.close(1002, "unsupported opcode");
          return;
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    drain();
  });
  socket.on("close", end);
  socket.on("error", end);
  if (buffered.length > 0) queueMicrotask(drain);
  return connection;
}
