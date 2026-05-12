import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
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

function buildReferencedOpenApiSpec({
  operations,
  properties
}: {
  operations: number;
  properties: number;
}) {
  const bigSchema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: properties }, (_, i) => [
        `field_${i}`,
        { type: "string", description: "x".repeat(100) }
      ])
    )
  };

  return {
    openapi: "3.1.0",
    info: { title: "Synthetic", version: "1" },
    paths: Object.fromEntries(
      Array.from({ length: operations }, (_, i) => [
        `/items/${i}`,
        {
          get: {
            operationId: `getItem${i}`,
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/BigSchema" }
                  }
                }
              }
            }
          }
        }
      ])
    ),
    components: { schemas: { BigSchema: bigSchema } }
  };
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

    expect(JSON.parse(callText(result))).toBe(42);

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
          const greeting = await codemode.greet({ name: "Result is " + sum });
          return greeting;
        }`
      }
    });

    expect(callText(result)).toBe("Hello, Result is 8!");

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

  it("code tool should unwrap JSON array from single text content", async () => {
    const upstream = createUpstreamServer();
    upstream.registerTool(
      "get_items",
      { description: "Return a JSON array", inputSchema: {} },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify([
              { id: 1, name: "a" },
              { id: 2, name: "b" }
            ])
          }
        ]
      })
    );
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const items = await codemode.get_items({});
          return items.filter(i => i.id === 2);
        }`
      }
    });

    expect(JSON.parse(callText(result))).toEqual([{ id: 2, name: "b" }]);

    await client.close();
  });

  it("code tool should surface upstream isError as a sandbox exception", async () => {
    const upstream = createUpstreamServer();
    upstream.registerTool(
      "fail",
      { description: "Always fails", inputSchema: {} },
      async () => ({
        content: [{ type: "text" as const, text: "something went wrong" }],
        isError: true
      })
    );
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: "async () => { return await codemode.fail({}); }"
      }
    });

    expect(callText(result)).toBe("Error: something went wrong");
    expect(result.isError).toBe(true);

    await client.close();
  });

  it("code tool should concatenate multi-text content into a single string", async () => {
    const upstream = createUpstreamServer();
    upstream.registerTool(
      "multi_text",
      { description: "Return multiple text items", inputSchema: {} },
      async () => ({
        content: [
          { type: "text" as const, text: "line one" },
          { type: "text" as const, text: "line two" }
        ]
      })
    );
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const text = await codemode.multi_text({});
          return text;
        }`
      }
    });

    expect(callText(result)).toBe("line one\nline two");

    await client.close();
  });

  it("code tool should unwrap JSON object from single text content", async () => {
    const upstream = createUpstreamServer();
    upstream.registerTool(
      "get_user",
      {
        description: "Return a user object",
        inputSchema: { id: z.number() }
      },
      async ({ id }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, name: "Alice", active: true })
          }
        ]
      })
    );
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const user = await codemode.get_user({ id: 7 });
          return user.name + " is " + (user.active ? "active" : "inactive");
        }`
      }
    });

    expect(callText(result)).toBe("Alice is active");

    await client.close();
  });

  it("sandbox code should be able to try/catch upstream isError", async () => {
    const upstream = createUpstreamServer();
    upstream.registerTool(
      "maybe_fail",
      { description: "Might fail", inputSchema: {} },
      async () => ({
        content: [{ type: "text" as const, text: "not found" }],
        isError: true
      })
    );
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const wrapped = await codeMcpServer({ server: upstream, executor });
    const client = await connectClient(wrapped);

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          try {
            await codemode.maybe_fail({});
            return "should not reach";
          } catch (e) {
            return "caught: " + e.message;
          }
        }`
      }
    });

    expect(callText(result)).toBe("caught: not found");

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

  it("should resolve $refs inside the sandbox", async () => {
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

  it("search should preserve sandbox truncation metadata", async () => {
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
        code: "async () => 'x'.repeat(25000)"
      }
    });

    const text = callText(result);
    expect(text).toContain("--- TRUNCATED ---");
    expect(text).toContain("Response was ~6,250 tokens");

    await client.close();
  });

  it("search should truncate oversized string results from custom executors on the host", async () => {
    const executor = {
      execute: async () => ({ result: "x".repeat(25000) })
    };
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: "async () => 'ignored'"
      }
    });

    const text = callText(result);
    expect(text).toContain("--- TRUNCATED ---");
    expect(text).toContain("Response was ~6,250 tokens");

    await client.close();
  });

  it("search should not trust arbitrary truncation markers from custom executors", async () => {
    const executor = {
      execute: async () => ({
        result: "--- TRUNCATED ---\n" + "x".repeat(25000)
      })
    };
    const server = openApiMcpServer({
      spec: sampleSpec,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: "async () => 'ignored'"
      }
    });

    const text = callText(result);
    expect(text).toContain("--- TRUNCATED ---");
    expect(text).toContain("Response was ~6,255 tokens");

    await client.close();
  });

  it("should preserve external refs and surface missing internal refs as undefined", async () => {
    const specWithRefs = {
      openapi: "3.0.0",
      info: { title: "Refs", version: "1" },
      paths: {
        "/external": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "schemas/external.json#/Thing" }
                  }
                }
              }
            }
          }
        },
        "/missing": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Missing" }
                  }
                }
              }
            }
          }
        }
      },
      components: { schemas: {} }
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
        code: `async () => {
          const spec = await codemode.spec();
          return {
            external: spec.paths["/external"].get.responses["200"].content["application/json"].schema,
            missing: String(spec.paths["/missing"].get.responses["200"].content["application/json"].schema)
          };
        }`
      }
    });

    expect(JSON.parse(callText(result))).toEqual({
      external: { $ref: "schemas/external.json#/Thing" },
      missing: "undefined"
    });

    await client.close();
  });

  it("should mark circular refs without recursing forever", async () => {
    const specWithCycle = {
      openapi: "3.0.0",
      info: { title: "Cycle", version: "1" },
      paths: {
        "/nodes": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Node" }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              child: { $ref: "#/components/schemas/Node" }
            }
          }
        }
      }
    };

    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: specWithCycle,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: `async () => {
          const spec = await codemode.spec();
          return spec.paths["/nodes"].get.responses["200"].content["application/json"].schema.properties.child;
        }`
      }
    });

    expect(JSON.parse(callText(result))).toEqual({
      $circular: "#/components/schemas/Node"
    });

    await client.close();
  });

  it("should reuse ref resolution work without sharing mutable objects", async () => {
    const specWithSharedRef = {
      openapi: "3.0.0",
      info: { title: "Shared", version: "1" },
      paths: {
        "/a": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Shared" }
                  }
                }
              }
            }
          }
        },
        "/b": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Shared" }
                  }
                }
              }
            }
          }
        }
      },
      components: {
        schemas: {
          Shared: {
            type: "object",
            properties: { id: { type: "string" } }
          }
        }
      }
    };

    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: specWithSharedRef,
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: `async () => {
          const spec = await codemode.spec();
          const a = spec.paths["/a"].get.responses["200"].content["application/json"].schema;
          const b = spec.paths["/b"].get.responses["200"].content["application/json"].schema;
          a.properties.id.type = "number";
          return { sameObject: a === b, bType: b.properties.id.type };
        }`
      }
    });

    expect(JSON.parse(callText(result))).toEqual({
      sameObject: false,
      bType: "string"
    });

    await client.close();
  });

  it("search should resolve large specs inside the sandbox instead of crossing RPC pre-expanded", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const server = openApiMcpServer({
      spec: buildReferencedOpenApiSpec({ operations: 2000, properties: 200 }),
      executor,
      request: async () => ({})
    });
    const client = await connectClient(server);

    const result = await client.callTool({
      name: "search",
      arguments: {
        code: "async () => { const spec = await codemode.spec(); return Object.keys(spec.paths).length; }"
      }
    });

    expect(callText(result)).toBe("2000");

    await client.close();
  });
});
