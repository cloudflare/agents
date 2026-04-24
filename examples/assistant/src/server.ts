/**
 * Assistant — a Think-based multi-session chat app.
 *
 * Architecture:
 *
 *     AssistantDirectory ("alice")                  ◄── one DO per GitHub login
 *       ├─ MyAssistant[chat-abc]  [facet]           ◄── one Think DO per chat
 *       ├─ MyAssistant[chat-def]  [facet]
 *       └─ MyAssistant[chat-ghi]  [facet]
 *
 * - `AssistantDirectory` is a top-level `Agent`. It owns the chat list,
 *   the sidebar state, and any per-user cross-chat concerns (e.g. the
 *   daily summary schedule that facets can't own themselves). It gates
 *   child access with `onBeforeSubAgent` as a strict-registry check.
 * - `MyAssistant` is a `Think` subclass that lives as a **facet** of
 *   `AssistantDirectory` (`this.subAgent(MyAssistant, chatId)`). Each
 *   chat is its own Durable Object with its own SQLite storage,
 *   workspace, extensions, MCP servers, and message history, all
 *   colocated with the parent on the same machine.
 * - The Worker authenticates the GitHub session, then forwards every
 *   `/chat*` request into the authenticated user's directory via
 *   `getAgentByName(env.AssistantDirectory, user.login).fetch(request)`.
 *   The built-in sub-agent router inside `Agent.fetch()` picks up the
 *   `/sub/my-assistant/:chatId` tail, so we don't need any custom
 *   per-chat plumbing in the Worker.
 *
 * Cross-chat shared workspace:
 *
 *     AssistantDirectory owns a single `Workspace` backed by its own
 *     SQLite. Every chat's `this.workspace` is a `SharedWorkspace`
 *     proxy that forwards `readFile` / `writeFile` / `readDir` / etc.
 *     to the parent's real workspace over a DO RPC hop. A file
 *     written in chat A is visible verbatim in chat B — the assistant
 *     has one continuous filesystem across every chat with a given
 *     user, not a fresh scratch space per conversation.
 *
 *     The proxy implements the `WorkspaceFsLike` interface from
 *     `@cloudflare/shell`, which is strictly wider than the
 *     `WorkspaceLike` Think's builtin tooling needs. That means the
 *     same proxy also backs codemode's `state.*` sandbox API via
 *     `createWorkspaceStateBackend` — so `state.planEdits` in chat B
 *     sees and mutates the same files chat A just wrote. No casts.
 *
 *     The directory's `Workspace` is constructed with
 *     `onChange: (ev) => this.broadcast(...)`, so every file mutation
 *     is fanned out to every client connected to the directory —
 *     meaning all of the user's open tabs, regardless of which chat
 *     is active. The client's `useChats()` hook turns each broadcast
 *     into a `workspaceRevision` bump, which the chat pane's file
 *     browser uses as a `useEffect` dep to stay live without polling.
 *
 * Cross-chat shared MCP:
 *
 *     MCP server registry, OAuth credentials, live connections, and
 *     tool descriptors all live on `AssistantDirectory`. Each
 *     `MyAssistant` child carries a `SharedMCPClient` proxy that
 *     builds each turn's MCP tool set by RPC'ing the parent for
 *     current tools, then routes each `execute` back through the
 *     parent. Net effect: auth to a server once, and every chat the
 *     user ever opens sees the tools. The OAuth redirect URL is
 *     `chat/mcp-callback` — one URL for every chat, resolved on the
 *     directory's authenticated Worker path. The child's own default
 *     `this.mcp` stays in place but empty; it's never registered on
 *     and never connects out.
 *
 * Features demonstrated inside each `MyAssistant`:
 *   - Workspace tools (read, write, edit, find, grep, delete) — backed by the shared directory workspace, not per-chat
 *   - Sandboxed code execution via @cloudflare/codemode
 *   - Self-authored extensions via ExtensionManager (per-chat — lives in the child DO's own storage)
 *   - Persistent memory via context blocks (per-chat)
 *   - Non-destructive compaction for long conversations
 *   - Full-text search across conversation history (FTS5)
 *   - Dynamic typed configuration (model tier, persona) — per-chat
 *   - MCP server integration — shared across all chats via SharedMCPClient
 *   - Client-side tools and tool approval
 *   - Lifecycle hooks (beforeToolCall logging, afterToolCall analytics)
 *   - Durable chat recovery (chatRecovery)
 *   - Regeneration with branch navigation
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, callable, getAgentByName } from "agents";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Think, Session, Workspace } from "@cloudflare/think";
import {
  createWorkspaceStateBackend,
  type FileInfo,
  type WorkspaceChangeEvent,
  type WorkspaceFsLike
} from "@cloudflare/shell";
import {
  createUnauthorizedResponse,
  getGitHubUserFromRequest,
  handleGitHubCallback,
  handleGitHubLogin,
  handleLogout
} from "./auth";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { AgentSearchProvider } from "agents/experimental/memory/session";
import type {
  TurnContext,
  TurnConfig,
  ChatResponseResult,
  ToolCallContext,
  ToolCallResultContext,
  StepContext
} from "@cloudflare/think";
import { tool, generateText } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";

// ── Shared types (sidebar state, RPC contracts) ───────────────────────

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface DirectoryState {
  chats: ChatSummary[];
}

/**
 * Tool descriptor the directory returns to children over RPC. Mirrors
 * what `MCPClientManager.listTools()` returns — an MCP SDK `Tool` plus
 * the `serverId` annotation so the child can build a `callMcpTool`
 * closure — and stays structured-cloneable for the DO RPC boundary.
 */
