import {
  McpConnector,
  sanitizeToolName,
  type CodemodeConnector,
  type McpConnectionLike
} from "@cloudflare/codemode";
import { ToolSetConnector } from "@cloudflare/codemode/ai";
import type { ToolSet } from "ai";
import { createWorkspaceStateBackend } from "@cloudflare/shell";
import { StateConnector } from "@cloudflare/shell/workers";
import type { WorkspaceLike } from "./workspace";
import { createExecuteRuntime, type ExecuteRuntime } from "./execute";
import { resolveWorkspaceFs } from "./workspace-fs";

export interface ThinkBashMcpManager {
  listServers(): Array<{ id: string; name: string }>;
  mcpConnections: Record<string, McpConnectionLike | undefined>;
}

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
  manager: ThinkBashMcpManager
): LiveMcpConnector[] {
  const connectors: LiveMcpConnector[] = [];
  const namespaces = new Map<string, string>();

  for (const server of manager.listServers()) {
    const connection = manager.mcpConnections[server.id];
    if (!connection) continue;

    const namespace = sanitizeToolName(server.name || server.id);
    const reservedFor = RESERVED_NAMESPACES.get(namespace);
    if (reservedFor) {
      throw new Error(
        `MCP server "${server.name}" maps to reserved Code Mode namespace ` +
          `"${namespace}", which is owned by ${reservedFor}. Register it ` +
          "with a different server name."
      );
    }
    const existing = namespaces.get(namespace);
    if (existing) {
      throw new Error(
        `MCP servers "${existing}" and "${server.name}" both map to Code Mode ` +
          `namespace "${namespace}". Register them with distinct names.`
      );
    }
    namespaces.set(namespace, server.name);
    connectors.push(new LiveMcpConnector(ctx, namespace, connection));
  }

  return connectors;
}

export interface ThinkBashToolSet {
  name: string;
  tools: ToolSet;
  instructions?: string;
}

export interface CreateThinkBashRuntimeOptions {
  ctx: DurableObjectState;
  loader: WorkerLoader;
  workspace: WorkspaceLike;
  mcp: ThinkBashMcpManager;
  toolSets?: ThinkBashToolSet[];
}

/**
 * Build Think's durable Code Mode runtime. Registered MCP servers are exposed
 * by server name (for example `github.searchIssues(...)`) without converting
 * their JSON Schemas into direct AI SDK tools.
 */
export function createThinkBashRuntime(
  options: CreateThinkBashRuntimeOptions
): ExecuteRuntime {
  const fs = resolveWorkspaceFs(options.workspace);
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
  for (const toolSet of options.toolSets ?? []) {
    if (Object.keys(toolSet.tools).length === 0) continue;
    connectors.push(
      new ToolSetConnector(options.ctx, {
        name: toolSet.name,
        tools: toolSet.tools,
        instructions: toolSet.instructions
      })
    );
  }
  return createExecuteRuntime({
    ctx: options.ctx,
    loader: options.loader,
    connectors,
    name: "bash"
  });
}
