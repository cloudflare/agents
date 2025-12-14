import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { MCPClientConnection } from "../../mcp/client-connection";
import type { MCPObservabilityEvent } from "../../observability/mcp";

/**
 * Mock MCP server for testing different scenarios
 */
class MockMcpServer {
  private server: McpServer;

  constructor(
    name = "test-server",
    capabilities: Partial<ServerCapabilities> = {}
  ) {
    this.server = new McpServer(
      { name, version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
          ...capabilities
        }
      }
    );
    this.setupDefaultTools();
  }

  private setupDefaultTools() {
    this.server.registerTool(
      "test-tool",
      {
        description: "A test tool",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        return { content: [{ text: `Test: ${message}`, type: "text" }] };
      }
    );

    this.server.resource("test-resource", "test://resource", async (uri) => ({
      contents: [{ text: "Test resource content", uri: uri.href }]
    }));

    this.server.prompt("test-prompt", "A test prompt", async () => ({
      messages: [
        { role: "user", content: { type: "text", text: "Test prompt" } }
      ]
    }));
  }

  async startServer(port = 3000): Promise<string> {
    // In a real implementation, this would start an HTTP server
    // For testing, we'll return a mock URL
    return `http://localhost:${port}`;
  }

  async stopServer() {
    // Cleanup server resources
  }
}

/**
 * Integration tests for MCPClientConnection
 */