export type McpToolDescriptor = Tool & { serverId: string };

type AgentConfig = {
  modelTier: "fast" | "capable";
  persona: string;
};

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

export class AssistantDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = { chats: [] };

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

    // The directory owns cross-chat scheduled work. Facets can't
    // schedule (see `packages/agents/src/index.ts` — schedule() throws
    // on _isFacet), so any recurring turn lives here and RPCs into the
    // most-recently-active child on fire.
    this.schedule("0 9 * * *", "dailySummary", {}, { idempotent: true });

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
    this.deleteSubAgent(MyAssistant, id);
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

  // ── Scheduled work (parent-owned, fans out to one child) ───────────

  /**
   * Fires daily at 09:00 UTC (from `onStart()`'s cron schedule).
   *
   * Design note: we post the summary into the most-recently-updated
   * chat rather than fanning out to every chat. For a demo this keeps
   * the behavior legible — one notification per day, attached to the
   * conversation the user was last using. A real app might fan out, or
   * skip chats idle beyond some threshold.
   */
  async dailySummary() {
    const [row] = this.sql<{ id: string }>`
      SELECT id FROM chat_meta ORDER BY updated_at DESC LIMIT 1
    `;
    if (!row) return;

    const target = await this.subAgent(MyAssistant, row.id);
    await target.postDailySummaryPrompt();
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

// ── SharedWorkspace — proxy used by children ─────────────────────────
//
// Satisfies `WorkspaceFsLike` (the interface shipped by
// `@cloudflare/shell`) by forwarding every call to the parent
// `AssistantDirectory`'s real `Workspace`. Because `WorkspaceFsLike`
// is a strict superset of `WorkspaceLike`, this also satisfies
// everything Think's builtin tools need — but covering the wider
// surface is what lets us pass the same object to
// `createWorkspaceStateBackend` below, so codemode's `state.*` sandbox
// API operates on the shared workspace too.
//
// Per-call it's one extra RPC hop; parent and child are DO facets
// colocated on the same machine, so the hop is in-process and cheap.
//
// The parent stub is resolved lazily on first use and cached. Stubs
// from `parentAgent()` are thin proxies — they don't hold connections,
// so caching the resolved stub across the child's lifetime is safe
// even if the parent hibernates and comes back between calls.

class SharedWorkspace implements WorkspaceFsLike {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(private child: Pick<MyAssistant, "parentAgent">) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.child.parentAgent(AssistantDirectory);
    return this.#stubPromise;
  }

  async readFile(path: string) {
    return (await this.parent()).readFile(path);
  }

  async readFileBytes(path: string) {
    return (await this.parent()).readFileBytes(path);
  }

  async writeFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["writeFile"]>[2]
  ) {
    return (await this.parent()).writeFile(path, content, mimeType);
  }

  async writeFileBytes(
    path: string,
    content: Parameters<Workspace["writeFileBytes"]>[1],
    mimeType?: Parameters<Workspace["writeFileBytes"]>[2]
  ) {
    return (await this.parent()).writeFileBytes(path, content, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["appendFile"]>[2]
  ) {
    return (await this.parent()).appendFile(path, content, mimeType);
  }

  async exists(path: string) {
    return (await this.parent()).exists(path);
  }

  async readDir(path?: string, opts?: Parameters<Workspace["readDir"]>[1]) {
    return (await this.parent()).readDir(path ?? "/", opts);
  }

  async rm(path: string, opts?: Parameters<Workspace["rm"]>[1]) {
    return (await this.parent()).rm(path, opts);
  }

  async glob(pattern: string) {
    return (await this.parent()).glob(pattern);
  }

  async mkdir(path: string, opts?: Parameters<Workspace["mkdir"]>[1]) {
    return (await this.parent()).mkdir(path, opts);
  }

  async stat(path: string) {
    return (await this.parent()).stat(path);
  }

  async lstat(path: string) {
    return (await this.parent()).lstat(path);
  }

  async cp(src: string, dest: string, opts?: Parameters<Workspace["cp"]>[2]) {
    return (await this.parent()).cp(src, dest, opts);
  }

  async mv(src: string, dest: string) {
    return (await this.parent()).mv(src, dest);
  }

  async symlink(target: string, linkPath: string) {
    return (await this.parent()).symlink(target, linkPath);
  }

  async readlink(path: string) {
    return (await this.parent()).readlink(path);
  }
}

