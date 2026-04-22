/**
 * Multi-session AI Chat example.
 *
 * Demonstrates the sub-agent routing primitive end-to-end:
 *
 *     Inbox (demo-user)                     ◄── top-level DO
 *       ├─ Chat (chat-abc)  [facet]         ◄── sub-agents, one per chat
 *       ├─ Chat (chat-def)  [facet]
 *       └─ Chat (chat-ghi)  [facet]
 *
 * - `Inbox` is a top-level `Agent`. It owns the sidebar (chat list)
 *   and a per-user shared memory blob.
 * - `Chat` is an `AIChatAgent` that lives as a **facet** of Inbox
 *   (`this.subAgent(Chat, id)`). Each chat is its own Durable Object
 *   — two chats for the same user run in parallel, each with its
 *   own SQLite storage, while all colocated on the same machine as
 *   the parent.
 * - Addressing is transparent: the client connects to an inbox at
 *   `/agents/inbox/{user}` for the sidebar and to a specific chat
 *   at `/agents/inbox/{user}/sub/chat/{chatId}` for the conversation.
 *   The `useAgent({ sub: [...] })` client option builds those
 *   sub-agent URLs.
 * - `Inbox.onBeforeSubAgent` acts as a strict-registry gate: only
 *   chats that exist in the sidebar index can be addressed. Unknown
 *   child names get a 404 before any facet is woken.
 * - A `Chat` reaches its parent via `this.parentPath[0]` — no
 *   hardcoded user IDs, no separate binding lookup.
 *
 * This is exactly the shape the proposed `Chats` base class in
 * `design/rfc-think-multi-session.md` will codify as sugar. Once
 * that lands, `createChat` / `deleteChat` / `onBeforeSubAgent` can
 * collapse into a few framework-provided defaults.
 *
 * For a single-user demo we hardcode the Inbox name as "demo-user".
 * A real app would authenticate the user first and use their id.
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { nanoid } from "nanoid";
import { z } from "zod";

// The single-user Inbox name used by this demo. A real app would use
// the authenticated user's id.
export const DEMO_USER = "demo-user";

// ── Types shared between Inbox and Chat ─────────────────────────────

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface InboxState {
  chats: ChatSummary[];
}

// ── Inbox — the parent / directory ─────────────────────────────────

/**
 * One Inbox DO per user.
 *
 * **Existence is framework-owned.** The set of chats is whatever
 * `listSubAgents(Chat)` returns — i.e. the facet registry that
 * `subAgent()` / `deleteSubAgent()` keep in lockstep with the
 * Durable Object itself. No parallel "chat exists" table to drift
 * out of sync with the real facets.
 *
 * **Metadata is app-owned.** Titles, preview snippets, and the
 * last-touched timestamp live in a separate `chat_meta` table keyed
 * by `chatId`. A row here is pure decoration — its absence is fine
 * (we fall back to defaults), and deleting a chat wipes the meta
 * row too.
 */
export class Inbox extends Agent<Env, InboxState> {
  initialState: InboxState = { chats: [] };

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS chat_meta (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS inbox_memory (
      label TEXT PRIMARY KEY,
      content TEXT NOT NULL
    )`;
    this._refreshState();
  }

  /**
   * Build the sidebar state from two sources:
   *   1. `listSubAgents(Chat)` — authoritative set of chats,
   *      maintained by the framework.
   *   2. `chat_meta` — app-owned decoration (title, preview).
   *
   * A chat that exists in the registry but has no meta row gets a
   * default title. A chat with a meta row but no registry entry is
   * silently ignored (the registry is the source of truth).
   */
  private _refreshState() {
    const registry = this.listSubAgents(Chat);
    const metaRows = this.sql<{
      id: string;
      title: string;
      updated_at: number;
      last_message_preview: string | null;
    }>`
      SELECT id, title, updated_at, last_message_preview FROM chat_meta
    `;
    const metaById = new Map(metaRows.map((m) => [m.id, m]));

    const chats: ChatSummary[] = registry
      .map((entry) => {
        const meta = metaById.get(entry.name);
        return {
          id: entry.name,
          title:
            meta?.title ??
            `Chat — ${new Date(entry.createdAt).toISOString().slice(0, 10)}`,
          createdAt: entry.createdAt,
          updatedAt: meta?.updated_at ?? entry.createdAt,
          lastMessagePreview: meta?.last_message_preview ?? undefined
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.setState({ ...this.state, chats });
  }

  // ── Strict-registry gate for child Chats ────────────────────────

  /**
   * Only allow clients to reach a `Chat` facet that the inbox has
   * explicitly spawned via `createChat`. Any other URL gets a 404
   * before the framework wakes the child. `hasSubAgent` is backed
   * by the same registry `listSubAgents` reads from.
   */
  override async onBeforeSubAgent(
    _req: Request,
    { className, name }: { className: string; name: string }
  ): Promise<Request | Response | void> {
    if (!this.hasSubAgent(className, name)) {
      return new Response("Chat not found", { status: 404 });
    }
    // Fall through — framework forwards the request to the facet.
  }

  // ── Sidebar operations ────────────────────────────────────────────

  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const title =
      opts?.title ?? `Chat — ${new Date(now).toISOString().slice(0, 10)}`;

    // Spawn the facet FIRST so the registry is populated. If the
    // metadata INSERT fails for any reason, the next `deleteChat` or
    // `_refreshState` will still see and clean up the chat via the
    // registry.
    await this.subAgent(Chat, id);
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, NULL)
    `;
    this._refreshState();
    return { id, title, createdAt: now, updatedAt: now };
  }

