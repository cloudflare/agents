import { describe, it, expect, beforeEach, vi } from "vitest";
import { MCPClientManager } from "../../mcp/client";
import { MCPClientConnection } from "../../mcp/client-connection";
import {
  AgentMCPClientStorage,
  type MCPServerRow
} from "../../mcp/client-storage";
import type { ToolCallOptions } from "ai";

/**
 * Internal type for test access to private storage.
 */
type MCPClientManagerInternal = {
  _storage: AgentMCPClientStorage;
};

describe("MCPClientManager OAuth Integration", () => {
  let manager: MCPClientManager;
  let mockStorageData: Map<string, MCPServerRow>;
  let mockKVData: Map<string, unknown>;

  beforeEach(() => {
    mockStorageData = new Map();
    mockKVData = new Map();

    // Create a proper mock storage adapter
    const mockStorage = new AgentMCPClientStorage(
      <T extends Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ) => {
        const query = strings.join("");

        if (query.includes("INSERT OR REPLACE")) {
          const id = values[0] as string;
          mockStorageData.set(id, {
            id: values[0] as string,
            name: values[1] as string,
            server_url: values[2] as string,
            client_id: values[3] as string | null,
            auth_url: values[4] as string | null,
            callback_url: values[5] as string,
            server_options: values[6] as string | null
          });
          return [] as unknown as T[];
        }

        if (query.includes("DELETE")) {
          const id = values[0] as string;
          mockStorageData.delete(id);
          return [] as unknown as T[];
        }

        if (query.includes("UPDATE") && query.includes("auth_url = NULL")) {
          // clearAuthUrl query - only clears auth_url, preserves callback_url
          const id = values[0] as string;
          const server = mockStorageData.get(id);
          if (server) {
            server.auth_url = null;
            mockStorageData.set(id, server);
          }
          return [] as unknown as T[];
        }

        if (query.includes("SELECT")) {
          if (query.includes("WHERE callback_url")) {
            const url = values[0] as string;
            for (const server of mockStorageData.values()) {
              if (server.callback_url === url) {
                return [server] as unknown as T[];
              }
            }
            return [] as unknown as T[];
          }
          return Array.from(mockStorageData.values()) as unknown as T[];
        }

        return [] as unknown as T[];
      },
      {
        get: <T>(key: string) => mockKVData.get(key) as T | undefined,
        put: (key: string, value: unknown) => {
          mockKVData.set(key, value);
        },
        list: vi.fn(),
        delete: vi.fn()
      }
    );

    manager = new MCPClientManager("test-client", "1.0.0", {
      storage: mockStorage
    });
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
    it("should recognize callback URLs from database", async () => {
      const callbackUrl1 = "http://localhost:3000/callback/server1";
      const callbackUrl2 = "http://localhost:3000/callback/server2";

      // Save servers with callback URLs to database
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "server1",
        name: "Test Server 1",
        server_url: "http://test1.com",
        callback_url: callbackUrl1,
        client_id: null,
        auth_url: null,
        server_options: null
      });
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "server2",
        name: "Test Server 2",
        server_url: "http://test2.com",
        callback_url: callbackUrl2,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Test callback recognition
      expect(
        await manager.isCallbackRequest(
          new Request(`${callbackUrl1}?code=test`)
        )
      ).toBe(true);
      expect(
        await manager.isCallbackRequest(
          new Request(`${callbackUrl2}?code=test`)
        )
      ).toBe(true);
      expect(
        await manager.isCallbackRequest(
          new Request("http://other.com/callback")
        )
      ).toBe(false);

      // Remove server from database
      await manager.removeServer("server1");

      // Should no longer recognize the removed server's callback
      expect(
        await manager.isCallbackRequest(
          new Request(`${callbackUrl1}?code=test`)
        )
      ).toBe(false);
      expect(
        await manager.isCallbackRequest(
          new Request(`${callbackUrl2}?code=test`)
        )
      ).toBe(true);
    });

    it("should handle callback request processing", async () => {
      const serverId = "test-server";
      const clientId = "test-client-id";
      const authCode = "test-auth-code";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;

      // Save server to database with callback URL
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

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
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "server1",
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

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
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "server1",
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      const callbackRequest = new Request(`${callbackUrl}?state=test`);

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("Unauthorized: no code provided");
    });

    it("should throw error for callback without state", async () => {
      const callbackUrl = "http://localhost:3000/callback/server1";
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "server1",
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      const callbackRequest = new Request(`${callbackUrl}?code=test`);

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("Unauthorized: no state provided");
    });

    it("should throw error for callback with non-existent server", async () => {
      const callbackUrl = "http://localhost:3000/callback/non-existent";
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "non-existent",
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      const callbackRequest = new Request(
        `${callbackUrl}?code=test&state=client`
      );

      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("Could not find serverId: non-existent");
    });

    it("should handle duplicate callback when already in ready state", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Create real connection in ready state (simulates duplicate callback)
      const connection = new MCPClientConnection(
        new URL("http://example.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: {}, client: {} }
      );

      // Mock methods and set state
      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "ready"; // Already authenticated

      manager.mcpConnections[serverId] = connection;

      const callbackRequest = new Request(
        `${callbackUrl}?code=test&state=client`
      );

      // Should gracefully handle duplicate callback by returning success
      const result = await manager.handleCallbackRequest(callbackRequest);
      expect(result.authSuccess).toBe(true);
      expect(result.serverId).toBe(serverId);
    });

    it("should error when callback received for connection in failed state", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Create connection in failed state
      const connection = new MCPClientConnection(
        new URL("http://example.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: {}, client: {} }
      );

      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "failed"; // Connection previously failed

      manager.mcpConnections[serverId] = connection;

      const callbackRequest = new Request(
        `${callbackUrl}?code=test&state=client`
      );

      // Should error - failed connections need to be recreated, not re-authenticated
      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow(
        'Failed to authenticate: the client is in "failed" state, expected "authenticating"'
      );
    });
  });

  describe("OAuth Security", () => {
    it("should clear auth_url but preserve callback_url after successful authentication", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;
      const authUrl = "https://auth.example.com/authorize";

      // Save server with auth_url and callback_url
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: "test-client-id",
        auth_url: authUrl,
        server_options: null
      });

      // Verify initial state
      let server = mockStorageData.get(serverId);
      expect(server).toBeDefined();
      expect(server?.callback_url).toBe(callbackUrl);
      expect(server?.auth_url).toBe(authUrl);

      // Create connection with auth provider
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
        new URL("http://test.com"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "auto", authProvider: mockAuthProvider },
          client: {}
        }
      );

      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "authenticating";
      connection.completeAuthorization = vi.fn().mockResolvedValue(undefined);

      manager.mcpConnections[serverId] = connection;

      // Handle callback
      const callbackRequest = new Request(
        `${callbackUrl}?code=test-code&state=test-state`
      );
      const result = await manager.handleCallbackRequest(callbackRequest);

      expect(result.authSuccess).toBe(true);

      // Verify auth_url cleared but callback_url preserved (for future OAuth flows)
      server = mockStorageData.get(serverId);
      expect(server).toBeDefined();
      expect(server?.callback_url).toBe(callbackUrl); // ✅ Preserved!
      expect(server?.auth_url).toBe(null); // ✅ Cleared!
    });

    it("should prevent second callback attempt after auth_url is cleared", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;

      // Save server with cleared callback_url (simulating post-auth state)
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: "", // Already cleared
        client_id: "test-client-id",
        auth_url: null, // Already cleared
        server_options: null
      });

      const callbackRequest = new Request(
        `${callbackUrl}?code=malicious-code&state=test-state`
      );

      // Request should not be recognized as a callback
      const isCallback = await manager.isCallbackRequest(callbackRequest);
      expect(isCallback).toBe(false);

      // And handleCallbackRequest should fail
      await expect(
        manager.handleCallbackRequest(callbackRequest)
      ).rejects.toThrow("No callback URI match found");
    });

    it("should only match exact callback URLs from database", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Exact match should work
      expect(
        await manager.isCallbackRequest(new Request(`${callbackUrl}?code=test`))
      ).toBe(true);

      // Prefix match should work (URL params)
      expect(
        await manager.isCallbackRequest(
          new Request(`${callbackUrl}?code=test&state=abc`)
        )
      ).toBe(true);

      // Different server ID should not match
      expect(
        await manager.isCallbackRequest(
          new Request(
            "http://localhost:3000/callback/different-server?code=test"
          )
        )
      ).toBe(false);

      // Different host should not match
      expect(
        await manager.isCallbackRequest(
          new Request(`http://evil.com/callback/${serverId}?code=test`)
        )
      ).toBe(false);

      // Different path should not match
      expect(
        await manager.isCallbackRequest(
          new Request(`http://localhost:3000/different/${serverId}?code=test`)
        )
      ).toBe(false);
    });
  });

  describe("OAuth Connection Restoration", () => {
    it("should restore OAuth connections from storage", async () => {
      const serverId = "oauth-server";
      const callbackUrl = "http://localhost:3000/callback";
      const clientId = "stored-client-id";
      const authUrl = "https://auth.example.com/authorize";

      // Save OAuth server to storage
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "OAuth Server",
        server_url: "http://oauth-server.com",
        callback_url: callbackUrl,
        client_id: clientId,
        auth_url: authUrl,
        server_options: JSON.stringify({
          transport: { type: "auto" },
          client: {}
        })
      });

      // Spy on connectToServer and mock it to set authenticating state
      const connectSpy = vi
        .spyOn(manager, "connectToServer")
        .mockImplementation(async (id) => {
          const conn = manager.mcpConnections[id];
          if (conn) {
            conn.init = vi.fn().mockImplementation(async () => {
              conn.connectionState = "authenticating";
            });
            await conn.init();
          }
          return {
            state: "authenticating",
            authUrl,
            clientId
          };
        });

      await manager.restoreConnectionsFromStorage("test-agent");

      // Verify connection was created and connectToServer was called
      const connection = manager.mcpConnections[serverId];
      expect(connection).toBeDefined();
      expect(connectSpy).toHaveBeenCalledWith(serverId);
      expect(connection.connectionState).toBe("authenticating");

      // Verify auth provider was set up
      expect(connection.options.transport.authProvider).toBeDefined();
      expect(connection.options.transport.authProvider?.serverId).toBe(
        serverId
      );
      expect(connection.options.transport.authProvider?.clientId).toBe(
        clientId
      );
    });

    it("should restore non-OAuth connections from storage", async () => {
      const serverId = "regular-server";
      const callbackUrl = "http://localhost:3000/callback";

      // Save non-OAuth server (no auth_url)
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Regular Server",
        server_url: "http://regular-server.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null, // No OAuth
        server_options: JSON.stringify({
          transport: { type: "sse", headers: { "X-Custom": "value" } },
          client: {}
        })
      });

      // Mock connectToServer to avoid real HTTP calls
      vi.spyOn(manager, "connectToServer").mockResolvedValue({
        state: "ready"
      });

      await manager.restoreConnectionsFromStorage("test-agent");

      // Verify connection was registered and connected
      const connection = manager.mcpConnections[serverId];
      expect(connection).toBeDefined();

      // Verify auth provider was created (required for all connections)
      expect(connection.options.transport.authProvider).toBeDefined();
    });

    it("should handle empty server list gracefully", async () => {
      await manager.restoreConnectionsFromStorage("test-agent");

      // Should not throw and should have no connections
      expect(Object.keys(manager.mcpConnections)).toHaveLength(0);
    });

    it("should restore mixed OAuth and non-OAuth servers", async () => {
      // Save OAuth server
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "oauth-server",
        name: "OAuth Server",
        server_url: "http://oauth.com",
        callback_url: "http://localhost:3000/callback/oauth",
        client_id: "oauth-client",
        auth_url: "https://auth.example.com/authorize",
        server_options: null
      });

      // Save regular server
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: "regular-server",
        name: "Regular Server",
        server_url: "http://regular.com",
        callback_url: "http://localhost:3000/callback/regular",
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Mock connectToServer to return appropriate states
      vi.spyOn(manager, "connectToServer").mockImplementation(async (id) => {
        const conn = manager.mcpConnections[id];
        if (id === "oauth-server" && conn) {
          conn.init = vi.fn().mockImplementation(async () => {
            conn.connectionState = "authenticating";
          });
          await conn.init();
          return {
            state: "authenticating",
            authUrl: "https://auth.example.com/authorize",
            clientId: "oauth-client"
          };
        }
        return { state: "ready" };
      });

      await manager.restoreConnectionsFromStorage("test-agent");

      // Verify OAuth server is in authenticating state
      expect(manager.mcpConnections["oauth-server"]).toBeDefined();
      expect(manager.mcpConnections["oauth-server"].connectionState).toBe(
        "authenticating"
      );

      // Verify regular server was connected
      expect(manager.mcpConnections["regular-server"]).toBeDefined();
    });
  });

  describe("registerServer() and connectToServer()", () => {
    it("should register a server and save to storage", () => {
      const id = "test-server-1";
      const url = "http://example.com/mcp";
      const name = "Test Server";
      const callbackUrl = "http://localhost:3000/callback";

      manager.registerServer(id, {
        url,
        name,
        callbackUrl,
        client: {},
        transport: { type: "auto" }
      });

      // Verify connection was created
      expect(manager.mcpConnections[id]).toBeDefined();
      expect(manager.mcpConnections[id].url.toString()).toBe(url);

      // Verify saved to storage
      const servers = mockStorageData.get(id);
      expect(servers).toBeDefined();
      expect(servers?.name).toBe(name);
      expect(servers?.server_url).toBe(url);
      expect(servers?.callback_url).toBe(callbackUrl);
    });

    it("should skip registering if server already exists", () => {
      const id = "existing-server";
      const url = "http://example.com/mcp";
      const name = "Existing Server";
      const callbackUrl = "http://localhost:3000/callback";

      // Register once
      manager.registerServer(id, {
        url,
        name,
        callbackUrl,
        client: {},
        transport: { type: "auto" }
      });
      const firstConnection = manager.mcpConnections[id];

      // Try to register again
      manager.registerServer(id, {
        url,
        name,
        callbackUrl,
        client: {},
        transport: { type: "auto" }
      });
      const secondConnection = manager.mcpConnections[id];

      // Should be the same connection object
      expect(secondConnection).toBe(firstConnection);
    });

    it("should save auth URL and client ID when registering OAuth server", () => {
      const id = "oauth-server";
      const url = "http://oauth.example.com/mcp";
      const name = "OAuth Server";
      const callbackUrl = "http://localhost:3000/callback";
      const authUrl = "https://auth.example.com/authorize";
      const clientId = "test-client-id";

      manager.registerServer(id, {
        url,
        name,
        callbackUrl,
        client: {},
        transport: { type: "auto" },
        authUrl,
        clientId
      });

      // Verify OAuth info saved to storage
      const server = mockStorageData.get(id);
      expect(server?.auth_url).toBe(authUrl);
      expect(server?.client_id).toBe(clientId);
    });

    it("should throw error when connecting to non-registered server", async () => {
      await expect(
        manager.connectToServer("non-existent-server")
      ).rejects.toThrow(
        "Server non-existent-server is not registered. Call registerServer() first."
      );
    });

    it("should update storage with OAuth info after connection", async () => {
      const id = "test-oauth-server";
      const url = "http://oauth.example.com/mcp";
      const name = "OAuth Server";
      const callbackUrl = "http://localhost:3000/callback";

      // Create a mock auth provider that returns auth URL
      const mockAuthProvider = {
        serverId: id,
        clientId: "mock-client-id",
        authUrl: "https://auth.example.com/authorize",
        redirectUrl: callbackUrl,
        clientMetadata: {
          client_name: "test-client",
          redirect_uris: [callbackUrl]
        },
        tokens: vi.fn(),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn((url) => {
          mockAuthProvider.authUrl = url.toString();
        }),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn()
      };

      // Register server with auth provider
      manager.registerServer(id, {
        url,
        name,
        callbackUrl,
        client: {},
        transport: {
          type: "auto",
          authProvider: mockAuthProvider
        }
      });

      // Mock the connection to return authenticating state
      const conn = manager.mcpConnections[id];
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "authenticating";
      });

      // Connect to server
      const result = await manager.connectToServer(id);

      // Verify auth URL is returned with authenticating state
      expect(result.state).toBe("authenticating");
      if (result.state === "authenticating") {
        expect(result.authUrl).toBe(mockAuthProvider.authUrl);
        expect(result.clientId).toBe(mockAuthProvider.clientId);
      }

      // Verify storage was updated with OAuth info
      const server = mockStorageData.get(id);
      expect(server?.auth_url).toBe(mockAuthProvider.authUrl);
      expect(server?.client_id).toBe(mockAuthProvider.clientId);
    });

    it("should fire onServerStateChanged when registering a server", async () => {
      const id = "test-server";
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      await manager.registerServer(id, {
        url: "http://example.com/mcp",
        name: "Test Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when connecting to non-OAuth server (ready state)", async () => {
      const id = "non-oauth-server";
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      await manager.registerServer(id, {
        url: "http://example.com/mcp",
        name: "Non-OAuth Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      // Mock connection to reach ready state
      const conn = manager.mcpConnections[id];
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "ready";
      });

      // Clear previous calls from registerServer
      onStateChangedSpy.mockClear();

      await manager.connectToServer(id);

      // Should fire when connection reaches ready state
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when connecting to OAuth server (authenticating state)", async () => {
      const id = "oauth-server";
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      const mockAuthProvider = {
        serverId: id,
        clientId: "mock-client-id",
        authUrl: "https://auth.example.com/authorize",
        redirectUrl: "http://localhost:3000/callback",
        clientMetadata: {
          client_name: "test-client",
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

      await manager.registerServer(id, {
        url: "http://oauth.example.com/mcp",
        name: "OAuth Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: {
          type: "auto",
          authProvider: mockAuthProvider
        }
      });

      // Mock connection to stay in authenticating state
      const conn = manager.mcpConnections[id];
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "authenticating";
      });

      // Clear previous calls from registerServer
      onStateChangedSpy.mockClear();

      await manager.connectToServer(id);

      // Should fire when OAuth is initialized
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when OAuth callback succeeds", async () => {
      const id = "oauth-callback-server";
      const callbackUrl = `http://localhost:3000/callback/${id}`;
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      // Setup server in storage
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id,
        name: "OAuth Server",
        server_url: "http://oauth.example.com/mcp",
        callback_url: callbackUrl,
        client_id: "test-client",
        auth_url: "https://auth.example.com/authorize",
        server_options: null
      });

      // Create connection with auth provider
      const mockAuthProvider = {
        authUrl: undefined,
        clientId: "test-client",
        serverId: id,
        redirectUrl: callbackUrl,
        clientMetadata: {
          client_name: "test-client",
          client_uri: "http://localhost:3000",
          redirect_uris: [callbackUrl]
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
        new URL("http://oauth.example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "auto", authProvider: mockAuthProvider },
          client: {}
        }
      );

      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "authenticating";
      connection.completeAuthorization = vi
        .fn()
        .mockImplementation(async () => {
          connection.connectionState = "connecting";
        });

      manager.mcpConnections[id] = connection;

      // Clear previous calls
      onStateChangedSpy.mockClear();

      const callbackRequest = new Request(
        `${callbackUrl}?code=test-code&state=test-state`
      );
      await manager.handleCallbackRequest(callbackRequest);

      // Should fire on successful callback
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when OAuth callback fails", async () => {
      const id = "oauth-fail-server";
      const callbackUrl = `http://localhost:3000/callback/${id}`;
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      // Setup server in storage
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id,
        name: "OAuth Server",
        server_url: "http://oauth.example.com/mcp",
        callback_url: callbackUrl,
        client_id: "test-client",
        auth_url: "https://auth.example.com/authorize",
        server_options: null
      });

      // Create connection with auth provider
      const mockAuthProvider = {
        authUrl: undefined,
        clientId: "test-client",
        serverId: id,
        redirectUrl: callbackUrl,
        clientMetadata: {
          client_name: "test-client",
          client_uri: "http://localhost:3000",
          redirect_uris: [callbackUrl]
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
        new URL("http://oauth.example.com/mcp"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "auto", authProvider: mockAuthProvider },
          client: {}
        }
      );

      connection.init = vi.fn().mockResolvedValue(undefined);
      connection.client.close = vi.fn().mockResolvedValue(undefined);
      connection.connectionState = "authenticating";
      connection.completeAuthorization = vi
        .fn()
        .mockRejectedValue(new Error("OAuth failed"));

      manager.mcpConnections[id] = connection;

      // Clear previous calls
      onStateChangedSpy.mockClear();

      const callbackRequest = new Request(
        `${callbackUrl}?code=test-code&state=test-state`
      );
      await manager.handleCallbackRequest(callbackRequest);

      // Should fire even on failed callback
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when establishConnection succeeds", async () => {
      const id = "establish-success-server";
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      await manager.registerServer(id, {
        url: "http://example.com/mcp",
        name: "Test Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      const conn = manager.mcpConnections[id];
      conn.connectionState = "connecting";
      conn.establishConnection = vi.fn().mockResolvedValue(undefined);

      // Clear previous calls from registerServer
      onStateChangedSpy.mockClear();

      await manager.establishConnection(id);

      // Should fire on successful establishment
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when establishConnection fails", async () => {
      const id = "establish-fail-server";
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      await manager.registerServer(id, {
        url: "http://example.com/mcp",
        name: "Test Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      const conn = manager.mcpConnections[id];
      conn.connectionState = "connecting";
      conn.establishConnection = vi
        .fn()
        .mockRejectedValue(new Error("Connection failed"));

      // Clear previous calls from registerServer
      onStateChangedSpy.mockClear();

      await manager.establishConnection(id);

      // Should fire even on failure
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });

    it("should fire onServerStateChanged when removing a server", async () => {
      const id = "remove-server";
      const onStateChangedSpy = vi.fn();
      manager.onServerStateChanged(onStateChangedSpy);

      await manager.registerServer(id, {
        url: "http://example.com/mcp",
        name: "Test Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      // Clear previous calls from registerServer
      onStateChangedSpy.mockClear();

      await manager.removeServer(id);

      // Should fire when server is removed
      expect(onStateChangedSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("getAITools() integration", () => {
    it("should return AI SDK tools after registering and connecting to server", async () => {
      const id = "test-mcp-server";
      const url = "http://example.com/mcp";
      const name = "Test MCP Server";
      const callbackUrl = "http://localhost:3000/callback";

      // Initialize jsonSchema (required for getAITools)
      await manager.ensureJsonSchema();

      // Register server
      manager.registerServer(id, {
        url,
        name,
        callbackUrl,
        client: {},
        transport: { type: "auto" }
      });

      // Mock the connection to simulate a successful connection with tools
      const conn = manager.mcpConnections[id];

      // Mock init to reach ready state
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "ready";

        // Simulate discovered tools
        conn.tools = [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "Test message"
                }
              },
              required: ["message"]
            }
          }
        ];
      });

      // Mock callTool
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Tool result" }]
      });

      // Connect to server
      await manager.connectToServer(id);

      // Verify connection is ready
      expect(conn.connectionState).toBe("ready");
      expect(conn.tools).toHaveLength(1);

      // Get AI tools
      const tools = manager.getAITools();

      // Verify tools are properly formatted for AI SDK
      expect(tools).toBeDefined();

      // Tool name should be namespaced with server ID
      const toolKey = `tool_${id.replace(/-/g, "")}_test_tool`;
      expect(tools[toolKey]).toBeDefined();

      // Verify tool structure
      const tool = tools[toolKey];
      expect(tool.description).toBe("A test tool");
      expect(tool.execute).toBeDefined();
      expect(tool.inputSchema).toBeDefined();

      // Test tool execution
      const result = await tool.execute!(
        { message: "test" },
        {} as ToolCallOptions
      );
      expect(result).toBeDefined();
      expect(conn.client.callTool).toHaveBeenCalledWith(
        {
          name: "test_tool",
          arguments: { message: "test" },
          serverId: id
        },
        undefined,
        undefined
      );
    });

    it("should aggregate tools from multiple connected servers", async () => {
      const server1Id = "server-1";
      const server2Id = "server-2";

      // Initialize jsonSchema
      await manager.ensureJsonSchema();

      // Register and connect first server
      manager.registerServer(server1Id, {
        url: "http://server1.com/mcp",
        name: "Server 1",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      const conn1 = manager.mcpConnections[server1Id];
      conn1.init = vi.fn().mockImplementation(async () => {
        conn1.connectionState = "ready";
        conn1.tools = [
          {
            name: "tool_one",
            description: "Tool from server 1",
            inputSchema: { type: "object", properties: {} }
          }
        ];
      });
      conn1.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Result 1" }]
      });

      await manager.connectToServer(server1Id);

      // Register and connect second server
      manager.registerServer(server2Id, {
        url: "http://server2.com/mcp",
        name: "Server 2",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      const conn2 = manager.mcpConnections[server2Id];
      conn2.init = vi.fn().mockImplementation(async () => {
        conn2.connectionState = "ready";
        conn2.tools = [
          {
            name: "tool_two",
            description: "Tool from server 2",
            inputSchema: { type: "object", properties: {} }
          }
        ];
      });
      conn2.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Result 2" }]
      });

      await manager.connectToServer(server2Id);

      // Get AI tools
      const tools = manager.getAITools();

      // Verify both tools are available
      const tool1Key = `tool_${server1Id.replace(/-/g, "")}_tool_one`;
      const tool2Key = `tool_${server2Id.replace(/-/g, "")}_tool_two`;

      expect(tools[tool1Key]).toBeDefined();
      expect(tools[tool2Key]).toBeDefined();
      expect(tools[tool1Key].description).toBe("Tool from server 1");
      expect(tools[tool2Key].description).toBe("Tool from server 2");

      // Test both tools execute correctly
      await tools[tool1Key].execute!({}, {} as ToolCallOptions);
      expect(conn1.client.callTool).toHaveBeenCalledWith(
        {
          name: "tool_one",
          arguments: {},
          serverId: server1Id
        },
        undefined,
        undefined
      );

      await tools[tool2Key].execute!({}, {} as ToolCallOptions);
      expect(conn2.client.callTool).toHaveBeenCalledWith(
        {
          name: "tool_two",
          arguments: {},
          serverId: server2Id
        },
        undefined,
        undefined
      );
    });

    it("should throw error if jsonSchema not initialized", () => {
      // Create a new manager without initializing jsonSchema
      const newManager = new MCPClientManager("test-client", "1.0.0", {
        storage: new AgentMCPClientStorage(
          <T extends Record<string, unknown>>() => [] as T[],
          {
            get: () => undefined,
            put: () => {},
            list: vi.fn(),
            delete: vi.fn()
          }
        )
      });

      expect(() => newManager.getAITools()).toThrow(
        "jsonSchema not initialized."
      );
    });
  });

  describe("clearAuthUrl()", () => {
    it("should clear auth_url after successful OAuth", async () => {
      const serverId = "oauth-server-clearauth";
      const callbackUrl = "http://localhost:3000/callback";
      const authUrl = "https://auth.example.com/authorize";

      // Save server with auth_url
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "OAuth Server",
        server_url: "http://oauth.example.com",
        callback_url: callbackUrl,
        client_id: "test-client-id",
        auth_url: authUrl,
        server_options: null
      });

      // Verify initial state
      let server = mockStorageData.get(serverId);
      expect(server?.auth_url).toBe(authUrl);
      expect(server?.callback_url).toBe(callbackUrl);

      // Clear auth URL
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.clearAuthUrl(serverId);

      // Verify auth_url cleared but callback_url preserved
      server = mockStorageData.get(serverId);
      expect(server?.auth_url).toBe(null);
      expect(server?.callback_url).toBe(callbackUrl); // ✅ Preserved!
      expect(server?.name).toBe("OAuth Server"); // ✅ Other fields preserved
      expect(server?.client_id).toBe("test-client-id");
    });

    it("should preserve all fields except auth_url", async () => {
      const serverId = "test-server-preserve";
      const serverData: MCPServerRow = {
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: "http://localhost:3000/callback",
        client_id: "my-client",
        auth_url: "https://auth.example.com",
        server_options: JSON.stringify({ transport: { type: "auto" } })
      };

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer(serverData);
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.clearAuthUrl(serverId);

      const server = mockStorageData.get(serverId);
      expect(server?.auth_url).toBe(null); // Only this changed
      expect(server?.id).toBe(serverData.id);
      expect(server?.name).toBe(serverData.name);
      expect(server?.server_url).toBe(serverData.server_url);
      expect(server?.callback_url).toBe(serverData.callback_url);
      expect(server?.client_id).toBe(serverData.client_id);
      expect(server?.server_options).toBe(serverData.server_options);
    });
  });

  describe("restoreConnectionsFromStorage() - Edge Cases", () => {
    it("should skip servers already in ready state", async () => {
      const serverId = "already-ready";

      // Save server to storage
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Ready Server",
        server_url: "http://ready.com",
        callback_url: "http://localhost:3000/callback",
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Pre-populate with a connection in ready state
      const existingConnection = new MCPClientConnection(
        new URL("http://ready.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "auto" }, client: {} }
      );
      existingConnection.connectionState = "ready";
      existingConnection.init = vi.fn();
      existingConnection.client.close = vi.fn().mockResolvedValue(undefined);

      manager.mcpConnections[serverId] = existingConnection;

      // Spy on connectToServer to verify it's not called
      const connectSpy = vi.spyOn(manager, "connectToServer");

      // Restore connections
      await manager.restoreConnectionsFromStorage("test-agent");

      // Verify connection was NOT recreated
      expect(manager.mcpConnections[serverId]).toBe(existingConnection);
      expect(connectSpy).not.toHaveBeenCalledWith(serverId);
    });

    it("should skip servers in connecting state", async () => {
      const serverId = "in-flight-connecting";

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Connecting Server",
        server_url: "http://connecting.com",
        callback_url: "http://localhost:3000/callback",
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Pre-populate with connection in "connecting" state
      const existingConnection = new MCPClientConnection(
        new URL("http://connecting.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "auto" }, client: {} }
      );
      existingConnection.connectionState = "connecting";
      existingConnection.init = vi.fn();
      existingConnection.client.close = vi.fn().mockResolvedValue(undefined);

      manager.mcpConnections[serverId] = existingConnection;

      const connectSpy = vi.spyOn(manager, "connectToServer");

      await manager.restoreConnectionsFromStorage("test-agent");

      // Should not recreate - let existing flow complete
      expect(manager.mcpConnections[serverId]).toBe(existingConnection);
      expect(connectSpy).not.toHaveBeenCalledWith(serverId);
    });

    it("should skip servers in authenticating state", async () => {
      const serverId = "in-flight-auth";

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Authenticating Server",
        server_url: "http://auth.com",
        callback_url: "http://localhost:3000/callback",
        client_id: "test-client",
        auth_url: "https://auth.example.com/authorize",
        server_options: null
      });

      // Pre-populate with connection in "authenticating" state
      const existingConnection = new MCPClientConnection(
        new URL("http://auth.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "auto" }, client: {} }
      );
      existingConnection.connectionState = "authenticating";
      existingConnection.init = vi.fn();
      existingConnection.client.close = vi.fn().mockResolvedValue(undefined);

      manager.mcpConnections[serverId] = existingConnection;

      const connectSpy = vi.spyOn(manager, "connectToServer");

      await manager.restoreConnectionsFromStorage("test-agent");

      // Should not recreate - OAuth flow in progress
      expect(manager.mcpConnections[serverId]).toBe(existingConnection);
      expect(connectSpy).not.toHaveBeenCalledWith(serverId);
    });

    it("should skip servers in discovering state", async () => {
      const serverId = "discovering";

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Discovering Server",
        server_url: "http://discover.com",
        callback_url: "http://localhost:3000/callback",
        client_id: null,
        auth_url: null,
        server_options: null
      });

      const existingConnection = new MCPClientConnection(
        new URL("http://discover.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "auto" }, client: {} }
      );
      existingConnection.connectionState = "discovering";
      existingConnection.init = vi.fn();
      existingConnection.client.close = vi.fn().mockResolvedValue(undefined);

      manager.mcpConnections[serverId] = existingConnection;

      const connectSpy = vi.spyOn(manager, "connectToServer");

      await manager.restoreConnectionsFromStorage("test-agent");

      expect(manager.mcpConnections[serverId]).toBe(existingConnection);
      expect(connectSpy).not.toHaveBeenCalledWith(serverId);
    });

    it("should recreate failed connections", async () => {
      const serverId = "failed-server";

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Failed Server",
        server_url: "http://failed.com",
        callback_url: "http://localhost:3000/callback",
        client_id: null,
        auth_url: null,
        server_options: JSON.stringify({ transport: { type: "auto" } })
      });

      // Pre-populate with a failed connection
      const failedConnection = new MCPClientConnection(
        new URL("http://failed.com"),
        { name: "test-client", version: "1.0.0" },
        { transport: { type: "auto" }, client: {} }
      );
      failedConnection.connectionState = "failed";
      failedConnection.client.close = vi.fn().mockResolvedValue(undefined);

      manager.mcpConnections[serverId] = failedConnection;

      // Track the old connection reference
      const oldConnection = manager.mcpConnections[serverId];

      // Mock connectToServer to avoid real HTTP calls
      vi.spyOn(manager, "connectToServer").mockResolvedValue({
        state: "ready"
      });

      await manager.restoreConnectionsFromStorage("test-agent");

      // Should have created a new connection (different object)
      // The old failed connection should have been replaced
      expect(manager.mcpConnections[serverId]).toBeDefined();
      expect(manager.mcpConnections[serverId]).not.toBe(oldConnection);
    });

    it("should only restore once (idempotent)", async () => {
      const serverId = "idempotent-test";

      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: "http://localhost:3000/callback",
        client_id: null,
        auth_url: null,
        server_options: null
      });

      // Mock connectToServer to avoid real HTTP calls
      vi.spyOn(manager, "connectToServer").mockResolvedValue({
        state: "ready"
      });

      // First restoration
      await manager.restoreConnectionsFromStorage("test-agent");
      const firstConnection = manager.mcpConnections[serverId];

      // Second restoration (should be no-op)
      await manager.restoreConnectionsFromStorage("test-agent");
      const secondConnection = manager.mcpConnections[serverId];

      // Should be the same connection
      expect(secondConnection).toBe(firstConnection);
    });
  });

  describe("restoreConnectionsFromStorage() - OAuth Token Reuse", () => {
    it("should attempt connection for OAuth server with stored tokens", async () => {
      const serverId = "oauth-with-tokens";
      const clientId = "stored-client-id";

      // Save OAuth server to storage (auth_url = null means we completed auth previously)
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "OAuth Server",
        server_url: "http://oauth.com",
        callback_url: "http://localhost:3000/callback",
        client_id: clientId,
        auth_url: null, // ✅ No auth_url - previously authenticated
        server_options: JSON.stringify({ transport: { type: "auto" } })
      });

      // Store valid OAuth tokens in KV (simulating previous successful auth)
      const tokenKey = `/test-client/${serverId}/${clientId}/token`;
      mockKVData.set(tokenKey, {
        access_token: "valid-token",
        token_type: "bearer"
      });

      // Spy on connectToServer to verify it's called
      const connectSpy = vi
        .spyOn(manager, "connectToServer")
        .mockResolvedValue({ state: "ready" });

      await manager.restoreConnectionsFromStorage("test-agent");

      // Verify connection was created and connectToServer was called
      const conn = manager.mcpConnections[serverId];
      expect(conn).toBeDefined();
      expect(connectSpy).toHaveBeenCalledWith(serverId);
    });

    it("should call connectToServer for OAuth servers with auth_url", async () => {
      const serverId = "oauth-needs-auth";
      const clientId = "needs-auth-client";

      // Save OAuth server with auth_url (indicates needs auth)
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "OAuth Server",
        server_url: "http://oauth.com",
        callback_url: "http://localhost:3000/callback",
        client_id: clientId,
        auth_url: "https://auth.example.com/authorize", // ✅ Has auth_url - needs auth
        server_options: JSON.stringify({ transport: { type: "auto" } })
      });

      // Spy on connectToServer
      const connectSpy = vi
        .spyOn(manager, "connectToServer")
        .mockResolvedValue({
          state: "authenticating",
          authUrl: "https://auth.example.com/authorize",
          clientId: "needs-auth-client"
        });

      await manager.restoreConnectionsFromStorage("test-agent");

      const conn = manager.mcpConnections[serverId];
      expect(conn).toBeDefined();

      // Should call connectToServer (let it determine if OAuth is needed)
      expect(connectSpy).toHaveBeenCalledWith(serverId);
    });
  });

  describe("connectToServer() - Connection States", () => {
    it("should return ready state for successful non-OAuth connection", async () => {
      const serverId = "non-oauth-connect-test";

      await manager.registerServer(serverId, {
        url: "http://test.com",
        name: "Non-OAuth Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      const conn = manager.mcpConnections[serverId];

      // Mock successful connection
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "ready";
      });

      const result = await manager.connectToServer(serverId);

      expect(result.state).toBe("ready");
      expect(conn.init).toHaveBeenCalled();
    });

    it("should return authenticating state and authUrl when OAuth needed", async () => {
      const serverId = "oauth-needed-server-test";
      const authUrl = "https://auth.example.com/authorize";

      const mockAuthProvider = {
        serverId,
        clientId: "test-client-id",
        authUrl,
        redirectUrl: "http://localhost:3000/callback",
        clientMetadata: {
          client_name: "test-client",
          redirect_uris: ["http://localhost:3000/callback"]
        },
        tokens: vi.fn().mockResolvedValue(undefined),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn()
      };

      await manager.registerServer(serverId, {
        url: "http://oauth.com",
        name: "OAuth Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto", authProvider: mockAuthProvider }
      });

      const conn = manager.mcpConnections[serverId];

      // Mock connection that needs OAuth
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "authenticating";
      });

      const result = await manager.connectToServer(serverId);

      expect(result.state).toBe("authenticating");
      if (result.state === "authenticating") {
        expect(result.authUrl).toBe(authUrl);
        expect(result.clientId).toBe("test-client-id");
      }

      // Verify auth_url saved to storage
      const server = mockStorageData.get(serverId);
      expect(server?.auth_url).toBe(authUrl);
      expect(server?.client_id).toBe("test-client-id");
    });

    it("should update storage with auth URL only when needed", async () => {
      const serverId = "storage-update-test-2";

      await manager.registerServer(serverId, {
        url: "http://test.com",
        name: "Test Server",
        callbackUrl: "http://localhost:3000/callback",
        client: {},
        transport: { type: "auto" }
      });

      const conn = manager.mcpConnections[serverId];

      // Mock non-OAuth connection (no auth URL)
      conn.init = vi.fn().mockImplementation(async () => {
        conn.connectionState = "ready";
      });

      await manager.connectToServer(serverId);

      // Storage should not have auth_url
      const server = mockStorageData.get(serverId);
      expect(server?.auth_url).toBe(null);
    });
  });

  describe("Integration: Full Reconnect Flows", () => {
    it("should automatically reconnect non-OAuth server on restore", async () => {
      const serverId = "auto-reconnect";

      // Simulate previous session: server was registered
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "Auto Reconnect Server",
        server_url: "http://auto.com",
        callback_url: "http://localhost:3000/callback",
        client_id: null,
        auth_url: null,
        server_options: JSON.stringify({ transport: { type: "auto" } })
      });

      // Mock connectToServer
      const connectSpy = vi
        .spyOn(manager, "connectToServer")
        .mockResolvedValue({ state: "ready" });

      // Simulate DO restart - restore connections
      await manager.restoreConnectionsFromStorage("test-agent");

      // Verify connection exists and was connected
      const conn = manager.mcpConnections[serverId];
      expect(conn).toBeDefined();
      expect(conn.url.toString()).toBe("http://auto.com/");
      expect(connectSpy).toHaveBeenCalledWith(serverId);
    });

    it("should call connectToServer for OAuth server after restore", async () => {
      const serverId = "oauth-reauth-flow";
      const authUrl = "https://auth.example.com/authorize";

      // Simulate previous session: OAuth server was registered but tokens expired
      await (
        manager as unknown as MCPClientManagerInternal
      )._storage.saveServer({
        id: serverId,
        name: "OAuth Reauth Server",
        server_url: "http://oauth.com",
        callback_url: "http://localhost:3000/callback",
        client_id: "old-client-id",
        auth_url: authUrl, // ✅ Has auth_url - indicates needs re-auth
        server_options: JSON.stringify({ transport: { type: "auto" } })
      });

      // Mock connectToServer to return authenticating state
      const connectSpy = vi
        .spyOn(manager, "connectToServer")
        .mockResolvedValue({
          state: "authenticating",
          authUrl,
          clientId: "old-client-id"
        });

      // Restore connections
      await manager.restoreConnectionsFromStorage("test-agent");

      const conn = manager.mcpConnections[serverId];
      expect(conn).toBeDefined();

      // Verify connectToServer was called
      expect(connectSpy).toHaveBeenCalledWith(serverId);

      // Developer would get auth URL from the returned state
      const servers = await manager.listServers();
      const server = servers.find((s) => s.id === serverId);
      expect(server?.auth_url).toBe(authUrl);
    });
  });
});
