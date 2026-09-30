import type { AgentEventStream } from "@earendil-works/pi-durable";
import type {
  Connection,
  ConnectionContext,
  LifecycleSockets
} from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import type {
  PiClientMessage,
  PiJson,
  PiSessionId,
  PiServerMessage
} from "./types";
import type { PiHarness } from "./pi-harness";

const SESSION_TAG_PREFIX = "pi-session:";
const SESSION_QUERY = "session";
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(request: Request, fallback: PiSessionId): string {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") return fallback;
  if (!/^[1-9][0-9]{0,15}$/.test(session)) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }
  return session;
}

function sessionOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );
  return tag?.slice(SESSION_TAG_PREFIX.length);
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
 * The session protocol over the `WebSockets` capability.
 *
 * pi's agent events are the wire format: each socket gets its own
 * `watchEvents` stream, which starts with a `snapshot` and then carries one
 * batch per commit. There is no replay log and no cursor. pi commits
 * partial answers and tool output as it goes, so a client that joins late,
 * reconnects, or outlives a hibernation gets a snapshot of the current
 * state and continues from there. The client folds events with the same
 * `reduceView` the tests use.
 */
export class PiTransport {
  readonly #harness: PiHarness;
  readonly #sockets: () => LifecycleSockets;
  readonly #watches = new Map<WebSocket, AgentEventStream>();

  constructor(harness: PiHarness, sockets: () => LifecycleSockets) {
    this.#harness = harness;
    this.#sockets = sockets;
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        sessionTag(sessionFromRequest(ctx.request, "1"))
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#unwatch(connection),
        onError: (connection) => this.#unwatch(connection)
      }
    };
  }

  /** Give every hibernated socket a new watch after the object restarts. */
  async reattach(): Promise<void> {
    if (this.#sockets().get().length === 0) return;
    // LifecycleSockets finds sockets by tag, not tags by socket, so walk
    // the sessions and look up each one's tag.
    for (const { id } of await this.#harness.sessions.list()) {
      for (const socket of this.#sockets().get(sessionTag(id))) {
        await this.#watch(socket, id);
      }
    }
  }

  async close(): Promise<void> {
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.all(watches.map((watch) => watch.stop()));
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    const session = sessionFromRequest(ctx.request, "1");
    send(connection, {
      type: "hello",
      session,
      tools: this.#harness.tools()
    });
    await this.#watch(connection, session);
  }

  async #watch(socket: WebSocket, session: PiSessionId): Promise<void> {
    await this.#unwatch(socket);
    const stream = await this.#harness.session(session).events();
    this.#watches.set(socket, stream);
    send(socket, { type: "events", session, events: [stream.snapshot] });
    stream.start(async (events) => {
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      send(socket, { type: "events", session, events });
    });
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);
    if (!watch) return;
    this.#watches.delete(socket);
    await watch.stop();
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    if (typeof raw !== "string") return;
    let message: PiClientMessage;
    try {
      message = JSON.parse(raw) as PiClientMessage;
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });
      return;
    }
    const session = sessionOf(connection.tags) ?? "1";
    try {
      const result = await this.#dispatch(connection, session, message);
      if (message.id !== undefined) {
        send(connection, { type: "result", id: message.id, result });
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(message.id === undefined ? {} : { id: message.id }),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #dispatch(
    connection: Connection,
    session: PiSessionId,
    message: PiClientMessage
  ): Promise<PiJson> {
    const handle = this.#harness.session(session);
    switch (message.type) {
      case "submit":
        return await handle.submit(message.input, {
          ...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
          ...(message.operationId ? { operationId: message.operationId } : {})
        });
      case "abort":
        return await handle.abort();
      case "reset":
        await handle.reset(message.handoff);
        return null;
      case "resync":
        await this.#watch(connection, session);
        return null;
      default:
        throw new Error(
          `Unknown pi message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }
}
