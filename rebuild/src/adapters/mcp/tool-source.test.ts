import { describe, expect, it, vi } from "vitest";
import {
  createMcpToolSource,
  toolSetFromExternalSource,
  type McpManagerLike
} from "./tool-source.js";

type ListedTool = ReturnType<McpManagerLike["listTools"]>[number];

function listedTool(serverId: string, name: string): ListedTool {
  return { serverId, name, inputSchema: { type: "object" } };
}

function createManager(tools: ListedTool[] = []): McpManagerLike {
  const calls: Array<{ name: string; input: unknown; aborted: boolean }> = [];
  return {
    async registerServer() {
      return "server";
    },
    async establishConnection() {},
    async waitForConnections() {},
    listTools() {
      return tools;
    },
    async callTool(params, _resultSchema, options) {
      calls.push({
        name: params.name,
        input: params.arguments,
        aborted: options?.signal?.aborted ?? false
      });
      if (params.name === "missing" || params.name === "broken") {
        throw new Error("tool failed");
      }
      if (options?.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return { content: [{ type: "text", text: "ok" }], calls };
    }
  };
}

describe("createMcpToolSource", () => {
  it("exposes the given id", () => {
    const source = createMcpToolSource("mcp-1", {
      manager: createManager()
    });
    expect(source.id).toBe("mcp-1");
  });

  it("ready() registers configured servers and waits for connections", async () => {
    const registerServer = vi.fn(async () => "server-1");
    const establishConnection = vi.fn(async () => {});
    const waitForConnections = vi.fn(async () => {});
    const manager: McpManagerLike = {
      registerServer,
      establishConnection,
      waitForConnections,
      listTools: () => [],
      callTool: async () => ({})
    };

    const source = createMcpToolSource("mcp-1", {
      manager,
      readyTimeoutMs: 50,
      servers: [
        {
          id: "server-1",
          name: "Server One",
          url: "https://example.com/mcp",
          transport: { type: "streamable-http" }
        }
      ]
    });

    await source.ready();

    expect(registerServer).toHaveBeenCalledWith("server-1", {
      url: "https://example.com/mcp",
      name: "Server One",
      callbackUrl: undefined,
      client: undefined,
      transport: { type: "streamable-http" },
      authUrl: undefined,
      clientId: undefined,
      retry: undefined
    });
    expect(establishConnection).toHaveBeenCalledWith("server-1");
    expect(waitForConnections).toHaveBeenCalledWith({ timeout: 50 });
  });

  it("listTools() returns raw MCP descriptors", async () => {
    const source = createMcpToolSource("mcp-1", {
      manager: createManager([
        {
          serverId: "server-1",
          name: "echo",
          description: "echoes input",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } }
          }
        }
      ])
    });

    await expect(source.listTools()).resolves.toEqual([
      {
        name: "echo",
        description: "echoes input",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } }
        }
      }
    ]);
  });

  it("callTool() invokes the matching MCP server tool", async () => {
    const source = createMcpToolSource("mcp-1", {
      manager: createManager([listedTool("server-1", "echo")])
    });

    const result = await source.callTool("echo", { message: "hi" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "ok" }],
      calls: [{ name: "echo", input: { message: "hi" }, aborted: false }]
    });
  });

  it("callTool() throws for unknown, failing, or ambiguous tools", async () => {
    await expect(
      createMcpToolSource("mcp-1", {
        manager: createManager([listedTool("server-1", "known")])
      }).callTool("missing", {})
    ).rejects.toThrow("Unknown MCP tool");

    await expect(
      createMcpToolSource("mcp-1", {
        manager: createManager([listedTool("server-1", "broken")])
      }).callTool("broken", {})
    ).rejects.toThrow("tool failed");

    await expect(
      createMcpToolSource("mcp-1", {
        manager: createManager([
          listedTool("server-1", "echo"),
          listedTool("server-2", "echo")
        ])
      }).callTool("echo", {})
    ).rejects.toThrow("Ambiguous MCP tool name");
  });

  it("callTool() forwards abort signals", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = createMcpToolSource("mcp-1", {
      manager: createManager([listedTool("server-1", "echo")])
    });

    await expect(
      source.callTool("echo", {}, controller.signal)
    ).rejects.toThrow("aborted");
  });
});

describe("toolSetFromExternalSource", () => {
  it("converts an ExternalToolSource into executable domain tools", async () => {
    const source = createMcpToolSource("mcp-1", {
      manager: createManager([
        {
          serverId: "server-1",
          name: "echo",
          description: "echoes input",
          inputSchema: { type: "object" }
        }
      ])
    });

    const tools = await toolSetFromExternalSource(source);
    const result = await tools.echo?.execute?.(
      { message: "hi" },
      {
        toolCallId: "call-1",
        requestId: "req-1",
        messages: [],
        signal: new AbortController().signal
      }
    );

    expect(tools.echo?.inputSchema).toEqual({
      jsonSchema: { type: "object" }
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "ok" }]
    });
  });
});
