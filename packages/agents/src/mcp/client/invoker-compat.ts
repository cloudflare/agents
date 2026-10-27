import type {
  CallToolRequest,
  CallToolRequestOptions,
  Client,
  ListToolsResult
} from "@modelcontextprotocol/client";
import type { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult as LegacyCallToolResult,
  ListToolsRequest
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions as LegacyRequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolSchemaOrOptions,
  normalizeCallToolArguments
} from "./invoker";

// Accepts both SDK v1 and v2 clients. Kept separate from `./invoker` because
// its types depend on `@modelcontextprotocol/sdk`, an optional peer that only
// the x402 entry needs.

export type CompatibleMcpClient = Client | LegacyClient;

export interface BoundMcpClientInvoker {
  listTools(
    params?: ListToolsRequest["params"],
    options?: CallToolRequestOptions
  ): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest["params"],
    schemaOrOptions?: CallToolSchemaOrOptions,
    options?: CallToolRequestOptions
  ): Promise<LegacyCallToolResult>;
}

/**
 * Bind the original methods before decorators such as x402 replace them. All
 * generation-specific calling conventions stay behind this small interface.
 */
export function bindMcpClient(
  client: CompatibleMcpClient
): BoundMcpClientInvoker {
  const isV2 =
    "getProtocolEra" in client &&
    typeof (client as { getProtocolEra?: unknown }).getProtocolEra ===
      "function";

  if (isV2) {
    const v2Client = client as Client;
    const listTools = v2Client.listTools.bind(v2Client);
    const callTool = v2Client.callTool.bind(v2Client);
    return {
      listTools: (params, options) => listTools(params, options),
      callTool: (params, schemaOrOptions, options) => {
        const normalized = normalizeCallToolArguments(schemaOrOptions, options);
        const pending = normalized.schema
          ? v2Client.request(
              { method: "tools/call", params },
              normalized.schema as never,
              normalized.options
            )
          : callTool(params, normalized.options);
        return pending as Promise<LegacyCallToolResult>;
      }
    };
  }

  const legacy = client as LegacyClient;
  const listTools = legacy.listTools.bind(legacy);
  const callTool = legacy.callTool.bind(legacy);
  return {
    listTools: (params, options) =>
      listTools(
        params,
        options as LegacyRequestOptions
      ) as Promise<ListToolsResult>,
    callTool: (params, schemaOrOptions, options) => {
      const normalized = normalizeCallToolArguments(schemaOrOptions, options);
      return callTool(
        params as Parameters<LegacyClient["callTool"]>[0],
        normalized.schema as Parameters<LegacyClient["callTool"]>[1],
        normalized.options as LegacyRequestOptions
      ) as Promise<LegacyCallToolResult>;
    }
  };
}
