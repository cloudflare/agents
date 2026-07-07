import { describe, expect, it, vi } from "vitest";

describe("legacy MCP handler warning", () => {
  it("warns once for the compatibility stack plus once for the experimental alias", async () => {
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
        expect.stringContaining("legacy MCP SDK v1 handler")
      ])
    );
  });
});
