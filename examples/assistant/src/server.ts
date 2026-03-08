/**
 * Assistant — Sub-agent architecture with shared workspace + MCP
 *
 * Architecture:
 *   - MyAssistant (parent): session registry, shared workspace, MCP connections
 *   - ChatSession (sub-agent): messages, session workspace, agentic loop
 *
 * Data flow:
 *   - Session list: broadcast to ALL clients via setState({ sessions })
 *   - Active session: per-connection via connection.setState()
 *   - Messages & streaming: per-connection via WebSocket messages
 *   - Tools: session ws local, shared ws + MCP proxied via ToolBridge
 *
 *   MyAssistant (parent)
 *     ├── Session registry (own SQLite, shared state)
 *     ├── Shared Workspace (own SQLite)
 *     ├── MCP client connections (eager)
 *     │
 *     ├── subAgent("session-abc")  →  ChatSession (isolated SQLite + workspace)
 *     ├── subAgent("session-def")  →  ChatSession (isolated SQLite + workspace)
 *     └── subAgent("session-ghi")  →  ChatSession (isolated SQLite + workspace)
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, getCurrentAgent, routeAgentRequest, callable } from "agents";
import type { Connection } from "agents";
import { withSubAgents } from "agents/experimental/subagent";
import type { MCPClientManager } from "agents/mcp/client";
import { Workspace } from "agents/experimental/workspace";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { ThinkSession } from "@cloudflare/think/think-session";
import type { StreamCallback } from "@cloudflare/think/think-session";
import { tool, jsonSchema } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

const SubAgentParent = withSubAgents(Agent);

// ─────────────────────────────────────────────────────────────────────────────
// Types (shared with client)
// ─────────────────────────────────────────────────────────────────────────────

export type SessionInfo = {
  id: string;
  name: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
};

export type AppState = {
  sessions: SessionInfo[];
};

export type ConnectionData = {
  activeSessionId: string | null;
};

export type ServerMessage =
  | { type: "messages"; sessionId: string; messages: UIMessage[] }
  | { type: "stream-start"; sessionId: string; requestId: string }
  | {
      type: "stream-event";
      requestId: string;
      event: string;
      replay?: boolean;
    }
  | { type: "stream-done"; requestId: string }
  | { type: "stream-resuming"; requestId: string };

export type ClientMessage =
  | { type: "cancel"; requestId: string }
  | { type: "resume-request" };

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

type McpToolDef = {
  key: string;
  name: string;
  serverId: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// ChatSession — ThinkSession sub-agent with workspace + shared tools via bridge
// ─────────────────────────────────────────────────────────────────────────────

export class ChatSession extends ThinkSession<Env> {
  workspace = new Workspace(this);

  // Per-call state, set before calling chat() via chatWithBridge()
  private _bridge: ToolBridge | null = null;
  private _mcpToolDefs: McpToolDef[] = [];

  override getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/zai-org/glm-4.7-flash"
    );
  }

  override getSystemPrompt(): string {
    return `You are a helpful coding assistant with access to workspace tools and optionally MCP tools.

You have two workspaces:
- Session workspace (private to this thread): read, write, edit, list, find, grep, delete
- Shared workspace (shared across all threads): shared_read, shared_write, shared_edit, shared_list, shared_find, shared_grep, shared_delete

Guidelines:
- Always read a file before editing it
- When editing, provide enough context in old_string to make the match unique
- Use find/shared_find to discover project structure
- Use grep/shared_grep to search for patterns across files`;
  }

  override getTools(): ToolSet {
    const sessionTools = createWorkspaceTools(this.workspace);
    if (!this._bridge) return sessionTools;
    const sharedTools = this._createSharedWorkspaceTools(this._bridge);
    const mcpTools = this._createMcpTools(this._bridge, this._mcpToolDefs);
    return { ...sessionTools, ...sharedTools, ...mcpTools };
  }

  override getMaxSteps(): number {
    return 10;
  }

  /**
   * Chat with a ToolBridge for shared workspace + MCP tools.
   * Stores the bridge for getTools(), then delegates to ThinkSession.chat().
   */
  async chatWithBridge(
    userMessage: string,
    toolBridge: ToolBridge,
    callback: StreamCallback,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    this._bridge = toolBridge;
    // Resolve MCP tools eagerly (async RPC) so getTools() can use them synchronously
    this._mcpToolDefs = await toolBridge.getMcpTools();
    try {
      await this.chat(userMessage, callback, { signal: options?.signal });
    } finally {
      this._bridge = null;
      this._mcpToolDefs = [];
    }
  }

  private _createMcpTools(bridge: ToolBridge, defs: McpToolDef[]): ToolSet {
    const tools: ToolSet = {};
    for (const def of defs) {
      tools[def.key] = {
        description: def.description ?? "",
        inputSchema: jsonSchema(def.inputSchema),
        execute: async (args: Record<string, unknown>) =>
          bridge.mcpExecute(def.name, def.serverId, args)
      };
    }
    return tools;
  }

  private _createSharedWorkspaceTools(bridge: ToolBridge): ToolSet {
    return {
      shared_read: tool({
        description:
          "Read a file from the shared workspace (accessible by all threads)",
        inputSchema: z.object({
          path: z.string().describe("File path")
        }),
        execute: async ({ path }) => {
          const content = await bridge.sharedRead(path);
          return content ?? "File not found";
        }
      }),
      shared_write: tool({
        description: "Write a file to the shared workspace",
        inputSchema: z.object({
          path: z.string().describe("File path"),
          content: z.string().describe("File content")
        }),
        execute: async ({ path, content }) => {
          await bridge.sharedWrite(path, content);
          return `Wrote ${content.length} chars to ${path}`;
        }
      }),
      shared_edit: tool({
        description:
          "Edit a file in the shared workspace by replacing a string match",
        inputSchema: z.object({
          path: z.string().describe("File path"),
          old_string: z.string().describe("Exact text to find"),
          new_string: z.string().describe("Replacement text")
        }),
        execute: async ({ path, old_string, new_string }) =>
          bridge.sharedEdit(path, old_string, new_string)
      }),
      shared_list: tool({
        description: "List files in a shared workspace directory",
        inputSchema: z.object({
          path: z.string().describe("Directory path").default("/")
        }),
        execute: async ({ path }) => bridge.sharedList(path)
      }),
      shared_find: tool({
        description: "Find files by glob pattern in the shared workspace",
        inputSchema: z.object({
          pattern: z.string().describe("Glob pattern")
        }),
        execute: async ({ pattern }) => bridge.sharedFind(pattern)
      }),
      shared_grep: tool({
        description: "Search for a regex pattern in shared workspace files",
        inputSchema: z.object({
          pattern: z.string().describe("Regex pattern"),
          glob: z.string().describe("File glob to search").optional()
        }),
        execute: async ({ pattern, glob }) => bridge.sharedGrep(pattern, glob)
      }),
      shared_delete: tool({
        description: "Delete a file or directory from the shared workspace",
        inputSchema: z.object({
          path: z.string().describe("Path to delete"),
          recursive: z.boolean().describe("Delete recursively").default(false)
        }),
        execute: async ({ path, recursive }) => {
          await bridge.sharedDelete(path, recursive);
          return `Deleted ${path}`;
        }
      })
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// StreamRelay — RpcTarget that relays chunks from sub-agent to WebSocket
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

  abort() {
    this.#aborted = true;
  }

  isAborted(): boolean {
    return this.#aborted;
  }

  updateConnection(connection: Connection) {
    this.#connection = connection;
  }

  getChunks(): string[] {
    return this.#chunks;
  }

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

  onDone() {
    // stream-done is sent by the parent after chatWithBridge completes
  }

  onError(_error: string) {
    if (this.#aborted) return;
    const msg: ServerMessage = {
      type: "stream-done" as const,
      requestId: this.#requestId
    };
    // Send the done signal — the error is already handled by ThinkSession's
    // onChatError hook. The client sees the stream end.
    this.#connection.send(JSON.stringify(msg));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolBridge — RpcTarget proxying shared workspace + MCP to sub-agents
// ─────────────────────────────────────────────────────────────────────────────

class ToolBridge extends RpcTarget {
  #workspace: Workspace;
  #mcpClient: MCPClientManager;

  constructor(workspace: Workspace, mcpClient: MCPClientManager) {
    super();
    this.#workspace = workspace;
    this.#mcpClient = mcpClient;
  }

  // ── Shared workspace operations ──

  async sharedRead(path: string): Promise<string | null> {
    return this.#workspace.readFile(path);
  }

  async sharedWrite(path: string, content: string): Promise<void> {
    const parent = path.replace(/\/[^/]+$/, "");
    if (parent && parent !== "/") {
      this.#workspace.mkdir(parent, { recursive: true });
    }
    await this.#workspace.writeFile(path, content);
  }

  async sharedEdit(
    path: string,
    oldStr: string,
    newStr: string
  ): Promise<Record<string, unknown>> {
    const content = await this.#workspace.readFile(path);
    if (content === null) return { error: `File not found: ${path}` };
    if (!content.includes(oldStr)) {
      return { error: `old_string not found in ${path}` };
    }
    const updated = content.replace(oldStr, newStr);
    await this.#workspace.writeFile(path, updated);
    return { path, replaced: true };
  }

  async sharedList(dir: string): Promise<unknown> {
    return this.#workspace.readDir(dir);
  }

  async sharedFind(pattern: string): Promise<unknown> {
    return this.#workspace.glob(pattern);
  }

  async sharedGrep(pattern: string, glob?: string): Promise<unknown> {
    const MAX_GREP_SIZE = 1_048_576;
    const files = glob
      ? await this.#workspace.glob(glob)
      : await this.#workspace.glob("**/*");
    const results: { path: string; matches: string[] }[] = [];
    const re = new RegExp(pattern, "gim");
    for (const file of files) {
      if (file.type !== "file" || file.size > MAX_GREP_SIZE) continue;
      const content = await this.#workspace.readFile(file.path);
      if (!content) continue;
      const matches = content.match(re);
      if (matches) results.push({ path: file.path, matches });
    }
    return results;
  }

  async sharedDelete(path: string, recursive: boolean): Promise<void> {
    await this.#workspace.rm(path, { recursive });
  }

  // ── MCP tools ──

  getMcpTools(): McpToolDef[] {
    const tools = this.#mcpClient.listTools();
    return tools.map((t) => ({
      key: `tool_${t.serverId.replace(/-/g, "")}_${t.name}`,
      name: t.name,
      serverId: t.serverId,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>
    }));
  }

  async mcpExecute(
    name: string,
    serverId: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const result = await this.#mcpClient.callTool({
      name,
      arguments: args,
      serverId
    });
    if (result.isError) {
      const content = result.content as
        | Array<{ type: string; text?: string }>
        | undefined;
      const text = content?.[0];
      throw new Error(
        text?.type === "text" && text.text ? text.text : "MCP tool call failed"
      );
    }
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MyAssistant — parent: session registry, shared workspace, MCP, routing
// ─────────────────────────────────────────────────────────────────────────────

export class MyAssistant extends SubAgentParent<Env, AppState> {
  initialState: AppState = { sessions: [] };
  sharedWorkspace = new Workspace(this);

  #activeStreams = new Map<
    string,
    {
      relay: StreamRelay;
      abort: AbortController;
      sessionId: string;
      connectionId: string;
    }
  >();

  async onStart() {
    this._initSessionTable();
    await this._broadcastSessions();

    // Configure OAuth popup behavior for MCP servers that require authentication
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

  // ─── MCP server management ──────────────────────────────────────────────

  @callable()
  async addServer(name: string, url: string, host: string) {
    return await this.addMcpServer(name, url, { callbackHost: host });
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    try {
      const msg = JSON.parse(message) as ClientMessage;
      switch (msg.type) {
        case "cancel": {
          const stream = this.#activeStreams.get(msg.requestId);
          if (stream) {
            stream.relay.abort();
            stream.abort.abort();
            this.#activeStreams.delete(msg.requestId);
          }
          break;
        }
        case "resume-request": {
          const activeId = this._getActiveSessionId(connection);
          if (!activeId) break;
          for (const [requestId, stream] of this.#activeStreams) {
            if (stream.sessionId !== activeId) continue;
            stream.relay.updateConnection(connection);
            stream.connectionId = connection.id;
            const resumeMsg: ServerMessage = {
              type: "stream-resuming",
              requestId
            };
            connection.send(JSON.stringify(resumeMsg));
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
      /* not a ClientMessage */
    }
  }

  private _initSessionTable() {
    this.sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async _broadcastSessions() {
    const rows = this.sql<{
      id: string;
      name: string;
      created_at: string;
      last_active_at: string;
    }>`
      SELECT id, name, created_at, last_active_at
      FROM sessions ORDER BY last_active_at DESC
    `;

    const sessions: SessionInfo[] = await Promise.all(
      rows.map(async (r) => {
        const session = await this.subAgent(ChatSession, `session-${r.id}`);
        return {
          id: r.id,
          name: r.name,
          messageCount: await session.getMessageCount(),
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at
        };
      })
    );
    this.setState({ sessions });
  }

  private async _sendSessionMessages(
    connection: Connection,
    sessionId: string
  ) {
    const session = await this.subAgent(ChatSession, `session-${sessionId}`);
    const messages = await session.getHistory();
    const msg: ServerMessage = { type: "messages", sessionId, messages };
    connection.send(JSON.stringify(msg));
  }

  private _getConnection(): Connection {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("No connection in context");
    return connection;
  }

  private _getActiveSessionId(connection: Connection): string | null {
    const data = connection.state as ConnectionData | null;
    return data?.activeSessionId ?? null;
  }

  // ─── Session CRUD ─────────────────────────────────────────────────────

  @callable()
  async createSession(name: string): Promise<string> {
    const id = crypto.randomUUID().slice(0, 8);
    this.sql`INSERT INTO sessions (id, name) VALUES (${id}, ${name})`;
    const connection = this._getConnection();
    connection.setState({
      activeSessionId: id
    } satisfies ConnectionData);
    await this._sendSessionMessages(connection, id);
    await this._broadcastSessions();
    return id;
  }

  @callable()
  async deleteSession(sessionId: string) {
    this.sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    this.deleteSubAgent(`session-${sessionId}`);
    const connection = this._getConnection();
    if (this._getActiveSessionId(connection) === sessionId) {
      connection.setState({
        activeSessionId: null
      } satisfies ConnectionData);
    }
    await this._broadcastSessions();
  }

  @callable()
  async switchSession(sessionId: string) {
    const connection = this._getConnection();
    connection.setState({
      activeSessionId: sessionId
    } satisfies ConnectionData);
    await this._sendSessionMessages(connection, sessionId);
  }

  @callable()
  async clearSession(sessionId: string) {
    const session = await this.subAgent(ChatSession, `session-${sessionId}`);
    await session.clearMessages();
    for (const conn of this.getConnections()) {
      if (this._getActiveSessionId(conn) === sessionId) {
        await this._sendSessionMessages(conn, sessionId);
      }
    }
    await this._broadcastSessions();
  }

  @callable()
  async renameSession(sessionId: string, name: string) {
    this.sql`
      UPDATE sessions SET name = ${name} WHERE id = ${sessionId}
    `;
    await this._broadcastSessions();
  }

  // ─── Send message ─────────────────────────────────────────────────────

  @callable()
  async sendMessage(text: string, requestId: string) {
    const connection = this._getConnection();
    const activeId = this._getActiveSessionId(connection);
    if (!activeId) throw new Error("No active session");

    const session = await this.subAgent(ChatSession, `session-${activeId}`);

    // Signal stream start
    const startMsg: ServerMessage = {
      type: "stream-start",
      sessionId: activeId,
      requestId
    };
    connection.send(JSON.stringify(startMsg));

    // Wait for MCP connections before assembling tools
    await this.mcp.waitForConnections({ timeout: 5000 });

    // Stream via RpcTarget callbacks
    const relay = new StreamRelay(connection, requestId);
    const toolBridge = new ToolBridge(this.sharedWorkspace, this.mcp);
    const abortController = new AbortController();

    this.#activeStreams.set(requestId, {
      relay,
      abort: abortController,
      sessionId: activeId,
      connectionId: connection.id
    });

    try {
      await session.chatWithBridge(text, toolBridge, relay, {
        signal: abortController.signal
      });
    } finally {
      this.#activeStreams.delete(requestId);
    }

    // Signal stream completion
    if (!relay.isAborted()) {
      const doneMsg: ServerMessage = { type: "stream-done", requestId };
      connection.send(JSON.stringify(doneMsg));
    }

    this
      .sql`UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ${activeId}`;
    await this._broadcastSessions();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
