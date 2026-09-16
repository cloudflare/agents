/**
 * The browser link: JSON commands in over the `WebSockets` capability, a
 * snapshot plus replay-then-tail event batches out. The socket is the
 * subscription; `wait`, `events`, `close` and `delete` are not callable
 * over this wire because lifetime belongs to the host.
 */
import type {
  Connection,
  ConnectionContext,
  LifecycleSockets
} from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import type { Harness } from "./harness";
import { harnessSessionTag, validateSessionId } from "./harness";
import {
  HARNESS_SESSION_QUERY,
  type HarnessCallMethod,
  type HarnessClientMessage,
  type HarnessServerMessage
} from "./protocol";
import {
  DEFAULT_SESSION_ID,
  HarnessError,
  type HarnessEvent,
  type HarnessPreview,
  type HarnessProtocol,
  type HarnessSession,
  type JsonValue
} from "./types";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;
const TAG_PREFIX = "harness:";
const EVENT_BATCH_MS = 30;

const CALLABLE: ReadonlySet<HarnessCallMethod> = new Set<HarnessCallMethod>([
  "prompt",
  "interrupt",
  "requests",
  "reply",
  "messages",
  "status",
  "result",
  "submit",
  "compact",
  "fork",
  "rewind",
  "configure",
  "cancelQueued"
]);

function sessionFromRequest(request: Request): string {
  const id =
    new URL(request.url).searchParams.get(HARNESS_SESSION_QUERY) ??
    DEFAULT_SESSION_ID;
  return validateSessionId(id);
}

function sessionOf(connection: Connection): string {
  const tag = connection.tags.find((candidate) =>
    candidate.startsWith(TAG_PREFIX)
  );
  return tag ? tag.slice(TAG_PREFIX.length) : DEFAULT_SESSION_ID;
}

/**
 * Why a value is not a client message, or undefined when it is one. Each
 * type's fields are checked here so the handlers below can trust them.
 */
function clientMessageError(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    return "Malformed harness message";
  }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "snapshot":
      return typeof message.id === "string"
        ? undefined
        : "snapshot needs a string id";
    case "subscribe":
      if (message.from !== undefined && typeof message.from !== "string") {
        return "subscribe.from must be a cursor string";
      }
      if (
        message.previews !== undefined &&
        typeof message.previews !== "boolean"
      ) {
        return "subscribe.previews must be a boolean";
      }
      return undefined;
    case "unsubscribe":
      return undefined;
    case "call":
      if (typeof message.id !== "string") return "call needs a string id";
      if (typeof message.method !== "string") {
        return "call needs a string method";
      }
      if (!Array.isArray(message.args)) return "call.args must be an array";
      return undefined;
    default:
      return `Unknown message type ${JSON.stringify(message.type)}`;
  }
}

function errorBody(error: unknown): {
  readonly name: string;
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof HarnessError) {
    return { name: error.name, code: error.code, message: error.message };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    code: "E_HARNESS",
    message: error instanceof Error ? error.message : String(error)
  };
}

function send<P extends HarnessProtocol>(
  socket: WebSocket,
  message: HarnessServerMessage<P>
): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

/**
 * One browser socket per session tag. Tails are in-memory and die with the
 * isolate; a client that reconnects resubscribes from its last cursor.
 */
export class HarnessTransport<P extends HarnessProtocol> {
  readonly #harness: Harness<P>;
  readonly #tails = new WeakMap<WebSocket, AbortController>();
  #sockets: (() => LifecycleSockets) | undefined;

  constructor(harness: Harness<P>) {
    this.#harness = harness;
  }