  @callable()
  async renameChat(id: string, title: string): Promise<void> {
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at)
      VALUES (${id}, ${title}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at
    `;
    this._refreshState();
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    // Wipe the facet (idempotent — safe if already gone), then
    // drop its metadata. Order doesn't matter for correctness since
    // the registry is authoritative, but we do the facet first so
    // a crash between the two leaves no orphan meta rows visible.
    this.deleteSubAgent(Chat, id);
    this.sql`DELETE FROM chat_meta WHERE id = ${id}`;
    this._refreshState();
  }

  // ── Shared memory (RPC target for child chats + client) ──────────

  @callable()
  async getSharedMemory(label: string): Promise<string | null> {
    const rows = this.sql<{ content: string }>`
      SELECT content FROM inbox_memory WHERE label = ${label}
    `;
    return rows[0]?.content ?? null;
  }

  @callable()
  async setSharedMemory(label: string, content: string): Promise<void> {
    this.sql`
      INSERT INTO inbox_memory (label, content)
      VALUES (${label}, ${content})
      ON CONFLICT(label) DO UPDATE SET content = ${content}
    `;
  }

  // ── Called by a child Chat when a turn is committed ──────────────

  @callable()
  async recordChatTurn(chatId: string, preview: string): Promise<void> {
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (
        ${chatId},
        ${`Chat — ${new Date().toISOString().slice(0, 10)}`},
        ${Date.now()},
        ${preview}
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_message_preview = excluded.last_message_preview
    `;
    this._refreshState();
  }
}

// ── Chat — a single conversation (facet of Inbox) ──────────────────

export class Chat extends AIChatAgent<Env> {
  /**
   * Resolve the parent Inbox via the framework's `parentAgent()`
   * helper. `parentAgent` reads `this.parentPath[0]` internally
   * and opens a typed stub on the given namespace — no hardcoded
   * user id, no manual `getAgentByName` plumbing.
   */
  private getInbox() {
    return this.parentAgent(this.env.Inbox);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // Read shared user memory from the Inbox. Fails soft — if the
    // parent is unreachable for any reason, the chat still works.
    let sharedMemory = "";
    try {
      const inbox = await this.getInbox();
      sharedMemory = (await inbox.getSharedMemory("memory")) ?? "";
    } catch {
      // Best-effort.
    }

    const systemPrompt = [
      "You are a friendly assistant. Keep replies concise.",
      sharedMemory
        ? `Things you already know about this user:\n${sharedMemory}`
        : null,
      "You have three tools available:",
      "- `rememberFact`: save a fact about the user to their shared memory. " +
        "EVERY chat (this one plus every other chat in the sidebar) will " +
        "see this fact in future turns. Use it when the user shares a " +
        "persistent preference, name, interest, or anything they'd expect " +
        "you to recall later.",
      "- `recallMemory`: re-read the full shared memory. Useful to double-" +
        "check what you know before answering a question about the user.",
      "- `getCurrentTime`: returns the server's current time in ISO-8601. " +
        "Use only when the user asks about the time."
    ]
      .filter(Boolean)
      .join("\n\n");

    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemPrompt,
      messages: await convertToModelMessages([...this.messages]),
      // Allow multi-step agentic loops — the model can call a tool,
      // observe its output, and respond in the same turn.
      stopWhen: stepCountIs(5),
      tools: {
        // ── Shared-memory tools (demonstrate cross-DO RPC from a
        // facet tool-execute into the parent Inbox). A write here
        // is visible to every sibling Chat on the next turn.
        rememberFact: tool({
          description:
            "Save a fact to the user's shared memory. The fact becomes " +
            "visible to every chat (including this one) on subsequent " +
            "turns.",
          inputSchema: z.object({
            fact: z
              .string()
              .describe(
                "A concise, first-person fact — e.g. 'The user prefers TypeScript over JavaScript.'"
              )
          }),
          execute: async ({ fact }) => {
            const inbox = await this.getInbox();
            const existing = (await inbox.getSharedMemory("memory")) ?? "";
            const next = existing ? `${existing}\n- ${fact}` : `- ${fact}`;
            await inbox.setSharedMemory("memory", next);
            return { saved: true, totalFacts: next.split("\n").length };
          }
        }),

        recallMemory: tool({
          description:
            "Read the user's shared memory — every fact saved across all chats.",
          inputSchema: z.object({}),
          execute: async () => {
            const inbox = await this.getInbox();
            const memory = (await inbox.getSharedMemory("memory")) ?? "";
            return {
              memory: memory || "(nothing saved yet)",
              facts: memory ? memory.split("\n").filter(Boolean).length : 0
            };
          }
        }),

        getCurrentTime: tool({
          description: "Get the server's current time in ISO-8601 format.",
          inputSchema: z.object({}),
          execute: async () => ({
            now: new Date().toISOString(),
            tz: "UTC"
          })
        })
      }
    });

    return result.toUIMessageStreamResponse();
  }

  protected async onChatResponse(): Promise<void> {
    // Update the sidebar preview on the parent. Best-effort.
    const last = this.messages[this.messages.length - 1];
    if (!last) return;

    const preview = last.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .slice(0, 120);

    try {
      const inbox = await this.getInbox();
      await inbox.recordChatTurn(this.name, preview);
    } catch (err) {
      console.warn("[Chat] Failed to update inbox preview:", err);
    }
  }
}

// ── Entry worker ────────────────────────────────────────────────────
//
// `routeAgentRequest` already knows how to dispatch the nested
// `/agents/inbox/{user}/sub/chat/{chatId}` shape to an Inbox facet —
// it walks the URL, wakes the Inbox parent, runs `onBeforeSubAgent`,
// and forwards to the Chat facet. The worker handler is a one-liner.

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
