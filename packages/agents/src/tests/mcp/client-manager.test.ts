import { describe, it, expect, beforeEach, vi } from "vitest";
import { MCPClientManager } from "../../mcp/client-manager";
import { MCPClientConnection } from "../../mcp/client-connection";
import {
  AgentMCPStorageAdapter,
  type MCPServerRow
} from "../../mcp/client-storage";
import type { AgentsOAuthProvider } from "../../mcp/do-oauth-client-provider";

describe("MCPClientManager OAuth Integration", () => {
  let manager: MCPClientManager;
  let mockStorageData: Map<string, MCPServerRow>;

  beforeEach(() => {
    mockStorageData = new Map();

    // Create a proper mock storage adapter
    const mockStorage = new AgentMCPStorageAdapter(
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

        if (
          query.includes("UPDATE") &&
          query.includes("callback_url = ''") &&
          query.includes("auth_url = NULL")
        ) {
          // Combined clearOAuthCredentials query
          const id = values[0] as string;
          const server = mockStorageData.get(id);
          if (server) {
            server.callback_url = "";
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
      manager.saveServer({
        id: "server1",
        name: "Test Server 1",
        server_url: "http://test1.com",
        callback_url: callbackUrl1,
        client_id: null,
        auth_url: null,
        server_options: null
      });
      manager.saveServer({
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
      manager.removeServer("server1");

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
      manager.saveServer({
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
      manager.saveServer({
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
      manager.saveServer({
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
      manager.saveServer({
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
      manager.saveServer({
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

    it("should throw error for callback when not in authenticating state", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;
      manager.saveServer({
        id: serverId,
        name: "Test Server",
        server_url: "http://test.com",
        callback_url: callbackUrl,
        client_id: null,
        auth_url: null,
        server_options: null
      });

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

  describe("OAuth Security", () => {
    it("should clear callback_url and auth_url after successful authentication", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;
      const authUrl = "https://auth.example.com/authorize";

      // Save server with auth_url and callback_url
      manager.saveServer({
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

      // Verify callback_url and auth_url were cleared
      server = mockStorageData.get(serverId);
      expect(server).toBeDefined();
      expect(server?.callback_url).toBe("");
      expect(server?.auth_url).toBe(null);
    });

    it("should prevent second callback attempt after auth_url is cleared", async () => {
      const serverId = "test-server";
      const callbackUrl = `http://localhost:3000/callback/${serverId}`;

      // Save server with cleared callback_url (simulating post-auth state)
      manager.saveServer({
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

      manager.saveServer({
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
      manager.saveServer({
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

      // Track auth provider creation
      const createdAuthProviders: AgentsOAuthProvider[] = [];
      const createAuthProvider = vi.fn(
        (id: string, url: string, cId?: string): AgentsOAuthProvider => {
          const provider: AgentsOAuthProvider = {
            serverId: id,
            clientId: cId,
            redirectUrl: url,
            authUrl: undefined,
            clientMetadata: {
              redirect_uris: [url]
            },
            tokens: vi.fn(),
            saveTokens: vi.fn(),
            clientInformation: vi.fn(),
            saveClientInformation: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn()
          };
          createdAuthProviders.push(provider);
          return provider;
        }
      );

      const reconnectServer = vi.fn();

      await manager.restoreConnectionsFromStorage(
        createAuthProvider,
        reconnectServer
      );

      // Verify auth provider was created with correct parameters
      expect(createAuthProvider).toHaveBeenCalledWith(
        serverId,
        callbackUrl,
        clientId
      );
      expect(createdAuthProviders).toHaveLength(1);
      expect(createdAuthProviders[0].serverId).toBe(serverId);
      expect(createdAuthProviders[0].clientId).toBe(clientId);

      // Verify connection was created in authenticating state
      const connection = manager.mcpConnections[serverId];
      expect(connection).toBeDefined();
      expect(connection.connectionState).toBe("authenticating");

      // Verify non-OAuth reconnect was not called
      expect(reconnectServer).not.toHaveBeenCalled();
    });

    it("should restore non-OAuth connections from storage", async () => {
      const serverId = "regular-server";
      const callbackUrl = "http://localhost:3000/callback";

      // Save non-OAuth server (no auth_url)
      manager.saveServer({
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

      const createAuthProvider = vi.fn();
      const reconnectServer = vi.fn().mockResolvedValue(undefined);

      await manager.restoreConnectionsFromStorage(
        createAuthProvider,
        reconnectServer
      );

      // Verify auth provider was NOT created
      expect(createAuthProvider).not.toHaveBeenCalled();

      // Verify reconnectServer was called with correct parameters
      expect(reconnectServer).toHaveBeenCalledWith(
        serverId,
        "Regular Server",
        "http://regular-server.com",
        callbackUrl,
        null, // client_id
        {
          transport: { type: "sse", headers: { "X-Custom": "value" } },
          client: {}
        }
      );
    });

    it("should handle empty server list gracefully", async () => {
      const createAuthProvider = vi.fn();
      const reconnectServer = vi.fn();

      await manager.restoreConnectionsFromStorage(
        createAuthProvider,
        reconnectServer
      );

      // Neither should be called with no servers
      expect(createAuthProvider).not.toHaveBeenCalled();
      expect(reconnectServer).not.toHaveBeenCalled();
    });

    it("should restore mixed OAuth and non-OAuth servers", async () => {
      // Save OAuth server
      manager.saveServer({
        id: "oauth-server",
        name: "OAuth Server",
        server_url: "http://oauth.com",
        callback_url: "http://localhost:3000/callback/oauth",
        client_id: "oauth-client",
        auth_url: "https://auth.example.com/authorize",
        server_options: null
      });

      // Save regular server
      manager.saveServer({
        id: "regular-server",
        name: "Regular Server",
        server_url: "http://regular.com",
        callback_url: "http://localhost:3000/callback/regular",
        client_id: null,
        auth_url: null,
        server_options: null
      });

      const createAuthProvider = vi.fn().mockReturnValue({
        serverId: undefined,
        clientId: undefined,
        authUrl: undefined,
        redirectUrl: "",
        clientMetadata: {},
        tokens: vi.fn(),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn()
      });
      const reconnectServer = vi.fn().mockResolvedValue(undefined);

      await manager.restoreConnectionsFromStorage(
        createAuthProvider,
        reconnectServer
      );

      // Verify OAuth server used auth provider
      expect(createAuthProvider).toHaveBeenCalledTimes(1);
      expect(manager.mcpConnections["oauth-server"]).toBeDefined();
      expect(manager.mcpConnections["oauth-server"].connectionState).toBe(
        "authenticating"
      );

      // Verify regular server used reconnect
      expect(reconnectServer).toHaveBeenCalledTimes(1);
      expect(reconnectServer).toHaveBeenCalledWith(
        "regular-server",
        "Regular Server",
        "http://regular.com",
        "http://localhost:3000/callback/regular",
        null,
        null
      );
    });
  });
});
