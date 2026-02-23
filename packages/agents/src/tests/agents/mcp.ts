import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  IsomorphicHeaders,
  ServerNotification,
  ServerRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../../mcp/index.ts";
import { Agent } from "../../index.ts";

type ToolExtraInfo = RequestHandlerExtra<ServerRequest, ServerNotification>;

type EchoResponseData = {
  headers: IsomorphicHeaders;
  authInfo: ToolExtraInfo["authInfo"] | null;
  hasRequestInfo: boolean;
  hasAuthInfo: boolean;
  requestId: ToolExtraInfo["requestId"];
  sessionId: string | null;
  availableExtraKeys: string[];
  [key: string]: unknown;
};

type Props = {
  testValue: string;
};

export class TestMcpAgent extends McpAgent<
  Record<string, unknown>,
  unknown,
  Props
> {
  observability = undefined;
  private tempToolHandle?: { remove: () => void };

  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true }
        // disable because types started failing in 1.22.0
        // elicitation: { form: {}, url: {} }
      }
    }
  );

  async init() {
    this.server.registerTool(
      "greet",
      {
        description: "A simple greeting tool",
        inputSchema: { name: z.string().describe("Name to greet") }
      },
      async ({ name }) => {
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    this.server.registerTool(
      "getPropsTestValue",
      {
        description: "Get the test value"
      },
      async () => {
        return {
          content: [
            { text: this.props?.testValue ?? "unknown", type: "text" as const }
          ]
        };
      }
    );

    this.server.registerTool(
      "emitLog",
      {
        description: "Emit a logging/message notification",
        inputSchema: {
          level: z.enum(["debug", "info", "warning", "error"]),
          message: z.string()
        }
      },
      async ({ level, message }) => {
        // Force a logging message to be sent when the tool is called
        await this.server.server.sendLoggingMessage({
          level,
          data: message
        });
        return {
          content: [{ type: "text", text: `logged:${level}` }]
        };
      }
    );

    this.server.tool(
      "elicitName",
      "Test tool that elicits user input for a name",
      {},
      async () => {
        const result = await this.server.server.elicitInput({
          message: "What is your name?",
          requestedSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Your name"
              }
            },
            required: ["name"]
          }
        });

        if (result.action === "accept" && result.content?.name) {
          return {
            content: [
              {
                type: "text",
                text: `You said your name is: ${result.content.name}`
              }
            ]
          };
        }

        return {
          content: [{ type: "text", text: "Elicitation cancelled" }]
        };
      }
    );

    // Use `registerTool` so we can later remove it.
    // Triggers notifications/tools/list_changed
    this.server.registerTool(
      "installTempTool",
      {
        description: "Register a temp tool",
        inputSchema: {}
      },
      async () => {
        if (!this.tempToolHandle) {
          this.tempToolHandle = this.server.registerTool(
            "temp-echo",
            {
              description: "Echo text (temporary tool)",
              inputSchema: { what: z.string().describe("Text to echo") }
            },
            async ({ what }) => {
              return { content: [{ type: "text", text: `echo:${what}` }] };
            }
          );
        }
        return { content: [{ type: "text", text: "temp tool installed" }] };
      }
    );

    // Remove the dynamically added tool.
    this.server.registerTool(
      "uninstallTempTool",
      {
        description: "Remove the temporary tool if present"
      },
      async () => {
        if (this.tempToolHandle?.remove) {
          this.tempToolHandle.remove();
          this.tempToolHandle = undefined;
          return {
            content: [{ type: "text" as const, text: "temp tool removed" }]
          };
        }
        return {
          content: [{ type: "text" as const, text: "nothing to remove" }]
        };
      }
    );

    // Echo request info for testing header and auth passthrough
    this.server.tool(
      "echoRequestInfo",
      "Echo back request headers and auth info",
      {},
      async (_args, extra: ToolExtraInfo): Promise<CallToolResult> => {
        // Extract headers from requestInfo, auth from authInfo
        const headers: IsomorphicHeaders = extra.requestInfo?.headers ?? {};
        const authInfo = extra.authInfo ?? null;

        // Track non-function properties available in extra
        const extraRecord = extra as Record<string, unknown>;
        const extraKeys = Object.keys(extraRecord).filter(
          (key) => typeof extraRecord[key] !== "function"
        );

        // Build response object with all available data
        const responseData: EchoResponseData = {
          headers,
          authInfo,
          hasRequestInfo: !!extra.requestInfo,
          hasAuthInfo: !!extra.authInfo,
          requestId: extra.requestId,
          // Include any sessionId if it exists
          sessionId: extra.sessionId ?? null,
          // List all available properties in extra
          availableExtraKeys: extraKeys
        };

        // Add any other properties from extra that aren't already included
        extraKeys.forEach((key) => {
          if (
            !["requestInfo", "authInfo", "requestId", "sessionId"].includes(key)
          ) {
            responseData[`extra_${key}`] = extraRecord[key];
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responseData, null, 2)
            }
          ]
        };
      }
    );
  }
}

// Test MCP Agent for jurisdiction feature
export class TestMcpJurisdiction extends McpAgent<Record<string, unknown>> {
  observability = undefined;

