import type {
  CallToolRequest,
  CallToolRequestOptions,
  CallToolResult,
  Client
} from "@modelcontextprotocol/client";

/**
 * A v1 result schema such as `CallToolResultSchema` or
 * `CompatibilityCallToolResultSchema` from `@modelcontextprotocol/sdk`.
 *
 * Typed structurally so the MCP client (reachable from the root `agents`
 * entry) does not depend on `@modelcontextprotocol/sdk`, which is an optional
 * peer.
 */
export type LegacyCallToolResultSchema = {
  parse(data: unknown): unknown;
};

export type CallToolSchemaOrOptions =
  | LegacyCallToolResultSchema
  | CallToolRequestOptions;

function isLegacyResultSchema(
  value: CallToolSchemaOrOptions | undefined
): value is LegacyCallToolResultSchema {
  return (
    typeof (value as { parse?: unknown } | undefined)?.parse === "function"
  );
}

export function normalizeCallToolArguments(
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
