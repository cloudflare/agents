import type { JSONSchema7 } from "json-schema";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { SimpleToolRecord } from "../executor";
import { sanitizeToolName } from "../utils";
import type { NamedToolProvider, ProviderOptions } from "./types";
import { addSnippets, renderProviderTypes } from "./shared";

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpConnectionLike {
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

export async function mcpProvider(
  options: ProviderOptions & { connection: McpConnectionLike }
): Promise<NamedToolProvider> {
  const providerName = sanitizeToolName(options.name);
  const tools = options.connection.tools?.length
    ? options.connection.tools
    : options.connection.fetchTools
      ? await options.connection.fetchTools()
      : [];
  const provider: NamedToolProvider = { name: providerName, tools: {} };
  const descriptors: JsonSchemaToolDescriptors = {};

  for (const tool of tools) {
    const sdkName = sanitizeToolName(tool.name);
    descriptors[sdkName] = {
      description: tool.description,
      inputSchema: tool.inputSchema as JSONSchema7,
      outputSchema: tool.outputSchema as JSONSchema7 | undefined
    };
    (provider.tools as SimpleToolRecord)[sdkName] = {
      description: tool.description,
      execute: async (args: unknown) =>
        unwrapMcpResult(
          await options.connection.client.callTool({
            name: tool.name,
            arguments: args as Record<string, unknown>
          })
        )
    };
  }

  await addSnippets(provider, options.snippets, options.executor, descriptors);
  provider.docs = {
    descriptors,
    instructions: [options.connection.instructions, options.instructions]
      .filter(Boolean)
      .join("\n\n")
  };
  provider.types = renderProviderTypes(providerName, provider.docs);
  return provider;
}
