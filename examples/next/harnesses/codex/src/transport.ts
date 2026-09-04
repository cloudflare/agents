import type { Connection, LifecycleSockets } from "agents/lifecycle";
import type { StreamChunk, Streams } from "agents/streams";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import type { KernelJson } from "./kernel-types";
import type {
  CodexClientMessage,
  CodexOperationSnapshot,
  CodexServerMessage,
  CodexSessionSnapshot,
  CodexWorkspaceFile,
  SessionMessage
} from "./protocol";

/** The harness surface the transport drives. */
export interface CodexTransportHost {
  readonly streams: Streams;
  snapshot(): Promise<CodexSessionSnapshot>;
  submit(input: {
    readonly prompt: string;
    readonly operationId?: string;
  }): Promise<KernelJson>;
  operation(operationId: string): Promise<CodexOperationSnapshot | null>;
  message(id: string): Promise<SessionMessage | null>;
  readFile(path: string): Promise<CodexWorkspaceFile>;
  restart(): void;
}

const SESSION_TAG = "codex";
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

function isClientMessage(value: unknown): value is CodexClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function send(socket: WebSocket, message: CodexServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

/**
 * The Codex harness's WebSocket protocol over the `WebSockets` capability.
 *
 * A client receives a session snapshot on connect, subscribes to an
 * operation's durable Streams log to replay-then-tail its kernel events, and
 * drives the harness with `submit` and `restart`. Operation state changes are
 * broadcast to every connection on the object.
 */
export class CodexTransport {
  readonly #host: CodexTransportHost;
  readonly #sockets: () => LifecycleSockets;
  readonly #tails = new WeakMap<WebSocket, Map<string, AbortController>>();

  constructor(host: CodexTransportHost, sockets: () => LifecycleSockets) {
    this.#host = host;
    this.#sockets = sockets;
  }

  /** Options for `new WebSockets(...)` that serve this protocol. */
  webSocketOptions(): WebSocketsOptions {
    return {
      getConnectionTags: () => [SESSION_TAG],
      handlers: {
        onConnect: (connection) => this.#onConnect(connection),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#stopTails(connection),
        onError: (connection) => this.#stopTails(connection)
      }
    };
  }

  /** Tell every connection that an operation was accepted or settled. */
  operationChanged(operation: CodexOperationSnapshot): void {
    for (const socket of this.#sockets().get(SESSION_TAG)) {
      send(socket, { type: "operation", operation });
    }
  }

  async #onConnect(connection: Connection): Promise<void> {
    send(connection, {
      type: "snapshot",
      snapshot: await this.#host.snapshot()
    });
  }

  async #onMessage(
    connection: Connection,
    raw: WebSocketMessage
  ): Promise<void> {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });
      return;
    }
    if (!isClientMessage(message)) {
      send(connection, { type: "error", message: "Malformed Codex message" });
      return;
    }
    const id = "id" in message ? message.id : undefined;
    try {
      switch (message.type) {
        case "snapshot":
          send(connection, {
            type: "snapshot",
            snapshot: await this.#host.snapshot()
          });
          return;
        case "submit": {
          const receipt = await this.#host.submit({
            prompt: message.prompt,
            ...(message.operationId === undefined
              ? {}
              : { operationId: message.operationId })
          });
          send(connection, { type: "result", id: message.id, result: receipt });
          return;
        }
        case "subscribe": {
          const operation = await this.#host.operation(message.operationId);
          if (!operation) {
            throw new Error(`Unknown operation ${message.operationId}`);
          }
          void this.#tail(connection, operation, message.from ?? 0);
          return;
        }
        case "operation": {
          const operation = await this.#host.operation(message.operationId);
          if (!operation) {
            throw new Error(`Unknown operation ${message.operationId}`);
          }
          send(connection, { type: "operation", id: message.id, operation });
          return;
        }
        case "message":
          send(connection, {
            type: "message",
            id: message.id,
            message: await this.#host.message(message.messageId)
          });
          return;
        case "restart":
          send(connection, { type: "result", id: message.id, result: true });
          this.#host.restart();
          return;
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(id === undefined ? {} : { id }),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #tail(
    socket: WebSocket,
    operation: CodexOperationSnapshot,
    from: number
  ): Promise<void> {
    let tails = this.#tails.get(socket);
    if (!tails) {
      tails = new Map();
      this.#tails.set(socket, tails);
    }
    tails.get(operation.operationId)?.abort();
    const controller = new AbortController();
    tails.set(operation.operationId, controller);
    try {
      for await (const batch of this.#host.streams.readBatches(
        operation.streamId,
        { from, signal: controller.signal }
      )) {
        if (socket.readyState !== OPEN) return;
        send(socket, chunkMessage(operation.operationId, batch));
      }
      send(socket, { type: "stream_end", operationId: operation.operationId });
    } catch (error) {
      if (controller.signal.aborted) return;
      send(socket, {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (tails.get(operation.operationId) === controller) {
        tails.delete(operation.operationId);
      }
    }
  }

  #stopTails(connection: Connection): void {
    const tails = this.#tails.get(connection);
    if (!tails) return;
    for (const controller of tails.values()) controller.abort();
    this.#tails.delete(connection);
  }
}

function chunkMessage(
  operationId: string,
  batch: readonly StreamChunk[]
): CodexServerMessage {
  return {
    type: "events",
    operationId,
    seq: batch[0]?.seq ?? 0,
    lastSeq: batch[batch.length - 1]?.seq ?? 0,
    // SAFETY: every chunk of an operation stream is one kernel event appended
    // by CodexHarness from its durable event journal.
    events: batch.map((chunk) => chunk.chunk as KernelJson)
  };
}
