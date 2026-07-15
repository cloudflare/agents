import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MCPClientConnection } from "./client-connection";

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
 * Structural tool set returned by MCPClientManager.getAITools(). Compatible
 * with the AI SDK without importing its types into the core declaration graph.
 */
export type MCPAIToolSet = Record<string, MCPAITool>;

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type CallTool = (
  params: CallToolRequest["params"] & { serverId: string }
) => Promise<CallToolResult>;

type CacheEntry = {
  serverId: string;
  /** Catalog arrays are replaced after discovery and tools/list_changed. */
  catalog: Tool[];
  tools: MCPAIToolSet;
};

/** Cache expensive JSON Schema to Zod conversion by connection catalog. */
export class MCPAIToolCache {
  readonly #entries = new WeakMap<MCPClientConnection, CacheEntry>();

  constructor(private readonly callTool: CallTool) {}

  get(serverId: string, connection: MCPClientConnection): MCPAIToolSet {
    const cached = this.#entries.get(connection);
    if (cached?.serverId === serverId && cached.catalog === connection.tools) {
      return cached.tools;
    }

    const tools: MCPAIToolSet = {};
    for (const tool of connection.tools) {
      try {
        const key = `tool_${serverId.replace(/-/g, "")}_${tool.name}`;
        tools[key] = {
          description: tool.description,
          title: tool.title ?? tool.annotations?.title,
          execute: (args) => this.#execute(serverId, tool.name, args),
          inputSchema: z.fromJSONSchema(
            (tool.inputSchema ?? { type: "object" }) as Parameters<
              typeof z.fromJSONSchema
            >[0]
          ),
          outputSchema: tool.outputSchema
            ? z.fromJSONSchema(
                tool.outputSchema as Parameters<typeof z.fromJSONSchema>[0]
              )
            : undefined
        };
      } catch (error) {
        console.warn(
          `[getAITools] Skipping tool "${tool.name}" from "${serverId}": ${error}`
        );
      }
    }

    this.#entries.set(connection, {
      serverId,
      catalog: connection.tools,
      tools
    });
    return tools;
  }

  async #execute(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const result = await this.callTool({ serverId, name, arguments: args });
    if (!result.isError) return result;

    const content = result.content as
      | Array<{ type: string; text?: string }>
      | undefined;
    const text = content?.[0];
    throw new Error(
      text?.type === "text" && text.text ? text.text : "Tool call failed"
    );
  }
}
