import type {
  Connection,
  ConnectionContext,
  LifecycleSockets
} from "agents/lifecycle";
import type { StreamChunk, Streams } from "agents/streams";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import type {
  PiAbortResult,
  PiClientMessage,
  PiEvent,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiJson,
  PiLaneSnapshot,
  PiMessageInput,
  PiOperationRequest,
  PiQueueReceipt,
  PiServerMessage,
  PiSlashCommand,
  PiSubmissionReceipt
} from "./types";

/** The harness surface the transport drives. */
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
  /**
   * The extension surface. Optional so a harness built without extensions
   * still satisfies the host contract; the transport answers the matching
   * client frames with an `unsupported` error when a method is absent.
   */
  resolveUi?(
    requestId: string,
    response: PiExtensionUiResponse,
    options: { lane: string }
  ): boolean;
  commands?(options: { lane: string }): Promise<readonly PiSlashCommand[]>;
  /** Current extension flag values, for a client that has just connected. */
  flags?(): Promise<Readonly<Record<string, boolean | string>>>;
  setFlag?(
    name: string,
    value: boolean | string
  ): Promise<Readonly<Record<string, boolean | string>>>;
  runCommand?(
    name: string,
    args: string | undefined,
    options: { lane: string }
  ): Promise<PiSubmissionReceipt>;
}

/** The UI request methods that wait for an answer; the rest are view updates. */
const DIALOG_METHODS: ReadonlySet<string> = new Set([
  "select",
  "confirm",
  "input",
  "editor"
]);

const LANE_TAG_PREFIX = "pi:";
const LANE_QUERY = "lane";
const MAX_LANE_LENGTH = 128;
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/** Hibernation tag applied to every connection subscribed to a lane. */
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
  } catch {
    // The socket closed between the state check and the send.
  }
}

/**
 * The harness's WebSocket protocol over the `WebSockets` capability:
 * JSON commands in, a lane snapshot plus operation stream chunks out.
 *
 * Live output is never a side channel. A client subscribes to an
 * operation's stream and the transport replays it from the client's cursor
 * through `Streams.readBatches`, then tails it — the same durable log an SSE
 * reader or a later replay sees. Tails are in-memory and die with the
 * isolate; a client that reconnects resubscribes from its last sequence.
 */
export class PiTransport {
  readonly #host: PiTransportHost;
  readonly #sockets: () => LifecycleSockets;
  readonly #tails = new WeakMap<WebSocket, Map<string, AbortController>>();
  /**
   * Dialogs broadcast to a lane and not yet settled. The transport is the only
   * place that knows both which lane a request went to and whether anyone is
   * still listening, so it owns the "last subscriber left" cancellation.
   */
  readonly #openDialogs = new Map<string, Set<string>>();

  constructor(host: PiTransportHost, sockets: () => LifecycleSockets) {
    this.#host = host;
    this.#sockets = sockets;
  }

  /** Options for `new WebSockets(...)` that serve this protocol. */
  webSocketOptions(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        laneTag(laneFromRequest(ctx.request, this.#host.defaultLane))
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#onClose(connection),
        onError: (connection) => this.#onClose(connection)
      }
    };
  }

  /**
   * Announce a newly opened operation stream to the lane's connections. A
   * brand-new stream is tailed for them from its start; a stream reopened
   * after a wake is announced with its cursor so each client resubscribes
   * from its own last sequence.
   */
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

