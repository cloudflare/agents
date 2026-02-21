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

// Test Agent for addMcpServer overload verification
export class TestAddMcpServerAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  // Track resolved arguments from addMcpServer calls
  lastResolvedArgs: {
    serverName: string;
    url: string;
    callbackHost?: string;
    agentsPrefix: string;
    transport?: { headers?: HeadersInit; type?: string };
    client?: unknown;
  } | null = null;

  // Override to capture resolved arguments without actually connecting
  async addMcpServer(
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
  ): Promise<{ id: string; state: "ready" }> {
    // Normalize arguments - same logic as Agent.addMcpServer
    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions: typeof options;

    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null
    ) {
      // New API: options object as third parameter
      resolvedCallbackHost = callbackHostOrOptions.callbackHost;
      resolvedAgentsPrefix = callbackHostOrOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: callbackHostOrOptions.client,
        transport: callbackHostOrOptions.transport
      };
    } else {
      // Legacy API: positional parameters
      resolvedCallbackHost = callbackHostOrOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    // Store resolved arguments for test verification
    this.lastResolvedArgs = {
      serverName,
      url,
      callbackHost: resolvedCallbackHost,
      agentsPrefix: resolvedAgentsPrefix,
      transport: resolvedOptions?.transport,
      client: resolvedOptions?.client
    };

    // Return mock result without actually connecting
    return { id: "test-id", state: "ready" };
  }

  async testNewApiWithOptions(name: string, url: string, callbackHost: string) {
    await this.addMcpServer(name, url, {
      callbackHost,
      agentsPrefix: "custom-agents",
      transport: { type: "sse", headers: { Authorization: "Bearer test" } }
    });
    // Non-null assertion safe because addMcpServer always sets lastResolvedArgs
    return this.lastResolvedArgs!;
  }

  async testNewApiMinimal(name: string, url: string) {
    await this.addMcpServer(name, url, {});
    return this.lastResolvedArgs!;
  }

  async testNoOptions(name: string, url: string) {
    await this.addMcpServer(name, url);
    return this.lastResolvedArgs!;
  }

  async testLegacyApiWithOptions(
    name: string,
    url: string,
    callbackHost: string
  ) {
    await this.addMcpServer(name, url, callbackHost, "legacy-prefix", {
      transport: { type: "streamable-http", headers: { "X-Custom": "value" } }
    });
    return this.lastResolvedArgs!;
  }

  async testLegacyApiMinimal(name: string, url: string, callbackHost: string) {
    await this.addMcpServer(name, url, callbackHost);
    return this.lastResolvedArgs!;
  }

  getLastResolvedArgs() {
    return this.lastResolvedArgs;
  }
}