// ── SharedMCPClient — child-side proxy for the directory's MCP ──────
//
// MCP state (server registry, OAuth tokens, live connections, tool
// caches) lives entirely on `AssistantDirectory`. This class lets a
// child expose those shared tools to its LLM as if they were local,
// while every actual invocation round-trips through one parent-DO
// RPC hop.
//
// Shape:
//   - `getAITools(timeoutMs?)` — snapshot the parent's current tools
//     and return them as an AI SDK `ToolSet`. Called once per turn
//     from `MyAssistant.beforeTurn`; the resulting tools are merged
//     into the turn via `TurnConfig.tools`.
//   - Each returned tool's `execute` RPCs `parent.callMcpTool(...)`
//     and translates the MCP-level `isError` result into a thrown
//     exception for Think's `afterToolCall` pipeline. Mirrors what
//     `MCPClientManager.getAITools()` does internally for a local
//     MCP client — same tool-key format, same error semantics — so
//     the LLM sees an identical surface whether MCP is local or
//     proxied.
//
// The parent stub is resolved lazily on first call and cached, same
// pattern as `SharedWorkspace` above.

class SharedMCPClient {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(private child: Pick<MyAssistant, "parentAgent">) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.child.parentAgent(AssistantDirectory);
    return this.#stubPromise;
  }

  /**
   * Assemble a snapshot `ToolSet` of the currently-ready MCP tools.
   * The returned tools are safe to splice into Think's turn toolset
   * via `TurnConfig.tools`.
   */
  async getAITools(timeoutMs = 5_000): Promise<ToolSet> {
    const parent = await this.parent();
    const descriptors = (await parent.listMcpToolDescriptors(
      timeoutMs
    )) as McpToolDescriptor[];

    const entries: [string, ToolSet[string]][] = [];
    for (const descriptor of descriptors) {
      try {
        // Same key format MCPClientManager uses internally, so the
        // LLM's tool vocabulary matches the local-MCP case.
        const toolKey = `tool_${descriptor.serverId.replace(/-/g, "")}_${descriptor.name}`;
        const { serverId, name, inputSchema, outputSchema } = descriptor;
        const title =
          descriptor.title ??
          (descriptor.annotations as { title?: string } | undefined)?.title;

        entries.push([
          toolKey,
          {
            description: descriptor.description,
            title,
            inputSchema: inputSchema
              ? z.fromJSONSchema(
                  inputSchema as Parameters<typeof z.fromJSONSchema>[0]
                )
              : z.fromJSONSchema({ type: "object" }),
            outputSchema: outputSchema
              ? z.fromJSONSchema(
                  outputSchema as Parameters<typeof z.fromJSONSchema>[0]
                )
              : undefined,
            execute: async (args) => {
              const stub = await this.parent();
              const result = (await stub.callMcpTool(
                serverId,
                name,
                args as Record<string, unknown>
              )) as CallToolResult;
              if (result.isError) {
                const content = result.content as
                  | Array<{ type: string; text?: string }>
                  | undefined;
                const firstText = content?.[0];
                const message =
                  firstText?.type === "text" && firstText.text
                    ? firstText.text
                    : "Tool call failed";
                throw new Error(message);
              }
              return result;
            }
          }
        ]);
      } catch (err) {
        console.warn(
          `[SharedMCPClient] Skipping tool "${descriptor.name}" from "${descriptor.serverId}": ${err}`
        );
      }
    }

    return Object.fromEntries(entries);
  }
}

