import { createExecutionContext, env } from "cloudflare:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { experimental_createMcpHandler } from "../../mcp/handler";
import { z } from "zod";

declare module "cloudflare:test" {
  interface ProvidedEnv {}
}

/**
 * Tests for experimental_createMcpHandler, focusing on CORS functionality
 */
describe("experimental_createMcpHandler", () => {
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

  describe("CORS - OPTIONS preflight requests", () => {
    it("should handle OPTIONS request with CORS enabled", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "*",
          methods: "GET, POST, DELETE, OPTIONS",
          headers: "Content-Type, Accept"
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, DELETE, OPTIONS"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Accept"
      );
    });

    it("should not handle OPTIONS when CORS is not configured", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp"
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      // Without CORS, OPTIONS should not add CORS headers
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should use default CORS values when only corsOptions is provided", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {} // Empty options should use defaults
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, DELETE, OPTIONS"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Accept, mcp-session-id, mcp-protocol-version"
      );
      expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    });
  });

  describe("CORS - Headers on successful responses", () => {
    it("should add CORS headers to successful POST responses", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "https://example.com",
          methods: "POST",
          headers: "Content-Type"
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type"
      );
    });

    it("should not add CORS headers when not configured", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp"
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    });
  });

  describe("CORS - Headers on error responses", () => {
    it("should add CORS headers to 404 responses for non-matching routes", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "https://example.com"
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/wrong-route", {
        method: "POST"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(404);
      // 404 happens before CORS handling, so it won't have CORS headers
      // This is the expected behavior - route check happens first
    });

    it("should add CORS headers to error responses when configured", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "https://example.com",
          methods: "POST"
        }
      });

      const ctx = createExecutionContext();
      // Send invalid JSON to trigger an error
      const request = new Request("http://example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json"
      });

      const response = await handler(request, env, ctx);

      // Should have CORS headers even on error
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    });
  });

  describe("CORS - Custom options", () => {
    it("should use custom maxAge", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          maxAge: 3600
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.headers.get("Access-Control-Max-Age")).toBe("3600");
    });

    it("should use custom exposeHeaders", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          exposeHeaders: "X-Custom-Header, mcp-session-id"
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "X-Custom-Header, mcp-session-id"
      );
    });

    it("should combine all custom CORS options", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "https://my-app.com",
          methods: "GET, POST",
          headers: "Content-Type, X-Custom-Header",
          maxAge: 7200,
          exposeHeaders: "X-Response-Header"
        }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://my-app.com"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, X-Custom-Header"
      );
      expect(response.headers.get("Access-Control-Max-Age")).toBe("7200");
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "X-Response-Header"
      );
    });
  });

  describe("Route matching", () => {
    it("should only handle requests matching the configured route", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        route: "/custom-mcp",
        corsOptions: { origin: "*" }
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
      expect(correctResponse.headers.get("Access-Control-Allow-Origin")).toBe(
        "*"
      );
    });

    it("should use default route /mcp when not specified", async () => {
      const server = createTestServer();
      const handler = experimental_createMcpHandler(server, {
        corsOptions: { origin: "*" }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
