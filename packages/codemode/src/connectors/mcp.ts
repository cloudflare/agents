import type { JSONSchema7 } from "json-schema";
import { sanitizeToolName } from "../utils";
import { CodemodeConnector, type ConnectorTools } from "./base";

type CallToolResult = {
  toolResult?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
};

type McpJsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

/** Structural tool shape shared by MCP SDK v1 and v2. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  [key: string]: unknown;
};

/** Structural boundary compatible with both the legacy and v2 MCP clients. */
export interface McpConnectionLike {
  name?: string;
  client: {
    callTool(params: {
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<CallToolResult>;
  };
  instructions?: string;
  tools?: McpTool[];
  fetchTools?: () => Promise<McpTool[]>;
}

function unwrapMcpResult(result: CallToolResult): unknown {
  if (result.toolResult !== undefined) return result.toolResult;
  if (result.isError) {
    const msg =
      result.content
        ?.filter((c) => c.type === "text")
        .map((c) => ("text" in c ? c.text : ""))
        .join("\n") || "Tool call failed";
    throw new Error(msg);
  }
  if (result.structuredContent != null) return result.structuredContent;
  const content = result.content;
  const allText =
    content !== undefined &&
    content.length > 0 &&
    content.every((c) => c.type === "text");
  if (!allText) return result;
  const text = content.map((c) => c.text ?? "").join("\n");
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
