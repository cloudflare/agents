import { describe, expect, it, vi } from "vitest";

describe("legacy MCP handler warning", () => {
  it("does not warn for explicit legacy APIs", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [mcp, { McpServer }] = await Promise.all([
      import("../../mcp"),
      import("@modelcontextprotocol/sdk/server/mcp.js")
    ]);

    mcp.createLegacyMcpHandler(
      new McpServer({ name: "explicit-legacy", version: "1.0.0" })
    );
    new mcp.WorkerTransport();

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for the SDK v1 overload plus once for the experimental alias", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [{ McpServer }, handlerModule, transportModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("../../mcp/handler"),
      import("../../mcp/worker-transport")
    ]);

    const server = new McpServer({ name: "legacy", version: "1.0.0" });
    handlerModule.experimental_createMcpHandler(server);
    new transportModule.WorkerTransport();
    handlerModule.createMcpHandler(
      new McpServer({ name: "legacy-2", version: "1.0.0" })
    );

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("experimental_createMcpHandler is deprecated"),
        expect.stringContaining(
          "Passing an MCP SDK v1 server to createMcpHandler is deprecated"
        )
      ])
    );
  });
});
