import { DurableObject, RpcTarget } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle, type Connection } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";

/**
 * A chat room on a plain Durable Object. The `WebSockets` capability owns
 * the whole connection subsystem: it claims upgrades, accepts hibernating
 * sockets, dispatches the handlers below inside the host invocation
 * boundary, and answers `getConnections()`. The room itself only keeps a
 * message table and decides what to broadcast.
 */

/** Per-connection state. Persisted on the socket, so it survives hibernation. */
type MemberState = {
  nick: string;
  joinedAt: number;
};

type RoomMessage = {
  id: number;
  nick: string;
  text: string;
  at: number;
};

/** Frames the room sends to every member. */
type ServerFrame =
  | { type: "history"; messages: RoomMessage[] }
  | { type: "join"; nick: string; members: number }
  | { type: "leave"; nick: string; members: number }
  | { type: "message"; message: RoomMessage }
  | { type: "whoami"; id: string; state: MemberState | null }
  | { type: "error"; error: string };

/** Frames a member may send. */
type ClientFrame = { type: "say"; text: string } | { type: "whoami" };

const MAX_TEXT = 1_000;

function nickFrom(request: Request, fallback: string): string {
  const nick = new URL(request.url).searchParams.get("nick")?.trim();
  return nick && nick.length <= 32 ? nick : fallback;
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
  if (type === "say" && typeof text === "string") {
    const trimmed = text.trim();
    if (trimmed && trimmed.length <= MAX_TEXT) return { type, text: trimmed };
  }
  return null;
}

/**
 * The same room, served as remote methods over a Cap'n Web session
 * (`?__agents_rpc=capnweb`). Prototype methods are the complete remote
 * interface. Each call runs through the host invocation boundary, so a
 * method may broadcast to the hibernating members like a handler does.
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

  members(): { id: string; nick: string; joinedAt: number }[] {
    return this.#room.members();
  }
}

export class RoomObject extends DurableObject<Env> {
  readonly webSockets = new WebSockets({
    handlers: {
      onConnect: (connection, { request }) => {
        // Only durable state survives hibernation: anything a later wake
        // needs about this connection goes through setState.
        const state: MemberState = {
          nick: nickFrom(request, `guest-${connection.id.slice(0, 6)}`),
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
    getConnectionTags: (_connection, { request }) => [
      `nick:${nickFrom(request, "guest")}`
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

  /** Persist one message and return the stored row. */
  post(nick: string, text: string): RoomMessage {
    const [row] = this.ctx.storage.sql
      .exec<RoomMessage>(
        "INSERT INTO room_messages (nick, text, at) VALUES (?, ?, ?) RETURNING id, nick, text, at",
        nick,
        text.slice(0, MAX_TEXT),
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

  /** Every open connection with its persisted state. */
  members(): { id: string; nick: string; joinedAt: number }[] {
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

  broadcast(frame: ServerFrame, exceptId?: string): void {
    for (const connection of this.webSockets.getConnections()) {
      if (connection.id !== exceptId) this.send(connection, frame);
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
        let body: Partial<{ nick: string; text: string }>;
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        if (typeof body.text !== "string" || !body.text.trim()) {
          return new Response(
            'Body must be { "text": string, "nick"?: string }',
            {
              status: 400
            }
          );
        }
        const message = this.post(body.nick ?? "server", body.text.trim());
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
