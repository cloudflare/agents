import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  WorkerTransport,
  type TransportState,
  type WorkerTransportOptions
} from "../../../mcp/worker-transport";
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
  });

  describe("Protocol Version - Validation on subsequent requests", () => {
    it("should accept missing header (defaults to negotiated version)", async () => {
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

      // Should accept - defaults to negotiated version
      expect(response.status).toBe(202);
    });

    it("should accept negotiated version header", async () => {
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

    it("should accept any supported version header regardless of negotiated version", async () => {
      // NOTE: The transport does not enforce version consistency after negotiation.
      // We only validate that the version header, if present, is in SUPPORTED_PROTOCOL_VERSIONS.
      // The SDK handles version semantics - the transport just rejects unknown versions.
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

      // Subsequent request with a different but supported version
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

      // Should accept - we only check if version is in supported list, not if it matches negotiated
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      await transport.handleRequest(initRequest);

      // Subsequent request with unsupported version (valid format but not in supported list)
      const followupRequest = new Request("http://example.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": "test-session",
          "MCP-Protocol-Version": "1999-01-01"
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
      expect(body.error.message).toContain("Unsupported protocol version");
      expect(body.error.message).toContain("1999-01-01");
    });
  });

  describe("Protocol Version - Validation on GET requests", () => {
    it("should accept GET request without version header (defaults to negotiated)", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session",
        enableJsonResponse: true
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

      const initResponse = await transport.handleRequest(initRequest);
      await initResponse.json();

      // GET request without version header - should accept
      const getRequest = new Request("http://example.com/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": "test-session"
        }
      });

      const response = await transport.handleRequest(getRequest);

      // Should accept - missing header defaults to negotiated version
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("should reject GET request with unsupported version header", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session",
        enableJsonResponse: true
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      const initResponse = await transport.handleRequest(initRequest);
      await initResponse.json();

      // GET request with unsupported version header
      const getRequest = new Request("http://example.com/", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": "test-session",
          "MCP-Protocol-Version": "1999-01-01"
        }
      });

      const response = await transport.handleRequest(getRequest);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("Unsupported protocol version");
    });
  });

  describe("Protocol Version - Validation on DELETE requests", () => {
    it("should accept DELETE request without version header (defaults to negotiated)", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session",
        enableJsonResponse: true
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      const initResponse = await transport.handleRequest(initRequest);
      await initResponse.json();

      // DELETE request without version header - should accept
      const deleteRequest = new Request("http://example.com/", {
        method: "DELETE",
        headers: {
          "mcp-session-id": "test-session"
        }
      });

      const response = await transport.handleRequest(deleteRequest);

      // Should accept - missing header defaults to negotiated version
      expect(response.status).toBe(200);
    });

    it("should reject DELETE request with unsupported version header", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "test-session",
        enableJsonResponse: true
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      const initResponse = await transport.handleRequest(initRequest);
      await initResponse.json();

      // DELETE request with unsupported version header
      const deleteRequest = new Request("http://example.com/", {
        method: "DELETE",
        headers: {
          "mcp-session-id": "test-session",
          "MCP-Protocol-Version": "1999-01-01"
        }
      });

      const response = await transport.handleRequest(deleteRequest);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("Unsupported protocol version");
    });
  });

  describe("Storage API - State Persistence", () => {
    it("should persist session state to storage", async () => {
      const server = createTestServer();
      let storedState: TransportState | undefined;

      const mockStorage = {
        get: async () => storedState,
        set: async (state: TransportState) => {
          storedState = state;
        }
      };

      // Use enableJsonResponse to get a proper JSON response instead of SSE stream
      // This ensures the SDK response is fully processed before the promise resolves
      const transport = await setupTransport(server, {
        sessionIdGenerator: () => "persistent-session",
        storage: mockStorage,
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
            protocolVersion: "2025-06-18"
          }
        })
      });

      // Wait for the response to complete - this ensures the SDK has
      // processed the request and sent its response through transport.send()
      const response = await transport.handleRequest(request);
      await response.json(); // Wait for response to be fully processed

      expect(storedState).toBeDefined();
      expect(storedState?.sessionId).toBe("persistent-session");
      expect(storedState?.initialized).toBe(true);
    });

    it("should negotiate down to latest supported version when client requests unsupported version", async () => {
      const server = createTestServer();
      const transport = await setupTransport(server, {
        enableJsonResponse: true
      });

      // Client requests a future unsupported version
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
      const body = (await response.json()) as {
        result?: { protocolVersion: string };
      };

      // Server should respond with latest supported version
      expect(body.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    });

    it("should restore session state from storage", async () => {
      const server = createTestServer();
      const existingState = {
        sessionId: "restored-session",
        initialized: true
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
            initialized: true
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
      expect((body as JSONRPCRequest).jsonrpc).toBe("2.0");
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

  describe("relatedRequestId Routing", () => {
    let transport: WorkerTransport;
    let postStreamWriter: WritableStreamDefaultWriter<Uint8Array>;
    let getStreamWriter: WritableStreamDefaultWriter<Uint8Array>;
    let postStreamData: string[] = [];
    let getStreamData: string[] = [];

    // Type for accessing private properties during testing (whitebox testing)
    type TransportInternal = {
      streamMapping: Map<string, unknown>;
      requestToStreamMapping: Map<string | number, string>;
    };

    /**
     * Helper to set up mock streams on the transport for testing.
     * This is whitebox testing that accesses private fields via type assertion.
     */
    const setupMockStream = (
      transport: WorkerTransport,
      streamId: string,
      writer: WritableStreamDefaultWriter<Uint8Array>,
      encoder: TextEncoder
    ) => {
      const transportInternal = transport as unknown as TransportInternal;
      transportInternal.streamMapping.set(streamId, {
        writer,
        encoder,
        cleanup: vi.fn()
      });
    };

    /**
     * Helper to map a request ID to a stream ID for testing.
     */
    const mapRequestToStream = (
      transport: WorkerTransport,
      requestId: string | number,
      streamId: string
    ) => {
      const transportInternal = transport as unknown as TransportInternal;
      transportInternal.requestToStreamMapping.set(requestId, streamId);
    };

    /**
     * Helper to delete a stream from the transport for testing.
     */
    const deleteStream = (transport: WorkerTransport, streamId: string) => {
      const transportInternal = transport as unknown as TransportInternal;
      transportInternal.streamMapping.delete(streamId);
    };

    beforeEach(() => {
      // Reset data arrays
      postStreamData = [];
      getStreamData = [];

      // Create transport
      transport = new WorkerTransport({
        sessionIdGenerator: () => "test-session"
      });

      // Mock the stream mappings manually
      const postEncoder = new TextEncoder();
      const getEncoder = new TextEncoder();

      // Create mock writers that capture data
      postStreamWriter = {
        write: vi.fn(async (chunk: Uint8Array) => {
          postStreamData.push(new TextDecoder().decode(chunk));
        }),
        close: vi.fn(),
        abort: vi.fn(),
        releaseLock: vi.fn()
      } as unknown as WritableStreamDefaultWriter<Uint8Array>;

      getStreamWriter = {
        write: vi.fn(async (chunk: Uint8Array) => {
          getStreamData.push(new TextDecoder().decode(chunk));
        }),
        close: vi.fn(),
        abort: vi.fn(),
        releaseLock: vi.fn()
      } as unknown as WritableStreamDefaultWriter<Uint8Array>;

      // Set up the stream mappings using helpers
      setupMockStream(
        transport,
        "post-stream-1",
        postStreamWriter,
        postEncoder
      );
      setupMockStream(transport, "_GET_stream", getStreamWriter, getEncoder);
      mapRequestToStream(transport, "req-1", "post-stream-1");
    });

    describe("Server-to-client requests with relatedRequestId", () => {
      it("should route messages with relatedRequestId through the POST stream", async () => {
        const elicitationRequest: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "elicit-1",
          method: "elicitation/create",
          params: {
            message: "What is your name?",
            mode: "form",
            requestedSchema: {
              type: "object",
              properties: {
                name: { type: "string" }
              }
            }
          }
        };

        // Send with relatedRequestId pointing to req-1 (which maps to post-stream-1)
        await transport.send(elicitationRequest, { relatedRequestId: "req-1" });

        // Should go through POST stream
        expect(postStreamWriter.write).toHaveBeenCalled();
        expect(postStreamData.length).toBe(1);
        expect(postStreamData[0]).toContain("elicitation/create");
        expect(postStreamData[0]).toContain("What is your name?");

        // Should NOT go through GET stream
        expect(getStreamWriter.write).not.toHaveBeenCalled();
        expect(getStreamData.length).toBe(0);
      });

      it("should route multiple messages to their respective streams based on relatedRequestId", async () => {
        // Add another POST stream
        const postStreamWriter2: WritableStreamDefaultWriter<Uint8Array> = {
          write: vi.fn(async (_chunk: Uint8Array) => {}),
          close: vi.fn(),
          abort: vi.fn(),
          releaseLock: vi.fn()
        } as unknown as WritableStreamDefaultWriter<Uint8Array>;

        const postEncoder2 = new TextEncoder();

        setupMockStream(
          transport,
          "post-stream-2",
          postStreamWriter2,
          postEncoder2
        );
        mapRequestToStream(transport, "req-2", "post-stream-2");

        const message1: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "msg-1",
          method: "elicitation/create",
          params: { message: "Message for stream 1" }
        };

        const message2: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "msg-2",
          method: "elicitation/create",
          params: { message: "Message for stream 2" }
        };

        // Send to different streams
        await transport.send(message1, { relatedRequestId: "req-1" });
        await transport.send(message2, { relatedRequestId: "req-2" });

        // Each stream should receive its own message
        expect(postStreamWriter.write).toHaveBeenCalledTimes(1);
        expect(postStreamWriter2.write).toHaveBeenCalledTimes(1);
        expect(getStreamWriter.write).not.toHaveBeenCalled();
      });
    });

    describe("Server-to-client requests without relatedRequestId", () => {
      it("should route messages without relatedRequestId through the standalone GET stream", async () => {
        const notification: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "notif-1",
          method: "notifications/message",
          params: {
            level: "info",
            data: "Server notification"
          }
        };

        // Send without relatedRequestId
        await transport.send(notification);

        // Should go through GET stream
        expect(getStreamWriter.write).toHaveBeenCalled();
        expect(getStreamData.length).toBe(1);
        expect(getStreamData[0]).toContain("notifications/message");

        // Should NOT go through POST stream
        expect(postStreamWriter.write).not.toHaveBeenCalled();
        expect(postStreamData.length).toBe(0);
      });

      it("should not fail when standalone GET stream is not available", async () => {
        // Remove the GET stream
        deleteStream(transport, "_GET_stream");

        const notification: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "notif-2",
          method: "notifications/message",
          params: { level: "info", data: "Test" }
        };

        // Should not throw
        await expect(transport.send(notification)).resolves.toBeUndefined();
      });
    });

    describe("Response routing", () => {
      it("should route responses based on their message.id (overriding relatedRequestId)", async () => {
        const response = {
          jsonrpc: "2.0" as const,
          id: "req-1",
          result: { content: [{ type: "text" as const, text: "Response" }] }
        };

        // Even if we provide a different relatedRequestId, response should use message.id
        await transport.send(response, { relatedRequestId: "something-else" });

        // Should go through POST stream (because message.id="req-1" maps to post-stream-1)
        expect(postStreamWriter.write).toHaveBeenCalled();
        expect(postStreamData.length).toBeGreaterThan(0);
      });
    });

    describe("Error handling", () => {
      it("should throw error when relatedRequestId has no mapped stream", async () => {
        const message: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "msg-1",
          method: "elicitation/create",
          params: {}
        };

        await expect(
          transport.send(message, { relatedRequestId: "non-existent-id" })
        ).rejects.toThrow(/No connection established/);
      });

      it("should not send responses to standalone stream when requestId is not mapped", async () => {
        const response = {
          jsonrpc: "2.0" as const,
          id: "unknown-request",
          result: { content: [] }
        };

        // Should throw because the requestId is not mapped to any stream
        await expect(transport.send(response)).rejects.toThrow(
          /No connection established for request ID/
        );
      });
    });

    describe("Edge cases", () => {
      it("should use message.id for responses even when relatedRequestId matches a different mapped request", async () => {
        // Set up: req-1 -> post-stream-1, req-2 -> post-stream-2
        const postStreamWriter2: WritableStreamDefaultWriter<Uint8Array> = {
          write: vi.fn(async (_chunk: Uint8Array) => {}),
          close: vi.fn(),
          abort: vi.fn(),
          releaseLock: vi.fn()
        } as unknown as WritableStreamDefaultWriter<Uint8Array>;

        setupMockStream(
          transport,
          "post-stream-2",
          postStreamWriter2,
          new TextEncoder()
        );
        mapRequestToStream(transport, "req-2", "post-stream-2");

        // Send a response with id="req-2" but relatedRequestId="req-1"
        const response = {
          jsonrpc: "2.0" as const,
          id: "req-2",
          result: { content: [{ type: "text" as const, text: "Response" }] }
        };

        await transport.send(response, { relatedRequestId: "req-1" });

        // Should go through post-stream-2 (based on message.id="req-2")
        // NOT post-stream-1 (based on relatedRequestId="req-1")
        expect(postStreamWriter2.write).toHaveBeenCalled();
        expect(postStreamWriter.write).not.toHaveBeenCalled();
      });

      it("should handle multiple concurrent server-to-client requests with the same relatedRequestId", async () => {
        // Both elicitations reference the same originating request
        const elicitation1: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "elicit-1",
          method: "elicitation/create",
          params: { message: "First elicitation" }
        };

        const elicitation2: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "elicit-2",
          method: "elicitation/create",
          params: { message: "Second elicitation" }
        };

        // Both use the same relatedRequestId
        await transport.send(elicitation1, { relatedRequestId: "req-1" });
        await transport.send(elicitation2, { relatedRequestId: "req-1" });

        // Both should go through the same POST stream
        expect(postStreamWriter.write).toHaveBeenCalledTimes(2);
        expect(postStreamData.length).toBe(2);
        expect(postStreamData[0]).toContain("First elicitation");
        expect(postStreamData[1]).toContain("Second elicitation");
      });

      it("should handle relatedRequestId that points to a closed stream differently than missing stream", async () => {
        // Map req-2 to a stream, then delete the stream (simulating closure)
        mapRequestToStream(transport, "req-2", "closed-stream");

        const message: JSONRPCRequest = {
          jsonrpc: "2.0",
          id: "msg-1",
          method: "elicitation/create",
          params: {}
        };

        // Should throw because stream is mapped but doesn't exist
        await expect(
          transport.send(message, { relatedRequestId: "req-2" })
        ).rejects.toThrow(/No connection established/);
      });
    });
  });
});
