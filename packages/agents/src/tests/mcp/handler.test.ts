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
 * The handler primarily passes options to WorkerTransport and handles routing
 * Detailed CORS and protocol version behavior is tested in worker-transport.test.ts
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

  describe("Custom Transport Option", () => {
    it("should use provided transport instead of creating new one", async () => {
      const server = createTestServer();
      const { WorkerTransport } = await import("../../mcp/worker-transport");
      const customTransport = new WorkerTransport({
        corsOptions: { origin: "https://custom-transport.com" }
      });

      const handler = createMcpHandler(server, {
        route: "/mcp",
        transport: customTransport
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      // Should use custom transport's CORS settings
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://custom-transport.com"
      );
    });

    it("should not connect server twice when transport already started", async () => {
      const server = createTestServer();
      const { WorkerTransport } = await import("../../mcp/worker-transport");
      const customTransport = new WorkerTransport();

      // Pre-connect the transport
      await server.connect(customTransport);
      expect(customTransport.started).toBe(true);

      const handler = createMcpHandler(server, {
        route: "/mcp",
        transport: customTransport
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      // Transport should still be started (not restarted)
      expect(customTransport.started).toBe(true);
    });
  });

  describe("WorkerTransportOptions Pass-Through", () => {
    it("should pass sessionIdGenerator to transport", async () => {
      const server = createTestServer();
      let customSessionIdCalled = false;
      const customSessionIdGenerator = () => {
        customSessionIdCalled = true;
        return "custom-session-id";
      };

      const handler = createMcpHandler(server, {
        route: "/mcp",
        sessionIdGenerator: customSessionIdGenerator
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
      expect(customSessionIdCalled).toBe(true);
      expect(response.headers.get("mcp-session-id")).toBe("custom-session-id");
    });

    it("should pass onsessioninitialized callback to transport", async () => {
      const server = createTestServer();
      let capturedSessionId: string | undefined;

      const handler = createMcpHandler(server, {
        route: "/mcp",
        sessionIdGenerator: () => "callback-test-session",
        onsessioninitialized: (sessionId: string) => {
          capturedSessionId = sessionId;
        }
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
      expect(capturedSessionId).toBeDefined();
      expect(typeof capturedSessionId).toBe("string");
    });

    it("should pass enableJsonResponse to transport", async () => {
      const server = createTestServer();
      const handler = createMcpHandler(server, {
        route: "/mcp",
        enableJsonResponse: true
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
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("should pass storage option to transport", async () => {
      const server = createTestServer();
      const mockStorage = {
        get: async () => undefined,
        set: async () => {}
      };

      const handler = createMcpHandler(server, {
        route: "/mcp",
        storage: mockStorage
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
    });

    it("should not pass handler-specific options to transport", async () => {
      const server = createTestServer();
      const handler = createMcpHandler(server, {
        route: "/custom-route",
        authContext: { props: { userId: "123" } },
        corsOptions: { origin: "https://example.com" }
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/custom-route", {
        method: "OPTIONS"
      });

      const response = await handler(request, env, ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
    });
  });

  describe("Error Handling", () => {
    it("should return 500 error when transport throws", async () => {
      const server = createTestServer();
      const { WorkerTransport } = await import("../../mcp/worker-transport");

      // Create a custom transport that throws
      const errorTransport = new WorkerTransport();
      errorTransport.handleRequest = async () => {
        throw new Error("Transport error");
      };

      const handler = createMcpHandler(server, {
        route: "/mcp",
        transport: errorTransport
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

      expect(response.status).toBe(500);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = (await response.json()) as JSONRPCError;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe("Transport error");
    });

    it("should return generic error message for non-Error exceptions", async () => {
      const server = createTestServer();
      const { WorkerTransport } = await import("../../mcp/worker-transport");

      const errorTransport = new WorkerTransport();
      errorTransport.handleRequest = async () => {
        throw "String error";
      };

      const handler = createMcpHandler(server, {
        route: "/mcp",
        transport: errorTransport
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

      expect(response.status).toBe(500);
      const body = (await response.json()) as JSONRPCError;
      expect(body.error.message).toBe("Internal server error");
    });
  });
});
