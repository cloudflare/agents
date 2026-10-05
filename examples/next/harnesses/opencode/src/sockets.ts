import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  ROOT_SESSION,
  type OpenCodeEventStream,
  type OpenCodeHarness,
  type OpenCodeJson,
  type OpenCodeSessionId
} from "agents/harness/opencode";
import type { OpenCodeClientMessage, OpenCodeServerMessage } from "./protocol";
import type { ToolInfo } from "./workspace";

const SESSION_TAG_PREFIX = "opencode-session:";
const SESSION_QUERY = "session";
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

function sessionTag(session: OpenCodeSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(
  request: Request,
  fallback: OpenCodeSessionId
): string {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") return fallback;
  if (session !== ROOT_SESSION && !/^ses_[0-9A-Za-z]{1,64}$/.test(session)) {
    throw new Error(`Invalid OpenCode session ${JSON.stringify(session)}`);
  }
  return session;
}

function sessionOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );
  return tag?.slice(SESSION_TAG_PREFIX.length);
}

function send(socket: WebSocket, message: OpenCodeServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

/**
 * App glue: this app's session protocol over the `WebSockets` capability,
 * built only on the harness's public API. The same glue as the Pi example.
 *
 * Each socket follows one session, picked by `?session=`, through its own
 * `session.events()` stream: a `snapshot`, then the session's events.
 * Commands on the socket call `session.submit()` and `abort()`. Watches
 * live in memory, so the host calls `reattach()` from its `onStart` to give
 * sockets that outlived the last isolate a new watch and a fresh snapshot.
 */
export class OpenCodeSessionSockets {
  readonly #harness: OpenCodeHarness;
  readonly #tools: readonly ToolInfo[];
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #watches = new Map<WebSocket, OpenCodeEventStream>();

  constructor(
    harness: OpenCodeHarness,
    /** The tools OpenCode was given, for the tool list sent on connect. */
    tools: readonly ToolInfo[],
    getWebSockets: (tag?: string) => WebSocket[]
  ) {
    this.#harness = harness;
    this.#tools = tools;
    this.#getWebSockets = getWebSockets;
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        sessionTag(sessionFromRequest(ctx.request, ROOT_SESSION))
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
    if (this.#getWebSockets().length === 0) return;
    // Sockets are found by tag, not tags by socket, so walk the sessions
    // and look up each one's tag; the root's sockets are tagged by alias.
    const ids = [
      ROOT_SESSION,
      ...(await this.#harness.sessions.list()).map(({ id }) => id)
    ];
    for (const id of ids) {
      for (const socket of this.#getWebSockets(sessionTag(id))) {
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
    const session = sessionFromRequest(ctx.request, ROOT_SESSION);
    await this.#watch(connection, session, { hello: true });
  }

  /**
   * Start a watch. On connect the hello goes first, with OpenCode's own id
   * for the session, so the client can show the CLI command for it.
   */
  async #watch(
    socket: WebSocket,
    session: OpenCodeSessionId,
    options: { hello?: boolean } = {}
  ): Promise<void> {
    await this.#unwatch(socket);
    const stream = await this.#harness.session(session).events();
    const resolved = stream.snapshot.session;
    this.#watches.set(socket, stream);
    if (options.hello) {
      send(socket, { type: "hello", session: resolved, tools: this.#tools });
    }
    send(socket, {
      type: "events",
      session: resolved,
      events: [stream.snapshot]
    });
    stream.start((events) => {
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      send(socket, { type: "events", session: resolved, events });
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
    let message: OpenCodeClientMessage;
    try {
      message = JSON.parse(raw) as OpenCodeClientMessage;
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });
      return;
    }
    const session = sessionOf(connection.tags) ?? ROOT_SESSION;
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
    session: OpenCodeSessionId,
    message: OpenCodeClientMessage
  ): Promise<OpenCodeJson> {
    const handle = this.#harness.session(session);
    switch (message.type) {
      case "submit":
        return await handle.submit(message.input, {
          ...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
          ...(message.operationId ? { operationId: message.operationId } : {})
        });
      case "abort":
        return await handle.abort();
      case "resync":
        await this.#watch(connection, session);
        return null;
      default:
        throw new Error(
          `Unknown OpenCode message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }
}
