import { callable } from "agents";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createWorkersAI } from "workers-ai-provider";
import { defineScheduledTasks, Think, Workspace } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import type { FileInfo, WorkspaceChangeEvent } from "@cloudflare/shell";
import { nanoid } from "nanoid";
import { MyAssistant } from "./agents/my-assistant/agent";
import type { ChatSummary, DirectoryState, McpToolDescriptor } from "./types";

// ── AssistantDirectory — one DO per authenticated GitHub user ─────────
//
// Owns:
//   - the chat index (titles, timestamps, previews) in `chat_meta`
//   - access control for its child chats (strict-registry gate)
//   - cross-chat scheduled work (daily summary)
//
// **Existence is framework-owned.** The authoritative set of chats is
// `listSubAgents(MyAssistant)` — the registry `subAgent()` /
// `deleteSubAgent()` maintain in lockstep with the actual facets. We
// keep a separate `chat_meta` table for metadata (title, preview) keyed
// by chat id; a row there is pure decoration. If they drift, the
// registry wins.

export class AssistantDirectory extends Think<Env, DirectoryState> {
  initialState: DirectoryState = { chats: [] };

  // The directory is a Think root used as an accumulator: it owns the
  // chat index, shared workspace, MCP registry, and cross-chat
  // scheduled work, but its own chat machinery stays dormant (clients
  // talk to per-chat `MyAssistant` facets, not the directory). Declaring
  // it as `Think` lets the directory own a declarative scheduled task
  // (see `getScheduledTasks`) and leaves room for top-level agentic work
  // later. `getModel()` is a stub for that future use — nothing in the
  // accumulator role calls it.
  override getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.6",
      { sessionAffinity: this.sessionAffinity }
    );
  }

  /**
   * Shared workspace for every chat under this directory. Backed by the
   * directory's own SQLite so all of a user's files live in one place —
   * a `hello.txt` written in chat A shows up verbatim in chat B.
   *
   * Children (`MyAssistant` facets) see this workspace through the
   * `SharedWorkspace` proxy below, which forwards each call to
   * `readFile` / `writeFile` / etc. here. See `SharedWorkspace`.
   *
   * The `onChange` hook fires on every mutation (create/update/delete)
   * regardless of which chat's tool caused it. We rebroadcast to every
   * client connected to this directory — that's every browser tab the
   * user has open — so live UI like the file browser refreshes across
   * chats and tabs without polling. See `_broadcastWorkspaceChange`.
   *
   * Security note: this means any tool running inside any chat has
   * read-write access to every file this user owns. That's the point —
   * a multi-chat assistant should remember what it did in previous
   * chats — but extensions declared with `workspace: "read-write"`
   * inherit the same reach. If you fork this example for a
   * less-trusted extension surface, add gating here.
   */
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name,
    onChange: (event) => this._broadcastWorkspaceChange(event)
    // r2: this.env.R2 — uncomment to spill large files to R2.
  });

  /**
   * Fan-out: push workspace change events to every client connected to
   * this directory. Each chat pane's `useAgent` connection to the
   * directory (via `useChats()`) receives these; the client side
   * treats them as signals to refresh workspace-backed UI.
   *
   * Deliberately a best-effort `broadcast` (not `setState`), so file
   * churn doesn't trigger full `DirectoryState` re-broadcasts on every
   * write. Does NOT notify sibling child facets — no tool in this
   * example reacts server-side to another chat's writes. Add a
   * parent → child RPC here if that use case shows up.
   */
  private _broadcastWorkspaceChange(event: WorkspaceChangeEvent): void {
    this.broadcast(JSON.stringify({ type: "workspace-change", event }));
  }

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS chat_meta (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    this._refreshState();

    // Cross-chat scheduled work is declared in `getScheduledTasks()` below
    // and reconciled automatically by Think after this `onStart` runs — no
    // manual `schedule()` call needed. (Sub-agents and Think roots alike can
    // own declarative scheduled tasks; the directory owns this one because
    // the daily summary is a cross-chat concern.)

    // OAuth popup handler for MCP servers. The directory owns the MCP
    // state, so the OAuth redirect (`/chat/mcp-callback`) lands here
    // and the framework dispatches into `this.mcp` via
    // `handleMcpOAuthCallback` on the base `Agent` class.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  /**
   * Only allow the Worker to reach a `MyAssistant` facet that this
   * directory has explicitly spawned via `createChat`. `hasSubAgent`
   * is backed by the same registry `listSubAgents` reads from, so an
   * unknown chat id gets a 404 before any child is woken.
   */
  override async onBeforeSubAgent(
    _req: Request,
    { className, name }: { className: string; name: string }
  ): Promise<Request | Response | void> {
    if (!this.hasSubAgent(className, name)) {
      return new Response(`${className} "${name}" not found`, { status: 404 });
    }
    // Fall through — framework forwards the request to the facet.
  }

  // ── Sidebar state ──────────────────────────────────────────────────

  /**
   * Build the sidebar from two sources:
   *   1. `listSubAgents(MyAssistant)` — authoritative set of chats.
   *   2. `chat_meta` — app-owned title + preview decoration.
   *
   * A chat present in the registry without a meta row still renders
   * with a default title; a meta row without a registry entry is
   * silently ignored.
   */
  private _refreshState() {
    const registry = this.listSubAgents(MyAssistant);
    const metaRows = this.sql<{
      id: string;
      title: string;
      updated_at: number;
      last_message_preview: string | null;
    }>`SELECT id, title, updated_at, last_message_preview FROM chat_meta`;
    const metaById = new Map(metaRows.map((row) => [row.id, row]));

    const chats: ChatSummary[] = registry
      .map((entry) => {
        const meta = metaById.get(entry.name);
        return {
          id: entry.name,
          title: meta?.title ?? defaultChatTitle(entry.createdAt),
          createdAt: entry.createdAt,
          updatedAt: meta?.updated_at ?? entry.createdAt,
          lastMessagePreview: meta?.last_message_preview ?? undefined
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.setState({ ...this.state, chats });
  }

  // ── Chat lifecycle (RPC from the sidebar) ──────────────────────────

  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const title = opts?.title?.trim() || defaultChatTitle(now);

    // Spawn the facet FIRST so the registry is populated. If the
    // metadata INSERT fails for any reason, a subsequent `deleteChat`
    // or `_refreshState` will still find the chat via the registry.
    await this.subAgent(MyAssistant, id);
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, NULL)
    `;
    this._refreshState();
    return {
      id,
      title,
      createdAt: now,
      updatedAt: now
    };
  }

  @callable()
  async renameChat(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at)
      VALUES (${id}, ${trimmed}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at
    `;
    this._refreshState();
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    // Wipe the facet (idempotent — safe if already gone), then drop
    // its metadata. Order doesn't matter for correctness since the
    // registry is authoritative, but we do the facet first so a crash
    // between the two leaves no orphan meta rows visible.
    await this.deleteSubAgent(MyAssistant, id);
    this.sql`DELETE FROM chat_meta WHERE id = ${id}`;
    this._refreshState();
  }

  /**
   * Called by a child `MyAssistant` after every assistant turn — see
   * `MyAssistant.onChatResponse`. Keeps the sidebar preview and
   * "last active" ordering in sync with the real conversations.
   *
   * Deliberately NOT `@callable()` — this is a parent-side side effect
   * of committing a turn, not something a browser should be able to
   * trigger directly. Child→parent DO RPC doesn't need the decorator.
   * Marking it `@callable()` would let a client forge sidebar entries
   * for any chat id in their own directory.
   */
  async recordChatTurn(chatId: string, preview: string): Promise<void> {
    this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (
        ${chatId},
        ${defaultChatTitle(Date.now())},
        ${Date.now()},
        ${preview}
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_message_preview = excluded.last_message_preview
    `;
    this._refreshState();
  }

  // ── Scheduled work (declarative, directory-owned, fans out to one child) ──

  /**
   * Wall-clock timezone for declarative scheduled tasks. A real app would
   * derive this per user; the demo pins it to UTC.
   */
  override getDefaultTimezone(): string {
    return "UTC";
  }

  /**
   * Declarative scheduled work, reconciled by Think on startup. The
   * directory is a Think root, so it owns this cross-chat task directly.
   *
   * `dailySummary` is a deterministic handler (not a prompt task): it
   * picks the most-recently-updated chat and RPCs a proactive summary
   * prompt into that one child, so the user gets a single daily
   * notification attached to the conversation they last used. A real app
   * might fan out to every chat, or skip chats idle beyond a threshold.
   */
  override getScheduledTasks() {
    return defineScheduledTasks({
      dailySummary: {
        schedule: "every day at 09:00",
        handler: async () => {
          const [row] = this.sql<{ id: string }>`
            SELECT id FROM chat_meta ORDER BY updated_at DESC LIMIT 1
          `;
          if (!row) return;
          const target = await this.subAgent(MyAssistant, row.id);
          await target.postDailySummaryPrompt();
        }
      }
    });
  }

  // ── Shared workspace RPC surface (called by SharedWorkspace) ─────
  //
  // Children reach the directory via `parentAgent(AssistantDirectory)`,
  // which exposes these as typed DO RPC methods. `@callable()` is
  // deliberately NOT used — the client has no business writing to
  // another chat's files via the sidebar websocket; workspace I/O is
  // LLM-tool-only. DO-to-DO RPC doesn't need the decorator.
  //
  // The surface covers the full `WorkspaceFsLike` interface from
  // `@cloudflare/shell`, which is what `createWorkspaceStateBackend`
  // needs to drive codemode's `state.*` sandbox API. That means a
  // plan from one chat can edit files the same way as a single-chat
  // app — the shared workspace is the single source of truth.
  //
  // Each method is a one-line delegate. We use
  // `Parameters<Workspace["method"]>[n]` to stay automatically in
  // sync with `@cloudflare/shell` rather than re-stating the types.

  async readFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.workspace.readFileBytes(path);
  }

  async writeFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["writeFile"]>[2]
  ): Promise<void> {
    return this.workspace.writeFile(path, content, mimeType);
  }

  async writeFileBytes(
    path: string,
    content: Parameters<Workspace["writeFileBytes"]>[1],
    mimeType?: Parameters<Workspace["writeFileBytes"]>[2]
  ): Promise<void> {
    return this.workspace.writeFileBytes(path, content, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["appendFile"]>[2]
  ): Promise<void> {
    return this.workspace.appendFile(path, content, mimeType);
  }

  async exists(path: string): Promise<boolean> {
    return this.workspace.exists(path);
  }

  async readDir(
    path: string,
    opts?: Parameters<Workspace["readDir"]>[1]
  ): Promise<FileInfo[]> {
    return this.workspace.readDir(path, opts);
  }

  async rm(path: string, opts?: Parameters<Workspace["rm"]>[1]): Promise<void> {
    return this.workspace.rm(path, opts);
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    return this.workspace.glob(pattern);
  }

  async mkdir(
    path: string,
    opts?: Parameters<Workspace["mkdir"]>[1]
  ): Promise<void> {
    return this.workspace.mkdir(path, opts);
  }

  async stat(path: string): Promise<FileInfo | null> {
    return this.workspace.stat(path);
  }

  async lstat(path: string): Promise<FileInfo | null> {
    return this.workspace.lstat(path);
  }

  async cp(
    src: string,
    dest: string,
    opts?: Parameters<Workspace["cp"]>[2]
  ): Promise<void> {
    return this.workspace.cp(src, dest, opts);
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.workspace.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.workspace.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.workspace.readlink(path);
  }

  // ── Shared MCP surface ───────────────────────────────────────────
  //
  // The directory owns the MCP state for every chat under it:
  //   - server registry (+ OAuth client registrations) in
  //     `cf_agents_mcp_servers`
  //   - OAuth tokens via `DurableObjectOAuthClientProvider`
  //   - live connections + tool/prompt/resource caches in memory
  //
  // Browser-callable surface (`@callable()`): `addServer` /
  // `removeServer`. These go through the directory's WS connection
  // (the one `useChats()` already owns) rather than the per-chat WS,
  // so the UI talks to the same DO that holds the state.
  //
  // Child-callable surface (not `@callable()`): `listMcpToolDescriptors`
  // / `callMcpTool`. These are invoked via `parentAgent(AssistantDirectory)`
  // from `SharedMCPClient` on each chat turn.

  /**
   * Register a new MCP server for this user and kick off the initial
   * connection. If the server requires OAuth, returns the provider's
   * `authUrl` so the browser can open the popup.
   *
   * The callback URL is `/chat/mcp-callback` — resolved by the Worker
   * to this directory instance for the authenticated user. One URL
   * for every server for every chat.
   */
  @callable()
  async addServer(
    name: string,
    url: string
  ): ReturnType<AssistantDirectory["addMcpServer"]> {
    return await this.addMcpServer(name, url, {
      callbackPath: "chat/mcp-callback"
    });
  }

  @callable()
  async removeServer(id: string): Promise<void> {
    await this.removeMcpServer(id);
  }

  /**
   * Snapshot of currently-ready MCP tools across every server this
   * directory has connected. Children call this once per chat turn
   * (via `SharedMCPClient.getAITools()`) to assemble the LLM's tool
   * set.
   *
   * Waits up to `timeoutMs` for in-progress connections to become
   * ready before returning, so a chat launched right after the
   * directory wakes from hibernation still sees tools from servers
   * that are mid-handshake. `MCPClientManager.waitForConnections`
   * returns eagerly if everything is already ready.
   *
   * Deliberately NOT `@callable()` — child→parent DO RPC doesn't
   * need the decorator, and the browser reads MCP state via the
   * `CF_AGENT_MCP_SERVERS` broadcast (automatic, not this path).
   */
  async listMcpToolDescriptors(
    timeoutMs = 5_000
  ): Promise<McpToolDescriptor[]> {
    await this.mcp.waitForConnections({ timeout: timeoutMs });
    return this.mcp.listTools() as McpToolDescriptor[];
  }

  /**
   * Invoke an MCP tool. Returns the raw `CallToolResult` from the MCP
   * SDK; the child is responsible for unwrapping `isError` into a
   * thrown exception for the AI SDK's tool pipeline.
   *
   * Deliberately NOT `@callable()` — only intended to be reached via
   * `SharedMCPClient.execute(...)`. A `@callable()` here would let a
   * client invoke any MCP tool directly over the sidebar WS,
   * bypassing the agent's `beforeToolCall`/`afterToolCall` hooks.
   */
  async callMcpTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    return (await this.mcp.callTool({
      arguments: args,
      name,
      serverId
    })) as CallToolResult;
  }
}

function defaultChatTitle(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  return `New chat — ${month} ${day}`;
}
