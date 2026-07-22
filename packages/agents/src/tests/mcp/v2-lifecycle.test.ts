import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MCPClientConnection } from "../../mcp/client-connection";
import { createMcpHandler } from "../../mcp/server";

function lifecycleServer() {
  const server = new McpServer({
    name: "lifecycle-server",
    version: "1.0.0"
  });
  server.registerTool(
    "add",
    {
      inputSchema: z.object({ a: z.number(), b: z.number() })
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }]
    })
  );
  server.registerPrompt(
    "greeting",
    { argsSchema: { name: z.string() } },
    async ({ name }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Hello ${name}` }
        }
      ]
    })
  );
  server.registerResource("status", "test://status", {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "ready" }]
  }));
  return server;
}

function connectionFor(
  methods: string[],
  mode: "auto" | "legacy"
): {
  connection: MCPClientConnection;
  closeHandler: () => Promise<void>;
} {
  const handler = createMcpHandler(() => lifecycleServer());
  const connection = new MCPClientConnection(
    new URL("https://example.com/mcp"),
    { name: "lifecycle-client", version: "1.0.0" },
    {
      client: { versionNegotiation: { mode } },
      transport: {
        type: "streamable-http",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "POST") {
            const body = (await request.clone().json()) as {
              method?: string;
            };
            if (body.method) methods.push(body.method);
          }
          return handler.fetch(request);
        }
      }
    }
  );
  return { connection, closeHandler: () => handler.close() };
}

async function exerciseLifecycle(connection: MCPClientConnection) {
  expect(await connection.init()).toBeUndefined();

  await expect(connection.client.listTools()).resolves.toMatchObject({
    tools: [expect.objectContaining({ name: "add" })]
  });
  await expect(connection.client.listPrompts()).resolves.toMatchObject({
    prompts: [expect.objectContaining({ name: "greeting" })]
  });
  await expect(connection.client.listResources()).resolves.toMatchObject({
    resources: [expect.objectContaining({ uri: "test://status" })]
  });
  await expect(
    connection.client.callTool({
      name: "add",
      arguments: { a: 2, b: 3 }
    })
  ).resolves.toMatchObject({
    content: [{ type: "text", text: "5" }]
  });
  await expect(
    connection.client.getPrompt({
      name: "greeting",
      arguments: { name: "Ada" }
    })
  ).resolves.toMatchObject({
    messages: [{ content: { type: "text", text: "Hello Ada" } }]
  });
  await expect(
    connection.client.readResource({ uri: "test://status" })
  ).resolves.toMatchObject({
    contents: [{ uri: "test://status", text: "ready" }]
  });
}

describe("MCP client/server lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("exercises discovery, catalogs, operations, and close on Stateless MCP", async () => {
    const methods: string[] = [];
    const { connection, closeHandler } = connectionFor(methods, "auto");
    cleanups.push(closeHandler);

    await exerciseLifecycle(connection);
    expect(connection.client.getProtocolEra()).toBe("modern");
    expect(methods[0]).toBe("server/discover");
    expect(methods).not.toContain("initialize");

    await connection.close();
  });

  it("exercises initialize, catalogs, operations, and close through Legacy compatibility", async () => {
    const methods: string[] = [];
    const { connection, closeHandler } = connectionFor(methods, "legacy");
    cleanups.push(closeHandler);

    await exerciseLifecycle(connection);
    expect(connection.client.getProtocolEra()).toBe("legacy");
    expect(methods[0]).toBe("initialize");
    expect(methods).not.toContain("server/discover");

    await connection.close();
  });
});
