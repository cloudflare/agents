import {
  McpConnector,
  sanitizeToolName,
  type CodemodeConnector,
  type McpConnectionLike
} from "@cloudflare/codemode";
import { ToolSetConnector } from "@cloudflare/codemode/ai";
import type { Tool, ToolSet } from "ai";
import {
  createWorkspaceStateBackend,
  isWorkspaceFsLike
} from "@cloudflare/shell";
import { StateConnector } from "@cloudflare/shell/workers";
import type { MCPClientManager } from "agents/mcp/client";
import type { WorkspaceLike } from "./workspace";
import { createExecuteRuntime, type ExecuteRuntime } from "./execute";

class LiveMcpConnector extends McpConnector {
  constructor(
    ctx: DurableObjectState,
    private readonly namespace: string,
    private readonly connection: McpConnectionLike
  ) {
    super(ctx, {});
  }

  override name(): string {
    return this.namespace;
  }

  protected override createConnection(): McpConnectionLike {
    return this.connection;
  }
}

const RESERVED_NAMESPACES = new Map([
  ["codemode", "the Code Mode platform SDK"],
  ["workspace", "Think's persistent workspace"],
  ["context", "Think session context"],
  ["skills", "Think Agent Skills"],
  ["extensions", "Think extensions"],
  ["fetch", "Think fetch targets"],
  ["tools", "application tools"],
  ["actions", "Think actions"],
  ["state", "the legacy Code Mode state connector"],
  ["cdp", "the browser connector"]
]);

function mcpConnectors(
  ctx: DurableObjectState,
  manager: MCPClientManager
): CodemodeConnector[] {
  const connectors: CodemodeConnector[] = [];
  const namespaces = new Map<string, string>();

  for (const server of manager.listServers()) {
    const connection = manager.mcpConnections[server.id];
    if (!connection) continue;

    const displayName = server.name || server.id;
    const namespace = sanitizeToolName(displayName);
    const reservedFor = RESERVED_NAMESPACES.get(namespace);
    if (reservedFor) {
      throw new Error(
        `MCP server "${displayName}" maps to reserved Code Mode namespace ` +
          `"${namespace}", which is owned by ${reservedFor}. Register it ` +
          "with a different server name."
      );
    }
    const existing = namespaces.get(namespace);
    if (existing !== undefined) {
      throw new Error(
        `MCP servers "${existing}" and "${displayName}" both map to Code Mode ` +
          `namespace "${namespace}". Register them with distinct names.`
      );
    }
    namespaces.set(namespace, displayName);
    connectors.push(new LiveMcpConnector(ctx, namespace, connection));
  }

  return connectors;
}

type CreateThinkCodeRuntimeOptions = {
  ctx: DurableObjectState;
  loader: WorkerLoader;
  workspace: WorkspaceLike;
  mcp: MCPClientManager;
  contextTools: ToolSet;
  skillTools: ToolSet;
  extensionTools: ToolSet;
  fetchTools: ToolSet;
};

/** Enforce one owner for Think's model-facing code execution surface. */
export function assertThinkCodeToolOwnership(
  tools: ToolSet,
  builtin: Tool
): void {
  const conflict =
    tools.code !== undefined && tools.code !== builtin
      ? "code"
      : tools.bash !== undefined
        ? "bash"
        : undefined;
  if (!conflict) return;

  throw new Error(
    `Think's built-in code tool cannot be combined with a custom ${conflict} ` +
      "tool. Set codeTool = false on the agent that owns the custom runtime."
  );
}

/**
 * Build Think's durable Code Mode runtime. Registered MCP servers are exposed
 * by server name (for example `github.searchIssues(...)`) without converting
 * their JSON Schemas into direct AI SDK tools.
 */
export function createThinkCodeRuntime(
  options: CreateThinkCodeRuntimeOptions
): ExecuteRuntime {
  const fs = isWorkspaceFsLike(options.workspace)
    ? options.workspace
    : undefined;
  const connectors: CodemodeConnector[] = mcpConnectors(
    options.ctx,
    options.mcp
  );
  if (fs) {
    connectors.unshift(
      new StateConnector(options.ctx, createWorkspaceStateBackend(fs), {
        name: "workspace"
      })
    );
  }
  const platformToolSets: Array<
    readonly [name: string, tools: ToolSet, instructions: string]
  > = [
    [
      "context",
      options.contextTools,
      "Read, search, load, and update the agent's durable context."
    ],
    [
      "skills",
      options.skillTools,
      "Activate agent skills and access their bundled resources."
    ],
    [
      "extensions",
      options.extensionTools,
      "Call tools contributed by loaded Think extensions."
    ],
    [
      "fetch",
      options.fetchTools,
      "Read allowlisted HTTP resources and configured service bindings."
    ]
  ];
  for (const [name, tools, instructions] of platformToolSets) {
    if (Object.keys(tools).length === 0) continue;
    connectors.push(
      new ToolSetConnector(options.ctx, { name, tools, instructions })
    );
  }
  return createExecuteRuntime({
    ctx: options.ctx,
    loader: options.loader,
    connectors,
    name: "code"
  });
}