// ── MyAssistant — one Think DO per chat (a facet of the directory) ────

export class MyAssistant extends Think<Env> {
  static options = {
    sendIdentityOnConnect: true
  };
  override maxSteps = 10;
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  /**
   * Override Think's default per-chat workspace with a proxy into the
   * shared `AssistantDirectory.workspace`. This class field runs in the
   * subclass's synthetic constructor after `super(ctx, env)`, so by the
   * time Think's wrapped `onStart` fires its `!this.workspace` default-
   * init check, the shared proxy is already in place — Think never
   * creates a per-chat `Workspace` at all.
   *
   * Declared as `WorkspaceFsLike` (the wider interface from
   * `@cloudflare/shell`) rather than Think's `WorkspaceLike` so that
   * `createWorkspaceStateBackend(this.workspace)` in `getTools()` sees
   * the full filesystem surface it needs. `WorkspaceFsLike` is a strict
   * superset of `WorkspaceLike`, so Think's internals keep working.
   *
   * All workspace-aware code — the builtin tools from
   * `createWorkspaceTools`, lifecycle hooks, the `listWorkspaceFiles`
   * / `readWorkspaceFile` RPCs below, and codemode's `state.*` sandbox
   * API via `createWorkspaceStateBackend` — routes through this proxy
   * transparently.
   */
  override workspace: WorkspaceFsLike = new SharedWorkspace(this);

  /**
   * Proxy to the directory's MCP state. Used by `beforeTurn` below to
   * splice the user's shared MCP tools into each turn's tool set.
   *
   * The child's own `this.mcp` (Think's default) stays around but is
   * never registered against — it exists solely so Agent framework
   * paths that reach for `this.mcp.*` (hibernation restore, OAuth
   * callback routing, broadcast plumbing) don't need to care about
   * the parallel-field arrangement. Those paths all resolve to an
   * empty, idle MCP client.
   *
   * OAuth callbacks (`/chat/mcp-callback`) are routed to the parent
   * directory by the Worker, never to a child, so child-side
   * `isCallbackRequest` in the framework reliably returns false here.
   */
  sharedMcp = new SharedMCPClient(this);

  getModel(): LanguageModel {
    const tier = this.getConfig<AgentConfig>()?.modelTier ?? "fast";
    const models: Record<string, string> = {
      fast: "@cf/moonshotai/kimi-k2.6",
      capable: "@cf/moonshotai/kimi-k2.6"
    };
    return createWorkersAI({ binding: this.env.AI })(
      models[tier] ?? models.fast,
      { sessionAffinity: this.sessionAffinity }
    );
  }

