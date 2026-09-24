import type { Connection, LifecycleSockets } from "../lifecycle";
import type { StreamChunk, Streams } from "../streams";
import type { WebSocketMessage, WebSocketsOptions } from "../websockets";
import type { OpenCodeRequest } from "./types";
import type {
  OCClientMessage,
  OCEvent,
  OCJson,
  OCServerMessage,
  OCSnapshot,
  OCSubmissionReceipt
} from "./types";

export interface OpenCodeTransportHost {
  readonly streams: Streams;
  snapshot(options: { sessionId?: string }): Promise<OCSnapshot>;
  submit(
    request: OpenCodeRequest,
    options: { sessionId?: string }
  ): Promise<OCSubmissionReceipt>;
  abort(options: {
    sessionId?: string;
    operationId?: string;
  }): Promise<{ operationId: string } | null>;
  steer(text: string, options: { sessionId?: string }): Promise<void>;
  replyPermission(
    permissionId: string,
    reply: "once" | "always" | "reject"
  ): Promise<void>;
}

const OPEN = 1;

function send(socket: WebSocket, message: OCServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {}
}

export class OpenCodeTransport {
  readonly #host: OpenCodeTransportHost;
  readonly #sockets: () => LifecycleSockets;
  readonly #tails = new WeakMap<WebSocket, Map<string, AbortController>>();

  constructor(host: OpenCodeTransportHost, sockets: () => LifecycleSockets) {
    this.#host = host;
    this.#sockets = sockets;
  }

  webSocketOptions(): WebSocketsOptions {
    return {
      handlers: {
        onConnect: (connection) => this.#onConnect(connection),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#stopTails(connection),
        onError: (connection) => this.#stopTails(connection)
      }
    };
  }

  sessionEvent(event: OCEvent): void {
    for (const socket of this.#sockets().get()) {
      send(socket as unknown as WebSocket, { type: "event", event });
    }
  }

  streamOpened(streamId: string, operationId: string, _cursor: number): void {
    for (const socket of this.#sockets().get()) {
      send(socket as unknown as WebSocket, {
        type: "stream_start",
        streamId,
        operationId
      });
    }
  }

  async #onConnect(connection: Connection): Promise<void> {
    const snapshot = await this.#host.snapshot({});
    send(connection as unknown as WebSocket, { type: "snapshot", snapshot });
  }

  async #onMessage(
    connection: Connection,
    raw: WebSocketMessage
  ): Promise<void> {
    if (typeof raw !== "string") return;
    let message: OCClientMessage;
    try {
      message = JSON.parse(raw) as OCClientMessage;
    } catch {
      send(connection as unknown as WebSocket, {
        type: "error",
        message: "Malformed message"
      });
      return;
    }
    const socket = connection as unknown as WebSocket;
    try {
      switch (message.type) {
        case "snapshot":
          send(socket, {
            type: "snapshot",
            id: message.id,
            snapshot: await this.#host.snapshot({})
          });
          return;
        case "subscribe":
          await this.#subscribe(socket, message.streamId, message.from ?? 0);
          return;
        case "unsubscribe":
          this.#stopTail(socket, message.streamId);
          return;
        case "submit": {
          const receipt = await this.#host.submit(message.request, {});
          send(socket, {
            type: "result",
            id: message.id,
            result: receipt as unknown as OCJson
          });
          return;
        }
        case "abort": {
          const result = await this.#host.abort({
            operationId: message.operationId
          });
          send(socket, {
            type: "result",
            id: message.id,
            result: result as unknown as OCJson
          });
          return;
        }
        case "steer":
          await this.#host.steer(message.text, {});
          send(socket, { type: "result", id: message.id, result: null });
          return;
        case "permission":
          await this.#host.replyPermission(message.permissionId, message.reply);
          send(socket, { type: "result", id: message.id, result: null });
          return;
      }
    } catch (error) {
      send(socket, {
        type: "error",
        id: "id" in message ? message.id : undefined,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #subscribe(
    socket: WebSocket,
    streamId: string,
    from: number
  ): Promise<void> {
    this.#stopTail(socket, streamId);
    const controller = new AbortController();
    let tails = this.#tails.get(socket);
    if (!tails) {
      tails = new Map();
      this.#tails.set(socket, tails);
    }
    tails.set(streamId, controller);

    const status = await this.#host.streams.status(streamId);
    if (!status) {
      send(socket, { type: "error", message: `Unknown stream ${streamId}` });
      return;
    }

    void (async () => {
      try {
        for await (const batch of this.#host.streams.readBatches(streamId, {
          from,
          signal: controller.signal
        })) {
          const chunks = batch as unknown as StreamChunk[];
          if (chunks.length === 0) continue;
          send(socket, {
            type: "events",
            streamId,
            operationId: String(status.metadata?.operationId ?? ""),
            seq: chunks[0].seq,
            lastSeq: chunks[chunks.length - 1].seq,
            events: chunks.flatMap(
              (chunk) => chunk.chunk as unknown as OCEvent[]
            )
          });
        }
        send(socket, {
          type: "stream_end",
          streamId,
          operationId: String(status.metadata?.operationId ?? "")
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          send(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    })();
  }

  #stopTail(socket: WebSocket, streamId: string): void {
    const tails = this.#tails.get(socket);
    tails?.get(streamId)?.abort();
    tails?.delete(streamId);
  }

  #stopTails(connection: Connection): void {
    const socket = connection as unknown as WebSocket;
    const tails = this.#tails.get(socket);
    if (!tails) return;
    for (const controller of tails.values()) controller.abort();
    this.#tails.delete(socket);
  }
}