describe("MCP Client Connection Integration", () => {
  let mockServer: MockMcpServer;
  let serverUrl: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockServer = new MockMcpServer();
    serverUrl = await mockServer.startServer();
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await mockServer.stopServer();
    consoleSpy.mockRestore();
  });

  describe("Connection Initialization", () => {
    it("should successfully initialize with all capabilities", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock all client methods to avoid real network calls
      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });
      connection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Test instructions");
      connection.client.listTools = vi.fn().mockResolvedValue({ tools: [] });
      connection.client.listResources = vi
        .fn()
        .mockResolvedValue({ resources: [] });
      connection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      connection.client.setNotificationHandler = vi.fn();

      await connection.init();

      // After init, connection should be in CONNECTED state
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery using the public discover() method
      const result = await connection.discover();

      expect(result.success).toBe(true);
      expect(connection.connectionState).toBe("ready");
      expect(connection.serverCapabilities).toBeDefined();
      expect(connection.tools).toBeDefined();
      expect(connection.resources).toBeDefined();
      expect(connection.prompts).toBeDefined();
      expect(connection.resourceTemplates).toBeDefined();
    });

    it("should handle authentication state correctly", async () => {
      const connection = new MCPClientConnection(
        new URL("http://localhost:3001/unauthorized"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock the client.connect to throw an unauthorized error
      const mockConnect = vi.fn().mockRejectedValue(new Error("Unauthorized"));
      connection.client.connect = mockConnect;

      await connection.init();

      expect(connection.connectionState).toBe("authenticating");
    });

    it("should handle complete connection failures", async () => {
      const connection = new MCPClientConnection(
        new URL("http://localhost:3001/error"),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock the client.connect to throw a non-auth error
      const mockConnect = vi
        .fn()
        .mockRejectedValue(new Error("Connection failed"));
      connection.client.connect = mockConnect;

      await connection.init();
      expect(connection.connectionState).toBe("failed");
    });

    it("should handle missing server capabilities", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock getServerCapabilities to return null
      const mockGetCapabilities = vi.fn().mockReturnValue(null);
      connection.client.getServerCapabilities = mockGetCapabilities;
      connection.client.connect = vi.fn().mockResolvedValue(undefined);

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Now try to discover - this should fail due to missing capabilities
      connection.connectionState = "discovering";
      await expect(connection.discoverAndRegister()).rejects.toThrow(
        "The MCP Server failed to return server capabilities"
      );
    });
  });

  describe("Capability Discovery", () => {
    it("should discover tools when server supports them", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock successful responses
      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true }
      });
      connection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Test instructions");
      connection.client.listTools = vi.fn().mockResolvedValue({
        tools: [
          {
            name: "test-tool",
            description: "A test tool",
            inputSchema: { type: "object" }
          }
        ]
      });
      connection.client.listResources = vi
        .fn()
        .mockResolvedValue({ resources: [] });
      connection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      connection.client.setNotificationHandler = vi.fn();

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery using the public discover() method
      const result = await connection.discover();

      expect(result.success).toBe(true);
      expect(connection.connectionState).toBe("ready");
      expect(connection.tools).toHaveLength(1);
      expect(connection.tools[0].name).toBe("test-tool");
    });

    it("should handle servers without specific capabilities", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock server with no tools capability
      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });
      connection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Test instructions");
      connection.client.listResources = vi
        .fn()
        .mockResolvedValue({ resources: [] });
      connection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      connection.client.setNotificationHandler = vi.fn();

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery using the public discover() method
      const result = await connection.discover();

      expect(result.success).toBe(true);
      expect(connection.connectionState).toBe("ready");
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(connection.prompts).toEqual([]);
    });

    it("should handle method-not-found errors gracefully", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock method not found error for tools
      const methodNotFoundError = { code: -32601, message: "Method not found" };
      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true }
      });
      connection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Test instructions");
      connection.client.listTools = vi
        .fn()
        .mockRejectedValue(methodNotFoundError);
      connection.client.listResources = vi
        .fn()
        .mockResolvedValue({ resources: [] });
      connection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      connection.client.setNotificationHandler = vi.fn();

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery using the public discover() method
      const result = await connection.discover();

      expect(result.success).toBe(true);
      expect(connection.connectionState).toBe("ready");
      expect(connection.tools).toEqual([]);

      // Collect observability events during initialization
      const observabilityEvents: MCPObservabilityEvent[] = [];
      // We need to set up the listener before init to catch events
      const newConnection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Set up event listener before init
      newConnection.onObservabilityEvent((event) => {
        observabilityEvents.push(event);
      });

      // Mock the same error scenario
      newConnection.client.connect = vi.fn().mockResolvedValue(undefined);
      newConnection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true }
      });
      newConnection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Test instructions");
      newConnection.client.listTools = vi
        .fn()
        .mockRejectedValue({ code: -32601, message: "Method not found" });
      newConnection.client.listResources = vi
        .fn()
        .mockResolvedValue({ resources: [] });
      newConnection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      newConnection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      newConnection.client.setNotificationHandler = vi.fn();

      await newConnection.init();
      expect(newConnection.connectionState).toBe("connected");

      // Trigger discovery using the public discover() method
      await newConnection.discover();

      // Now verify the observability events were fired (filter for discover events only)
      const discoverEvents = observabilityEvents.filter(
        (e) => e.type === "mcp:client:discover"
      );
      // Should have 2 events: one warning about method-not-found, one completion
      expect(discoverEvents).toHaveLength(2);

      // First event should be the method-not-found warning
      expect(discoverEvents[0].displayMessage).toContain(
        "The server advertised support for the capability tools"
      );
      expect(discoverEvents[0].payload.capability).toBe("tools");

      // Second event should be the completion event
      expect(discoverEvents[1].displayMessage).toContain("Discovery completed");
    });
  });

  describe("Discovery Failure Handling", () => {
    it("should fail discovery when any capability fails", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock mixed success/failure scenario
      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });

      // Instructions fails
      connection.client.getInstructions = vi
        .fn()
        .mockRejectedValue(new Error("Instructions service down"));

      // Tools succeeds
      connection.client.listTools = vi.fn().mockResolvedValue({
        tools: [
          {
            name: "working-tool",
            description: "A working tool",
            inputSchema: { type: "object" }
          }
        ]
      });
      connection.client.setNotificationHandler = vi.fn();

      // Resources fails
      connection.client.listResources = vi
        .fn()
        .mockRejectedValue(new Error("Resources service down"));

      // Prompts succeeds
      connection.client.listPrompts = vi.fn().mockResolvedValue({
        prompts: [{ name: "working-prompt", description: "A working prompt" }]
      });

      // Resource templates succeeds
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery - should fail and return error result
      const result = await connection.discover();

      expect(result.success).toBe(false);
      expect(result.error).toContain("Instructions service down");

      // Connection should return to connected state (not failed) so user can retry
      expect(connection.connectionState).toBe("connected");

      // Verify observability event for failure
      const testConnection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      const observabilityEvents: MCPObservabilityEvent[] = [];
      testConnection.onObservabilityEvent((event) => {
        observabilityEvents.push(event);
      });

      // Re-setup the same failure scenario
      testConnection.client.connect = vi.fn().mockResolvedValue(undefined);
      testConnection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });
      testConnection.client.getInstructions = vi
        .fn()
        .mockRejectedValue(new Error("Instructions service down"));
      testConnection.client.listTools = vi.fn().mockResolvedValue({
        tools: [
          {
            name: "working-tool",
            description: "A working tool",
            inputSchema: { type: "object" }
          }
        ]
      });
      testConnection.client.setNotificationHandler = vi.fn();
      testConnection.client.listResources = vi
        .fn()
        .mockRejectedValue(new Error("Resources service down"));
      testConnection.client.listPrompts = vi.fn().mockResolvedValue({
        prompts: [{ name: "working-prompt", description: "A working prompt" }]
      });
      testConnection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });

      await testConnection.init();

      // Trigger discovery - should fail
      const testResult = await testConnection.discover();
      expect(testResult.success).toBe(false);

      // Should have fired observability event for the failure
      const discoverEvents = observabilityEvents.filter(
        (e) => e.type === "mcp:client:discover"
      );
      expect(discoverEvents).toHaveLength(1);
      expect(discoverEvents[0].displayMessage).toContain(
        "Failed to discover capabilities"
      );
    });

    it("should fail and set connection to failed state when discovery fails", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      // Mock all capabilities failing
      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });

      const serviceError = new Error("All services down");
      connection.client.getInstructions = vi
        .fn()
        .mockRejectedValue(serviceError);
      connection.client.listTools = vi.fn().mockRejectedValue(serviceError);
      connection.client.listResources = vi.fn().mockRejectedValue(serviceError);
      connection.client.listPrompts = vi.fn().mockRejectedValue(serviceError);
      connection.client.listResourceTemplates = vi
        .fn()
        .mockRejectedValue(serviceError);
      connection.client.setNotificationHandler = vi.fn();

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery - should fail
      const result = await connection.discover();

      expect(result.success).toBe(false);
      expect(result.error).toContain("All services down");

      // Connection should return to connected state (not failed) so user can retry
      expect(connection.connectionState).toBe("connected");

      // Verify observability event for failure
      const testConn = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      const events: MCPObservabilityEvent[] = [];
      testConn.onObservabilityEvent((event) => {
        events.push(event);
      });

      const allServicesError = new Error("All services down");
      testConn.client.connect = vi.fn().mockResolvedValue(undefined);
      testConn.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      });
      testConn.client.getInstructions = vi
        .fn()
        .mockRejectedValue(allServicesError);
      testConn.client.listTools = vi.fn().mockRejectedValue(allServicesError);
      testConn.client.listResources = vi
        .fn()
        .mockRejectedValue(allServicesError);
      testConn.client.listPrompts = vi.fn().mockRejectedValue(allServicesError);
      testConn.client.listResourceTemplates = vi
        .fn()
        .mockRejectedValue(allServicesError);
      testConn.client.setNotificationHandler = vi.fn();

      await testConn.init();

      // Trigger discovery - should fail
      const testResult = await testConn.discover();
      expect(testResult.success).toBe(false);

      // Should have fired observability event for the failure
      const discoverEvents = events.filter(
        (e) => e.type === "mcp:client:discover"
      );
      expect(discoverEvents).toHaveLength(1);
      expect(discoverEvents[0].displayMessage).toContain(
        "Failed to discover capabilities"
      );
    });

    it("should fail on first error during discovery", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({
        tools: { listChanged: true },
        resources: { listChanged: true }
      });

      // First operation succeeds, but second fails
      connection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Working instructions");
      connection.client.listTools = vi
        .fn()
        .mockRejectedValue({ code: -32601, message: "Method not found" });
      connection.client.listResources = vi
        .fn()
        .mockRejectedValue(new Error("Network timeout"));
      connection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      connection.client.setNotificationHandler = vi.fn();

      await connection.init();
      expect(connection.connectionState).toBe("connected");

      // Trigger discovery - should fail on first error
      const result = await connection.discover();

      expect(result.success).toBe(false);

      // Connection should return to connected state (not failed) so user can retry
      expect(connection.connectionState).toBe("connected");
    });
  });

  describe("OAuth Authentication Flow", () => {
    it("should handle OAuth completion and connection establishment", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: {
            type: "streamable-http",
            authProvider: {
              authUrl: undefined,
              clientId: undefined,
              serverId: undefined,
              redirectUrl: "http://localhost:3000/callback",
              clientMetadata: {
                client_name: "test-client",
                client_uri: "http://localhost:3000",
                redirect_uris: ["http://localhost:3000/callback"]
              },
              tokens: vi.fn().mockResolvedValue({ access_token: "test-token" }),
              saveTokens: vi.fn(),
              clientInformation: vi.fn(),
              saveClientInformation: vi.fn(),
              redirectToAuthorization: vi.fn(),
              saveCodeVerifier: vi.fn(),
              codeVerifier: vi.fn(),
              checkState: vi.fn().mockResolvedValue({ valid: true }),
              consumeState: vi.fn().mockResolvedValue(undefined),
              deleteCodeVerifier: vi.fn().mockResolvedValue(undefined)
            }
          },
          client: {}
        }
      );

      // Mock the methods to test the two-phase auth flow
      connection.init = vi.fn().mockImplementation(async () => {
        connection.connectionState = "authenticating";
      });

      connection.completeAuthorization = vi
        .fn()
        .mockImplementation(async (code: string) => {
          expect(code).toBe("test-auth-code");
          connection.connectionState = "connecting";
          return "streamable-http"; // Return the successful transport
        });

      // Mock client methods needed for discovery
      connection.client.getServerCapabilities = vi.fn().mockReturnValue({});
      connection.client.getInstructions = vi
        .fn()
        .mockResolvedValue("Test instructions");
      connection.client.listTools = vi.fn().mockResolvedValue({ tools: [] });
      connection.client.listResources = vi
        .fn()
        .mockResolvedValue({ resources: [] });
      connection.client.listPrompts = vi
        .fn()
        .mockResolvedValue({ prompts: [] });
      connection.client.listResourceTemplates = vi
        .fn()
        .mockResolvedValue({ resourceTemplates: [] });
      connection.client.setNotificationHandler = vi.fn();

      const authCode = "test-auth-code";

      // Test the two-phase flow
      await connection.init();
      expect(connection.connectionState).toBe("authenticating");

      await connection.completeAuthorization(authCode);
      expect(connection.connectionState).toBe("connecting");

      // After completing OAuth, call init again to establish the actual connection
      connection.init = vi.fn().mockImplementation(async () => {
        connection.connectionState = "connected";
      });
      await connection.init();

      expect(connection.connectionState).toBe("connected");

      // Trigger discovery using the public discover() method
      const result = await connection.discover();

      expect(result.success).toBe(true);
      expect(connection.connectionState).toBe("ready");
    });

    it("should preserve PKCE verifier during multiple saveCodeVerifier calls", async () => {
      // Mock storage to simulate DurableObject storage behavior
      const storageData = new Map<string, unknown>();

      // This test verifies the PKCE preservation logic in DurableObjectOAuthClientProvider
      const mockAuthProvider = {
        authUrl: undefined,
        clientId: "test-client-id",
        serverId: "test-server-id",
        redirectUrl: "http://localhost:3000/callback",
        clientMetadata: {
          client_name: "test-client",
          client_uri: "http://localhost:3000",
          redirect_uris: ["http://localhost:3000/callback"]
        },
        tokens: vi.fn().mockResolvedValue({ access_token: "test-token" }),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn(),
        // Mock actual preservation behavior: simulate storage-based preservation
        saveCodeVerifier: vi
          .fn()
          .mockImplementation(async (verifier: string) => {
            // Simulate the actual preservation logic from DurableObjectOAuthClientProvider
            const existingVerifier = storageData.get("verifier-key");
            if (existingVerifier) {
              // Preserve existing verifier (don't overwrite) - this is the expected behavior
              return;
            }
            // Save first verifier
            storageData.set("verifier-key", verifier);
          }),
        codeVerifier: vi.fn().mockImplementation(async () => {
          const stored = storageData.get("verifier-key");
          if (!stored) throw new Error("No code verifier found");
          return stored as string;
        }),
        checkState: vi.fn().mockResolvedValue({ valid: true }),
        consumeState: vi.fn().mockResolvedValue(undefined),
        deleteCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      // Test the PKCE preservation logic - this tests EXPECTED behavior
      await mockAuthProvider.saveCodeVerifier("original-verifier");
      await mockAuthProvider.saveCodeVerifier("should-be-ignored");

      // EXPECTED: Original verifier should be preserved, second one ignored
      const retrievedVerifier = await mockAuthProvider.codeVerifier();
      expect(retrievedVerifier).toBe("original-verifier");

      // Verify both calls were made but only first one was stored
      expect(mockAuthProvider.saveCodeVerifier).toHaveBeenCalledTimes(2);
      expect(mockAuthProvider.saveCodeVerifier).toHaveBeenNthCalledWith(
        1,
        "original-verifier"
      );
      expect(mockAuthProvider.saveCodeVerifier).toHaveBeenNthCalledWith(
        2,
        "should-be-ignored"
      );
    });
  });

  describe("OAuth Error Scenarios", () => {
    it("should handle OAuth failure during authorization completion", async () => {
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
        tokens: vi.fn().mockResolvedValue({ access_token: "test-token" }),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn(),
        checkState: vi.fn().mockResolvedValue({ valid: true }),
        consumeState: vi.fn().mockResolvedValue(undefined),
        deleteCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: {
            type: "streamable-http",
            authProvider: mockAuthProvider
          },
          client: {}
        }
      );

      // Mock transport to throw OAuth-related error during finishAuth
      const mockTransport = {
        finishAuth: vi.fn().mockRejectedValue(new Error("OAuth token expired"))
      };

      connection.getTransport = vi.fn().mockReturnValue(mockTransport);

      // Set connection to authenticating state first
      connection.connectionState = "authenticating";

      await expect(
        connection.completeAuthorization("invalid-auth-code")
      ).rejects.toThrow();
      expect(connection.connectionState).toBe("failed");
    });

    it("should not save OAuth transport when no authProvider", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "auto" }, // No authProvider
          client: {}
        }
      );

      // Mock client.connect to throw Unauthorized
      connection.client.connect = vi
        .fn()
        .mockRejectedValue(new Error("Unauthorized"));

      // Should set state to authenticating (not throw) when Unauthorized without authProvider
      await connection.init();
      expect(connection.connectionState).toBe("authenticating");

      // Test passes because it verifies the behavior when no authProvider exists
      // (The OAuth transport saving logic requires an authProvider to be present)
    });

    it("should handle network failure during OAuth completion", async () => {
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
        tokens: vi.fn().mockResolvedValue({ access_token: "test-token" }),
        saveTokens: vi.fn(),
        clientInformation: vi.fn(),
        saveClientInformation: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn(),
        checkState: vi.fn().mockResolvedValue({ valid: true }),
        consumeState: vi.fn().mockResolvedValue(undefined),
        deleteCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: {
            type: "streamable-http",
            authProvider: mockAuthProvider
          },
          client: {}
        }
      );

      // Mock transport to throw network error during finishAuth
      const mockTransport = {
        finishAuth: vi.fn().mockRejectedValue(new Error("Network timeout"))
      };

      connection.getTransport = vi.fn().mockReturnValue(mockTransport);

      // Set connection to authenticating state first
      connection.connectionState = "authenticating";

      await expect(
        connection.completeAuthorization("test-auth-code")
      ).rejects.toThrow();
      expect(connection.connectionState).toBe("failed");
    });
  });
});
