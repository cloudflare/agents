/**
 * Chat Rooms — Multiple conversations via SubAgent facets
 *
 * Architecture:
 *   - OverseerAgent (parent): room registry, WebSocket routing
 *   - ChatRoom (sub-agent): messages, LLM calls, streaming via RpcTarget callback
 *
 * Data flow:
 *   - Room list: broadcast to ALL clients via setState({ rooms })
 *   - Active room: per-connection via connection.setState({ activeRoomId })
 *   - Messages & streaming: per-connection via direct WebSocket messages
 *
 *   OverseerAgent
 *     ├── Room registry (own SQLite, shared state)
 *     ├── Per-connection routing
 *     │
 *     ├── subAgent("room-abc")  →  ChatRoom (isolated SQLite + LLM)
 *     ├── subAgent("room-def")  →  ChatRoom (isolated SQLite + LLM)
 *     └── subAgent("room-ghi")  →  ChatRoom (isolated SQLite + LLM)
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, getCurrentAgent, routeAgentRequest, callable } from "agents";
import type { Connection } from "agents";
import { streamText, tool, stepCountIs } from "ai";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types (shared with client)
// ─────────────────────────────────────────────────────────────────────────────

export type RoomInfo = {
  id: string;
  name: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

/** Broadcast state — room list only. Synced to all clients via setState. */
export type RoomsState = {
  rooms: RoomInfo[];
};

/** Per-connection state — stored via connection.setState(). */
export type ConnectionData = {
  activeRoomId: string | null;
};

/**
 * Messages sent to individual clients via connection.send().
 *
 * stream-event carries a serialized UIMessageChunk from the AI SDK's
 * toUIMessageStream(). The client can process text-delta, reasoning-delta,
 * tool-input-*, etc. without importing from the AI SDK.
 */
export type ServerMessage =
  | { type: "messages"; roomId: string; messages: ChatMessage[] }
  | { type: "stream-start"; roomId: string; requestId: string }
  | { type: "stream-event"; requestId: string; event: string; replay?: boolean }
  | { type: "stream-done"; requestId: string; message: ChatMessage }
  | { type: "stream-resuming"; requestId: string };

/** Messages the client sends directly on the WebSocket (not RPC). */
export type ClientMessage =
  | { type: "cancel"; requestId: string }
  | { type: "resume-request" };

// ─────────────────────────────────────────────────────────────────────────────
// ChatRoom — sub-agent with isolated SQLite + LLM calls
// ─────────────────────────────────────────────────────────────────────────────