  /** Options for `new WebSockets(...)` that serve this protocol. */
  webSocketOptions(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        harnessSessionTag(sessionFromRequest(ctx.request))
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#stopTail(connection),
        onError: (connection) => this.#stopTail(connection)
      }
    };
  }

  /** @internal Sockets are reachable only once the harness is installed. */
  bindSockets(sockets: () => LifecycleSockets): void {
    this.#sockets = sockets;
  }

  /** Tell a session's sockets that status changed; clients re-snapshot. */
  statusChanged(_sessionId: string): void {
    // Clients re-snapshot on operation boundaries they see in the event
    // log; nothing to push here.
  }

  /** Tell a session's sockets that its open requests changed. */
  requestsChanged(_sessionId: string): void {
    // Same: `request_raised` / `request_replied` frames drive the client.
  }

  /** Close every socket of a deleted session. */
  sessionDeleted(sessionId: string): void {
    const sockets = this.#sockets?.();
    if (!sockets) return;
    for (const socket of sockets.get(harnessSessionTag(sessionId))) {
      send(socket, {
        type: "error",
        error: {
          name: "HarnessClosedError",
          code: "E_CLOSED",
          message: "Session deleted"
        }
      });
      try {
        socket.close(1000, "session deleted");
      } catch {
        // Already closing.
      }
    }
  }

  async #onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): Promise<void> {
    const sessionId = sessionFromRequest(ctx.request);
    await this.#snapshot(connection, sessionId);
  }

  async #snapshot(
    socket: WebSocket,
    sessionId: string,
    id?: string
  ): Promise<void> {
    const session = this.#harness.session(sessionId);
    try {
      const [status, requests, messages] = await Promise.all([
        session.status(),
        session.requests(),
        session.messages()
      ]);
      send(socket, {
        type: "snapshot",
        ...(id === undefined ? {} : { id }),
        status,
        requests,
        messages
      });
    } catch (error) {
      send(socket, {
        type: "error",
        ...(id === undefined ? {} : { id }),
        error: errorBody(error)
      });
    }
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
      send(connection, {
        type: "error",
        error: { name: "Error", code: "E_PROTOCOL", message: "Malformed JSON" }
      });
      return;
    }
    const malformed = clientMessageError(message);
    if (malformed !== undefined) {
      send(connection, {
        type: "error",
        error: { name: "Error", code: "E_PROTOCOL", message: malformed }
      });
      return;
    }
    const sessionId = sessionOf(connection);
    // SAFETY: clientMessageError checked the shape of every variant.
    const parsed = message as HarnessClientMessage;
    switch (parsed.type) {
      case "snapshot":
        await this.#snapshot(connection, sessionId, parsed.id);
        return;
      case "subscribe":
        void this.#tail(connection, sessionId, parsed.from, parsed.previews);
        return;
      case "unsubscribe":
        this.#stopTail(connection);
        return;
      case "call":
        await this.#call(connection, sessionId, parsed);
        return;
    }
  }

  async #call(
    socket: WebSocket,
    sessionId: string,
    message: Extract<HarnessClientMessage, { type: "call" }>
  ): Promise<void> {
    if (!CALLABLE.has(message.method)) {
      send(socket, {
        type: "error",
        id: message.id,
        error: {
          name: "Error",
          code: "E_PROTOCOL",
          message: `Method ${JSON.stringify(message.method)} is not callable over the browser link`
        }
      });
      return;
    }
    const session = this.#harness.session(sessionId);
    try {
      const value = await this.#dispatch(session, message.method, message.args);
      send(socket, { type: "result", id: message.id, value });
    } catch (error) {
      send(socket, { type: "error", id: message.id, error: errorBody(error) });
    }
  }

  async #dispatch(
    session: HarnessSession<P>,
    method: HarnessCallMethod,
    args: readonly JsonValue[]
  ): Promise<JsonValue> {
    // SAFETY: every argument crossed the wire as JSON; the handle validates
    // shapes it cares about and the runtime owns the rest.
    const a = args as readonly never[];
    switch (method) {
      case "prompt":
        return asJson(await session.prompt(a[0], a[1]));
      case "interrupt":
        return asJson(await session.interrupt(a[0]));
      case "requests":
        return asJson(await session.requests());
      case "reply":
        return asJson(await session.reply(a[0], a[1]));
      case "messages":
        return asJson(await session.messages(a[0]));
      case "status":
        return asJson(await session.status());
      case "result":
        return asJson((await session.result(a[0])) ?? null);
      case "submit":
        return asJson(await session.submit(a[0], a[1]));
      case "compact":
        return asJson(await session.compact(a[0]));
      case "fork": {
        const fork = await session.fork(a[0]);
        return { sessionId: fork.sessionId };
      }
      case "rewind":
        return asJson(await session.rewind(a[0], a[1]));
      case "configure":
        return asJson(await session.configure(a[0]));
      case "cancelQueued":
        return await session.cancelQueued(a[0]);
    }
  }

  async #tail(
    socket: WebSocket,
    sessionId: string,
    from: string | undefined,
    previews: boolean | undefined
  ): Promise<void> {
    this.#tails.get(socket)?.abort();
    const controller = new AbortController();
    this.#tails.set(socket, controller);
    let batch: HarnessEvent<P>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (batch.length === 0) return;
      const events = batch;
      batch = [];
      send(socket, { type: "events", sessionId, events });
    };
    try {
      for await (const item of this.#harness.events(sessionId, {
        ...(from === undefined ? {} : { from }),
        previews: previews ?? false,
        signal: controller.signal,
        onUpToDate: () => {
          flush();
          send(socket, { type: "up_to_date", sessionId });
        }
      })) {
        if (socket.readyState !== OPEN) return;
        if ("preview" in item) {
          flush();
          send(socket, {
            type: "preview",
            sessionId,
            preview: item as HarnessPreview
          });
          continue;
        }
        batch.push(item);
        if (item.replay) {
          if (batch.length >= 64) flush();
        } else {
          timer ??= setTimeout(flush, EVENT_BATCH_MS);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      send(socket, { type: "error", error: errorBody(error) });
    } finally {
      flush();
      if (this.#tails.get(socket) === controller) this.#tails.delete(socket);
    }
  }

  #stopTail(connection: Connection): void {
    this.#tails.get(connection)?.abort();
    this.#tails.delete(connection);
  }
}

function asJson(value: unknown): JsonValue {
  // SAFETY: every handle result is plain data by construction.
  return value as JsonValue;
}
