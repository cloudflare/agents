import type { MCPClientManager } from "./client";
import { MCPConnectionState } from "./client-connection";
import { decodeMcpServerOptions, type MCPServerRow } from "./client-storage";
import { isDurableObjectNamespace, RPC_DO_PREFIX } from "./rpc";

type RpcRestorationManager = Pick<
  MCPClientManager,
  "connect" | "discoverIfConnected" | "mcpConnections"
>;

/** Restore persisted RPC connections through a manager's public transport API. */
export async function restoreRpcConnections(
  manager: RpcRestorationManager,
  env: Cloudflare.Env | undefined,
  servers: readonly MCPServerRow[]
): Promise<void> {
  if (!env) {
    for (const server of servers) {
      console.warn(
        `[MCPClientManager] Cannot restore RPC MCP server "${server.name}": ` +
          "no env was provided; pass { env } when constructing MCPClientManager"
      );
    }
    return;
  }

  for (const server of servers) {
    if (manager.mcpConnections[server.id]) continue;

    const options = decodeMcpServerOptions(server.server_options);
    const binding = options.bindingName
      ? Object.entries(env).find(([name]) => name === options.bindingName)?.[1]
      : undefined;
    if (!isDurableObjectNamespace(binding)) {
      console.warn(
        `[MCPClientManager] Cannot restore RPC MCP server "${server.name}": binding ` +
          `"${options.bindingName ?? "<missing>"}" not found in env`
      );
      continue;
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
}
