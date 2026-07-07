import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "../../mcp/handler";

describe("SDK v2 stateless fallback warning", () => {
  it("does not warn for a 2025 request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = createMcpHandler(
      () => new McpServer({ name: "modern", version: "1.0.0" })
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
});
