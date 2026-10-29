/**
 * `agents/mcp/client`: the MCP client capability and its types.
 *
 * - `manager.ts`: `MCPClientManager`, the public API and Lifecycle hooks
 * - `servers.ts`: each server's connection life, and what happens after a
 *   failure
 * - `authorization.ts`: authorization links, OAuth callbacks, and
 *   re-authorization during requests
 * - `jobs.ts`: the durable link-expiry job
 */
export { MCPClientManager } from "./manager";
export { getNamespacedData } from "./catalog";
export type {
  MCPClientElicitationHandler,
  MCPClientElicitationHandlers,
  MCPClientManagerOptions,
  MCPConnectionResult,
  MCPDiscoverResult,
  MCPOAuthCallbackResult,
  MCPServerFilter,
  MCPServerOptions,
  MCPServerSettlement,
  RegisterServerOptions
} from "./types";
export type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
export {
  RPC_DO_PREFIX,
  RPCClientTransport,
  type McpRpcAgent,
  type RPCClientTransportOptions
} from "../rpc";
export type {
  MCPElicitationHandler,
  MCPElicitationHandlers
} from "./connection";
export type { McpClientOptions } from "../types";
export {
  MCPAuthorizationRequiredError,
  MCPConnectionNotFoundError
} from "./errors";
export type { MCPAITool, MCPAIToolSet } from "./ai-tools";
export type {
  MCPClientOAuthCallbackConfig,
  MCPClientOAuthResult
} from "./oauth-callback";
export { MCP_SERVER_ID_MAX_LENGTH, normalizeServerId } from "./url-policy";
