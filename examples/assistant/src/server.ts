/**
 * Assistant — Orchestrator + dynamic sub-agent architecture
 *
 * Architecture:
 *   - MyAssistant (parent/orchestrator): own chat, agent registry, shared workspace, MCP
 *   - ChatSession (sub-agent): dynamically configured with model, prompt, tools
 *
 * The orchestrator is itself conversational — you chat with it directly.
 * It can spawn specialized sub-agents, delegate tasks to them, or hand off
 * so you enter a sub-agent's chat directly.
 *
 *   MyAssistant (orchestrator)
 *     ├── Own chat (via "orchestrator" ChatSession)
 *     ├── Shared Workspace (own SQLite)
 *     ├── MCP client connections
 *     ├── Agent registry (SQLite table)
 *     │
 *     ├── subAgent("agent-abc")  →  ChatSession (researcher, fast model)
 *     ├── subAgent("agent-def")  →  ChatSession (coder, capable model)
 *     └── subAgent("agent-ghi")  →  ChatSession (custom config)
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, getCurrentAgent, routeAgentRequest, callable } from "agents";
import type { Connection } from "agents";
import type { MCPClientManager } from "agents/mcp/client";
import { Workspace } from "agents/experimental/workspace";
import type { FileInfo } from "agents/experimental/workspace";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { Think } from "@cloudflare/think";
import type { StreamCallback } from "@cloudflare/think";
import { tool, jsonSchema } from "ai";
import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Types (shared with client)
// ─────────────────────────────────────────────────────────────────────────────

export type ModelTier = "fast" | "capable";

export type AgentConfig = {
  name: string;
  systemPrompt: string;
  modelTier: ModelTier;
  toolAccess: "workspace" | "workspace+shared" | "workspace+shared+mcp";
};

export type AgentInfo = {
  id: string;
  name: string;
  config: AgentConfig;
  messageCount: number;
  status: "idle" | "working" | "done" | "error";
  lastTaskDescription: string | null;
  createdAt: string;
  lastActiveAt: string;
};

export type { FileInfo };

export type AppState = {
  agents: AgentInfo[];
};

export type ConnectionData = {
  activeAgentId: string | null;
};

export type ServerMessage =
  | { type: "messages"; agentId: string; messages: UIMessage[] }
  | {
      type: "stream-start";
      agentId: string;
      requestId: string;
      delegation?: boolean;
    }
  | {
      type: "stream-event";
      requestId: string;
      event: string;
      replay?: boolean;
    }
  | { type: "stream-done"; requestId: string }
  | { type: "stream-resuming"; requestId: string }
  | { type: "navigate"; agentId: string };

export type ClientMessage =
  | { type: "cancel"; requestId: string }
  | { type: "resume-request" };

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ORCHESTRATOR_ID = "orchestrator";

const MODEL_IDS: Record<ModelTier, string> = {
  fast: "@cf/zai-org/glm-4.7-flash",
  capable: "@cf/zai-org/glm-4.7-flash"
};

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

type OrchestratorToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type AgentRow = {
  id: string;
  name: string;
  config_json: string;
  status: string;
  last_task: string | null;
  message_count: number;
  created_at: string;
  last_active_at: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// ChatSession — Think sub-agent with dynamic config
// ─────────────────────────────────────────────────────────────────────────────

export class ChatSession extends Think<Env, AgentConfig> {
  workspace = new Workspace(this);

  override getModel(): LanguageModel {
    const config = this.getConfig();
    const tier = config?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }

  override getSystemPrompt(): string {
    const config = this.getConfig();
    if (config?.systemPrompt) return config.systemPrompt;

    return `You are a helpful assistant with access to workspace tools.

You have two workspaces:
- Session workspace (private to this conversation): read, write, edit, list, find, grep, delete
- Shared workspace (shared across all agents): shared_read, shared_write, shared_edit, shared_list, shared_find, shared_grep, shared_delete

Guidelines:
- Always read a file before editing it
- When editing, provide enough context in old_string to make the match unique
- Use find/shared_find to discover project structure
- Use grep/shared_grep to search for patterns across files`;
  }

  override getTools(): ToolSet {
    return createWorkspaceTools(this.workspace);
  }

  override getMaxSteps(): number {
    return 10;
  }

  // ── Workspace browsing (called by orchestrator via RPC) ──

  @callable()
  listFiles(path: string): FileInfo[] {
    return this.workspace.readDir(path || "/");
  }

  @callable()
  async getFileContent(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  /**
   * Chat with extra bridge-provided tools (shared workspace, MCP, orchestrator).
   * Resolves tool defs eagerly, sets up abort forwarding, then calls
   * chat() with per-call tools.
   */
  async chatWithBridge(
    userMessage: string,
    toolBridge: ToolBridge,
    callback: StreamCallback
  ): Promise<void> {
    const extraTools = await buildBridgeTools(toolBridge, this.getConfig());

    // AbortSignal can't cross the RPC boundary (DataCloneError).
    // Instead, create a local AbortController and register an AbortReceiver
    // on the bridge. The parent calls bridge.triggerAbort() which fires
    // receiver.abort() on the sub-agent side via RPC.
    const localAbort = new AbortController();
    const receiver = new AbortReceiver(localAbort);
    await toolBridge.registerAbortReceiver(receiver);

    await this.chat(userMessage, callback, {
      tools: extraTools,
      signal: localAbort.signal
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge tool factories — resolve tools that call back to the parent via RPC
// ─────────────────────────────────────────────────────────────────────────────

async function buildBridgeTools(
  bridge: ToolBridge,
  config: AgentConfig | null
): Promise<ToolSet> {
  const toolAccess = config?.toolAccess ?? "workspace+shared+mcp";
  if (toolAccess === "workspace") return {};

  const sharedTools = createSharedWorkspaceTools(bridge);
  if (toolAccess === "workspace+shared") return sharedTools;

  const mcpDefs = await bridge.getMcpTools();
  const orchDefs = await bridge.getOrchestratorToolDefs();
  return {
    ...sharedTools,
    ...createMcpTools(bridge, mcpDefs),
    ...createOrchestratorTools(bridge, orchDefs)
  };
}

function createMcpTools(bridge: ToolBridge, defs: McpToolDef[]): ToolSet {
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

function createOrchestratorTools(
  bridge: ToolBridge,
  defs: OrchestratorToolDef[]
): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    tools[def.name] = {
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema),
      execute: async (args: Record<string, unknown>) =>
        bridge.orchestratorExecute(def.name, args)
    };
  }
  return tools;
}

function createSharedWorkspaceTools(bridge: ToolBridge): ToolSet {
  return {
    shared_read: tool({
      description:
        "Read a file from the shared workspace (accessible by all agents)",
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

// ─────────────────────────────────────────────────────────────────────────────
// ChunkRelay — unified RpcTarget that buffers + broadcasts chunks to viewers
// Used for both user-initiated streams and background delegation.
// ─────────────────────────────────────────────────────────────────────────────

class ChunkRelay extends RpcTarget {
  #agentId: string;
  #chunks: string[] = [];
  #viewers = new Map<string, { connection: Connection; requestId: string }>();
  #resultText = "";
  #error: string | null = null;
  #done = false;
  #aborted = false;

  constructor(agentId: string) {
    super();
    this.#agentId = agentId;
  }

  /** Add a viewer and send stream-start. Used for user-initiated streams. */
  addViewer(
    connection: Connection,
    requestId: string,
    opts?: { delegation?: boolean }
  ): void {
    const startMsg: ServerMessage = {
      type: "stream-start",
      agentId: this.#agentId,
      requestId,
      delegation: opts?.delegation
    };
    connection.send(JSON.stringify(startMsg));
    this.#viewers.set(connection.id, { connection, requestId });
  }

  /** Attach a new viewer mid-stream (delegation). Replays buffer + streams live. */
  attachViewer(connection: Connection): void {
    if (this.#done) return;
    const requestId = `deleg-${crypto.randomUUID().slice(0, 8)}`;
    this.addViewer(connection, requestId, { delegation: true });
    for (const chunk of this.#chunks) {
      const msg: ServerMessage = {
        type: "stream-event",
        requestId,
        event: chunk
      };
      connection.send(JSON.stringify(msg));
    }
  }

  /** Detach a viewer. Sends stream-done so the client cleans up. */
  detachViewer(connectionId: string): void {
    const viewer = this.#viewers.get(connectionId);
    if (viewer) {
      const msg: ServerMessage = {
        type: "stream-done",
        requestId: viewer.requestId
      };
      viewer.connection.send(JSON.stringify(msg));
      this.#viewers.delete(connectionId);
    }
  }

  /** Resume a viewer after reconnect. Updates connection + replays buffer. */
  resumeViewer(oldConnectionId: string, connection: Connection): void {
    const viewer = this.#viewers.get(oldConnectionId);
    if (!viewer) return;
    this.#viewers.delete(oldConnectionId);
    this.#viewers.set(connection.id, {
      connection,
      requestId: viewer.requestId
    });
    const resumeMsg: ServerMessage = {
      type: "stream-resuming",
      requestId: viewer.requestId
    };
    connection.send(JSON.stringify(resumeMsg));
    for (const chunk of this.#chunks) {
      const msg: ServerMessage = {
        type: "stream-event",
        requestId: viewer.requestId,
        event: chunk,
        replay: true
      };
      connection.send(JSON.stringify(msg));
    }
  }

  abort(): void {
    this.#aborted = true;
  }

  isAborted(): boolean {
    return this.#aborted;
  }

  isDone(): boolean {
    return this.#done;
  }

  getResult(): { text: string; error: string | null } {
    return { text: this.#resultText, error: this.#error };
  }

  onEvent(json: string): void {
    this.#chunks.push(json);
    try {
      const chunk = JSON.parse(json);
      if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
        this.#resultText += chunk.delta;
      }
    } catch {
      // ignore
    }
    if (this.#aborted) return;
    for (const { connection, requestId } of this.#viewers.values()) {
      const msg: ServerMessage = {
        type: "stream-event",
        requestId,
        event: json
      };
      connection.send(JSON.stringify(msg));
    }
  }

  onDone(): void {
    this.#done = true;
    this.#finish();
  }

  onError(error: string): void {
    this.#error = error;
    this.#done = true;
    this.#finish();
  }

  #finish(): void {
    if (this.#aborted) return;
    for (const { connection, requestId } of this.#viewers.values()) {
      const msg: ServerMessage = { type: "stream-done", requestId };
      connection.send(JSON.stringify(msg));
    }
    this.#viewers.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AbortReceiver — RpcTarget that lives on the sub-agent, called by the parent
// ─────────────────────────────────────────────────────────────────────────────

class AbortReceiver extends RpcTarget {
  #controller: AbortController;

  constructor(controller: AbortController) {
    super();
    this.#controller = controller;
  }

  /** Called by the parent (via RPC) to abort the sub-agent's LLM call. */
  abort(): void {
    this.#controller.abort();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolBridge — RpcTarget proxying shared workspace + MCP to sub-agents
// ─────────────────────────────────────────────────────────────────────────────

class ToolBridge extends RpcTarget {
  #workspace: Workspace;
  #mcpClient: MCPClientManager;
  #abortReceiver: AbortReceiver | null = null;

  constructor(workspace: Workspace, mcpClient: MCPClientManager) {
    super();
    this.#workspace = workspace;
    this.#mcpClient = mcpClient;
  }

  /**
   * Called by the sub-agent (via RPC) to register its AbortReceiver.
   * The parent stores the stub so it can call receiver.abort() later.
   */
  registerAbortReceiver(receiver: AbortReceiver): void {
    this.#abortReceiver = receiver;
  }

  /** Called by the parent (locally) to trigger abort on the sub-agent. */
  triggerAbort(): void {
    // Fire-and-forget RPC call to the sub-agent's AbortReceiver.
    // Executes when the sub-agent's input gate opens (during I/O).
    this.#abortReceiver?.abort();
  }

  // ── Shared workspace operations ──

  async sharedRead(path: string): Promise<string | null> {
    return this.#workspace.readFile(path);
  }

  async sharedWrite(path: string, content: string): Promise<void> {
    const parent = path.replace(/\/[^/]+$/, "");
    if (parent && parent !== "/") {
      await this.#workspace.mkdir(parent, { recursive: true });
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

  // ── Orchestrator tools (overridden by OrchestratorBridge) ──

  getOrchestratorToolDefs(): OrchestratorToolDef[] {
    return [];
  }

  async orchestratorExecute(
    _name: string,
    _args: Record<string, unknown>
  ): Promise<unknown> {
    throw new Error("Orchestrator tools not available on this bridge");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OrchestratorBridge — extends ToolBridge with orchestrator tool execution
// ─────────────────────────────────────────────────────────────────────────────

const ORCHESTRATOR_TOOL_DEFS: OrchestratorToolDef[] = [
  {
    name: "spawn_agent",
    description:
      "Spawn a new specialized agent with custom configuration. Returns the agent ID.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short descriptive name (e.g. 'Researcher', 'Code Writer')"
        },
        system_prompt: {
          type: "string",
          description: "System prompt defining the agent's role and behavior"
        },
        model_tier: {
          type: "string",
          enum: ["fast", "capable"],
          description:
            "Model tier: 'fast' for simple tasks, 'capable' for complex reasoning"
        },
        tool_access: {
          type: "string",
          enum: ["workspace", "workspace+shared", "workspace+shared+mcp"],
          description: "Tool access level",
          default: "workspace+shared+mcp"
        }
      },
      required: ["name", "system_prompt", "model_tier"]
    }
  },
  {
    name: "delegate_task",
    description:
      "Delegate a task to an existing agent. Returns immediately — the agent works in the background. The user sees status updates in the sidebar. Use list_agents to check progress later.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "ID of the agent to delegate to"
        },
        task: {
          type: "string",
          description: "Task description / prompt to send to the agent"
        }
      },
      required: ["agent_id", "task"]
    }
  },
  {
    name: "hand_off",
    description:
      "Switch the user's view to a specific agent's chat. Use when the user wants to interact directly.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "ID of the agent to hand off to"
        }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "list_agents",
    description: "List all spawned agents with their status and configuration.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_available_tools",
    description: "List all tools available from connected MCP servers.",
    inputSchema: { type: "object", properties: {} }
  }
];

class OrchestratorBridge extends ToolBridge {
  #execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;

  constructor(
    workspace: Workspace,
    mcpClient: MCPClientManager,
    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  ) {
    super(workspace, mcpClient);
    this.#execute = execute;
  }

  override getOrchestratorToolDefs(): OrchestratorToolDef[] {
    return ORCHESTRATOR_TOOL_DEFS;
  }

  override async orchestratorExecute(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return this.#execute(name, args);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MyAssistant — orchestrator: own chat, agent registry, delegation, handoff
// ─────────────────────────────────────────────────────────────────────────────

export class MyAssistant extends Agent<Env, AppState> {
  initialState: AppState = { agents: [] };
  sharedWorkspace = new Workspace(this);

  #activeStreams = new Map<
    string,
    {
      relay: ChunkRelay;
      bridge: ToolBridge;
      agentId: string;
      connectionId: string;
    }
  >();

  #activeDelegations = new Map<string, ChunkRelay>();

  async onStart() {
    this._initTables();
    this._ensureOrchestratorAgent();
    this._broadcastAgents();

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

  async onConnect(connection: Connection) {
    // Restore active agent on reconnect (e.g. after hibernation wake)
    const activeId = this._getActiveAgentId(connection);
    if (activeId) {
      // If this agent has an active delegation, skip the sub-agent RPC
      // (it's busy running chatWithBridge) and attach to the live stream.
      // _runDelegation pushes full history when done.
      const delegation = this.#activeDelegations.get(activeId);
      if (delegation && !delegation.isDone()) {
        const msg: ServerMessage = {
          type: "messages",
          agentId: activeId,
          messages: []
        };
        connection.send(JSON.stringify(msg));
        delegation.attachViewer(connection);
      } else {
        await this._sendAgentMessages(connection, activeId);
      }
    }
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
            stream.bridge.triggerAbort();
            this.#activeStreams.delete(msg.requestId);
          }
          break;
        }
        case "resume-request": {
          const activeId = this._getActiveAgentId(connection);
          if (!activeId) break;
          for (const [_requestId, stream] of this.#activeStreams) {
            if (stream.agentId !== activeId) continue;
            stream.relay.resumeViewer(stream.connectionId, connection);
            stream.connectionId = connection.id;
            break;
          }
          break;
        }
      }
    } catch {
      /* not a ClientMessage */
    }
  }

  private _initTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'idle',
        last_task TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    // Migration: add message_count column for existing tables
    try {
      this
        .sql`ALTER TABLE agents ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`;
    } catch {
      // Column already exists
    }
  }

  private _ensureOrchestratorAgent() {
    const existing = this.sql<{ id: string }>`
      SELECT id FROM agents WHERE id = ${ORCHESTRATOR_ID}
    `;
    if (existing.length === 0) {
      const config: AgentConfig = {
        name: "Orchestrator",
        systemPrompt: "", // overridden at runtime with orchestrator-specific prompt
        modelTier: "capable",
        toolAccess: "workspace+shared+mcp"
      };
      this.sql`
        INSERT INTO agents (id, name, config_json, status)
        VALUES (${ORCHESTRATOR_ID}, 'Orchestrator', ${JSON.stringify(config)}, 'idle')
      `;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private _broadcastAgents() {
    const rows = this.sql<AgentRow>`
      SELECT id, name, config_json, status, last_task, message_count,
             created_at, last_active_at
      FROM agents ORDER BY
        CASE WHEN id = ${ORCHESTRATOR_ID} THEN 0 ELSE 1 END,
        last_active_at DESC
    `;

    const agents: AgentInfo[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      config: JSON.parse(r.config_json) as AgentConfig,
      messageCount: r.message_count,
      status: r.status as AgentInfo["status"],
      lastTaskDescription: r.last_task,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at
    }));
    this.setState({ agents });
  }

  private async _updateMessageCount(agentId: string) {
    const session = await this.subAgent(ChatSession, `agent-${agentId}`);
    const count = await session.getMessageCount();
    this.sql`UPDATE agents SET message_count = ${count} WHERE id = ${agentId}`;
  }

  private async _sendAgentMessages(connection: Connection, agentId: string) {
    const session = await this.subAgent(ChatSession, `agent-${agentId}`);
    const messages = await session.getHistory();
    const msg: ServerMessage = { type: "messages", agentId, messages };
    connection.send(JSON.stringify(msg));
  }

  private _getConnection(): Connection {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("No connection in context");
    return connection;
  }

  private _getActiveAgentId(connection: Connection): string | null {
    const data = connection.state as ConnectionData | null;
    return data?.activeAgentId ?? null;
  }

  private _setAgentStatus(
    agentId: string,
    status: AgentInfo["status"],
    lastTask?: string
  ) {
    if (lastTask !== undefined) {
      this.sql`
        UPDATE agents SET status = ${status}, last_task = ${lastTask},
        last_active_at = CURRENT_TIMESTAMP WHERE id = ${agentId}
      `;
    } else {
      this.sql`
        UPDATE agents SET status = ${status},
        last_active_at = CURRENT_TIMESTAMP WHERE id = ${agentId}
      `;
    }
  }

  // ─── Orchestrator ─────────────────────────────────────────────────────

  private _getOrchestratorSystemPrompt(): string {
    return `You are an orchestrator assistant. You manage a team of specialized AI agents.

You can:
1. Chat directly with the user and answer questions
2. Spawn specialized agents for specific tasks (spawn_agent)
3. Delegate tasks to existing agents (delegate_task) — the agent works and returns a result
4. Hand off to an agent (hand_off) — switches the user to that agent's chat
5. List your spawned agents and their status (list_agents)
6. Discover available MCP tools (list_available_tools)

Model tiers:
- "fast": Quick responses, good for simple tasks (file operations, summaries, Q&A)
- "capable": Stronger reasoning, better for complex tasks (coding, analysis, multi-step)

Tool access levels:
- "workspace": Agent gets only its own private workspace
- "workspace+shared": Agent gets private + shared workspace (can collaborate)
- "workspace+shared+mcp": Full access including MCP server tools

Guidelines:
- For simple questions, answer directly without spawning agents
- For complex multi-step tasks, spawn a specialized agent and delegate
- Choose the right model tier: "fast" for simple, "capable" for complex
- Write clear, focused system prompts when spawning agents
- Use the shared workspace for files that multiple agents need to access
- When delegating, provide clear task descriptions
- After delegation completes, summarize the result for the user

You also have workspace tools for your own use (read, write, edit, list, find, grep, delete for both session and shared workspaces).`;
  }

  /**
   * Execute an orchestrator tool by name. Called by OrchestratorBridge
   * via RPC when a sub-agent invokes an orchestrator tool.
   */
  private async _executeOrchestratorTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (name) {
      case "spawn_agent":
        return this._toolSpawnAgent(args);
      case "delegate_task":
        return this._toolDelegateTask(args);
      case "hand_off":
        return this._toolHandOff(args);
      case "list_agents":
        return this._toolListAgents();
      case "list_available_tools":
        return this._toolListAvailableTools();
      default:
        throw new Error(`Unknown orchestrator tool: ${name}`);
    }
  }

  private async _toolSpawnAgent(args: Record<string, unknown>) {
    const name = args.name as string;
    const systemPrompt = args.system_prompt as string;
    const modelTier = (args.model_tier as ModelTier) ?? "fast";
    const toolAccess =
      (args.tool_access as AgentConfig["toolAccess"]) ?? "workspace+shared+mcp";

    const id = crypto.randomUUID().slice(0, 8);
    const config: AgentConfig = {
      name,
      systemPrompt,
      modelTier,
      toolAccess
    };
    this.sql`
      INSERT INTO agents (id, name, config_json, status)
      VALUES (${id}, ${name}, ${JSON.stringify(config)}, 'idle')
    `;
    const session = await this.subAgent(ChatSession, `agent-${id}`);
    await session.configure(config);
    this._broadcastAgents();
    return { agentId: id, name, modelTier, toolAccess };
  }

  private _toolDelegateTask(args: Record<string, unknown>) {
    const agentId = args.agent_id as string;
    const task = args.task as string;
    const rows = this.sql<{ id: string }>`
      SELECT id FROM agents WHERE id = ${agentId}
    `;
    if (rows.length === 0) return { error: `Agent ${agentId} not found` };

    this._setAgentStatus(agentId, "working", task);
    this._broadcastAgents();

    // Fire-and-forget: run the sub-agent in the background
    this.ctx.waitUntil(this._runDelegation(agentId, task));

    return { status: "delegated", agentId, task };
  }

  private async _runDelegation(agentId: string, task: string) {
    let status: "done" | "error" = "done";
    const relay = new ChunkRelay(agentId);
    this.#activeDelegations.set(agentId, relay);
    try {
      const session = await this.subAgent(ChatSession, `agent-${agentId}`);
      await this.mcp.waitForConnections({ timeout: 5000 });
      const toolBridge = new ToolBridge(this.sharedWorkspace, this.mcp);
      await session.chatWithBridge(task, toolBridge, relay);
      if (relay.getResult().error) status = "error";
      await this._updateMessageCount(agentId);
    } catch {
      status = "error";
    } finally {
      this.#activeDelegations.delete(agentId);
    }

    this._setAgentStatus(agentId, status);
    this._broadcastAgents();

    // Push fresh messages to any connection viewing this agent
    for (const conn of this.getConnections()) {
      if (this._getActiveAgentId(conn) === agentId) {
        await this._sendAgentMessages(conn, agentId);
      }
    }
  }

  private async _toolHandOff(args: Record<string, unknown>) {
    const agentId = args.agent_id as string;
    const rows = this.sql<{ id: string; name: string }>`
      SELECT id, name FROM agents WHERE id = ${agentId}
    `;
    if (rows.length === 0) return { error: `Agent ${agentId} not found` };

    // Only navigate the connection that initiated this request
    const { connection } = getCurrentAgent();
    if (connection) {
      const navMsg: ServerMessage = { type: "navigate", agentId };
      connection.send(JSON.stringify(navMsg));
    }
    return { navigated: true, agentId, name: rows[0].name };
  }

  private _toolListAgents() {
    const rows = this.sql<AgentRow>`
      SELECT id, name, config_json, status, last_task, message_count, created_at, last_active_at
      FROM agents WHERE id != ${ORCHESTRATOR_ID}
      ORDER BY last_active_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      lastTask: r.last_task,
      config: JSON.parse(r.config_json),
      createdAt: r.created_at
    }));
  }

  private async _toolListAvailableTools() {
    await this.mcp.waitForConnections({ timeout: 5000 });
    const tools = this.mcp.listTools();
    return tools.map((t) => ({
      name: t.name,
      serverId: t.serverId,
      description: t.description
    }));
  }

  // ─── Agent CRUD ─────────────────────────────────────────────────────

  @callable()
  async switchAgent(agentId: string) {
    const connection = this._getConnection();

    // Detach from previous delegation relay if viewing one
    const prevId = this._getActiveAgentId(connection);
    if (prevId) {
      this.#activeDelegations.get(prevId)?.detachViewer(connection.id);
    }

    connection.setState({ activeAgentId: agentId } satisfies ConnectionData);

    // If this agent has an active delegation, skip the sub-agent RPC
    // (it's busy running chatWithBridge) and attach to the live stream.
    // _runDelegation pushes full history when done.
    const delegation = this.#activeDelegations.get(agentId);
    if (delegation && !delegation.isDone()) {
      const msg: ServerMessage = { type: "messages", agentId, messages: [] };
      connection.send(JSON.stringify(msg));
      delegation.attachViewer(connection);
    } else {
      await this._sendAgentMessages(connection, agentId);
    }
  }

  @callable()
  async deleteAgent(agentId: string) {
    if (agentId === ORCHESTRATOR_ID) return; // can't delete orchestrator
    this.sql`DELETE FROM agents WHERE id = ${agentId}`;
    this.deleteSubAgent(ChatSession, `agent-${agentId}`);
    const connection = this._getConnection();
    if (this._getActiveAgentId(connection) === agentId) {
      connection.setState({
        activeAgentId: ORCHESTRATOR_ID
      } satisfies ConnectionData);
      await this._sendAgentMessages(connection, ORCHESTRATOR_ID);
    }
    this._broadcastAgents();
  }

  @callable()
  async clearAgent(agentId: string) {
    const session = await this.subAgent(ChatSession, `agent-${agentId}`);
    await session.clearMessages();
    this.sql`UPDATE agents SET message_count = 0 WHERE id = ${agentId}`;
    if (agentId !== ORCHESTRATOR_ID) {
      this._setAgentStatus(agentId, "idle");
    }
    for (const conn of this.getConnections()) {
      if (this._getActiveAgentId(conn) === agentId) {
        await this._sendAgentMessages(conn, agentId);
      }
    }
    this._broadcastAgents();
  }

  @callable()
  async renameAgent(agentId: string, name: string) {
    this.sql`UPDATE agents SET name = ${name} WHERE id = ${agentId}`;
    this._broadcastAgents();
  }

  // ─── Workspace browsing ──────────────────────────────────────────────

  @callable()
  async listWorkspaceFiles(
    agentId: string,
    which: "private" | "shared",
    path: string
  ): Promise<FileInfo[]> {
    if (which === "shared") {
      return this.sharedWorkspace.readDir(path || "/");
    }
    const session = await this.subAgent(ChatSession, `agent-${agentId}`);
    return session.listFiles(path || "/");
  }

  @callable()
  async readWorkspaceFile(
    agentId: string,
    which: "private" | "shared",
    path: string
  ): Promise<string | null> {
    if (which === "shared") {
      return this.sharedWorkspace.readFile(path);
    }
    const session = await this.subAgent(ChatSession, `agent-${agentId}`);
    return session.getFileContent(path);
  }

  // ─── Send message ─────────────────────────────────────────────────────

  @callable()
  async sendMessage(text: string, requestId: string) {
    const connection = this._getConnection();
    const activeId = this._getActiveAgentId(connection);
    if (!activeId) throw new Error("No active agent");

    const session = await this.subAgent(ChatSession, `agent-${activeId}`);

    // Configure orchestrator session if not already set
    if (activeId === ORCHESTRATOR_ID) {
      const existing = await session.getConfig();
      if (!existing) {
        await session.configure({
          name: "Orchestrator",
          systemPrompt: this._getOrchestratorSystemPrompt(),
          modelTier: "capable",
          toolAccess: "workspace+shared+mcp"
        });
      }
    }

    await this.mcp.waitForConnections({ timeout: 5000 });

    // Orchestrator gets OrchestratorBridge (with spawn/delegate/handoff tools),
    // regular agents get plain ToolBridge
    const toolBridge =
      activeId === ORCHESTRATOR_ID
        ? new OrchestratorBridge(this.sharedWorkspace, this.mcp, (name, args) =>
            this._executeOrchestratorTool(name, args)
          )
        : new ToolBridge(this.sharedWorkspace, this.mcp);

    const relay = new ChunkRelay(activeId);
    relay.addViewer(connection, requestId);

    this.#activeStreams.set(requestId, {
      relay,
      bridge: toolBridge,
      agentId: activeId,
      connectionId: connection.id
    });

    try {
      await session.chatWithBridge(text, toolBridge, relay);
    } finally {
      this.#activeStreams.delete(requestId);
    }

    // stream-done is sent by relay.onDone() (called by Think.chat)

    await this._updateMessageCount(activeId);
    this.sql`
      UPDATE agents SET last_active_at = CURRENT_TIMESTAMP WHERE id = ${activeId}
    `;
    this._broadcastAgents();
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
