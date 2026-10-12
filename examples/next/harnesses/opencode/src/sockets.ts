import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  ROOT_SESSION,
  type OpenCodeEventStream,
  type OpenCodeHarness,
  type OpenCodeSessionEvent,
  type OpenCodeSessionId
} from "agents/harness/opencode";
import type { ClientMessage, ServerMessage, SessionSnapshot } from "./protocol";

const SESSION_TAG_PREFIX = "opencode-session:";
const SESSION_QUERY = "session";
/** A bound on one prompt; this example has no other quotas. */
const MAX_PROMPT_LENGTH = 100_000;
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/**
 * Events after which the transcript has changed in a way the client should
 * see in full: a new input, a finished step or tool, the run starting, a
 * compaction. Deltas are forwarded as they are.
 */
const RESNAPSHOT = new Set<OpenCodeSessionEvent["type"]>([
  "operation_queued",
  "operation_withdrawn",
  "operation_start",
  "run_start",
  "message_end",
  "tool_start",
  "tool_end",
  "compaction_start",
  "transcript_reset"
]);

function sessionTag(session: OpenCodeSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

/** The `?session=` the socket asked for, or undefined if it is malformed. */
function sessionFromRequest(request: Request): OpenCodeSessionId | undefined {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") return ROOT_SESSION;
  return /^ses[A-Za-z0-9_]{1,64}$/.test(session) ? session : undefined;
}

/** The session a socket follows, or undefined if it asked for a bad one. */
function sessionOf(tags: readonly string[]): OpenCodeSessionId | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );
  return tag?.slice(SESSION_TAG_PREFIX.length);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the state check and the send.
  }
}

