import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { z } from "zod";
import { type MCPClientConnection, MCPConnectionState } from "./connection";

/** One MCP tool converted for the AI SDK. */
export type MCPAITool = {
  description?: string;
  title?: string;
  execute: (
    args: Record<string, unknown>,
    options?: unknown
  ) => Promise<unknown>;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
};

/**
 * Structural tool set returned by {@link MCPClientManager.getAITools}.
 * Compatible with the AI SDK without importing its types into the core
 * `agents` declaration graph.
 */
export type MCPAIToolSet = Record<string, MCPAITool>;

type MCPAIConvertedSchemas = {
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
};

type MCPAISchemaSource = {
  tool: Tool;
  inputSchema: Tool["inputSchema"] | undefined;
  outputSchema: Tool["outputSchema"] | undefined;
};

type MCPAISchemaCacheSlot = MCPAISchemaSource &
  (
    | { status: "converted"; converted: MCPAIConvertedSchemas }
    | { status: "failed"; error: string }
  );

type MCPAISchemaCacheEntry = {
  catalog: Tool[];
  converted: Array<MCPAISchemaCacheSlot | undefined>;
};

/** A namespaced tool call, as `MCPClientManager.callTool()` accepts it. */
type NamespacedToolCall = (params: {
  arguments: Record<string, unknown>;
  name: string;
  serverId: string;
}) => Promise<CallToolResult>;

/**
 * Converts MCP tool catalogs into AI SDK tool records. Converted schemas are
 * cached per connection while that connection keeps the same catalog array
 * and schema-source identities; tool records and `execute` closures are
 * rebuilt on every call.
 */
export class MCPAIToolConverter {
  /** Only the current catalog is cached, so old schema graphs are released. */
  readonly #schemas = new WeakMap<MCPClientConnection, MCPAISchemaCacheEntry>();

  /**
   * Convert the tools of the given connections.
   *
   * @param connections - Connections keyed by server id.
   * @param callTool - Runs a tool call for a tool's `execute`.
   * @returns AI SDK tools keyed `tool_<serverId>_<toolName>`.
   */
  convert(
    connections: Record<string, MCPClientConnection>,
    callTool: NamespacedToolCall
  ): MCPAIToolSet {
    const entries: [string, MCPAITool][] = [];

    for (const [serverId, conn] of Object.entries(connections)) {
      if (
        conn.connectionState !== MCPConnectionState.READY &&
        conn.connectionState !== MCPConnectionState.AUTHENTICATING
      ) {
        console.warn(
          `[getAITools] WARNING: Reading tools from connection ${serverId} in state "${conn.connectionState}". Tools may not be loaded yet.`
        );
      }

      const catalog = conn.tools;
      let cache = this.#schemas.get(conn);
      if (!cache || cache.catalog !== catalog) {
        cache = { catalog, converted: [] };
        this.#schemas.set(conn, cache);
      }

      for (const [index, tool] of catalog.entries()) {
        const toolName = tool.name;
        try {
          const sourceInputSchema = tool.inputSchema;
          const sourceOutputSchema = tool.outputSchema;
          let slot = cache.converted[index];
          if (
            !slot ||
            slot.tool !== tool ||
            slot.inputSchema !== sourceInputSchema ||
            slot.outputSchema !== sourceOutputSchema
          ) {
            try {
              slot = {
                status: "converted",
                tool,
                inputSchema: sourceInputSchema,
                outputSchema: sourceOutputSchema,
                converted: {
                  inputSchema: sourceInputSchema
                    ? z.fromJSONSchema(
                        sourceInputSchema as Parameters<
                          typeof z.fromJSONSchema
                        >[0]
                      )
                    : z.fromJSONSchema({ type: "object" }),
                  outputSchema: sourceOutputSchema
                    ? z.fromJSONSchema(
                        sourceOutputSchema as Parameters<
                          typeof z.fromJSONSchema
                        >[0]
                      )
                    : undefined
                }
              };
            } catch (error) {
              const errorText = String(error);
              cache.converted[index] = {
                status: "failed",
                tool,
                inputSchema: sourceInputSchema,
                outputSchema: sourceOutputSchema,
                error: errorText
              };
              console.warn(
                `[getAITools] Skipping tool "${toolName}" from "${serverId}": ${errorText}`
              );
              continue;
            }
            cache.converted[index] = slot;
          }

          if (slot.status === "failed") continue;

          const toolKey = `tool_${serverId.replace(/-/g, "")}_${toolName}`;
          const title = tool.title ?? tool.annotations?.title;
          const description = tool.description;
          entries.push([
            toolKey,
            {
              description,
              title,
              execute: async (args) => {
                const result = await callTool({
                  arguments: args,
                  name: toolName,
                  serverId
                });
                if (result.isError) {
                  const content = result.content as
                    | Array<{ type: string; text?: string }>
                    | undefined;
                  const textContent = content?.[0];
                  const message =
                    textContent?.type === "text" && textContent.text
                      ? textContent.text
                      : "Tool call failed";
                  throw new Error(message);
                }
                return result;
              },
              inputSchema: slot.converted.inputSchema,
              outputSchema: slot.converted.outputSchema
            }
          ]);
        } catch (error) {
          console.warn(
            `[getAITools] Skipping tool "${toolName}" from "${serverId}": ${error}`
          );
        }
      }

      // Release removed slots when a public catalog array is spliced in place.
      cache.converted.length = catalog.length;
    }

    return Object.fromEntries(entries);
  }
}
