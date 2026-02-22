import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TestMcpJurisdiction } from "../worker";
import * as indexModule from "../../index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_MCP_JURISDICTION: DurableObjectNamespace<TestMcpJurisdiction>;
  }
}

/**
 * Tests for jurisdiction option in McpAgent.serve()
 *
 * These tests verify that the jurisdiction parameter is properly passed through
 * to the Durable Object creation. Note that actual jurisdiction enforcement
 * (data localization) happens at the Cloudflare runtime level in production
 * and is not enforced in workerd (the local development runtime).
 *
 * Therefore, these tests mock getAgentByName to verify parameter passing
 * without triggering the "Jurisdiction restrictions are not implemented in workerd"
 * error. In production, Cloudflare will respect the jurisdiction parameter
 * and create Durable Objects in the specified region (e.g., "eu" for EU data centers).
 */

describe("McpAgent jurisdiction option", () => {
  describe("serve() with jurisdiction", () => {
    let getAgentByNameSpy: ReturnType<
      typeof vi.spyOn<
        typeof indexModule,
        // @ts-expect-error - getAgentByName is not a method of the indexModule
        "getAgentByName"
      >
    >;
    let originalGetAgentByName: typeof indexModule.getAgentByName;

    beforeEach(() => {
      // Store the original function
      originalGetAgentByName = indexModule.getAgentByName;
      // Spy on getAgentByName to verify jurisdiction is passed
      getAgentByNameSpy = vi.spyOn(indexModule, "getAgentByName");

      // Mock getAgentByName to avoid workerd jurisdiction limitations
      getAgentByNameSpy.mockImplementation(async (namespace, name, options) => {
        // In workerd, jurisdiction is not supported, so we mock this to test
        // that the parameter is passed correctly without actually enforcing it
        const mockOptions = { ...options };
        delete mockOptions.jurisdiction; // Remove jurisdiction to avoid workerd error
        return originalGetAgentByName(namespace, name, mockOptions);
      });
    });

    afterEach(() => {
      getAgentByNameSpy.mockRestore();
    });

    it("should pass jurisdiction parameter to getAgentByName for streamable-http transport", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        jurisdiction: "eu",
        transport: "streamable-http"
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

      await handler.fetch(request, env, ctx);

      // Verify getAgentByName was called with the jurisdiction option
      expect(getAgentByNameSpy).toHaveBeenCalled();
      const callArgs = getAgentByNameSpy.mock.calls[0];
      expect(callArgs[2]).toHaveProperty("jurisdiction", "eu");
    });

    it("should pass jurisdiction parameter to getAgentByName for SSE transport", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        jurisdiction: "eu",
        transport: "sse"
      });

      const ctx = createExecutionContext();
      const request = new Request("http://example.com/mcp", {
        method: "GET"
      });

      await handler.fetch(request, env, ctx);

      // Verify getAgentByName was called with the jurisdiction option
      expect(getAgentByNameSpy).toHaveBeenCalled();
      const callArgs = getAgentByNameSpy.mock.calls[0];
      expect(callArgs[2]).toHaveProperty("jurisdiction", "eu");
    });

    it("should pass fedramp jurisdiction correctly", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        jurisdiction: "fedramp",
        transport: "streamable-http"
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

      await handler.fetch(request, env, ctx);

      expect(getAgentByNameSpy).toHaveBeenCalled();
      const callArgs = getAgentByNameSpy.mock.calls[0];
      expect(callArgs[2]).toHaveProperty("jurisdiction", "fedramp");
    });

    it("should work without jurisdiction (defaults to undefined)", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        transport: "streamable-http"
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

      await handler.fetch(request, env, ctx);

      expect(getAgentByNameSpy).toHaveBeenCalled();
      const callArgs = getAgentByNameSpy.mock.calls[0];
      // Should either not have jurisdiction property or be undefined
      if (callArgs[2]) {
        expect(callArgs[2].jurisdiction).toBeUndefined();
      }
    });

    it("should pass jurisdiction for subsequent requests with session ID", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        jurisdiction: "eu",
        transport: "streamable-http"
      });

      const ctx = createExecutionContext();

      // First request (initialization)
      const initRequest = new Request("http://example.com/mcp", {
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

      const initResponse = await handler.fetch(initRequest, env, ctx);
      const sessionId = initResponse.headers.get("mcp-session-id");

      // Clear previous spy calls
      getAgentByNameSpy.mockClear();

      // Second request (with session ID)
      const followUpRequest = new Request("http://example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "2",
          method: "tools/list",
          params: {}
        })
      });

      await handler.fetch(followUpRequest, env, ctx);

      // Verify jurisdiction is still passed for subsequent requests
      expect(getAgentByNameSpy).toHaveBeenCalled();
      const callArgs = getAgentByNameSpy.mock.calls[0];
      expect(callArgs[2]).toHaveProperty("jurisdiction", "eu");
    });

    it("should pass jurisdiction for SSE message endpoint", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        jurisdiction: "eu",
        transport: "sse"
      });

      const ctx = createExecutionContext();

      // First, establish SSE connection
      const sseRequest = new Request(
        "http://example.com/mcp?sessionId=test-session",
        {
          method: "GET"
        }
      );

      await handler.fetch(sseRequest, env, ctx);

      // Clear previous spy calls
      getAgentByNameSpy.mockClear();

      // Now send a message
      const messageRequest = new Request(
        "http://example.com/mcp/message?sessionId=test-session",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
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
        }
      );

      await handler.fetch(messageRequest, env, ctx);

      // Verify jurisdiction is passed for SSE message endpoint
      expect(getAgentByNameSpy).toHaveBeenCalled();
      const callArgs = getAgentByNameSpy.mock.calls[0];
      expect(callArgs[2]).toHaveProperty("jurisdiction", "eu");
    });
  });

  describe("Integration test - jurisdiction doesn't break functionality", () => {
    beforeEach(() => {
      // Use the same mock setup for integration tests
      const originalGetAgentByName = indexModule.getAgentByName;
      const spy = vi.spyOn(indexModule, "getAgentByName");
      spy.mockImplementation(async (namespace, name, options) => {
        const mockOptions = { ...options };
        delete mockOptions.jurisdiction;
        return originalGetAgentByName(namespace, name, mockOptions);
      });
    });

    it("should successfully handle requests with eu jurisdiction", async () => {
      const handler = TestMcpJurisdiction.serve("/mcp", {
        binding: "TEST_MCP_JURISDICTION",
        jurisdiction: "eu",
        transport: "streamable-http"
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

      const response = await handler.fetch(request, env, ctx);

      // Request should succeed with jurisdiction set
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeDefined();
    });
  });
});
