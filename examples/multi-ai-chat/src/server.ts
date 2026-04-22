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

import { Agent, callable, getAgentByName, routeAgentRequest } from "agents";
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
 * One Inbox DO per user. Maintains:
 *   - `chats`: a sidebar index (broadcast via `state`)
 *   - `memory`: a per-user shared context blob (readable by any
 *     child Chat via RPC)
 */
export class Inbox extends Agent<Env, InboxState> {
  initialState: InboxState = { chats: [] };

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS inbox_chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS inbox_memory (
      label TEXT PRIMARY KEY,
      content TEXT NOT NULL
    )`;
    this._refreshState();
  }

  private _refreshState() {
    const rows = this.sql<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      last_message_preview: string | null;
    }>`
      SELECT id, title, created_at, updated_at, last_message_preview
      FROM inbox_chats
      ORDER BY updated_at DESC
    `;
    const chats: ChatSummary[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessagePreview: r.last_message_preview ?? undefined
    }));
    this.setState({ ...this.state, chats });
  }

  // ── Strict-registry gate for child Chats ────────────────────────

  /**
   * Only allow clients to reach a `Chat` facet that the inbox has
   * explicitly spawned via `createChat`. Any other URL gets a 404
   * before the framework wakes the child. `hasSubAgent` is backed
   * by the sub-agent registry that `subAgent()` / `deleteSubAgent()`
   * maintain automatically.
   */
  override async onBeforeSubAgent(
    _req: Request,
    { className, name }: { className: string; name: string }
  ): Promise<Request | Response | void> {
    if (className !== "Chat") {
      return new Response("Unknown child class", { status: 404 });
    }
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
    this.sql`
      INSERT INTO inbox_chats (id, title, created_at, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, ${now}, NULL)
    `;
    // Eagerly spawn the facet so the sub-agent registry records it.
    // `onBeforeSubAgent` uses `hasSubAgent` as a strict gate, so a
    // chat only becomes reachable once `subAgent()` has been called
    // at least once. Idempotent — no-op on existing.
    await this.subAgent(Chat, id);
    this._refreshState();
    return { id, title, createdAt: now, updatedAt: now };
  }

  @callable()
  async renameChat(id: string, title: string): Promise<void> {
    this.sql`
      UPDATE inbox_chats
      SET title = ${title}, updated_at = ${Date.now()}
      WHERE id = ${id}
    `;
    this._refreshState();
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    this.sql`DELETE FROM inbox_chats WHERE id = ${id}`;
    // Wipe the facet's SQLite and remove it from the sub-agent
    // registry. Idempotent — safe to call even if already gone.
    this.deleteSubAgent(Chat, id);
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
      UPDATE inbox_chats
      SET updated_at = ${Date.now()}, last_message_preview = ${preview}
      WHERE id = ${chatId}
    `;
    this._refreshState();
  }
}

// ── Chat — a single conversation (facet of Inbox) ──────────────────

export class Chat extends AIChatAgent<Env> {
  /**
   * Resolve the parent Inbox stub via the path the framework
   * populated at facet-init time. No hardcoded user id, no direct
   * binding guesswork — `parentPath[0]` is the direct ancestor that
   * spawned this facet.
   */
  private async getInbox() {
    const [parent] = this.parentPath;
    if (!parent || parent.className !== "Inbox") {
      throw new Error("Chat must be a facet of Inbox");
    }
    return await getAgentByName(this.env.Inbox, parent.name);
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
