import { createExecutionContext, env } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpHandler } from "../../mcp/handler";
import { z } from "zod";

declare module "cloudflare:test" {
  interface ProvidedEnv {}
}

/**
 * Tests for createMcpHandler
 * The handler primarily passes options to WorkerTransport and handles routing
 * Detailed CORS and protocol version behavior is tested in worker-transport.test.ts
 */
describe("createMcpHandler", () => {
  const createTestServer = () => {
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.tool(
      "test-tool",
      "A test tool",
      { message: z.string().describe("Test message") },
      async ({ message }): Promise<CallToolResult> => ({
        content: [{ text: `Echo: ${message}`, type: "text" }]
      })
    );

    return server;
  };

  describe("Route matching", () => {
    it("should only handle requests matching the configured route", async () => {
      const server = createTestServer();
      const handler = createMcpHandler(server, {
        route: "/custom-mcp"
      });

      const ctx = createExecutionContext();

      // Request to non-matching route
      const wrongRequest = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });
      const wrongResponse = await handler(wrongRequest, env, ctx);
      expect(wrongResponse.status).toBe(404);

      // Request to matching route
      const correctRequest = new Request("http://example.com/custom-mcp", {
        method: "OPTIONS"
      });
      const correctResponse = await handler(correctRequest, env, ctx);
      expect(correctResponse.status).toBe(200);
    });

    it("should use default route /mcp when not specified", async () => {
      const server = createTestServer();
      const handler = createMcpHandler(server);

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
    });
  });

  describe("Options passing - verification via behavior", () => {
    it("should apply custom CORS options", async () => {
      const server = createTestServer();
      const handler = createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "https://example.com",
          methods: "GET, POST"
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      // Verify custom CORS options are applied
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST"
      );
    });
  });

  describe("Integration - Basic functionality", () => {
    it("should handle initialization request end-to-end", async () => {
      const server = createTestServer();
      const handler = createMcpHandler(server, {
        route: "/mcp"
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
            protocolVersion: "2025-03-26"
          }
        })
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      // Should have CORS headers from WorkerTransport
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
