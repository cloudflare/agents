import { createExecutionContext } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createLegacyMcpHandler } from "../../mcp/handler-legacy";

describe("SDK v2 server on the existing legacy handler", () => {
  it("serves a 2025 initialize request through WorkerTransport", async () => {
    const server = new McpServer({ name: "v2-on-v1", version: "1.0.0" });
    const handler = createLegacyMcpHandler(server as never, {
      enableJsonResponse: true
    });

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
      {},
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "v2-on-v1", version: "1.0.0" }
      }
    });
  });
});
