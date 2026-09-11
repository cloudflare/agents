import { DurableObject, RpcTarget } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle, type Connection } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";

/**
 * A chat room on a plain Durable Object. The `WebSockets` capability owns
 * the whole connection subsystem: it claims upgrades on either wire,
 * dispatches the handlers below inside the host invocation boundary,
 * speaks the Agent protocol so `useAgent` works against this object, and
 * answers `getConnections()`. The room itself only keeps a message table
 * and decides what to broadcast.
 */

/** Per-connection state. Persisted on the socket, so it survives hibernation. */
type MemberState = {
  nick: string;
  joinedAt: number;
};

export type RoomMessage = {
  id: number;
  nick: string;
  text: string;
  at: number;
};

export type Member = { id: string; nick: string; joinedAt: number };

/** Frames the room sends to every member. */
export type ServerFrame =
  | { type: "history"; messages: RoomMessage[] }
  | { type: "join"; nick: string; members: number }
  | { type: "leave"; nick: string; members: number }
  | { type: "message"; message: RoomMessage }
  | { type: "whoami"; id: string; state: MemberState | null }
  | { type: "error"; error: string };

/** Frames a member may send, besides the Agent protocol's own. */
type ClientFrame = { type: "say"; text: string } | { type: "whoami" };

const MAX_TEXT = 1_000;
const MAX_NICK = 32;

/** Trim and bound a nickname; `null` when unusable. */
function cleanNick(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const nick = value.trim();
  return nick && nick.length <= MAX_NICK ? nick : null;
}

/** Trim and bound a message; `null` when unusable. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_TEXT ? text : null;
}

function nickFrom(connection: Connection, request: Request): string {
  return (
    cleanNick(new URL(request.url).searchParams.get("nick")) ??
    `guest-${connection.id.slice(0, 6)}`
  );
}

function parseClientFrame(raw: unknown): ClientFrame | null {
  if (typeof raw !== "string") return null;
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== "object") return null;
  const { type, text } = frame as Partial<Record<string, unknown>>;
  if (type === "whoami") return { type };
  if (type === "say") {
    const clean = cleanText(text);
    if (clean) return { type, text: clean };
  }
  return null;
}

/**
 * A handle to one member, returned by reference. On the Cap'n Web transport
 * the caller receives a live stub and can keep calling it; on the WebSocket
 * wire an RpcTarget cannot be serialized into a JSON frame, so `member()`
 * reports an error there.
 */
class MemberHandle extends RpcTarget {
  readonly #room: RoomObject;
  readonly #id: string;

  constructor(room: RoomObject, id: string) {
    super();
    this.#room = room;
    this.#id = id;
  }

  /** Send a frame to this member only. */
  whisper(from: string, text: string): boolean {
    const connection = this.#room.webSockets.getConnection(this.#id);
    if (!connection) return false;
    this.#room.send(connection, {
      type: "message",
      message: {
        id: 0,
        nick: `${cleanNick(from) ?? "anonymous"} (whisper)`,
        text: cleanText(text) ?? "",
        at: Date.now()
      }
    });
    return true;
  }
}

/**
 * The room's remote interface. Prototype methods are the complete surface.
 * On the WebSocket wire the capability answers the JSON `rpc` frames
 * `useAgent().stub` sends against it; on the Cap'n Web wire these are
 * native methods on the session root. Each call runs through the host invocation
 * boundary with the calling connection in scope, so a method may broadcast
 * to the hibernating members like a handler does.
 */
class RoomCallables extends RpcTarget {
  readonly #room: RoomObject;

  constructor(room: RoomObject) {
    super();
    this.#room = room;
  }

  say(nick: string, text: string): RoomMessage {
    const message = this.#room.post(nick, text);
    this.#room.broadcast({ type: "message", message });
    return message;
  }

  history(): RoomMessage[] {
    return this.#room.history();
  }

  members(): Member[] {
    return this.#room.members();
  }