export class ChatRoom extends Agent<Env> {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }

  /**
   * Stream a chat response using the AI SDK's UIMessageStream protocol.
   *
   * The sub-agent owns the full lifecycle:
   * store user message → load history → call LLM → stream UIMessageChunk
   * events via callback → store assistant response.
   *
   * Each chunk is a serialized UIMessageChunk JSON string (text-delta,
   * reasoning-delta, tool-input-*, etc.) relayed to the parent.
   */
  async chatStream(
    userMessage: string,
    callback: {
      onEvent(json: string): void;
      onDone(message: ChatMessage): void;
    }
  ): Promise<void> {
    // Store user message
    this.sql`
      INSERT INTO messages (id, role, content)
      VALUES (${crypto.randomUUID()}, 'user', ${userMessage})
    `;

    // Load conversation history
    const history = this.sql<{ role: string; content: string }>`
      SELECT role, content FROM messages ORDER BY created_at
    `;

    // Stream the LLM response using the AI SDK's UIMessageStream protocol
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant. Each chat room has its own independent " +
        "conversation history. Be concise and helpful. " +
        "You have access to tools — use them when appropriate.",
      messages: history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content
      })),
      tools: {
        get_current_time: tool({
          description: "Get the current date and time",
          inputSchema: z.object({}),
          execute: async () => new Date().toISOString()
        }),
        roll_dice: tool({
          description: "Roll a dice with the specified number of sides",
          inputSchema: z.object({
            sides: z.number().describe("Number of sides on the dice").default(6)
          }),
          execute: async ({ sides }) => ({
            result: Math.floor(Math.random() * sides) + 1,
            sides
          })
        })
      },
      stopWhen: stepCountIs(5)
    });

    // Iterate over typed UIMessageChunk objects from the AI SDK.
    // Each chunk is serialized and relayed to the parent via the callback.
    // We also accumulate text from text-delta events for persistence.
    let accumulated = "";
    for await (const chunk of result.toUIMessageStream()) {
      if (chunk.type === "text-delta" && "delta" in chunk) {
        accumulated += (chunk as { delta: string }).delta;
      }
      await callback.onEvent(JSON.stringify(chunk));
    }

    // Store the assistant response
    const msgId = crypto.randomUUID();
    this.sql`
      INSERT INTO messages (id, role, content)
      VALUES (${msgId}, 'assistant', ${accumulated})
    `;

    // Get the stored message with its timestamp
    const stored = this.sql<ChatMessage>`
      SELECT id, role, content, created_at as createdAt
      FROM messages WHERE id = ${msgId}
    `;

    await callback.onDone(stored[0]);
  }

  getMessages(): ChatMessage[] {
    return this.sql<ChatMessage>`
      SELECT id, role, content, created_at as createdAt
      FROM messages ORDER BY created_at
    `;
  }

  getMessageCount(): number {
    const rows = this.sql<{
      cnt: number;
    }>`SELECT COUNT(*) as cnt FROM messages`;
    return rows[0].cnt;
  }

  clearMessages(): void {
    this.sql`DELETE FROM messages`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamRelay — RpcTarget that relays chunks from sub-agent to a WebSocket
// ─────────────────────────────────────────────────────────────────────────────

class StreamRelay extends RpcTarget {
  #connection: Connection;
  #requestId: string;
  #chunks: string[] = [];
  #aborted = false;

  constructor(connection: Connection, requestId: string) {
    super();
    this.#connection = connection;
    this.#requestId = requestId;
  }

  /** Stop forwarding events (called on cancel). */
  abort() {
    this.#aborted = true;
  }

  /** Reassign to a new connection (called on resume after reconnect). */
  updateConnection(connection: Connection) {
    this.#connection = connection;
  }

  /** Get buffered chunks for replay on resume. */
  getChunks(): string[] {
    return this.#chunks;
  }

  /** Relay a serialized UIMessageChunk event to the WebSocket connection. */
  onEvent(json: string) {
    this.#chunks.push(json);
    if (this.#aborted) return;
    const msg: ServerMessage = {
      type: "stream-event",
      requestId: this.#requestId,
      event: json
    };
    this.#connection.send(JSON.stringify(msg));
  }

  onDone(message: ChatMessage) {
    if (this.#aborted) return;
    const msg: ServerMessage = {
      type: "stream-done",
      requestId: this.#requestId,
      message
    };
    this.#connection.send(JSON.stringify(msg));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OverseerAgent — room registry + WebSocket router
// ─────────────────────────────────────────────────────────────────────────────

export class OverseerAgent extends Agent<Env, RoomsState> {
  initialState: RoomsState = { rooms: [] };

  /** Active streams keyed by requestId — used for cancel and resume. */
  #activeStreams = new Map<
    string,
    { relay: StreamRelay; roomId: string; connectionId: string }
  >();

  async onStart() {
    this._initRoomTable();
    await this._broadcastRooms();
  }

  /**
   * Handle non-RPC WebSocket messages: cancel and resume-request.
   * These bypass the RPC system and arrive as raw messages.
   */
  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    try {
      const msg = JSON.parse(message) as ClientMessage;
      switch (msg.type) {
        case "cancel": {
          const stream = this.#activeStreams.get(msg.requestId);
          if (stream) {
            stream.relay.abort();
            this.#activeStreams.delete(msg.requestId);
          }
          break;
        }
        case "resume-request": {
          // Find active stream matching the connection's current room
          const activeId = this._getActiveRoomId(connection);
          if (!activeId) break;
          for (const [requestId, stream] of this.#activeStreams) {
            if (stream.roomId !== activeId) continue;
            stream.relay.updateConnection(connection);
            stream.connectionId = connection.id;
            // Send resuming signal
            const resumeMsg: ServerMessage = {
              type: "stream-resuming",
              requestId
            };
            connection.send(JSON.stringify(resumeMsg));
            // Replay buffered chunks
            for (const chunk of stream.relay.getChunks()) {
              const replayMsg: ServerMessage = {
                type: "stream-event",
                requestId,
                event: chunk,
                replay: true
              };
              connection.send(JSON.stringify(replayMsg));
            }
            break;
          }
          break;
        }
      }
    } catch {
      /* not a ClientMessage — ignore */
    }
  }

  private _initRoomTable() {
    this.sql`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Broadcast the room list to all connected clients via shared state. */
  private async _broadcastRooms() {
    const rooms = this.sql<{
      id: string;
      name: string;
      created_at: string;
      last_active_at: string;
    }>`
      SELECT id, name, created_at, last_active_at
      FROM rooms ORDER BY last_active_at DESC
    `;

    const roomInfos: RoomInfo[] = await Promise.all(
      rooms.map(async (r) => {
        const room = await this.subAgent(ChatRoom, `room-${r.id}`);
        return {
          id: r.id,
          name: r.name,
          messageCount: await room.getMessageCount(),
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at
        };
      })
    );

    this.setState({ rooms: roomInfos });
  }

  /** Send the messages of a room to a specific connection. */
  private async _sendRoomMessages(connection: Connection, roomId: string) {
    const room = await this.subAgent(ChatRoom, `room-${roomId}`);
    const messages = await room.getMessages();
    const msg: ServerMessage = { type: "messages", roomId, messages };
    connection.send(JSON.stringify(msg));
  }

  /** Get the calling connection from the agent context. */
  private _getConnection(): Connection {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("No connection in context");
    return connection;
  }

  /** Get the active room ID for a connection. */
  private _getActiveRoomId(connection: Connection): string | null {
    const data = connection.state as ConnectionData | null;
    return data?.activeRoomId ?? null;
  }

  // ─── Room CRUD ───────────────────────────────────────────────────────

  @callable()
  async createRoom(name: string): Promise<string> {
    const id = crypto.randomUUID().slice(0, 8);
    this.sql`INSERT INTO rooms (id, name) VALUES (${id}, ${name})`;

    // Auto-switch the calling connection to the new room
    const connection = this._getConnection();
    connection.setState({ activeRoomId: id } satisfies ConnectionData);
    await this._sendRoomMessages(connection, id);

    await this._broadcastRooms();
    return id;
  }

  @callable()
  async deleteRoom(roomId: string) {
    this.sql`DELETE FROM rooms WHERE id = ${roomId}`;
    this.deleteSubAgent(ChatRoom, `room-${roomId}`);

    // If the calling connection was viewing this room, clear it
    const connection = this._getConnection();
    if (this._getActiveRoomId(connection) === roomId) {
      connection.setState({ activeRoomId: null } satisfies ConnectionData);
    }

    await this._broadcastRooms();
  }

  @callable()
  async switchRoom(roomId: string) {
    const connection = this._getConnection();
    connection.setState({ activeRoomId: roomId } satisfies ConnectionData);
    await this._sendRoomMessages(connection, roomId);
  }

  @callable()
  async clearRoom(roomId: string) {
    const room = await this.subAgent(ChatRoom, `room-${roomId}`);
    await room.clearMessages();

    // Send empty messages to all connections viewing this room
    for (const conn of this.getConnections()) {
      if (this._getActiveRoomId(conn) === roomId) {
        await this._sendRoomMessages(conn, roomId);
      }
    }

    await this._broadcastRooms();
  }

  @callable()
  async renameRoom(roomId: string, name: string) {
    this.sql`UPDATE rooms SET name = ${name} WHERE id = ${roomId}`;
    await this._broadcastRooms();
  }

  // ─── Send message ────────────────────────────────────────────────────

  /**
   * Send a message to the active room with streaming.
   *
   * Flow:
   * 1. Get the calling connection's active room
   * 2. Send stream-start to the connection
   * 3. Call chatStream() on the sub-agent with an RpcTarget relay
   *    — the sub-agent stores the user msg, calls LLM, streams chunks
   *    — the relay forwards each chunk to the WebSocket connection
   * 4. On stream-done, broadcast updated room list (message counts)
   */
  @callable()
  async sendMessage(text: string, requestId: string) {
    const connection = this._getConnection();
    const activeId = this._getActiveRoomId(connection);
    if (!activeId) throw new Error("No active room");

    const room = await this.subAgent(ChatRoom, `room-${activeId}`);

    // Signal stream start
    const startMsg: ServerMessage = {
      type: "stream-start",
      roomId: activeId,
      requestId
    };
    connection.send(JSON.stringify(startMsg));

    // Stream via RpcTarget callback — sub-agent calls back to relay,
    // relay sends chunks to the WebSocket connection
    const relay = new StreamRelay(connection, requestId);

    // Track active stream for cancel/resume
    this.#activeStreams.set(requestId, {
      relay,
      roomId: activeId,
      connectionId: connection.id
    });

    try {
      await room.chatStream(text, relay);
    } finally {
      this.#activeStreams.delete(requestId);
    }

    // Update room timestamps and broadcast new message counts
    this
      .sql`UPDATE rooms SET last_active_at = CURRENT_TIMESTAMP WHERE id = ${activeId}`;
    await this._broadcastRooms();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
