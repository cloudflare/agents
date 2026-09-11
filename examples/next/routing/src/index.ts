import { DurableObject, RpcTarget } from "cloudflare:workers";
import {
  Agent,
  callable,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import { Lifecycle } from "agents/lifecycle";
import { RoutedAgents } from "agents/routing";
import { WebSockets } from "agents/websockets";

/**
 * The recommended shape for "many chats per user": one top-level
 * Durable Object per chat, owned and routed to by a per-user hub.
 *
 * The hub is a plain Durable Object composed with two capabilities.
 * `RoutedAgents` gives it a durable catalog of chat IDs mapped to opaque
 * physical names, and forwards `/chats/{id}/...` requests and WebSocket
 * upgrades to the right chat. `WebSockets` serves the hub's own methods
 * to the browser as Cap'n Web callables. Each chat pushes its metadata
 * back into the hub so listing, search, and deletion never wake a chat.
 *
 * The targets must be `Agent`s: the capability relies on Agent's
 * condemnation protocol to wipe a deleted chat's storage.
 *
 * Contrast with dynamic agents (facets): a chat needs no isolation
 * boundary from its parent, does need its own alarms and placement,
 * and a user accumulates an unbounded number of them. See
 * docs/agents/sub-agents.md for the decision rule.
 */

type ChatMeta = {
  title: string | null;
  lastMessage: string | null;
  /**
   * The pushing message's own ordinal in its chat, from `messages`'
   * `AUTOINCREMENT` id. Fences out delayed or superseded pushes without
   * relying on `Date.now()` resolution: two messages sent back to back
   * (a real echo can round-trip inside one millisecond) get consecutive
   * ordinals and so never tie, unlike wall-clock timestamps.
   */
  seq: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

/** Recorded once by the owning hub right after the entry is created. */
type ChatOwner = {
  userId: string;
  chatId: string;
};

/** One Durable Object per conversation, reached only through its owner. */
export class ChatAgent extends Agent<Env> {
  onStart(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
  }

  init(owner: ChatOwner): Promise<void> {
    return this.ctx.storage.put("owner", owner);
  }

  @callable()
  async addMessage(role: "user" | "assistant", text: string): Promise<number> {
    const [{ id: seq }] = this.sql<{ id: number }>`
      INSERT INTO messages (role, text, at) VALUES (${role}, ${text}, ${Date.now()})
      RETURNING id
    `;

    // Push the latest snapshot to the owner so listing and search never
    // wake this DO. The owner's copy is derived data: a failed push
    // leaves it stale until the next message, and a push for a deleted
    // chat is refused, so nothing can resurrect a deleted entry.
    const owner = await this.ctx.storage.get<ChatOwner>("owner");
    const [first] = this.sql<{ text: string }>`
      SELECT text FROM messages WHERE role = 'user' ORDER BY id ASC LIMIT 1
    `;
    if (owner) {
      try {
        const hub = this.env.UserHub.getByName(owner.userId);
        await hub.recordChatActivity(owner.chatId, {
          title: first ? first.text.slice(0, 80) : null,
          lastMessage: text.slice(0, 120),
          seq
        });
      } catch (error) {
        console.warn("[ChatAgent] owner update failed", error);
      }
    }

    return seq;
  }

  @callable()
  getMessages(): ChatMessage[] {
    return this.sql<ChatMessage>`
      SELECT role, text, at FROM messages ORDER BY id ASC
    `;
  }

  /**
   * HTTP surface. The path the chat sees is the forwarded suffix:
   * `/agents/user-hub/{user}/chats/{id}/messages` arrives here as
   * `/messages`.
   */
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/messages") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      const { role, text } = body as Partial<ChatMessage>;
      if (
        (role !== "user" && role !== "assistant") ||
        typeof text !== "string" ||
        text === ""
      ) {
        return new Response(
          'Body must be { "role": "user" | "assistant", "text": string }',
          { status: 400 }
        );
      }
      await this.addMessage(role, text);
    }
    return Response.json(this.getMessages());
  }

  /**
   * A WebSocket upgraded through the hub's route is answered by this
   * Agent, which then owns the socket: frames never wake the hub.
   */
  override onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`echo:${String(message)}`);
  }
}