  /** Look a member up by nick; the result is passed by reference. */
  member(nick: string): MemberHandle {
    const [id] = this.#room.membersNamed(cleanNick(nick) ?? "");
    if (!id) throw new Error(`No member named ${String(nick)}`);
    return new MemberHandle(this.#room, id);
  }

  /** Streams to the caller; `useAgent().call` surfaces it via stream callbacks. */
  countdown(from: number): ReadableStream<number> {
    const start = Math.min(Math.max(Math.trunc(from), 1), 10);
    return new ReadableStream<number>({
      start(controller) {
        for (let n = start; n >= 0; n--) controller.enqueue(n);
        controller.close();
      }
    });
  }
}

export class RoomObject extends DurableObject<Env> {
  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, { request }) => {
        // Only durable state survives hibernation: anything a later wake
        // needs about this connection goes through setState.
        const state: MemberState = {
          nick: nickFrom(connection, request),
          joinedAt: Date.now()
        };
        connection.setState(state);
        this.send(connection, { type: "history", messages: this.history() });
        this.broadcast({
          type: "join",
          nick: state.nick,
          members: this.members().length
        });
      },
      // Agent protocol frames (identity, rpc) never reach here: the
      // capability answers them first. Everything else is the room's own.
      onMessage: (connection, message) => {
        const frame = parseClientFrame(message);
        if (!frame) {
          this.send(connection, {
            type: "error",
            error: 'Expected {"type":"say","text":"..."} or {"type":"whoami"}'
          });
          return;
        }
        const state = connection.state as MemberState | null;
        switch (frame.type) {
          case "whoami":
            this.send(connection, { type: "whoami", id: connection.id, state });
            return;
          case "say": {
            const message = this.post(state?.nick ?? "anonymous", frame.text);
            this.broadcast({ type: "message", message });
            return;
          }
        }
      },
      onClose: (connection) => {
        const state = connection.state as MemberState | null;
        // The closing socket is already gone from getConnections().
        this.broadcast({
          type: "leave",
          nick: state?.nick ?? "anonymous",
          members: this.members().length
        });
      }
    },
    // Tags are set once at accept time and queryable through
    // getConnections(tag) after any wake. The connection id is always tag 0.
    getConnectionTags: (connection, { request }) => [
      `nick:${nickFrom(connection, request)}`
    ],
    callables: new RoomCallables(this)
  });

  readonly lifecycle = Lifecycle.install(this).use(this.webSockets);

  onStart(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nick TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Persist one message and return the stored row. Every write path — a
   * socket frame, a callable, an HTTP POST — comes through here, so the
   * bounds apply to all of them.
   */
  post(nick: unknown, text: unknown): RoomMessage {
    const cleanedText = cleanText(text);
    if (!cleanedText) {
      throw new Error(`text must be 1-${MAX_TEXT} characters`);
    }
    const [row] = this.ctx.storage.sql
      .exec<RoomMessage>(
        "INSERT INTO room_messages (nick, text, at) VALUES (?, ?, ?) RETURNING id, nick, text, at",
        cleanNick(nick) ?? "anonymous",
        cleanedText,
        Date.now()
      )
      .toArray();
    return row;
  }

  history(limit = 50): RoomMessage[] {
    return this.ctx.storage.sql
      .exec<RoomMessage>(
        "SELECT id, nick, text, at FROM (SELECT * FROM room_messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        limit
      )
      .toArray();
  }

  /** Every open connection on either wire, with its state. */
  members(): Member[] {
    return [...this.webSockets.getConnections<MemberState>()].map(
      (connection) => ({
        id: connection.id,
        nick: connection.state?.nick ?? "anonymous",
        joinedAt: connection.state?.joinedAt ?? 0
      })
    );
  }

  /** Connections accepted with a given nick, resolved through their tag. */
  membersNamed(nick: string): string[] {
    return [...this.webSockets.getConnections(`nick:${nick}`)].map(
      (connection) => connection.id
    );
  }

  send(connection: Connection, frame: ServerFrame): void {
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      // The socket closed between the wake and the send; a close wake
      // follows and the capability drops it from getConnections().
    }
  }

  broadcast(frame: ServerFrame): void {
    for (const connection of this.webSockets.getConnections()) {
      this.send(connection, frame);
    }
  }

  /**
   * HTTP surface under /agents/room-object/{name}: the same room read and
   * written without a socket. A POST here pushes to every member, which is
   * how a webhook or a scheduled job would reach connected clients.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.slice(url.pathname.lastIndexOf("/"));
    switch (route) {
      case "/history":
        return Response.json(this.history());
      case "/members": {
        const nick = url.searchParams.get("nick");
        return Response.json(nick ? this.membersNamed(nick) : this.members());
      }
      case "/say": {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (body === null || typeof body !== "object") {
          return badSay();
        }
        const { nick, text } = body as Partial<Record<string, unknown>>;
        if (!cleanText(text) || (nick !== undefined && !cleanNick(nick))) {
          return badSay();
        }
        const message = this.post(nick ?? "server", text);
        this.broadcast({ type: "message", message });
        return Response.json(message);
      }
      default:
        return Response.json({
          name: this.lifecycle.name,
          members: this.members().length,
          messages: this.history().length,
          routes: ["/history", "/members", "/say"]
        });
    }
  }
}

function badSay(): Response {
  return new Response(
    `Body must be { "text": string (1-${MAX_TEXT}), "nick"?: string (1-${MAX_NICK}) }`,
    { status: 400 }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "WebSockets demo. Connect a socket to /agents/room-object/<room>?nick=<you>, or GET /history, /members, POST /say.",
        { status: 404 }
      )
    );
  }
} satisfies ExportedHandler<Env>;
