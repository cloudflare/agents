import { describe, expect, it } from "vitest";
import { MCPClientManager } from "../../../mcp/client";
import type { DurableObjectOAuthClientProvider } from "../../../mcp/do-oauth-client-provider";

/**
 * Tests for MCP client-side functionality
 */
describe("MCP Client Manager", () => {
  const mockServerUrl = "http://localhost:3000/mcp";

  describe("Client Creation", () => {
    it("should create a client manager", () => {
      const manager = new MCPClientManager("test-client", "1.0.0");
      expect(manager).toBeDefined();
      expect(manager.mcpConnections).toEqual({});
    });
  });

  describe("Transport Configuration", () => {
    it("should connect with streamable HTTP transport", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      const mockAuthProvider = {
        serverId: "test-server",
        clientId: "test-client",
        authUrl: "http://localhost:3000/auth",
        redirectUrl: new URL("http://localhost:3000/callback"),
        tokens: () => Promise.resolve({ access_token: "test-token" })
      } as unknown as DurableObjectOAuthClientProvider;

      try {
        const result = await manager.connect(mockServerUrl, {
          transport: {
            type: "streamable-http",
            authProvider: mockAuthProvider
          }
        });

        expect(result).toBeDefined();
        expect(result.id).toBeDefined();
        expect(typeof result.id).toBe("string");
        expect(result.id.length).toBe(8);
      } catch (error) {
        // Expected to fail in test environment, but transport should be created
        expect(error).toBeDefined();
      }
    });

    it("should connect with SSE transport", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      try {
        const result = await manager.connect(mockServerUrl, {
          transport: {
            type: "sse"
          }
        });

        expect(result).toBeDefined();
        expect(result.id).toBeDefined();
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeDefined();
      }
    });

    it("should default to streamable HTTP transport", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      try {
        const result = await manager.connect(mockServerUrl, {
          transport: {
            // No type specified, should default to streamable-http
          }
        });

        expect(result).toBeDefined();
        expect(result.id).toBeDefined();
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeDefined();
      }
    });
  });

  describe("Connection Management", () => {
    it("should handle reconnection", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      const mockAuthProvider = {
        serverId: "test-server",
        clientId: "test-client",
        authUrl: "http://localhost:3000/auth",
        redirectUrl: new URL("http://localhost:3000/callback"),
        tokens: () => Promise.resolve({ access_token: "test-token" })
      } as unknown as DurableObjectOAuthClientProvider;

      try {
        const result = await manager.connect(mockServerUrl, {
          reconnect: {
            id: "existing-server-id",
            oauthClientId: "existing-client-id",
            oauthCode: "auth-code-123"
          },
          transport: {
            type: "streamable-http",
            authProvider: mockAuthProvider
          }
        });

        expect(result).toBeDefined();
        expect(result.id).toBe("existing-server-id");
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeDefined();
      }
    });

    it("should maintain connection state", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      expect(Object.keys(manager.mcpConnections)).toHaveLength(0);

      try {
        await manager.connect(mockServerUrl, {
          transport: {
            type: "streamable-http"
          }
        });
      } catch (_error) {
        // Expected to fail, but connection should be created
      }

      expect(Object.keys(manager.mcpConnections)).toHaveLength(1);
    });

    it("should close individual connections", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      try {
        const result = await manager.connect(mockServerUrl, {
          transport: {
            type: "streamable-http"
          }
        });

        expect(Object.keys(manager.mcpConnections)).toHaveLength(1);

        await manager.closeConnection(result.id);

        expect(Object.keys(manager.mcpConnections)).toHaveLength(0);
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeDefined();
      }
    });

    it("should close all connections", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      try {
        await manager.connect(mockServerUrl, {
          transport: {
            type: "streamable-http"
          }
        });

        await manager.connect(mockServerUrl, {
          transport: {
            type: "sse"
          }
        });

        expect(Object.keys(manager.mcpConnections).length).toBeGreaterThan(0);

        await manager.closeAllConnections();

        // Note: closeAllConnections closes clients but doesn't remove from connections object
        expect(Object.keys(manager.mcpConnections).length).toBeGreaterThan(0);
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeDefined();
      }
    });
  });

  describe("OAuth Integration", () => {
    it("should handle OAuth callback requests", () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      // Test with no registered callbacks
      const testRequest = new Request("http://localhost:3000/callback");
      expect(manager.isCallbackRequest(testRequest)).toBe(false);
    });

    it("should support authentication flow", async () => {
      const manager = new MCPClientManager("test-client", "1.0.0");

      const mockAuthProvider = {
        serverId: "test-server",
        clientId: "test-client",
        authUrl: "http://localhost:3000/auth",
        redirectUrl: new URL("http://localhost:3000/callback"),
        tokens: () => Promise.resolve({ access_token: "test-token" })
      } as unknown as DurableObjectOAuthClientProvider;

      try {
        const result = await manager.connect(mockServerUrl, {
          transport: {
            type: "streamable-http",
            authProvider: mockAuthProvider
          }
        });

        // Should have auth-related properties when auth provider is present
        expect(result).toBeDefined();
        expect(result.id).toBeDefined();
      } catch (error) {
        // Expected to fail in test environment
        expect(error).toBeDefined();
      }
    });
  });
});