/**
 * The hub's remote interface. Prototype methods are the complete surface
 * served to the browser over a Cap'n Web session at
 * `/agents/user-hub/{user}?__agents_rpc=capnweb`.
 */
class HubCallables extends RpcTarget {
  readonly #hub: UserHub;

  constructor(hub: UserHub) {
    super();
    this.#hub = hub;
  }

  createChat(): Promise<string> {
    return this.#hub.createChat();
  }

  listChats() {
    return this.#hub.listChats();
  }

  searchChats(query: string) {
    return this.#hub.searchChats(query);
  }

  deleteChat(chatId: string): Promise<boolean> {
    return this.#hub.deleteChat(chatId);
  }
}

/**
 * The per-user hub. It owns the set of chats, routes to them, and holds
 * the pushed metadata that the sidebar and search read.
 */
export class UserHub extends DurableObject<Env> {
  readonly chats = new RoutedAgents<ChatAgent, ChatMeta>({
    namespace: this.env.ChatAgent,
    // Claims every `/chats/{id}/...` path under this hub before any
    // other capability or onRequest sees it.
    route: "chats"
  });

  readonly webSockets = new WebSockets({
    callables: new HubCallables(this)
  });

  // RoutedAgents is installed first so a forwarded upgrade under
  // `/chats/{id}` reaches the chat, and only the hub's own upgrades fall
  // through to the callables endpoint.
  readonly lifecycle = Lifecycle.install(this)
    .use(this.chats)
    .use(this.webSockets);

  async createChat(): Promise<string> {
    const { id } = await this.chats.create({
      metadata: { title: null, lastMessage: null, seq: 0 }
    });
    try {
      // get() resolves the entry to an initialized, typed stub for RPC.
      const chat = await this.chats.get(id);
      if (!chat) throw new Error(`Chat ${id} vanished during creation`);
      await chat.init({ userId: this.lifecycle.name, chatId: id });
    } catch (error) {
      // The catalog row is uninitialized ownership without a matching
      // one-time init call, so it would never learn the chat pushes its
      // activity back into. Remove it rather than leave a chat that looks
      // created but can never appear as more than "New chat" again.
      await this.chats.delete(id);
      throw error;
    }
    return id;
  }

  /**
   * DO-RPC target for ChatAgent pushes. Rejects a push whose `seq` is
   * not strictly greater than the entry's current one, so a push
   * delayed by a slow round-trip can't overwrite one that arrived first
   * — `RoutedAgents.setMetadata()` itself has no ordering concept, so
   * the fence lives here. False for a deleted chat or a superseded push.
   *
   * `blockConcurrencyWhile` makes the read-then-write atomic against
   * other concurrent calls to this method on this same hub instance —
   * without it, two pushes could both read the same "current" value
   * before either writes, and the fence would compare against a value
   * that's already stale by the time the later one applies.
   */
  recordChatActivity(chatId: string, meta: ChatMeta): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = (await this.chats.list()).find(
        (entry) => entry.id === chatId
      );
      if (!current || (current.metadata?.seq ?? 0) >= meta.seq) {
        return false;
      }
      return this.chats.setMetadata(chatId, meta);
    });
  }

  /** Most recent activity first; reads only this DO. */
  listChats() {
    return this.chats.list();
  }

  /** Cross-chat search over the pushed metadata; no chat wakes up. */
  async searchChats(query: string) {
    const needle = query.toLowerCase();
    return (await this.chats.list()).filter(({ metadata }) =>
      [metadata?.title, metadata?.lastMessage].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    );
  }

  /** Destroys the chat's own storage and removes it from the catalog. */
  deleteChat(chatId: string): Promise<boolean> {
    return this.chats.delete(chatId);
  }

  /** Plain HTTP view of the catalog, for curl. */
  async onRequest(): Promise<Response> {
    return Response.json({
      user: this.lifecycle.name,
      chats: await this.chats.list()
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Routes both /agents/user-hub/{user} and the forwarded
    // /agents/user-hub/{user}/chats/{id}/... paths: RoutedAgents claims the
    // latter from inside the hub once the request reaches it.
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
