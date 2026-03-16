import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { DynamicWorkerExecutor } from "../executor";
import { codeMcpServer, openApiMcpServer } from "../mcp";

function createUpstreamServer() {
  const server = new McpServer({
    name: "test-tools",
    version: "1.0.0"
  });

  server.registerTool(
    "add",
    {
      description: "Add two numbers",
      inputSchema: {
        a: z.number().describe("First number"),
        b: z.number().describe("Second number")
      }
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }]
    })
  );

  server.registerTool(
    "greet",
    {
      description: "Generate a greeting",
      inputSchema: {
        name: z.string().describe("Name to greet")
      }
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }]
    })
  );

  return server;
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function callText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe("codeMcpServer", () => {
  it("should expose a single code tool", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["code"]);

    await client.close();
  });

  it("code tool description should declare codemode with add and greet methods", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const { tools } = await client.listTools();

    expect(tools[0].description).toMatchSnapshot();

    await client.close();
  });

  it("code tool should call upstream add(10, 32) and return 42", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const r = await codemode.add({ a: 10, b: 32 });
          return r;
        }`
      }
    });

    expect(JSON.parse(callText(result)).content[0].text).toBe("42");

    await client.close();
  });

  it("code tool should chain add then greet", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const sum = await codemode.add({ a: 5, b: 3 });
          const greeting = await codemode.greet({ name: "Result is " + sum.content[0].text });
          return greeting;
        }`
      }
    });

    expect(JSON.parse(callText(result)).content[0].text).toBe(
      "Hello, Result is 8!"
    );

    await client.close();
  });

  it("code tool should return error on throw", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => { throw new Error('test error'); }"
      }
    });

    expect(callText(result)).toBe("Error: test error");

    await client.close();
  });

  it("code tool should handle undefined return value", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => { return undefined; }"
      }
    });

    expect(callText(result)).toBe("undefined");

    await client.close();
  });

  it("code tool should handle null return value", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => { return null; }"
      }
    });

    expect(callText(result)).toBe("null");

    await client.close();
  });

  it("code tool should handle non-existent upstream tool", async () => {
    const upstream = createUpstreamServer();
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => { return await codemode.nonexistent({}); }"
      }
    });

    expect(callText(result)).toBe('Error: Tool "nonexistent" not found');

    await client.close();
  });
});

describe("openApiMcpServer", () => {
  const sampleSpec = {
    openapi: "3.0.0",
    paths: {
      "/users": {
        get: {
          summary: "List users",
          tags: ["users"],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer" }
            }
          ]
        },
        post: {
          summary: "Create user",
          tags: ["users"],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } }
                }
              }
            }
          }
        }
      },
      "/users/{id}": {
        get: {
          summary: "Get user by ID",
          tags: ["users"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" }
            }
          ]
        }
      }
    }
  };

  it("should expose search and execute tools", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["execute", "search"]);

    await client.close();
  });

  it("search tool description should match snapshot", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    const searchTool = tools.find((t) => t.name === "search");
    expect(searchTool!.description).toMatchSnapshot();

    await client.close();
  });

  it("execute tool description should match snapshot", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    const executeTool = tools.find((t) => t.name === "execute");
    expect(executeTool!.description).toMatchSnapshot();

    await client.close();
  });

  it("search tool should list spec paths via codemode.spec()", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: "async () => { const spec = await codemode.spec(); return Object.keys(spec.paths); }"
      }
    });

    expect(JSON.parse(callText(result))).toEqual(["/users", "/users/{id}"]);

    await client.close();
  });

  it("search tool should return first operation summary", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: "async () => { const spec = await codemode.spec(); return spec.paths['/users'].get.summary; }"
      }
    });

    expect(callText(result)).toBe("List users");

    await client.close();
  });

  it("execute tool should proxy codemode.request() to host-side function", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async (opts) => ({
        status: 200,
        method: opts.method,
        path: opts.path,
        data: [{ id: 1, name: "Alice" }]
      })
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "execute",
      arguments: {
        code: 'async () => await codemode.request({ method: "GET", path: "/users" })'
      }
    });

    expect(JSON.parse(callText(result))).toEqual({
      status: 200,
      method: "GET",
      path: "/users",
      data: [{ id: 1, name: "Alice" }]
    });

    await client.close();
  });

  it("execute tool should return error when request throws", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => {
        throw new Error("unauthorized");
      }
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "execute",
      arguments: {
        code: 'async () => await codemode.request({ method: "GET", path: "/secret" })'
      }
    });

    expect(callText(result)).toBe("Error: unauthorized");

    await client.close();
  });

  it("should resolve $refs before injecting spec", async () => {
    const specWithRefs = {
      openapi: "3.0.0",
      paths: {
        "/items": {
          get: {
            summary: "List items",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ItemList" }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          ItemList: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } }
          }
        }
      }
    };

    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: specWithRefs,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: "async () => { const spec = await codemode.spec(); return spec.paths['/items'].get.responses['200'].content['application/json'].schema; }"
      }
    });

    expect(JSON.parse(callText(result))).toEqual({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } } }
    });

    await client.close();
  });
});
