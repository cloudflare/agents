import type { JSONSchema7 } from "json-schema";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { sanitizeToolName } from "../utils";
import { CodemodeConnector, type ConnectorTools } from "./base";

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpConnectionLike {
  name?: string;
  client: Pick<Client, "callTool">;
  instructions?: string;
  tools?: McpTool[];
  fetchTools?: () => Promise<McpTool[]>;
}

function unwrapMcpResult(result: CallToolResult): unknown {
  if ("toolResult" in result) return result.toolResult;
  if (result.isError) {
    const msg =
      result.content
        ?.filter((c) => c.type === "text")
        .map((c) => ("text" in c ? c.text : ""))
        .join("\n") || "Tool call failed";
    throw new Error(msg);
  }
  if (result.structuredContent != null) return result.structuredContent;
  const allText =
    result.content?.length > 0 &&
    result.content.every((c) => c.type === "text");
  if (!allText) return result;
  const text = result.content
    .map((c) => ("text" in c ? c.text : ""))
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Connector backed by an MCP connection. Each MCP tool becomes one entry in
 * the tools record, executing through `connection.client.callTool()`.
 *
 * Subclass and implement `createConnection()`. To mark a derived tool as
 * requiring approval or to attach a revert, override the `tool(name, t)`
 * decoration hook from the base class.
 */
export abstract class McpConnector<
  Env = unknown,
  Props = unknown
> extends CodemodeConnector<Env, Props> {
  protected abstract createConnection():
    | Promise<McpConnectionLike>
    | McpConnectionLike;

  protected toolName(tool: McpTool): string {
    return sanitizeToolName(tool.name);
  }

  // Cached connection
  #connectionPromise?: Promise<McpConnectionLike>;
  protected getConnection(): Promise<McpConnectionLike> {
    return (this.#connectionPromise ??= Promise.resolve(
      this.createConnection()
    ));
  }

  protected async fetchTools(): Promise<McpTool[]> {
    const connection = await this.getConnection();
    if (connection.tools?.length) return connection.tools;
    if (connection.fetchTools) return connection.fetchTools();
    return [];
  }

  override async describe() {
    const desc = await super.describe();
    const connection = await this.getConnection();
    if (connection.instructions) {
      desc.instructions = [connection.instructions, desc.instructions]
        .filter(Boolean)
        .join("\n\n");
    }
    return desc;
  }

  protected override async tools(): Promise<ConnectorTools> {
    const mcpTools = await this.fetchTools();
    const out: ConnectorTools = {};
    const sources = new Map<string, string>();
    for (const tool of mcpTools) {
      const name = this.toolName(tool);
      const existing = sources.get(name);
      if (existing !== undefined) {
        throw new Error(
          `MCP tools "${existing}" and "${tool.name}" on ${this.name()} both ` +
            `map to "${name}". Override toolName() to disambiguate.`
        );
      }
      sources.set(name, tool.name);
      out[name] = {
        description: tool.description,
        inputSchema: tool.inputSchema as JSONSchema7,
        outputSchema: tool.outputSchema as JSONSchema7 | undefined,
        execute: async (args: unknown) => {
          const connection = await this.getConnection();
          return unwrapMcpResult(
            await connection.client.callTool({
              name: tool.name,
              arguments: args as Record<string, unknown>
            })
          );
        }
      };
    }
    return out;
  }
}
