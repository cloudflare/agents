import type { MCPClientManager } from "./index";
import { MCPConnectionState } from "./connection";
import { decodeMcpServerOptions, type MCPServerRow } from "./storage";
import { isDurableObjectNamespace, RPC_DO_PREFIX } from "../rpc";

type RpcRestorationManager = Pick<
  MCPClientManager,
  "connect" | "discoverIfConnected" | "mcpConnections"
>;

/**
 * Restore one persisted RPC connection through a manager's public transport
 * API: resolve its Durable Object binding from `env` by the stored binding
 * name, reconnect, and discover. Failures are logged, not thrown.
 */
export async function restoreRpcConnection(
  manager: RpcRestorationManager,
  env: Cloudflare.Env | undefined,
  server: MCPServerRow
): Promise<void> {
  if (!env) {
    console.warn(
      `[MCPClientManager] Cannot restore RPC MCP server "${server.name}": ` +
        "no env was provided; pass { env } when constructing MCPClientManager"
    );
    return;
  }
  if (manager.mcpConnections[server.id]) return;

  const options = decodeMcpServerOptions(server.server_options);
  const binding = options.bindingName
    ? Object.entries(env).find(([name]) => name === options.bindingName)?.[1]
    : undefined;
  if (!isDurableObjectNamespace(binding)) {
    console.warn(
      `[MCPClientManager] Cannot restore RPC MCP server "${server.name}": binding ` +
        `"${options.bindingName ?? "<missing>"}" not found in env`
    );
    return;
  }

  const normalizedName = server.server_url.replace(RPC_DO_PREFIX, "");
  try {
    await manager.connect(`${RPC_DO_PREFIX}${normalizedName}`, {
      reconnect: { id: server.id },
      transport: {
        type: "rpc",
        namespace: binding,
        name: normalizedName,
        props: options.props
      }
    });

    const connection = manager.mcpConnections[server.id];
    if (connection?.connectionState === MCPConnectionState.CONNECTED) {
      await manager.discoverIfConnected(server.id);
    }
  } catch (error) {
    console.error(
      `[MCPClientManager] Error restoring RPC MCP server "${server.name}":`,
      error
    );
  }
}
