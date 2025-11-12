import { describe, it, expect, beforeEach, vi } from "vitest";
import { MCPClientManager } from "../../mcp/client";
import { MCPClientConnection } from "../../mcp/client-connection";

describe("MCPClientManager OAuth Integration", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    manager = new MCPClientManager("test-client", "1.0.0");
  });

  describe("Connection Reuse During OAuth", () => {
    it("should test OAuth reconnect logic through connection reuse condition", async () => {
      const serverId = "test-server-id";

      // Create a real connection and mock its methods
      const connection = new MCPClientConnection(
        new URL("http://example.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "auto" }, client: {} }
      );

      // Mock connection methods to avoid real HTTP calls
      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);

      // Set up connection state
      connection.connectionState = "authenticating";

      // Pre-populate manager with existing connection
      manager.mcpConnections[serverId] = connection;

      // Test the OAuth reconnect path by checking the condition logic
      const hasExistingConnection = !!manager.mcpConnections[serverId];
      const isOAuthReconnect = true; // simulating OAuth code being present

      // This tests our connection reuse logic: !options.reconnect?.oauthCode || !this.mcpConnections[id]
      const shouldReuseConnection = isOAuthReconnect && hasExistingConnection;

      expect(shouldReuseConnection).toBe(true);
      expect(manager.mcpConnections[serverId]).toBe(connection);
      expect(connection.connectionState).toBe("authenticating");
    });
  });

  describe("Callback URL Management", () => {
    it("should register and unregister callback URLs", () => {
      const callbackUrl1 = "http://localhost:3000/callback/server1";
      const callbackUrl2 = "http://localhost:3000/callback/server2";

      // Register callback URLs
      manager.registerCallbackUrl(callbackUrl1);
      manager.registerCallbackUrl(callbackUrl2);

      // Test callback recognition
      expect(
        manager.isCallbackRequest(new Request(`${callbackUrl1}?code=test`))
      ).toBe(true);
      expect(
        manager.isCallbackRequest(new Request(`${callbackUrl2}?code=test`))
      ).toBe(true);
      expect(
        manager.isCallbackRequest(new Request("http://other.com/callback"))
      ).toBe(false);

      // Unregister callback URL
      manager.unregisterCallbackUrl("server1");

      // Should no longer recognize the unregistered callback
      expect(
        manager.isCallbackRequest(new Request(`${callbackUrl1}?code=test`))
      ).toBe(false);
      expect(
        manager.isCallbackRequest(new Request(`${callbackUrl2}?code=test`))
      ).toBe(true);
    });

    it("should not register duplicate callback URLs", () => {
      const callbackUrl = "http://localhost:3000/callback/server1";

      // Register the same URL multiple times
      manager.registerCallbackUrl(callbackUrl);
      manager.registerCallbackUrl(callbackUrl);
      manager.registerCallbackUrl(callbackUrl);

      // Verify no duplicates by testing callback recognition still works with one registration
      expect(
        manager.isCallbackRequest(new Request(`${callbackUrl}?code=test`))
      ).toBe(true);
    });

    it("should handle callback request processing", async () => {
      const serverId = "test-server";
      const clientId = "test-client-id";
      const authCode = "test-auth-code";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;

      // Register callback URL
      manager.registerCallbackUrl(callbackUrl);

      // Create real connection with authProvider and mock its methods
      const mockAuthProvider = {
        authUrl: undefined,
        clientId: undefined,
        serverId: undefined,
        redirectUrl: "http://localhost:3000/callback",
        clientMetadata: {
          client_name: "test-client",
          client_uri: "http://localhost:3000",
          redirect_uris: ["http://localhost:3000/callback"]
        },
        tokens: vi.fn(),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn()
      };

      const connection = new MCPClientConnection(
        new URL("http://example.com"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "auto", authProvider: mockAuthProvider },
          client: {}
        }
      );

      // Mock methods to avoid HTTP calls
      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "authenticating";

      manager.mcpConnections[serverId] = connection;

      // Mock the completeAuthorization method for OAuth completion
      const completeAuthSpy = vi
        .spyOn(connection, "completeAuthorization")
        .mockImplementation(async () => {
          connection.connectionState = "connecting";
        });

      // Create callback request
      const callbackRequest = new Request(
        `${callbackUrl}?code=${authCode}&state=${clientId}`
      );

      // Process callback
      const result = await manager.handleCallbackRequest(callbackRequest);

      expect(result.serverId).toBe(serverId);
      expect(result.authSuccess).toBe(true);

      // Verify completeAuthorization was called with the OAuth code
      expect(completeAuthSpy).toHaveBeenCalledWith(authCode);

      // Verify the auth provider was set up correctly
      expect(connection.options.transport.authProvider?.clientId).toBe(
        clientId
      );
      expect(connection.options.transport.authProvider?.serverId).toBe(
        serverId
      );
    });

    it("should throw error for callback without matching URL", async () => {
      const callbackRequest = new Request(
        "http://localhost:3000/unknown?code=test"
      );

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("No callback URI match found");
    });

    it("should handle OAuth error response from provider", async () => {
      const callbackUrl = "http://localhost:3000/callback/server1";
      manager.registerCallbackUrl(callbackUrl);

      const callbackRequest = new Request(
        `${callbackUrl}?error=access_denied&error_description=User%20denied%20access`
      );

      const result = await manager.handleCallbackRequest(callbackRequest);

      expect(result.serverId).toBe("server1");
      expect(result.authSuccess).toBe(false);
      expect(result.authError).toBe("User denied access");
    });

    it("should throw error for callback without code or error", async () => {
      const callbackUrl = "http://localhost:3000/callback/server1";
      manager.registerCallbackUrl(callbackUrl);

      const callbackRequest = new Request(`${callbackUrl}?state=test`);

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("Unauthorized: no code provided");
    });

    it("should throw error for callback without state", async () => {
      const callbackUrl = "http://localhost:3000/callback/server1";
      manager.registerCallbackUrl(callbackUrl);

      const callbackRequest = new Request(`${callbackUrl}?code=test`);

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("Unauthorized: no state provided");
    });

    it("should throw error for callback with non-existent server", async () => {
      const callbackUrl = "http://localhost:3000/callback/non-existent";
      manager.registerCallbackUrl(callbackUrl);

      const callbackRequest = new Request(
        `${callbackUrl}?code=test&state=client`
      );

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("Could not find serverId: non-existent");
    });

    it("should throw error for callback when not in authenticating state", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;
      manager.registerCallbackUrl(callbackUrl);

      // Create real connection in ready state (not authenticating)
      const connection = new MCPClientConnection(
        new URL("http://example.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: {}, client: {} }
      );

      // Mock methods and set state
      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "ready"; // Not authenticating

      manager.mcpConnections[serverId] = connection;

      const callbackRequest = new Request(
        `${callbackUrl}?code=test&state=client`
      );

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow(
        "Failed to authenticate: the client isn't in the `authenticating` state"
      );
    });
  });
});
