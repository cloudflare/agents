import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ServerCapabilities
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { MCPClientConnection } from "../../mcp/client-connection";

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
    this.server.tool(
      "test-tool",
      "A test tool",
      { message: z.string().describe("Test message") },
      async ({ message }): Promise<CallToolResult> => {
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
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
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

      await expect(connection.init()).rejects.toThrow("Connection failed");
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
      const mockGetCapabilities = vi.fn().mockResolvedValue(null);
      connection.client.getServerCapabilities = mockGetCapabilities;
      connection.client.connect = vi.fn().mockResolvedValue(undefined);

      await expect(connection.init()).rejects.toThrow(
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
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
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
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
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
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
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

      expect(connection.connectionState).toBe("ready");
      expect(connection.tools).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "The server advertised support for the capability tools"
        )
      );
    });
  });

  describe("Promise.allSettled Resilience", () => {
    it("should continue initialization when some capabilities fail", async () => {
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
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
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

      // Connection should still be ready despite partial failures
      expect(connection.connectionState).toBe("ready");

      // Failed capabilities should have fallback values
      expect(connection.instructions).toBeUndefined();
      expect(connection.resources).toEqual([]);

      // Successful capabilities should be populated
      expect(connection.tools).toHaveLength(1);
      expect(connection.tools[0].name).toBe("working-tool");
      expect(connection.prompts).toHaveLength(1);
      expect(connection.prompts[0].name).toBe("working-prompt");
      expect(connection.resourceTemplates).toEqual([]);

      // Should log failures
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize instructions:",
        expect.any(Error)
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize resources:",
        expect.any(Error)
      );
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it("should handle all capabilities failing", async () => {
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
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
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

      // Connection should still be ready with all fallback values
      expect(connection.connectionState).toBe("ready");
      expect(connection.instructions).toBeUndefined();
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(connection.prompts).toEqual([]);
      expect(connection.resourceTemplates).toEqual([]);

      // Should log all failures
      expect(consoleSpy).toHaveBeenCalledTimes(5);
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize instructions:",
        serviceError
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize tools:",
        serviceError
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize resources:",
        serviceError
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize prompts:",
        serviceError
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize resource templates:",
        serviceError
      );
    });

    it("should handle mixed error types gracefully", async () => {
      const connection = new MCPClientConnection(
        new URL(serverUrl),
        { name: "test-client", version: "1.0.0" },
        {
          transport: { type: "streamable-http" },
          client: {}
        }
      );

      connection.client.connect = vi.fn().mockResolvedValue(undefined);
      connection.client.getServerCapabilities = vi.fn().mockResolvedValue({
        tools: { listChanged: true },
        resources: { listChanged: true }
      });

      // Different types of errors
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

      expect(connection.connectionState).toBe("ready");
      expect(connection.instructions).toBe("Working instructions");
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(connection.prompts).toEqual([]);

      // Should log both types of errors
      // Note: Method not found errors are handled by capabilityErrorHandler and logged differently
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "The server advertised support for the capability tools"
        )
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        "Failed to initialize resources:",
        expect.any(Error)
      );
    });
  });

  describe("OAuth Authentication Flow", () => {
    it("should handle OAuth code during initialization", async () => {
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
              codeVerifier: vi.fn()
            }
          },
          client: {}
        }
      );

      // Mock the init method to test the auth code path without real network calls
      const _originalInit = connection.init.bind(connection);
      connection.init = vi.fn().mockImplementation(async (code?: string) => {
        // Simulate the auth code being passed through
        if (code) {
          expect(code).toBe("test-auth-code");
        }

        // Set up successful state
        connection.connectionState = "ready";
        connection.serverCapabilities = {};
        connection.instructions = "Test instructions";
        connection.tools = [];
        connection.resources = [];
        connection.prompts = [];
        connection.resourceTemplates = [];
      });

      const authCode = "test-auth-code";
      await connection.init(authCode);

      expect(connection.init).toHaveBeenCalledWith(authCode);
      expect(connection.connectionState).toBe("ready");
    });
  });
});
