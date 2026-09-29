import type { Connection, LifecycleSockets } from "agents/lifecycle";
import type { StreamChunk, Streams } from "agents/streams";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import { HarnessBuildError } from "./harness-runtime";
import type { JsonObject } from "./json";
import { toJsonValue } from "./json";
import type {
  HarnessClientMessage,
  HarnessRevision,
  HarnessServerMessage,
  HarnessSnapshot,
  HarnessTurn,
  HarnessTurnReceipt
} from "./protocol";

/** The harness surface the transport drives. */
export interface HarnessTransportHost {
  readonly streams: Streams;
  snapshot(): Promise<HarnessSnapshot>;
  submit(prompt: string): Promise<HarnessTurnReceipt>;
  getTurn(turnId: string): Promise<HarnessTurn | null>;
  writeSource(path: string, content: string): Promise<void>;
  activate(note: string): Promise<HarnessRevision>;
  restore(revisionId: number): Promise<HarnessRevision>;
}

const OBJECT_TAG = "self-modifying";
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

function isClientMessage(value: unknown): value is HarnessClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function send(socket: WebSocket, message: HarnessServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

function asObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  return typeof json === "object" && json !== null && !Array.isArray(json)
    ? json
    : { value: json };
}

/**
 * The harness's WebSocket protocol over the `WebSockets` capability.
 *
 * A client receives an object snapshot on connect, subscribes to a turn's
 * durable Streams log to replay-then-tail its events, and drives the harness
 * with `submit`, `write_source`, `activate`, and `restore`. Turn and revision
 * changes are broadcast to every connection on the object.
 */
export class HarnessTransport {
  readonly #host: HarnessTransportHost;
  readonly #sockets: () => LifecycleSockets;
  readonly #tails = new WeakMap<WebSocket, Map<string, AbortController>>();

  constructor(host: HarnessTransportHost, sockets: () => LifecycleSockets) {
    this.#host = host;
    this.#sockets = sockets;
  }

  /** Options for `new WebSockets(...)` that serve this protocol. */
  webSocketOptions(): WebSocketsOptions {
    return {
      getConnectionTags: () => [OBJECT_TAG],
      handlers: {
        onConnect: (connection) => this.#sendSnapshot(connection),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#stopTails(connection),
        onError: (connection) => this.#stopTails(connection)
      }
    };
  }

  /** Tell every connection that a turn changed state. */
  turnChanged(turn: HarnessTurn): void {
    for (const socket of this.#sockets().get(OBJECT_TAG)) {
      send(socket, { type: "turn", turn });
    }
  }

  /** Tell every connection that revisions, source, or the journal changed. */
  async stateChanged(): Promise<void> {
    const sockets = this.#sockets().get(OBJECT_TAG);
    if (sockets.length === 0) return;
    const snapshot = await this.#host.snapshot();
    for (const socket of sockets) send(socket, { type: "snapshot", snapshot });
  }

  async #sendSnapshot(socket: WebSocket): Promise<void> {
    send(socket, { type: "snapshot", snapshot: await this.#host.snapshot() });
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
      send(connection, { type: "error", message: "Malformed harness message" });
      return;
    }
    const id = "id" in message ? message.id : undefined;
    try {
      switch (message.type) {
        case "snapshot":
          await this.#sendSnapshot(connection);
          return;
        case "submit": {
          const receipt = await this.#host.submit(message.prompt);
          send(connection, {
            type: "result",
            id: message.id,
            result: asObject(receipt)
          });
          return;
        }
        case "subscribe": {
          const turn = await this.#host.getTurn(message.turnId);
          if (!turn) throw new Error(`Unknown turn ${message.turnId}`);
          void this.#tail(connection, turn, message.from ?? 0);
          return;
        }
        case "write_source":
          await this.#host.writeSource(message.path, message.content);
          send(connection, {
            type: "result",
            id: message.id,
            result: { written: true }
          });
          await this.stateChanged();
          return;
        case "activate": {
          const revision = await this.#host.activate(message.note);
          send(connection, {
            type: "result",
            id: message.id,
            result: asObject(revision)
          });
          await this.stateChanged();
          return;
        }
        case "restore": {
          const revision = await this.#host.restore(message.revisionId);
          send(connection, {
            type: "result",
            id: message.id,
            result: asObject(revision)
          });
          await this.stateChanged();
          return;
        }
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(id === undefined ? {} : { id }),
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof HarnessBuildError ? { phase: error.phase } : {})
      });
      // A failed activation still journals; let clients see it.
      if (error instanceof HarnessBuildError) await this.stateChanged();
    }
  }

  async #tail(
    socket: WebSocket,
    turn: HarnessTurn,
    from: number
  ): Promise<void> {
    let tails = this.#tails.get(socket);
    if (!tails) {
      tails = new Map();
      this.#tails.set(socket, tails);
    }
    tails.get(turn.turnId)?.abort();
    const controller = new AbortController();
    tails.set(turn.turnId, controller);
    try {
      for await (const batch of this.#host.streams.readBatches(turn.streamId, {
        from,
        signal: controller.signal
      })) {
        if (socket.readyState !== OPEN) return;
        send(socket, chunkMessage(turn.turnId, batch));
      }
      send(socket, { type: "stream_end", turnId: turn.turnId });
    } catch (error) {
      if (controller.signal.aborted) return;
      // A failed turn errors its stream; the turn row carries the message.
      send(socket, { type: "stream_end", turnId: turn.turnId });
      void error;
    } finally {
      if (tails.get(turn.turnId) === controller) tails.delete(turn.turnId);
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
  turnId: string,
  batch: readonly StreamChunk[]
): HarnessServerMessage {
  return {
    type: "events",
    turnId,
    seq: batch[0]?.seq ?? 0,
    lastSeq: batch[batch.length - 1]?.seq ?? 0,
    events: batch.map((chunk) => asObject(chunk.chunk))
  };
}
