import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "./json-schema-types";
import { runCode } from "./run-code";
import { sanitizeToolName } from "./utils";
import type { Executor, ResolvedProvider, ToolProvider } from "./executor";
import type { ToolDescriptors } from "./tool-types";

export type ProviderSnippet = {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  code: string;
};

export type ProviderSnippetRecord = Record<string, ProviderSnippet>;

export type ProviderOptions = {
  name: string;
  instructions?: string;
  snippets?: ProviderSnippetRecord;
  executor?: Executor;
};

function providerTypes(
  providerName: string,
  descriptors: JsonSchemaToolDescriptors,
  instructions?: string
): string {
  const types = generateTypesFromJsonSchema(descriptors).replace(
    "declare const codemode",
    `declare const ${sanitizeToolName(providerName)}`
  );
  return [instructions, types].filter(Boolean).join("\n\n");
}

function resolvedProviderFromToolProvider(
  provider: ToolProvider
): ResolvedProvider {
  return {
    name: provider.name,
    fns: Object.fromEntries(
      Object.entries(provider.tools).flatMap(([name, tool]) => {
        const execute =
          tool && typeof tool === "object" && "execute" in tool
            ? (tool as { execute?: (input: unknown) => Promise<unknown> })
                .execute
            : undefined;
        return execute ? [[name, execute]] : [];
      })
    )
  };
}

async function addSnippets(
  provider: ToolProvider,
  snippets: ProviderSnippetRecord | undefined,
  executor: Executor | undefined,
  descriptors: JsonSchemaToolDescriptors
): Promise<void> {
  if (!snippets) return;
  for (const [name, snippet] of Object.entries(snippets)) {
    const sdkName = sanitizeToolName(name);
    descriptors[sdkName] = {
      description: snippet.description,
      inputSchema: snippet.inputSchema as JSONSchema7,
      outputSchema: snippet.outputSchema as JSONSchema7 | undefined
    };
    provider.tools[sdkName] = {
      description: snippet.description,
      inputSchema: snippet.inputSchema,
      outputSchema: snippet.outputSchema,
      execute: async (args: unknown) => {
        if (!executor)
          throw new Error(`Snippet "${name}" requires an executor.`);
        const result = await runCode({
          executor,
          code: `async () => {\n  const snippet = (${snippet.code});\n  return await snippet(${JSON.stringify(args)});\n}`,
          providers: [resolvedProviderFromToolProvider(provider)]
        });
        return result.result;
      }
    };
  }
}

export async function toolsetProvider(
  options: ProviderOptions & { tools: ToolDescriptors | ToolSet }
): Promise<ToolProvider> {
  const provider: ToolProvider = {
    name: sanitizeToolName(options.name),
    tools: options.tools,
    types: options.instructions
  };
  const descriptors: JsonSchemaToolDescriptors = {};
  await addSnippets(provider, options.snippets, options.executor, descriptors);
  if (Object.keys(descriptors).length > 0) {
    provider.types = providerTypes(
      provider.name,
      descriptors,
      options.instructions
    );
  }
  return provider;
}

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
): Promise<ToolProvider> {
  const providerName = sanitizeToolName(options.name);
  const tools = options.connection.tools?.length
    ? options.connection.tools
    : options.connection.fetchTools
      ? await options.connection.fetchTools()
      : [];
  const provider: ToolProvider = { name: providerName, tools: {} };
  const descriptors: JsonSchemaToolDescriptors = {};

  for (const tool of tools) {
    const sdkName = sanitizeToolName(tool.name);
    descriptors[sdkName] = {
      description: tool.description,
      inputSchema: tool.inputSchema as JSONSchema7,
      outputSchema: tool.outputSchema as JSONSchema7 | undefined
    };
    provider.tools[sdkName] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
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
  provider.types = providerTypes(
    providerName,
    descriptors,
    [options.connection.instructions, options.instructions]
      .filter(Boolean)
      .join("\n\n")
  );
  return provider;
}

export type OpenApiRequestOptions = {
  operationId: string;
  params?: Record<string, unknown>;
  body?: unknown;
};

export async function openApiProvider(
  options: ProviderOptions & {
    spec: Record<string, unknown>;
    request: (options: OpenApiRequestOptions) => Promise<unknown>;
  }
): Promise<ToolProvider> {
  const providerName = sanitizeToolName(options.name);
  const descriptors: JsonSchemaToolDescriptors = {
    search: {
      description: "Search the OpenAPI spec.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    },
    request: {
      description: "Execute an OpenAPI operation by operationId.",
      inputSchema: {
        type: "object",
        properties: {
          operationId: { type: "string" },
          params: { type: "object", additionalProperties: true },
          body: {}
        },
        required: ["operationId"]
      }
    }
  };
  const provider: ToolProvider = {
    name: providerName,
    tools: {
      search: {
        description: "Search the OpenAPI spec.",
        inputSchema: descriptors.search.inputSchema,
        execute: async ({ query }: { query: string }) => {
          const q = query.toLowerCase();
          const paths = (options.spec.paths ?? {}) as Record<
            string,
            Record<string, unknown>
          >;
          return Object.entries(paths).flatMap(([path, methods]) =>
            Object.entries(methods).flatMap(([method, operation]) => {
              const op = operation as {
                operationId?: string;
                summary?: string;
                description?: string;
              };
              const haystack = [
                path,
                method,
                op.operationId,
                op.summary,
                op.description
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return haystack.includes(q)
                ? [
                    {
                      path,
                      method,
                      operationId: op.operationId,
                      summary: op.summary
                    }
                  ]
                : [];
            })
          );
        }
      },
      request: {
        description: "Execute an OpenAPI operation by operationId.",
        inputSchema: descriptors.request.inputSchema,
        execute: options.request as (input: unknown) => Promise<unknown>
      }
    }
  };
  await addSnippets(provider, options.snippets, options.executor, descriptors);
  provider.types = providerTypes(
    providerName,
    descriptors,
    options.instructions
  );
  return provider;
}
