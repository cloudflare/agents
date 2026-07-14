import type {
  CallToolRequest,
  CallToolRequestOptions,
  CallToolResult,
  Client,
  ListToolsResult
} from "@modelcontextprotocol/client";
import type { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult as LegacyCallToolResult,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequest
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions as LegacyRequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

export type LegacyCallToolResultSchema =
  | typeof CallToolResultSchema
  | typeof CompatibilityCallToolResultSchema;

export type CallToolSchemaOrOptions =
  | LegacyCallToolResultSchema
  | CallToolRequestOptions;

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

function isLegacyResultSchema(
  value: CallToolSchemaOrOptions | undefined
): value is LegacyCallToolResultSchema {
  return (
    typeof (value as { parse?: unknown } | undefined)?.parse === "function"
  );
}

function normalizeCallToolArguments(
  schemaOrOptions?: CallToolSchemaOrOptions,
  options?: CallToolRequestOptions
): {
  schema?: LegacyCallToolResultSchema;
  options?: CallToolRequestOptions;
} {
  return isLegacyResultSchema(schemaOrOptions)
    ? { schema: schemaOrOptions, options }
    : { options: schemaOrOptions ?? options };
}

/**
 * Invoke SDK v2 while preserving the deprecated v1 result-schema overload.
 * The v2 request funnel still owns decoding and automatic MRTR.
 */
export function callV2Tool(
  client: Client,
  params: CallToolRequest["params"],
  schemaOrOptions?: CallToolSchemaOrOptions,
  options?: CallToolRequestOptions
): Promise<CallToolResult> {
  const normalized = normalizeCallToolArguments(schemaOrOptions, options);
  if (normalized.schema) {
    return client.request(
      { method: "tools/call", params },
      normalized.schema as never,
      normalized.options
    ) as Promise<CallToolResult>;
  }
  return client.callTool(params, normalized.options);
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
    const modern = client as Client;
    const listTools = modern.listTools.bind(modern);
    const callTool = modern.callTool.bind(modern);
    return {
      listTools: (params, options) => listTools(params, options),
      callTool: (params, schemaOrOptions, options) => {
        const normalized = normalizeCallToolArguments(schemaOrOptions, options);
        const pending = normalized.schema
          ? modern.request(
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
        normalized.schema,
        normalized.options as LegacyRequestOptions
      ) as Promise<LegacyCallToolResult>;
    }
  };
}
