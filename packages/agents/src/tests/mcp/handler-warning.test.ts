import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { McpServer as StatelessMcpServer } from "@modelcontextprotocol/server";
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

  it("does not warn for a v2 factory serving a legacy request", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createMcpHandler } = await import("../../mcp/handler-compat");
    const handler = createMcpHandler(
      () => new StatelessMcpServer({ name: "stateless", version: "1.0.0" })
    );

    const response = await handler(
      new Request("http://example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" }
          }
        })
      }),
      env,
      createExecutionContext()
    );
    await response.text();

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for the SDK v1 overload plus once for the experimental alias", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [{ McpServer }, handlerModule, transportModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("../../mcp/handler-compat"),
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
        expect.stringMatching(
          /experimental_createMcpHandler is deprecated.*Pass an @modelcontextprotocol\/server factory to createMcpHandler.*temporarily retain.*createLegacyMcpHandler/
        ),
        expect.stringMatching(
          /Passing an MCP SDK v1 server to createMcpHandler is deprecated.*Pass an @modelcontextprotocol\/server factory to createMcpHandler.*temporarily retain.*createLegacyMcpHandler/
        )
      ])
    );
  });
});
