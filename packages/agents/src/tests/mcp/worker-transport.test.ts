import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  WorkerTransport,
  type WorkerTransportOptions
} from "../../mcp/worker-transport";
import { z } from "zod";

/**
 * Tests for WorkerTransport, focusing on CORS and protocol version handling
 */
describe("WorkerTransport", () => {
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

  const setupTransport = async (
    server: McpServer,
    options?: WorkerTransportOptions
  ) => {
    const transport = new WorkerTransport(options);
    // server.connect() will call transport.start() internally
    await server.connect(transport);
    return transport;
  };

  describe("CORS - OPTIONS preflight requests", () => {
    it("should handle OPTIONS request with custom CORS options", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        corsOptions: {
          origin: "https://example.com",
          methods: "GET, POST",
          headers: "Content-Type, Accept"
        }
      });

      const request = new Request("http://example.com/", {
        method: "OPTIONS"
      });

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Accept"
      );
    });

    it("should use default CORS values when not configured", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server);

      const request = new Request("http://example.com/", {
        method: "OPTIONS"
      });

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, DELETE, OPTIONS"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version"
      );
      expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    });

    it("should merge custom options with defaults", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        corsOptions: {
          maxAge: 3600
        }
      });

      const request = new Request("http://example.com/", {
        method: "OPTIONS"
      });

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      // Should use custom maxAge
      expect(response.headers.get("Access-Control-Max-Age")).toBe("3600");
      // Should use default origin
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("CORS - Headers on actual responses", () => {
    it("should only include origin and expose-headers on POST responses", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        corsOptions: {
          origin: "https://example.com",
          methods: "POST",
          headers: "Content-Type"
        }
      });

      const request = new Request("http://example.com/", {
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

      const response = await transport.handleRequest(request);

      // Only origin and expose-headers for actual responses
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "mcp-session-id"
      );
      // These should NOT be on actual responses, only OPTIONS
      expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
      expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
    });

    it("should use custom exposeHeaders on actual responses", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        corsOptions: {
          exposeHeaders: "X-Custom-Header, mcp-session-id"
        }
      });

      const request = new Request("http://example.com/", {
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

      const response = await transport.handleRequest(request);

      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "X-Custom-Header, mcp-session-id"
      );
    });
  });

  describe("CORS - Headers on error responses", () => {
    it("should add CORS headers to error responses", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        corsOptions: {
          origin: "https://example.com"
        }
      });

      // Send invalid JSON to trigger parse error
      const request = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: "invalid json"
      });

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(400);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "mcp-session-id"
      );
    });
  });

  describe("Protocol Version - Initialization", () => {
    it("should capture protocol version from initialize request", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server);

      const request = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      const response = await transport.handleRequest(request);

      // Should accept the version without error
      expect(response.status).toBe(200);
    });

    it("should default to 2025-03-26 when version not specified", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server);

      const request = new Request("http://example.com/", {
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
            clientInfo: { name: "test", version: "1.0" }
            // No protocolVersion
          }
        })
      });

      const response = await transport.handleRequest(request);

      // Should accept and default to 2025-03-26
      expect(response.status).toBe(200);
    });

    it("should default to 2025-03-26 for unsupported version", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server);

      const request = new Request("http://example.com/", {
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
            protocolVersion: "2099-01-01" // Unsupported future version
          }
        })
      });

      const response = await transport.handleRequest(request);

      // Should accept but use default version
      expect(response.status).toBe(200);
    });
  });

  describe("Protocol Version - Validation on subsequent requests", () => {
    it("should allow missing header for default version 2025-03-26", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize with 2025-03-26
      const initRequest = new Request("http://example.com/", {
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

      await transport.handleRequest(initRequest);

      // Subsequent request WITHOUT MCP-Protocol-Version header
      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "test-session"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      const response = await transport.handleRequest(followupRequest);

      // Should allow for backwards compatibility
      expect(response.status).toBe(202);
    });

    it("should require header for version 2025-06-18", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize with 2025-06-18
      const initRequest = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(initRequest);

      // Subsequent request WITHOUT MCP-Protocol-Version header
      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "test-session"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      const response = await transport.handleRequest(followupRequest);

      // Should require header for version > 2025-03-26
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("MCP-Protocol-Version");
      expect(body.error.message).toContain("required");
    });

    it("should accept correct version header on subsequent requests", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize with 2025-06-18
      const initRequest = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(initRequest);

      // Subsequent request WITH correct MCP-Protocol-Version header
      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "test-session",
          "MCP-Protocol-Version": "2025-06-18"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      const response = await transport.handleRequest(followupRequest);

      expect(response.status).toBe(202);
    });

    it("should reject unsupported version header", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize
      const initRequest = new Request("http://example.com/", {
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

      await transport.handleRequest(initRequest);

      // Subsequent request with unsupported version
      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "test-session",
          "MCP-Protocol-Version": "2099-01-01"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      const response = await transport.handleRequest(followupRequest);

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("Unsupported");
      expect(body.error.message).toContain("MCP-Protocol-Version");
    });

    it("should reject mismatched version header", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize with 2025-06-18
      const initRequest = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(initRequest);

      // Subsequent request with different version
      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "test-session",
          "MCP-Protocol-Version": "2025-03-26"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      const response = await transport.handleRequest(followupRequest);

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("mismatch");
      expect(body.error.message).toContain("Expected: 2025-06-18");
      expect(body.error.message).toContain("Got: 2025-03-26");
    });
  });

  describe("Protocol Version - Validation on GET requests", () => {
    it("should validate protocol version on SSE GET requests", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize with 2025-06-18
      const initRequest = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(initRequest);

      // GET request without version header
      const getRequest = new Request("http://example.com/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": "test-session"
        }
      });

      const response = await transport.handleRequest(getRequest);

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("MCP-Protocol-Version");
    });
  });

  describe("Protocol Version - Validation on DELETE requests", () => {
    it("should validate protocol version on DELETE requests", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session"
      });

      // Initialize with 2025-06-18
      const initRequest = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(initRequest);

      // DELETE request without version header
      const deleteRequest = new Request("http://example.com/", {
        method: "DELETE",
        headers: {
          "mcp-session-id": "test-session"
        }
      });

      const response = await transport.handleRequest(deleteRequest);

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("MCP-Protocol-Version");
    });
  });

  describe("Storage API - State Persistence", () => {
    it("should persist session state to storage", async () => {
      const server = createTestServer();
      let storedState: any = undefined;

      const mockStorage = {
        get: async () => storedState,
        set: async (state: any) => {
          storedState = state;
        }
      };

      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "persistent-session",
        storage: mockStorage
      });

      const request = new Request("http://example.com/", {
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(request);

      expect(storedState).toBeDefined();
      expect(storedState.sessionId).toBe("persistent-session");
      expect(storedState.initialized).toBe(true);
      expect(storedState.protocolVersion).toBe("2025-06-18");
    });

    it("should restore session state from storage", async () => {
      const server = createTestServer();
      const existingState = {
        sessionId: "restored-session",
        initialized: true,
        protocolVersion: "2025-06-18" as const
      };

      const mockStorage = {
        get: async () => existingState,
        set: async () => {}
      };

      const transport = await setupTransport(server, {
        storage: mockStorage
      });

      const request = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "restored-session",
          "MCP-Protocol-Version": "2025-06-18"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      const response = await transport.handleRequest(request);

      expect(transport.sessionId).toBe("restored-session");
      expect(response.status).toBe(202);
    });

    it("should handle storage with no existing state", async () => {
      const server = createTestServer();
      const mockStorage = {
        get: async () => undefined,
        set: async () => {}
      };

      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "new-session",
        storage: mockStorage
      });

      const request = new Request("http://example.com/", {
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

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("new-session");
    });

    it("should only restore state once", async () => {
      const server = createTestServer();
      let getCalls = 0;

      const mockStorage = {
        get: async () => {
          getCalls++;
          return {
            sessionId: "restored-session",
            initialized: true,
            protocolVersion: "2025-03-26" as const
          };
        },
        set: async () => {}
      };

      const transport = await setupTransport(server, {
        storage: mockStorage
      });

      // Make multiple requests
      const request = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "restored-session"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      await transport.handleRequest(request);
      await transport.handleRequest(request);

      expect(getCalls).toBe(1);
    });
  });

  describe("Session Management", () => {
    it("should use custom sessionIdGenerator", async () => {
      const server = createTestServer();
      let generatorCalled = false;

      const transport = await setupTransport(server, {
        sessionIdGenerator: () => {
          generatorCalled = true;
          return "custom-generated-id";
        }
      });

      const request = new Request("http://example.com/", {
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

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(generatorCalled).toBe(true);
      expect(response.headers.get("mcp-session-id")).toBe(
        "custom-generated-id"
      );
      expect(transport.sessionId).toBe("custom-generated-id");
    });

    it("should fire onsessioninitialized callback", async () => {
      const server = createTestServer();
      let callbackSessionId: string | undefined;
      let callbackCalled = false;

      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "callback-test-session",
        onsessioninitialized: (sessionId: string) => {
          callbackCalled = true;
          callbackSessionId = sessionId;
        }
      });

      const request = new Request("http://example.com/", {
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

      await transport.handleRequest(request);

      expect(callbackCalled).toBe(true);
      expect(callbackSessionId).toBe("callback-test-session");
    });

    it("should only call onsessioninitialized once per session", async () => {
      const server = createTestServer();
      let callbackCount = 0;

      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "single-callback-session",
        onsessioninitialized: () => {
          callbackCount++;
        }
      });

      // First request - initialize
      const initRequest = new Request("http://example.com/", {
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

      await transport.handleRequest(initRequest);

      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "single-callback-session"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });

      await transport.handleRequest(followupRequest);

      expect(callbackCount).toBe(1);
    });
  });

  describe("JSON Response Mode", () => {
    it("should return JSON response when enableJsonResponse is true", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        enableJsonResponse: true
      });

      const request = new Request("http://example.com/", {
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

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = await response.json();
      expect(body).toBeDefined();
      expect((body as any).jsonrpc).toBe("2.0");
    });

    it("should return SSE stream when enableJsonResponse is false", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        enableJsonResponse: false
      });

      const request = new Request("http://example.com/", {
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

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("should return JSON when enableJsonResponse is true regardless of Accept header order", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        enableJsonResponse: true
      });

      const request = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json"
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

      const response = await transport.handleRequest(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });
});