function parse(raw: WebSocketMessage): ClientMessage | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && "type" in value
      ? // SAFETY: the dispatcher checks `type` and rejects unknown commands;
        // each field it reads is checked where it is used.
        (value as ClientMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * App glue: this app's session protocol over the `WebSockets` capability,
 * built only on the harness's public API.
 *
 * Each socket follows one session, picked by `?session=`. On connect it gets
 * a snapshot of the transcript. While a session runs, one watch on
 * `session.events()` fans the session's events out to every socket on it,
 * with a fresh snapshot after each change to the transcript. The watch stops
 * when the session is idle, so the object can hibernate between runs with
 * its sockets still open.
 */
export class OpenCodeSessionSockets {
  readonly #harness: OpenCodeHarness;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  /** One event stream per running session, or its opening. */
  readonly #watches = new Map<
    OpenCodeSessionId,
    Promise<OpenCodeEventStream | undefined>
  >();
  /** Sessions with a snapshot being sent, and whether another is due. */
  readonly #snapshots = new Map<OpenCodeSessionId, boolean>();

  constructor(
    harness: OpenCodeHarness,
    getWebSockets: (tag?: string) => WebSocket[]
  ) {
    this.#harness = harness;
    this.#getWebSockets = getWebSockets;
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => {
        const session = sessionFromRequest(ctx.request);
        return session === undefined ? [] : [sessionTag(session)];
      },
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) => this.#onMessage(connection, message)
      }
    };
  }

  /**
   * Watch every running session that has sockets, after the object
   * restarts: watches live in memory, and a crashed run resumes on boot.
   */
  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) return;
    for (const { id, busy } of await this.#harness.sessions.list()) {
      if (this.#getWebSockets(sessionTag(id)).length === 0) continue;
      await this.#broadcastSnapshot(id);
      if (busy) this.#watch(id);
    }
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    const session = sessionFromRequest(ctx.request);
    const sessions = await this.#harness.sessions.list();
    if (
      session === undefined ||
      !sessions.some((info) => info.id === session)
    ) {
      send(connection, {
        type: "error",
        code: "unknown_session",
        message: `Unknown session ${JSON.stringify(
          new URL(ctx.request.url).searchParams.get(SESSION_QUERY)
        )}`
      });
      // A close sent from onConnect, before the upgrade completes, does not
      // reach the client, so the client closes on this error instead. The
      // socket has no session tag, so it gets no session's events.
      return;
    }
    send(connection, { type: "hello", session });
    send(connection, { type: "sessions", sessions });
    const snapshot = await this.#snapshot(session);
    send(connection, { type: "snapshot", ...snapshot });
    if (snapshot.busy) this.#watch(session);
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    const message = parse(raw);
    if (message === undefined) {
      send(connection, { type: "error", message: "Malformed message" });
      return;
    }
    const session = sessionOf(connection.tags);
    if (session === undefined) {
      send(connection, {
        type: "error",
        code: "unknown_session",
        message: "This socket has no session"
      });
      return;
    }
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
    message: ClientMessage
  ): Promise<unknown> {
    const handle = this.#harness.session(session);
    switch (message.type) {
      case "submit": {
        if (typeof message.text !== "string" || message.text.trim() === "") {
          throw new Error("Nothing to send");
        }
        if (message.text.length > MAX_PROMPT_LENGTH) {
          throw new Error(
            `Prompts are limited to ${MAX_PROMPT_LENGTH.toLocaleString()} characters`
          );
        }
        this.#watch(session);
        const receipt = await handle.submit(message.text, {
          whenBusy: message.whenBusy === "steer" ? "steer" : "followUp"
        });
        await this.#broadcastSnapshot(session);
        // Once the operation settles, send the final transcript and stop
        // watching if nothing else is running. This holds even if the watch
        // attached after the run's last event.
        void handle
          .wait(receipt.operationId)
          .then(() => this.#settle(session))
          .catch((error: unknown) => {
            console.warn("OpenCode wait failed", error);
          });
        return receipt;
      }
      case "abort":
        await handle.abort();
        await this.#settle(session);
        return true;
      case "create": {
        const created = await this.#harness.sessions.create();
        const sessions = await this.#harness.sessions.list();
        for (const socket of this.#getWebSockets()) {
          send(socket, { type: "sessions", sessions });
        }
        return { session: created.id };
      }
      case "resync":
        send(connection, {
          type: "snapshot",
          ...(await this.#snapshot(session))
        });
        return null;
      default:
        throw new Error(
          `Unknown message type ${JSON.stringify((message as { type: unknown }).type)}`
        );
    }
  }

  async #snapshot(session: OpenCodeSessionId): Promise<SessionSnapshot> {
    const handle = this.#harness.session(session);
    const [messages, busy, pending] = await Promise.all([
      handle.history(),
      handle.busy(),
      this.#harness.pending({ session })
    ]);
    return { session, messages, busy, pending };
  }

  /** Send every socket on the session a snapshot, one at a time. */
  async #broadcastSnapshot(session: OpenCodeSessionId): Promise<void> {
    if (this.#snapshots.has(session)) {
      this.#snapshots.set(session, true);
      return;
    }
    this.#snapshots.set(session, false);
    try {
      do {
        this.#snapshots.set(session, false);
        const snapshot = await this.#snapshot(session);
        for (const socket of this.#getWebSockets(sessionTag(session))) {
          send(socket, { type: "snapshot", ...snapshot });
        }
      } while (this.#snapshots.get(session) === true);
    } finally {
      this.#snapshots.delete(session);
    }
  }

  /** Final snapshot, and stop the watch if the session is idle. */
  async #settle(session: OpenCodeSessionId): Promise<void> {
    await this.#broadcastSnapshot(session);
    // Busy flags, and the title OpenCode generates after the first run.
    const sessions = await this.#harness.sessions.list();
    for (const socket of this.#getWebSockets()) {
      send(socket, { type: "sessions", sessions });
    }
    if (!(await this.#harness.session(session).busy())) {
      await this.#unwatch(session);
    }
  }

  /** Watch the session's events until it is idle. Idempotent. */
  #watch(session: OpenCodeSessionId): void {
    if (this.#watches.has(session)) return;
    const opening = this.#harness
      .session(session)
      .events()
      .then((stream) => {
        stream.start((events) => void this.#onEvents(session, events));
        return stream;
      })
      .catch((error: unknown) => {
        console.warn("OpenCode event watch failed to open", error);
        if (this.#watches.get(session) === opening) {
          this.#watches.delete(session);
        }
        return undefined;
      });
    this.#watches.set(session, opening);
  }

  async #unwatch(session: OpenCodeSessionId): Promise<void> {
    const opening = this.#watches.get(session);
    if (opening === undefined) return;
    this.#watches.delete(session);
    await (await opening)?.stop();
  }

  async #onEvents(
    session: OpenCodeSessionId,
    events: readonly OpenCodeSessionEvent[]
  ): Promise<void> {
    for (const event of events) {
      for (const socket of this.#getWebSockets(sessionTag(session))) {
        send(socket, { type: "event", event });
      }
    }
    try {
      if (this.#getWebSockets(sessionTag(session)).length === 0) {
        await this.#unwatch(session);
      } else if (events.some((event) => event.type === "run_end")) {
        await this.#settle(session);
      } else if (events.some((event) => RESNAPSHOT.has(event.type))) {
        await this.#broadcastSnapshot(session);
      } else if (events.some((event) => event.type === "fault")) {
        // The stream may have ended: open a new one if the session runs.
        await this.#unwatch(session);
        if (await this.#harness.session(session).busy()) this.#watch(session);
      }
    } catch (error) {
      console.warn("OpenCode event handling failed", error);
    }
  }
}