  /** Deliver a lane event that happened outside any operation stream. */
  laneEvent(lane: string, event: PiEvent): void {
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "event", lane, event });
    }
  }

  /**
   * Broadcast one extension UI request to a lane's connections and report how
   * many received it. Zero is the bridge's cue to answer with the default
   * rather than wait for a client that is not there.
   */
  extensionUiRequest(lane: string, request: PiExtensionUiRequest): number {
    if (DIALOG_METHODS.has(request.method)) {
      let open = this.#openDialogs.get(lane);
      if (!open) {
        open = new Set();
        this.#openDialogs.set(lane, open);
      }
      open.add(request.requestId);
    }
    let delivered = 0;
    for (const socket of this.#sockets().get(laneTag(lane))) {
      if (socket.readyState !== OPEN) continue;
      send(socket, {
        type: "extension_ui_request",
        lane,
        requestId: request.requestId,
        request
      });
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Announce that a dialog is dead: its timeout elapsed, the run was aborted,
   * or an answer already settled it. Clients take the modal down; without the
   * frame a settled dialog sits on screen and its late answer is dropped in
   * silence.
   */
  extensionUiSettled(lane: string, requestId: string): void {
    const open = this.#openDialogs.get(lane);
    if (open) {
      open.delete(requestId);
      if (open.size === 0) this.#openDialogs.delete(lane);
    }
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "extension_ui_settled", lane, requestId });
    }
  }

  /** Broadcast a hook, event listener or extension failure to a lane. */
  handlerError(
    lane: string,
    payload: {
      readonly kind: "hook" | "event" | "extension";
      readonly source: string;
      readonly message: string;
      readonly stack?: string;
    }
  ): void {
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "handler_error", lane, ...payload });
    }
  }

  /** Broadcast a changed slash command set to a lane's connections. */
  commandsChanged(lane: string, commands: readonly PiSlashCommand[]): void {
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "commands", lane, commands });
    }
  }

  /** Broadcast changed extension flags to a lane's connections. */
  flagsChanged(
    lane: string,
    flags: Readonly<Record<string, boolean | string>>
  ): void {
    for (const socket of this.#sockets().get(laneTag(lane))) {
      send(socket, { type: "flags", flags });
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
        // SAFETY: every command reply is a projected JSON value.
        send(connection, { type: "result", id, result: result as PiJson });
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(id === undefined ? {} : { id }),
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
          ...(message.operationId === undefined
            ? {}
            : { operationId: message.operationId })
        });
      case "steer":
        return this.#host.steer(message.message, { lane });
      case "extension_ui_response": {
        const resolveUi = this.#host.resolveUi;
        if (!resolveUi) throw unsupported(message.type);
        const answered = resolveUi.call(
          this.#host,
          message.requestId,
          message.response,
          { lane }
        );
        if (!answered) {
          // The dialog settled before this answer arrived. Say so rather than
          // dropping it: the client is still showing a modal for it.
          send(connection, {
            type: "extension_ui_settled",
            lane,
            requestId: message.requestId
          });
          throw stale(message.type);
        }
        return answered;
      }
      case "get_commands": {
        const commands = this.#host.commands;
        if (!commands) throw unsupported(message.type);
        send(connection, {
          type: "commands",
          id: message.id,
          lane,
          commands: await commands.call(this.#host, { lane })
        });
        return SUBSCRIPTION;
      }
      case "get_flags": {
        const flags = this.#host.flags;
        if (!flags) throw unsupported(message.type);
        send(connection, {
          type: "flags",
          id: message.id,
          flags: await flags.call(this.#host)
        });
        return SUBSCRIPTION;
      }
      case "set_flag": {
        const setFlag = this.#host.setFlag;
        if (!setFlag) throw unsupported(message.type);
        send(connection, {
          type: "flags",
          id: message.id,
          flags: await setFlag.call(this.#host, message.name, message.value)
        });
        return SUBSCRIPTION;
      }
      case "command": {
        const runCommand = this.#host.runCommand;
        if (!runCommand) throw unsupported(message.type);
        return runCommand.call(this.#host, message.name, message.args, {
          lane
        });
      }
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

  #onClose(connection: Connection): void {
    this.#stopTails(connection);
    this.#cancelOrphanedDialogs(
      laneOf(connection, this.#host.defaultLane),
      connection
    );
  }

  #stopTails(connection: Connection): void {
    const tails = this.#tails.get(connection);
    if (!tails) return;
    for (const controller of tails.values()) controller.abort();
    this.#tails.delete(connection);
  }

  /**
   * The last subscriber to a lane has gone. Every dialog it was owed is now
   * unanswerable, and an extension waiting on one holds a hook gate open until
   * the harness's timeout, so settle them with their defaults now — exactly as
   * the bridge does for a dialog broadcast to nobody in the first place.
   */
  #cancelOrphanedDialogs(lane: string, closing: Connection): void {
    const open = this.#openDialogs.get(lane);
    if (!open || open.size === 0) return;
    for (const socket of this.#sockets().get(laneTag(lane))) {
      // The closing connection may still be listed, and may still report OPEN
      // when the close came from this side.
      if (socket !== closing && socket.readyState === OPEN) return;
    }
    const resolveUi = this.#host.resolveUi;
    if (!resolveUi) return;
    // The bridge answers back through `extensionUiSettled`, which mutates
    // `open`, so cancel over a copy.
    for (const requestId of [...open]) {
      resolveUi.call(this.#host, requestId, { cancelled: true }, { lane });
    }
    this.#openDialogs.delete(lane);
  }
}

/** Sentinel for commands whose reply is the subscription itself. */
const SUBSCRIPTION = Symbol("pi-subscription");

/** A frame this harness understands but this host does not implement. */
function unsupported(type: string): Error {
  return new Error(`unsupported: ${type}`);
}

/** A frame that arrived too late to change anything. */
function stale(type: string): Error {
  return new Error(`stale: ${type}`);
}

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
    // SAFETY: every chunk of an operation stream is appended by
    // OperationStreamWriter as a PiEvent array.
    events: batch.flatMap((chunk) => chunk.chunk as unknown as PiEvent[])
  };
}
