import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { normalizeCode } from "./normalize";
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
    typeof content === "string" ? content : JSON.stringify(content, null, 2);

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
export async function codeMcpServer(
  server: McpServer,
  executor: Executor
): Promise<McpServer> {
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
    fns[sanitizeToolName(toolName)] = async (args: unknown) => {
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
        code: z
          .string()
          .describe("JavaScript async arrow function to execute")
      }
    },
    async ({ code }) => {
      try {
        const result = await executor.execute(normalizeCode(code), fns);
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
  spec: unknown;
  executor: Executor;
  request: (options: RequestOptions) => Promise<unknown>;
  name?: string;
  version?: string;
  extraDescription?: string;
}

/**
 * Resolve $ref pointers in a JSON object against the root spec.
 */
function resolveRefs(
  obj: unknown,
  spec: Record<string, unknown>,
  seen = new Set<string>()
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => resolveRefs(item, spec, seen));

  const record = obj as Record<string, unknown>;

  if ("$ref" in record && typeof record.$ref === "string") {
    const ref = record.$ref;
    if (seen.has(ref)) return { $circular: ref };
    seen.add(ref);

    const parts = ref.replace("#/", "").split("/");
    let resolved: unknown = spec;
    for (const part of parts) {
      resolved = (resolved as Record<string, unknown>)?.[part];
    }
    return resolveRefs(resolved, spec, seen);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveRefs(value, spec, seen);
  }
  return result;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface OperationObject {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
}

/**
 * Process a raw OpenAPI spec: resolve $refs and extract paths.
 */
function processSpec(spec: Record<string, unknown>): {
  paths: Record<string, Record<string, unknown>>;
} {
  const rawPaths = (spec.paths || {}) as Record<
    string,
    Record<string, OperationObject>
  >;
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, pathItem] of Object.entries(rawPaths)) {
    if (!pathItem) continue;
    paths[path] = {};

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op) {
        paths[path][method] = {
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          parameters: resolveRefs(op.parameters, spec),
          requestBody: resolveRefs(op.requestBody, spec),
          responses: resolveRefs(op.responses, spec)
        };
      }
    }
  }

  return { paths };
}

const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
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

declare function request(options: RequestOptions): Promise<unknown>;
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
    extraDescription
  } = options;

  const processed = processSpec(options.spec as Record<string, unknown>);

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

// Find endpoints by tag
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'users')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint details
async () => {
  const op = spec.paths['/users']?.get;
  return { summary: op?.summary, parameters: op?.parameters };
}`,
      inputSchema: {
        code: z
          .string()
          .describe("JavaScript async arrow function to search the spec")
      }
    },
    async ({ code }) => {
      try {
        const result = await executor.execute(
          normalizeCode(code),
          {},
          { spec: processed }
        );
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
  return await request({ method: "GET", path: "/users", query: { limit: 10 } });
}${extraDescription ? `\n\n${extraDescription}` : ""}`;

  server.registerTool(
    "execute",
    {
      description: executeDescription,
      inputSchema: {
        code: z
          .string()
          .describe("JavaScript async arrow function to execute")
      }
    },
    async ({ code }) => {
      try {
        const result = await executor.execute(
          normalizeCode(code),
          {},
          { request: requestFn }
        );
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
