import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "./json-schema-types";
import { sanitizeToolName } from "./utils";
import type { Executor } from "./executor";

import type { JSONSchema7 } from "json-schema";

// -- Shared utilities --

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 6000;
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN;

function truncateResponse(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : (JSON.stringify(content, null, 2) ?? "undefined");

  if (text.length <= MAX_CHARS) {
    return text;
  }

  const truncated = text.slice(0, MAX_CHARS);
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN);

  return `${truncated}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- codeMcpServer --

const CODE_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

{{example}}`;

/**
 * Wrap an existing MCP server with a single codemode `code` tool.
 *
 * Connects to the upstream server via in-memory transport, discovers its
 * tools, and returns a new MCP server with a `code` tool that exposes
 * all upstream tools as typed methods.
 */
export interface CodeMcpServerOptions {
  server: McpServer;
  executor: Executor;
}

export async function codeMcpServer(
  options: CodeMcpServerOptions
): Promise<McpServer> {
  const { server, executor } = options;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: "codemode-proxy", version: "1.0.0" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  // Build type hints
  const toolDescriptors: JsonSchemaToolDescriptors = {};
  for (const tool of tools) {
    toolDescriptors[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema as JSONSchema7
    };
  }
  const types = generateTypesFromJsonSchema(toolDescriptors);

  // Build executor fns — each upstream tool is a direct method
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const tool of tools) {
    const toolName = tool.name;
    fns[toolName] = async (args: unknown) => {
      const result = await client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown>
      });
      return result;
    };
  }

  // Build example from first upstream tool with placeholder args
  const firstTool = tools[0];
  let example = "";
  if (firstTool) {
    const schema = firstTool.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const props = schema.properties ?? {};
    const parts: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
      if (prop.type === "number" || prop.type === "integer") {
        parts.push(`${key}: 0`);
      } else if (prop.type === "boolean") {
        parts.push(`${key}: true`);
      } else {
        parts.push(`${key}: "..."`);
      }
    }
    const args = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
    example = `Example: async () => { const r = await codemode.${sanitizeToolName(firstTool.name)}(${args}); return r; }`;
  }

  const description = CODE_DESCRIPTION.replace("{{types}}", types).replace(
    "{{example}}",
    example
  );

  const codemodeServer = new McpServer({
    name: "codemode",
    version: "1.0.0"
  });

  codemodeServer.registerTool(
    "code",
    {
      description,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute")
      }
    },
    async ({ code }) => {
      try {
        const result = await executor.execute(code, fns);
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text" as const, text: truncateResponse(result.result) }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${formatError(error)}` }
          ],
          isError: true
        };
      }
    }
  );

  return codemodeServer;
}

// -- openApiMcpServer --

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
}

export interface OpenApiMcpServerOptions {
  spec: Record<string, unknown>;
  executor: Executor;
  request: (options: RequestOptions) => Promise<unknown>;
  name?: string;
  version?: string;
  description?: string;
}

/**
 * Resolve internal $ref pointers in a JSON object against the root document.
 * Only handles `#/` internal refs. External file refs are left as-is.
 */
function resolveRefs(
  obj: unknown,
  root: Record<string, unknown>,
  seen = new Set<string>()
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj))
    return obj.map((item) => resolveRefs(item, root, seen));

  const record = obj as Record<string, unknown>;

  if ("$ref" in record && typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    if (!ref.startsWith("#/")) return record;
    seen.add(ref);

    const parts = ref
      .slice(2)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let resolved: unknown = root;
    for (const part of parts) {
      resolved = (resolved as Record<string, unknown>)?.[part];
    }
    const result = resolveRefs(resolved, root, seen);
    seen.delete(ref);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, root, seen);
  }
  return result;
}

const SPEC_TYPES = `
// OpenAPI 3.x spec with $refs resolved inline.
// The spec object follows the standard OpenAPI 3.x structure.

interface OperationObject {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: "query" | "header" | "path" | "cookie";
    required?: boolean;
    schema?: unknown;
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, {
    description?: string;
    content?: Record<string, { schema?: unknown }>;
  }>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

interface PathItem {
  summary?: string;
  description?: string;
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
  parameters?: OperationObject["parameters"];
}

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, PathItem>;
  servers?: Array<{ url: string; description?: string }>;
  components?: Record<string, unknown>;
  tags?: Array<{ name: string; description?: string }>;
}

declare const codemode: {
  spec(): Promise<OpenApiSpec>;
};
`;

const REQUEST_TYPES = `
interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
}

declare const codemode: {
  request(options: RequestOptions): Promise<unknown>;
};
`;

/**
 * Create an MCP server with search + execute tools from an OpenAPI spec.
 *
 * The search tool lets the LLM query the spec to find endpoints.
 * The execute tool lets the LLM call the API via a user-provided
 * request function that runs on the host (auth never enters the sandbox).
 */
export function openApiMcpServer(options: OpenApiMcpServerOptions): McpServer {
  const {
    executor,
    request: requestFn,
    name = "openapi",
    version = "1.0.0",
    description
  } = options;

  const resolved = resolveRefs(options.spec, options.spec);

  const server = new McpServer({ name, version });

  // --- search tool ---
  server.registerTool(
    "search",
    {
      description: `Search the OpenAPI spec. All $refs are pre-resolved inline.

Types:
${SPEC_TYPES}

Your code must be an async arrow function that returns the result.

Examples:

// List all paths
async () => {
  const spec = await codemode.spec();
  return Object.keys(spec.paths);
}

// Find endpoints by tag
async () => {
  const spec = await codemode.spec();
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'your_tag')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}`,
      inputSchema: {
        code: z
          .string()
          .describe("JavaScript async arrow function to search the spec")
      }
    },
    async ({ code }) => {
      try {
        const result = await executor.execute(code, {
          spec: async () => resolved
        });
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text" as const, text: truncateResponse(result.result) }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${formatError(error)}` }
          ],
          isError: true
        };
      }
    }
  );

  // --- execute tool ---
  const executeDescription = `Execute API calls using JavaScript code. First use 'search' to find the right endpoints.

Available in your code:
${REQUEST_TYPES}

Your code must be an async arrow function that returns the result.

Example:
async () => {
  return await codemode.request({ method: "GET", path: "/your/endpoint" });
}${description ? `\n\n${description}` : ""}`;

  server.registerTool(
    "execute",
    {
      description: executeDescription,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute")
      }
    },
    async ({ code }) => {
      try {
        const result = await executor.execute(code, {
          request: (args: unknown) => requestFn(args as RequestOptions)
        });
        if (result.error) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${result.error}` }
            ],
            isError: true
          };
        }
        return {
          content: [
            { type: "text" as const, text: truncateResponse(result.result) }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${formatError(error)}` }
          ],
          isError: true
        };
      }
    }
  );

  return server;
}
