import type { RPCClientTransportOptions } from "../rpc";
import { decodeMcpServerOptions, type MCPServerRow } from "./storage";
import { isDurableObjectNamespace, RPC_DO_PREFIX } from "../rpc";

/** The transport for a stored RPC server, or why it cannot be built. */
export type RpcTransportResolution =
  | {
      readonly _tag: "resolved";
      readonly transport: RPCClientTransportOptions & { type: "rpc" };
    }
  | { readonly _tag: "unresolved"; readonly reason: string };

/**
 * Build the RPC transport for a stored server by resolving its Durable
 * Object binding from `env` by the binding name persisted with the server.
 */
export function resolveRpcTransport(
  env: Cloudflare.Env | undefined,
  server: MCPServerRow
): RpcTransportResolution {
  if (!env) {
    return {
      _tag: "unresolved",
      reason:
        "no env was provided; pass { env } when constructing MCPClientManager"
    };
  }
  const options = decodeMcpServerOptions(server.server_options);
  const binding = options.bindingName
    ? Object.entries(env).find(([name]) => name === options.bindingName)?.[1]
    : undefined;
  if (!isDurableObjectNamespace(binding)) {
    return {
      _tag: "unresolved",
      reason: `binding "${options.bindingName ?? "<missing>"}" not found in env`
    };
  }
  return {
    _tag: "resolved",
    transport: {
      type: "rpc",
      namespace: binding,
      name: server.server_url.replace(RPC_DO_PREFIX, ""),
      props: options.props
    }
  };
}