  configureSession(session: Session) {
    const persona =
      this.getConfig<AgentConfig>()?.persona ||
      "You are a capable technical assistant. You have access to a persistent workspace, sandboxed code execution, and the ability to create new tools on the fly. You think before you act, and you prefer writing code over making many sequential tool calls.";

    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            `${persona}

Be concise. Prefer short, direct answers over lengthy explanations.
The execute tool runs JavaScript you write in a sandboxed environment. Use it for multi-file operations, data transformations, or any task that would require many sequential tool calls.
You can create extensions: new tools that persist across conversations. Offer to create one when a recurring task would benefit from it.
When you learn something about the user or their project, save it to memory.`
        }
      })
      .withContext("memory", {
        description:
          "Key facts about the user, their preferences, project context, and decisions made during conversation. Update when you learn something that would be useful in future turns.",
        maxTokens: 2000
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.getModel(), prompt }).then((r) => r.text)
        })
      )
      .compactAfter(50000)
      .withContext("knowledge", {
        description:
          "Searchable knowledge base. Index useful information with set_context and retrieve it later with search_context.",
        provider: new AgentSearchProvider(this)
      })
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    const extensionTools = this.extensionManager
      ? {
          ...createExtensionTools({ manager: this.extensionManager }),
          ...this.extensionManager.getTools()
        }
      : {};

    return {
      execute: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        // `state.*` inside the sandbox is backed by the SHARED workspace
        // too — `createWorkspaceStateBackend` accepts our `SharedWorkspace`
        // proxy because it satisfies the `WorkspaceFsLike` interface from
        // `@cloudflare/shell`. That means `state.planEdits`/`applyEdits`
        // in chat B sees and mutates the same files chat A just wrote.
        state: createWorkspaceStateBackend(this.workspace),
        loader: this.env.LOADER
      }),

      ...extensionTools,

      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name")
        }),
        execute: async ({ city }) => {
          const conditions = ["sunny", "cloudy", "rainy", "snowy"];
          const temp = Math.floor(Math.random() * 30) + 5;
          return {
            city,
            temperature: temp,
            condition:
              conditions[Math.floor(Math.random() * conditions.length)],
            unit: "celsius"
          };
        }
      }),

      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
        inputSchema: z.object({})
      }),

      calculate: tool({
        description:
          "Perform a math calculation. Requires approval for large numbers (over 1000).",
        inputSchema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number"),
          operator: z.enum(["+", "-", "*", "/"]).describe("Arithmetic operator")
        }),
        needsApproval: async ({ a, b }) =>
          Math.abs(a) > 1000 || Math.abs(b) > 1000,
        execute: async ({ a, b, operator }) => {
          const ops: Record<string, (x: number, y: number) => number> = {
            "+": (x, y) => x + y,
            "-": (x, y) => x - y,
            "*": (x, y) => x * y,
            "/": (x, y) => x / y
          };
          if (operator === "/" && b === 0) {
            return { error: "Division by zero" };
          }
          return {
            expression: `${a} ${operator} ${b}`,
            result: ops[operator](a, b)
          };
        }
      })
    };
  }

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    // Splice the directory's shared MCP tools into this turn. Think
    // merges `config.tools` additively on top of the base tool set, so
    // whatever tools we return here join `workspace` / `extensions` /
    // `execute` / builtins on every turn. The proxy waits for any
    // in-progress MCP connections to settle (5s default) before
    // returning, so a chat that just woke up still sees tools from
    // servers that are mid-handshake.
    const mcpTools = await this.sharedMcp.getAITools();

    console.log(
      `Turn starting: ${Object.keys(ctx.tools).length} base tools + ${Object.keys(mcpTools).length} MCP tools, continuation=${ctx.continuation}`
    );

    return { tools: mcpTools };
  }

  beforeToolCall(ctx: ToolCallContext): void {
    console.log(`Tool call: ${ctx.toolName}`, JSON.stringify(ctx.input));
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    if (ctx.success) {
      const resultSize = JSON.stringify(ctx.output).length;
      console.log(
        `Tool result: ${ctx.toolName} (${resultSize} bytes, ${ctx.durationMs}ms)`
      );
    } else {
      console.error(
        `Tool failed: ${ctx.toolName} (${ctx.durationMs}ms)`,
        ctx.error
      );
    }
  }

  onStepFinish(ctx: StepContext): void {
    if (ctx.usage) {
      console.log(
        `Step finished (${ctx.finishReason}): ${ctx.usage.inputTokens}in/${ctx.usage.outputTokens}out`
      );
    }
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    console.log(`Turn ${result.status}: ${result.message.parts.length} parts`);

    // Update the sidebar preview on the parent directory. Best-effort —
    // the chat should still function if the RPC fails.
    const preview = result.message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .slice(0, 120);
    if (!preview) return;

    try {
      const directory = await this.parentAgent(AssistantDirectory);
      await directory.recordChatTurn(this.name, preview);
    } catch (err) {
      console.warn("[MyAssistant] Failed to update directory preview:", err);
    }
  }

  // No `onStart` override: MCP is shared from the parent directory
  // (see `AssistantDirectory.onStart`), schedules live on the parent,
  // and everything per-chat (workspace, extensions, session config)
  // is wired up by Think's own base `onStart` via class fields.

  /**
   * Called by `AssistantDirectory.dailySummary()` on the daily cron.
   * Queues a proactive user message so the model produces a summary on
   * the next connection/turn. Runs as an RPC from the parent — no
   * model call happens here.
   *
   * Deliberately NOT `@callable()` — parent→child DO RPC doesn't need
   * the decorator, and exposing this to browsers would let a client
   * inject a "summarize recent work" prompt on demand.
   */
  async postDailySummaryPrompt() {
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: "Generate a brief summary of what we worked on recently. Check the workspace for any files and summarize the current state of things."
          }
        ]
      }
    ]);
  }

  // `addServer` / `removeServer` used to live here as `@callable`
  // wrappers around `this.addMcpServer` / `this.removeMcpServer`. They
  // moved to `AssistantDirectory` so every chat shares one MCP server
  // list. The client now calls the directory directly via `useChats()`;
  // see `src/use-chats.ts`.

  @callable()
  async getResponseVersions(userMessageId: string) {
    return this.session.getBranches(userMessageId);
  }

  @callable()
  updateConfig(config: AgentConfig) {
    this.configure<AgentConfig>(config);
  }

  @callable()
  currentConfig() {
    return this.getConfig<AgentConfig>();
  }

  @callable()
  async listWorkspaceFiles(path: string = "/") {
    try {
      return await this.workspace.readDir(path);
    } catch {
      return [];
    }
  }

  @callable()
  async readWorkspaceFile(path: string) {
    try {
      return await this.workspace.readFile(path);
    } catch {
      return null;
    }
  }

  @callable()
  async listExtensions() {
    if (!this.extensionManager) return [];
    return this.extensionManager.list();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function defaultChatTitle(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  return `New chat — ${month} ${day}`;
}

function createJsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

// ── Worker ────────────────────────────────────────────────────────────
//
// The Worker owns exactly two things:
//   1. the GitHub OAuth flow
//   2. the auth gate in front of `/chat*`, forwarding to the user's
//      AssistantDirectory. The directory's built-in sub-agent router
//      picks up the `/sub/my-assistant/:chatId` tail on its own — no
//      per-chat routing code lives here.

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/auth/login") {
        return handleGitHubLogin(request, env);
      }

      if (url.pathname === "/auth/callback") {
        return await handleGitHubCallback(request, env);
      }

      if (url.pathname === "/auth/logout") {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        return handleLogout(request);
      }

      if (url.pathname === "/auth/me") {
        const user = await getGitHubUserFromRequest(request);
        if (!user) {
          return createUnauthorizedResponse(request);
        }
        return createJsonResponse(user);
      }

      // User-scoped chat routing. The Worker, not the browser, decides
      // which AssistantDirectory DO owns this user's chats. Everything
      // below `/chat` (including sub-agent routing to a specific
      // `MyAssistant` facet) is handled by the directory's built-in
      // `Agent.fetch()` + sub-routing logic.
      if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
        const user = await getGitHubUserFromRequest(request);
        if (!user) {
          return createUnauthorizedResponse(request);
        }

        const directory = await getAgentByName(
          env.AssistantDirectory,
          user.login
        );
        return directory.fetch(request);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected auth error";
      return createJsonResponse({ error: message }, { status: 500 });
    }

    // Any other path is intentionally unhandled. We do NOT fall back
    // to `routeAgentRequest` — that would let a client reach
    // `/agents/assistant-directory/<login>` or
    // `/agents/my-assistant/<chatId>` without going through the
    // GitHub-authenticated `/chat*` gate.
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
