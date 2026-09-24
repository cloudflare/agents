import type {
  Connection,
  ConnectionContext,
  LifecycleSockets
} from "../lifecycle";
import type { StreamChunk, Streams } from "../streams";
import type { WebSocketMessage, WebSocketsOptions } from "../websockets";
import type {
  PiAbortResult,
  PiClientMessage,
  PiEvent,
  PiJson,
  PiLaneSnapshot,
  PiMessageInput,
  PiOperationRequest,
  PiQueueReceipt,
  PiServerMessage,
  PiSubmissionReceipt
} from "./types";

export interface PiTransportHost {
  readonly defaultLane: string;
  readonly streams: Streams;
  snapshot(options: { lane: string }): Promise<PiLaneSnapshot>;
  submit(
    request: PiOperationRequest,
    options: { lane: string }
  ): Promise<PiSubmissionReceipt>;
  abort(options: {
    lane: string;
    operationId?: string;
  }): Promise<PiAbortResult>;
  steer(
    message: PiMessageInput,
    options: { lane: string }
  ): Promise<PiQueueReceipt>;
}

const LANE_TAG_PREFIX = "pi:";
const LANE_QUERY = "lane";
const MAX_LANE_LENGTH = 128;

const OPEN = 1;

export function laneTag(lane: string): string {
  return `${LANE_TAG_PREFIX}${lane}`;
}

function laneFromRequest(request: Request, fallback: string): string {
  const lane = new URL(request.url).searchParams.get(LANE_QUERY) ?? fallback;
  if (lane.length === 0 || lane.length > MAX_LANE_LENGTH || /\s/.test(lane)) {
    throw new Error(`Invalid pi lane ${JSON.stringify(lane)}`);
  }
  return lane;
}

function laneOf(connection: Connection, fallback: string): string {
  const tag = connection.tags.find((candidate) =>
    candidate.startsWith(LANE_TAG_PREFIX)
  );
  return tag ? tag.slice(LANE_TAG_PREFIX.length) : fallback;
}

function isClientMessage(value: unknown): value is PiClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function send(socket: WebSocket, message: PiServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {}
}

export class PiTransport {
  readonly #host: PiTransportHost;
  readonly #sockets: () => LifecycleSockets;
  readonly #tails = new WeakMap<WebSocket, Map<string, AbortController>>();

  constructor(host: PiTransportHost, sockets: () => LifecycleSockets) {
    this.#host = host;
    this.#sockets = sockets;
  }

  webSocketOptions(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        laneTag(laneFromRequest(ctx.request, this.#host.defaultLane))
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#stopTails(connection),
        onError: (connection) => this.#stopTails(connection)
      }
    };
  }

  streamOpened(
    lane: string,
    streamId: string,
    operationId: string,
    cursor: number
  ): void {
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "stream_start", lane, streamId, operationId });
      if (cursor === 0) {
        void this.#tail(socket, lane, streamId, operationId, 0);
      }
    }
  }

  laneEvent(lane: string, event: PiEvent): void {
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "event", lane, event });
    }
  }

  async #onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    const lane = laneFromRequest(ctx.request, this.#host.defaultLane);
    send(connection, {
      type: "snapshot",
      snapshot: await this.#host.snapshot({ lane })
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
      send(connection, { type: "error", message: "Malformed pi message" });
      return;
    }
    const lane = laneOf(connection, this.#host.defaultLane);
    const id = "id" in message ? message.id : undefined;
    try {
      const result = await this.#dispatch(connection, lane, message);
      if (id !== undefined && result !== SUBSCRIPTION) {
        send(connection, { type: "result", id, result: result as PiJson });
      }
    } catch (error) {
      send(connection, {
        type: "error",
        id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #dispatch(
    connection: Connection,
    lane: string,
    message: PiClientMessage
  ): Promise<unknown> {
    switch (message.type) {
      case "subscribe": {
        const status = await this.#host.streams.status(message.streamId);
        if (!status) throw new Error(`Unknown stream ${message.streamId}`);
        const operationId = operationIdOf(status.metadata);
        if (status.metadata?.lane !== lane || operationId === undefined) {
          throw new Error(`Stream ${message.streamId} is not on lane ${lane}`);
        }
        void this.#tail(
          connection,
          lane,
          message.streamId,
          operationId,
          message.from ?? 0
        );
        return SUBSCRIPTION;
      }
      case "unsubscribe":
        this.#tails.get(connection)?.get(message.streamId)?.abort();
        return SUBSCRIPTION;
      case "snapshot":
        send(connection, {
          type: "snapshot",
          id: message.id,
          snapshot: await this.#host.snapshot({ lane })
        });
        return SUBSCRIPTION;
      case "submit":
        return this.#host.submit(message.request, { lane });
      case "abort":
        return this.#host.abort({
          lane,
          operationId: message.operationId
        });
      case "steer":
        return this.#host.steer(message.message, { lane });
      default:
        throw new Error(
          `Unknown pi message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }

  async #tail(
    socket: WebSocket,
    lane: string,
    streamId: string,
    operationId: string,
    from: number
  ): Promise<void> {
    let tails = this.#tails.get(socket);
    if (!tails) {
      tails = new Map();
      this.#tails.set(socket, tails);
    }
    tails.get(streamId)?.abort();
    const controller = new AbortController();
    tails.set(streamId, controller);
    try {
      for await (const batch of this.#host.streams.readBatches(streamId, {
        from,
        signal: controller.signal
      })) {
        if (socket.readyState !== OPEN) return;
        send(socket, chunkMessage(lane, streamId, operationId, batch));
      }
      send(socket, { type: "stream_end", lane, streamId, operationId });
    } catch (error) {
      if (controller.signal.aborted) return;
      send(socket, {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (tails.get(streamId) === controller) tails.delete(streamId);
    }
  }

  #stopTails(connection: Connection): void {
    const tails = this.#tails.get(connection);
    if (!tails) return;
    for (const controller of tails.values()) controller.abort();
    this.#tails.delete(connection);
  }
}

const SUBSCRIPTION = Symbol("pi-subscription");

function operationIdOf(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const value = metadata?.operationId;
  return typeof value === "string" ? value : undefined;
}

function chunkMessage(
  lane: string,
  streamId: string,
  operationId: string,
  batch: readonly StreamChunk[]
): PiServerMessage {
  const first = batch[0];
  return {
    type: "events",
    lane,
    streamId,
    operationId,
    seq: first?.seq ?? 0,
    lastSeq: batch[batch.length - 1]?.seq ?? 0,
    events: batch.flatMap((chunk) => chunk.chunk as unknown as PiEvent[])
  };
}