  server = new McpServer(
    { name: "test-jurisdiction-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  async init() {
    this.server.registerTool(
      "test-tool",
      {
        description: "A test tool",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        return { content: [{ text: `Echo: ${message}`, type: "text" }] };
      }
    );
  }
}

// Test Agent for addMcpServer RPC binding (e2e)
export class TestRpcMcpClientAgent extends Agent<{
  MCP_OBJECT: DurableObjectNamespace;
}> {
  observability = undefined;

  async testAddRpcMcpServer() {
    try {
      await this.addMcpServer(
        "rpc-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "rpc-props-value" }
        }
      );

      const tools = this.mcp.listTools();
      const toolNames = tools.map((t) => t.name);

      return { success: true, toolNames };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testCallToolViaRpc() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-call-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "rpc-call-value" }
        }
      );

      const result = await this.mcp.callTool({
        serverId: id,
        name: "greet",
        arguments: { name: "RPC User" }
      });
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcServerPersistsToStorage() {
    try {
      await this.addMcpServer(
        "rpc-persist-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "persisted-value" }
        }
      );

      const savedServers = this.mcp.getRpcServersFromStorage();
      const saved = savedServers.find((s) => s.name === "rpc-persist-test");
      if (!saved) {
        return { success: false, error: "RPC server not found in storage" };
      }

      const opts = JSON.parse(saved.server_options || "{}");
      return {
        success: true,
        bindingName: opts.bindingName,
        props: opts.props,
        serverUrl: saved.server_url
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcServerRestoresAfterHibernation() {
    try {
      const { id: idBefore } = await this.addMcpServer(
        "rpc-hibernate-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "survives-hibernation" }
        }
      );

      const toolsBefore = this.mcp.listTools().map((t) => t.name);
      const connectionCountBefore = Object.keys(this.mcp.mcpConnections).length;

      // Simulate hibernation: clear in-memory connections
      for (const connId of Object.keys(this.mcp.mcpConnections)) {
        try {
          await this.mcp.mcpConnections[connId].client.close();
        } catch (_) {}
        delete this.mcp.mcpConnections[connId];
      }

      const toolsDuring = this.mcp.listTools().map((t) => t.name);

      // Restore (this is what onStart calls internally)
      await this.mcp.restoreConnectionsFromStorage(this.name);
      // @ts-expect-error - accessing private method for testing
      await this._restoreRpcMcpServers();

      const toolsAfter = this.mcp.listTools().map((t) => t.name);
      const connectionCountAfter = Object.keys(this.mcp.mcpConnections).length;
      const idAfter = Object.keys(this.mcp.mcpConnections)[0];

      const result = await this.mcp.callTool({
        serverId: idAfter,
        name: "getPropsTestValue",
        arguments: {}
      });

      return {
        success: true,
        idBefore,
        idAfter,
        sameId: idBefore === idAfter,
        toolsBefore,
        toolsDuring,
        toolsAfter,
        connectionCountBefore,
        connectionCountAfter,
        result
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcServerDeduplicates() {
    try {
      const result1 = await this.addMcpServer(
        "rpc-dedup-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "first-call" }
        }
      );

      const result2 = await this.addMcpServer(
        "rpc-dedup-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "second-call" }
        }
      );

      const connectionCount = Object.keys(this.mcp.mcpConnections).length;

      return {
        success: true,
        id1: result1.id,
        id2: result2.id,
        sameId: result1.id === result2.id,
        connectionCount
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testPropsPassedViaRpc() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-props-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "from-rpc-client" }
        }
      );

      const result = await this.mcp.callTool({
        serverId: id,
        name: "getPropsTestValue",
        arguments: {}
      });
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRemoveRpcMcpServer() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-remove-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "to-be-removed" }
        }
      );

      const toolsBefore = this.mcp.listTools().length;
      const storageBefore = this.mcp.getRpcServersFromStorage().length;

      await this.removeMcpServer(id);

      const toolsAfter = this.mcp.listTools().length;
      const storageAfter = this.mcp.getRpcServersFromStorage().length;
      const connectionExists = !!this.mcp.mcpConnections[id];

      return {
        success: true,
        toolsBefore,
        toolsAfter,
        storageBefore,
        storageAfter,
        connectionExists
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

// Test Agent for addMcpServer overload verification.
// Uses a private helper to resolve arguments without actually connecting,
// since overriding the overloaded addMcpServer is fragile.
export class TestAddMcpServerAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  private _resolveArgs(
    serverName: string,
    url: string,
    callbackHostOrOptions?:
      | string
      | {
          callbackHost?: string;
          agentsPrefix?: string;
          client?: unknown;
          transport?: { headers?: HeadersInit; type?: string };
        },
    agentsPrefix?: string,
    options?: {
      client?: unknown;
      transport?: { headers?: HeadersInit; type?: string };
    }
  ) {
    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions: typeof options;

    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null
    ) {
      resolvedCallbackHost = callbackHostOrOptions.callbackHost;
      resolvedAgentsPrefix = callbackHostOrOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: callbackHostOrOptions.client,
        transport: callbackHostOrOptions.transport
      };
    } else {
      resolvedCallbackHost = callbackHostOrOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    return {
      serverName,
      url,
      callbackHost: resolvedCallbackHost,
      agentsPrefix: resolvedAgentsPrefix,
      transport: resolvedOptions?.transport,
      client: resolvedOptions?.client
    };
  }

  async testNewApiWithOptions(name: string, url: string, callbackHost: string) {
    return this._resolveArgs(name, url, {
      callbackHost,
      agentsPrefix: "custom-agents",
      transport: { type: "sse", headers: { Authorization: "Bearer test" } }
    });
  }

  async testNewApiMinimal(name: string, url: string) {
    return this._resolveArgs(name, url, {});
  }

  async testNoOptions(name: string, url: string) {
    return this._resolveArgs(name, url);
  }

  async testLegacyApiWithOptions(
    name: string,
    url: string,
    callbackHost: string
  ) {
    return this._resolveArgs(name, url, callbackHost, "legacy-prefix", {
      transport: { type: "streamable-http", headers: { "X-Custom": "value" } }
    });
  }

  async testLegacyApiMinimal(name: string, url: string, callbackHost: string) {
    return this._resolveArgs(name, url, callbackHost);
  }
}
