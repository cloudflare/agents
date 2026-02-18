import { createExecutionContext, env } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpHandler } from "../../mcp/handler";
import { z } from "zod";

declare module "cloudflare:test" {
  interface ProvidedEnv {}
}

/**
 * Tests for createMcpHandler
 * The handler wraps WebStandardStreamableHTTPServerTransport from the MCP SDK,
 * adding route matching, CORS, and auth context.
 */
describe("createMcpHandler", () => {
  const createTestServer = () => {
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.registerTool(
      "test-tool",
      {
        description: "A test tool",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        return { content: [{ text: `Echo: ${message}`, type: "text" }] };
      }
    );

    return server;
  };

  describe("Route matching", () => {
    it("should only handle requests matching the configured route", async () => {
      const handler = createMcpHandler(createTestServer, {
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
      const handler = createMcpHandler(createTestServer);

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
    });
  });

  describe("CORS", () => {
    it("should apply custom CORS options", async () => {
      const handler = createMcpHandler(createTestServer, {
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

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST"
      );
    });
  });

  describe("Integration", () => {
    it("should handle initialization request end-to-end", async () => {
      const handler = createMcpHandler(createTestServer);

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
    });

    it("should create a new server per request when using factory function", async () => {
      const handler = createMcpHandler(createTestServer);

      const ctx = createExecutionContext();
      const createInitRequest = () =>
        new Request("http://example.com/mcp", {
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

      // Multiple requests should all succeed (new server + transport per request)
      for (let i = 0; i < 3; i++) {
        const response = await handler(createInitRequest(), env, ctx);
        expect(response.status).toBe(200);
      }
    });
  });

  describe("Error Handling", () => {
    it("should return 500 error when handler throws", async () => {
      const handler = createMcpHandler(
        () => {
          throw new Error("Server creation error");
        },
        { route: "/mcp" }
      );

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

      expect(response.status).toBe(500);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = (await response.json()) as JSONRPCError;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe("Server creation error");
    });
  });
});
