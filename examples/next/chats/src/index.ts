import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";
import { RoutedAgents } from "agents/routing";

/**
 * The recommended shape for "many chats per user": one top-level
 * Durable Object per chat, owned and routed to by a per-user hub.
 *
 * `RoutedAgents` gives the hub a durable catalog of chat IDs mapped to
 * opaque physical names, and forwards `/chats/{id}/...` requests and
 * WebSocket upgrades to the right chat. Each chat pushes its metadata
 * back into the hub so listing, search, and deletion never wake a chat.
 *
 * Contrast with dynamic agents (facets): a chat needs no isolation
 * boundary from its parent, does need its own alarms and placement,
 * and a user accumulates an unbounded number of them. See
 * docs/agents/sub-agents.md for the decision rule.
 */

type ChatMeta = {
  title: string | null;
  lastMessage: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: number;
};

/** Recorded once by the owning UserAgent right after the entry is created. */
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
    const at = Date.now();
    this.sql`
      INSERT INTO messages (role, text, at) VALUES (${role}, ${text}, ${at})
    `;
    const [{ n }] = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM messages
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
        const user = await getAgentByName(this.env.UserAgent, owner.userId);
        await user.recordChatActivity(owner.chatId, {
          title: first ? first.text.slice(0, 80) : null,
          lastMessage: text.slice(0, 120)
        });
      } catch (error) {
        console.warn("[ChatAgent] owner update failed", error);
      }
    }

    return n;
  }

  @callable()
  getMessages(): ChatMessage[] {
    return this.sql<ChatMessage>`
      SELECT role, text, at FROM messages ORDER BY id ASC
    `;
  }

  /** HTTP surface, reached as `/agents/user-agent/{user}/chats/{id}/messages`. */
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
}

/**
 * The per-user hub. It owns the set of chats, routes to them, and holds
 * the pushed metadata that the sidebar and search read.
 */
export class UserAgent extends Agent<Env> {
  readonly chats = new RoutedAgents<ChatAgent, ChatMeta>({
    namespace: this.env.ChatAgent,
    route: "chats"
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.chats);
  }

  @callable()
  async createChat(): Promise<string> {
    const { id } = await this.chats.create({
      metadata: { title: null, lastMessage: null }
    });
    try {
      const chat = await this.chats.get(id);
      if (!chat) throw new Error(`Chat ${id} vanished during creation`);
      await chat.init({ userId: this.name, chatId: id });
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

  /** DO-RPC target for ChatAgent pushes. False once the chat is deleted. */
  recordChatActivity(chatId: string, meta: ChatMeta): Promise<boolean> {
    return this.chats.setMetadata(chatId, meta);
  }

  /** Most recent activity first; reads only this DO. */
  @callable()
  listChats() {
    return this.chats.list();
  }

  /** Cross-chat search over the pushed metadata; no chat wakes up. */
  @callable()
  async searchChats(query: string) {
    const needle = query.toLowerCase();
    return (await this.chats.list()).filter(({ metadata }) =>
      [metadata?.title, metadata?.lastMessage].some((value) =>
        value?.toLowerCase().includes(needle)
      )
    );
  }

  /** Destroys the chat's own storage and removes it from the catalog. */
  @callable()
  deleteChat(chatId: string): Promise<boolean> {
    return this.chats.delete(chatId);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
