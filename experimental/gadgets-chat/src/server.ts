/**
 * Chat Rooms — Multiple conversations via Durable Object Facets
 *
 * Plain Agent (not AIChatAgent) that manages chat rooms. Each room is
 * a facet with its own isolated SQLite. The facet handles the LLM call
 * (via generateText) and stores messages. The parent manages rooms and
 * syncs state to all connected clients.
 *
 *   OverseerAgent (plain Agent)
 *     ├── Room registry (own SQLite)
 *     ├── State sync to all WebSocket clients
 *     │
 *     ├── facet("room-abc")  →  ChatRoom (own SQLite + LLM calls)
 *     ├── facet("room-def")  →  ChatRoom (own SQLite + LLM calls)
 *     └── facet("room-ghi")  →  ChatRoom (own SQLite + LLM calls)
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, routeAgentRequest, callable } from "agents";
import { DurableObject } from "cloudflare:workers";
import { generateText, streamText } from "ai";

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

export type RoomsState = {
  rooms: RoomInfo[];
  activeRoomId: string | null;
  activeRoomMessages: ChatMessage[];
  /** Set while the LLM is generating a response */
  isThinking: boolean;
  /** Partial response text while streaming (empty string when not streaming) */
  streamingText: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// ChatRoom — facet with isolated SQLite + LLM calls
// ─────────────────────────────────────────────────────────────────────────────

export class ChatRoom extends DurableObject<Env> {
  private db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /** Store a user message and generate an assistant response. */
  async chat(userMessage: string): Promise<string> {
    // Store user message
    this.db.exec(
      "INSERT INTO messages (id, role, content) VALUES (?, ?, ?)",
      crypto.randomUUID(),
      "user",
      userMessage
    );

    // Load conversation history
    const history = [
      ...this.db
        .exec("SELECT role, content FROM messages ORDER BY created_at")
        .toArray()
    ] as { role: string; content: string }[];

    // Call the LLM inside the facet's context
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = await generateText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant. Each chat room has its own independent " +
        "conversation history. Be concise and helpful.",
      messages: history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content
      }))
    });

    // Store assistant response
    this.db.exec(
      "INSERT INTO messages (id, role, content) VALUES (?, ?, ?)",
      crypto.randomUUID(),
      "assistant",
      result.text
    );

    return result.text;
  }

  /** Add a single message (used by parent to store user msg before LLM call). */
  addMessage(role: string, content: string): void {
    this.db.exec(
      "INSERT INTO messages (id, role, content) VALUES (?, ?, ?)",
      crypto.randomUUID(),
      role,
      content
    );
  }

  /** Get conversation history for LLM context (called by parent for streaming). */
  loadHistory(): { role: string; content: string }[] {
    return [
      ...this.db
        .exec("SELECT role, content FROM messages ORDER BY created_at")
        .toArray()
    ] as { role: string; content: string }[];
  }

  getMessages(): ChatMessage[] {
    return [
      ...this.db
        .exec(
          "SELECT id, role, content, created_at as createdAt FROM messages ORDER BY created_at"
        )
        .toArray()
    ] as ChatMessage[];
  }

  getMessageCount(): number {
    return (
      this.db.exec("SELECT COUNT(*) as cnt FROM messages").one() as {
        cnt: number;
      }
    ).cnt;
  }

  clearMessages(): void {
    this.db.exec("DELETE FROM messages");
  }
}

