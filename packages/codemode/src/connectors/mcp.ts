import type { JSONSchema7 } from "json-schema";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import { sanitizeToolName } from "../utils";
import { CodemodeConnector } from "./base";

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
 * Connector backed by an MCP connection.
 *
 * Subclass and implement `createConnection()`.
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

  // Cached connection and tools
  #connectionPromise?: Promise<McpConnectionLike>;
  protected getConnection(): Promise<McpConnectionLike> {
    return (this.#connectionPromise ??= Promise.resolve(
      this.createConnection()
    ));
  }

  #toolsPromise?: Promise<McpTool[]>;
  protected listTools(): Promise<McpTool[]> {
    return (this.#toolsPromise ??= this.fetchTools());
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

  protected override async loadDescriptors(): Promise<JsonSchemaToolDescriptors> {
    const tools = await this.listTools();
    const descriptors: JsonSchemaToolDescriptors = {};
    for (const tool of tools) {
      descriptors[this.toolName(tool)] = {
        description: tool.description,
        inputSchema: tool.inputSchema as JSONSchema7,
        outputSchema: tool.outputSchema as JSONSchema7 | undefined
      };
    }
    return descriptors;
  }

  async executeTool(method: string, args: unknown): Promise<unknown> {
    const connection = await this.getConnection();
    const tools = await this.listTools();
    const tool = tools.find((t) => this.toolName(t) === method);
    if (!tool) throw new Error(`Tool "${method}" not found on ${this.name()}`);
    return unwrapMcpResult(
      await connection.client.callTool({
        name: tool.name,
        arguments: args as Record<string, unknown>
      })
    );
  }
}