/** Typed facet stub. */
interface ChatRoomFacet {
  chat(msg: string): Promise<string>;
  addMessage(role: string, content: string): Promise<void>;
  loadHistory(): Promise<{ role: string; content: string }[]>;
  getMessages(): Promise<ChatMessage[]>;
  getMessageCount(): Promise<number>;
  clearMessages(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OverseerAgent — plain Agent, manages rooms, syncs state
// ─────────────────────────────────────────────────────────────────────────────

export class OverseerAgent extends Agent<Env, RoomsState> {
  initialState: RoomsState = {
    rooms: [],
    activeRoomId: null,
    activeRoomMessages: [],
    isThinking: false,
    streamingText: ""
  };

  async onStart() {
    this._initRoomTable();
    await this._syncState();
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

  // ─── Facet access ────────────────────────────────────────────────────

  private _room(roomId: string): ChatRoomFacet {
    // @ts-expect-error — ctx.facets and ctx.exports are experimental
    return this.ctx.facets.get(`room-${roomId}`, () => ({
      // @ts-expect-error — ctx.exports is experimental
      class: this.ctx.exports.ChatRoom
    })) as ChatRoomFacet;
  }

  // ─── State sync ──────────────────────────────────────────────────────

  private async _syncState(activeRoomId?: string | null, isThinking = false) {
    const rooms = this.sql<{
      id: string;
      name: string;
      created_at: string;
      last_active_at: string;
    }>`
      SELECT id, name, created_at, last_active_at
      FROM rooms ORDER BY last_active_at DESC
    `;

    const resolvedActiveId =
      activeRoomId !== undefined
        ? activeRoomId
        : (this.state?.activeRoomId ?? null);
    const activeId =
      resolvedActiveId && rooms.some((r) => r.id === resolvedActiveId)
        ? resolvedActiveId
        : rooms.length > 0
          ? rooms[0].id
          : null;

    const roomInfos: RoomInfo[] = await Promise.all(
      rooms.map(async (r) => ({
        id: r.id,
        name: r.name,
        messageCount: await this._room(r.id).getMessageCount(),
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at
      }))
    );

    let activeMessages: ChatMessage[] = [];
    if (activeId) {
      activeMessages = await this._room(activeId).getMessages();
    }

    this.setState({
      rooms: roomInfos,
      activeRoomId: activeId,
      activeRoomMessages: activeMessages,
      isThinking,
      streamingText: ""
    });
  }

  // ─── Room CRUD ───────────────────────────────────────────────────────

  @callable()
  async createRoom(name: string): Promise<string> {
    const id = crypto.randomUUID().slice(0, 8);
    this.sql`INSERT INTO rooms (id, name) VALUES (${id}, ${name})`;
    await this._syncState(id);
    return id;
  }

  @callable()
  async deleteRoom(roomId: string) {
    this.sql`DELETE FROM rooms WHERE id = ${roomId}`;
    // @ts-expect-error — ctx.facets is experimental
    this.ctx.facets.delete(`room-${roomId}`);
    const nextActive =
      this.state.activeRoomId === roomId ? null : this.state.activeRoomId;
    await this._syncState(nextActive);
  }

  @callable()
  async switchRoom(roomId: string) {
    await this._syncState(roomId);
  }

  @callable()
  async clearRoom(roomId: string) {
    await this._room(roomId).clearMessages();
    await this._syncState();
  }

  @callable()
  async renameRoom(roomId: string, name: string) {
    this.sql`UPDATE rooms SET name = ${name} WHERE id = ${roomId}`;
    await this._syncState();
  }

  // ─── Send message ────────────────────────────────────────────────────

  /**
   * Send a message to the active room with streaming.
   *
   * Flow:
   * 1. Store user message in the facet → sync state (user sees their msg)
   * 2. Load conversation history from the facet
   * 3. Call streamText() — as tokens arrive, push partial state updates
   * 4. When done, store the assistant response in the facet → sync final state
   *
   * The LLM call happens in the parent (not the facet) so we can push
   * incremental state updates. The facet is the message store; the parent
   * is the streaming relay.
   */
  @callable()
  async sendMessage(text: string) {
    const activeId = this.state.activeRoomId;
    if (!activeId) throw new Error("No active room");

    // 1. Store user message in the facet and show it immediately
    await this._room(activeId).addMessage("user", text);
    await this._syncState(undefined, true); // isThinking = true

    // 2. Load conversation history from the facet (isolated storage)
    const history = await this._room(activeId).loadHistory();

    // 3. Stream the LLM response, pushing partial updates to the UI
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful assistant. Each chat room has its own independent " +
        "conversation history. Be concise and helpful.",
      messages: history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content
      }))
    });

    // Read the stream token by token and push state updates
    let accumulated = "";
    for await (const chunk of result.textStream) {
      accumulated += chunk;
      // Push partial text to all connected clients
      this.setState({
        ...this.state,
        isThinking: true,
        streamingText: accumulated
      });
    }

    // 4. Streaming done — store the full response in the facet
    await this._room(activeId).addMessage("assistant", accumulated);
    this
      .sql`UPDATE rooms SET last_active_at = CURRENT_TIMESTAMP WHERE id = ${activeId}`;

    // Final sync: messages from facet, streaming cleared
    await this._syncState();
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
