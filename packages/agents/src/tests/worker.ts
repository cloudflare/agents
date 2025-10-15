import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import {
  Agent,
  callable,
  routeAgentRequest,
  type AgentEmail,
  type Connection,
  type WSMessage
} from "../index.ts";
import { AIChatAgent } from "../ai-chat-agent.ts";
import type { UIMessage as ChatMessage } from "ai";
import type { MCPClientConnection } from "../mcp/client-connection";

interface ToolCallPart {
  type: string;
  toolCallId: string;
  state: "input-available" | "output-available";
  input: Record<string, unknown>;
  output?: unknown;
}

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
  TestChatAgent: DurableObjectNamespace<TestChatAgent>;
  TestOAuthAgent: DurableObjectNamespace<TestOAuthAgent>;
};

type State = unknown;

type Props = {
  testValue: string;
};

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  private tempToolHandle?: { remove: () => void };

  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {}, tools: { listChanged: true } } }
  );

  async init() {
    this.server.tool(
      "greet",
      "A simple greeting tool",
      { name: z.string().describe("Name to greet") },
      async ({ name }): Promise<CallToolResult> => {
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    this.server.tool(
      "getPropsTestValue",
      {},
      async (): Promise<CallToolResult> => {
        return {
          content: [{ text: this.props?.testValue ?? "unknown", type: "text" }]
        };
      }
    );

    this.server.tool(
      "emitLog",
      "Emit a logging/message notification",
      {
        level: z.enum(["debug", "info", "warning", "error"]),
        message: z.string()
      },
      async ({ level, message }): Promise<CallToolResult> => {
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

    // Use `registerTool` so we can later remove it.
    // Triggers notifications/tools/list_changed
    this.server.tool(
      "installTempTool",
      "Register a temporary tool that echoes input",
      {},
      async (): Promise<CallToolResult> => {
        if (!this.tempToolHandle) {
          // Prefer modern registerTool(name, description, schema, handler)
          this.tempToolHandle = this.server.registerTool(
            "temp-echo",
            {
              description: "Echo text (temporary tool)",
              inputSchema: { what: z.string().describe("Text to echo") }
            },
            async ({ what }: { what: string }): Promise<CallToolResult> => {
              return { content: [{ type: "text", text: `echo:${what}` }] };
            }
          );
        }
        // Most SDKs auto-send notifications/tools/list_changed here.
        return { content: [{ type: "text", text: "temp tool installed" }] };
      }
    );

    // Remove the dynamically added tool.
    // Triggers notifications/tools/list_changed
    this.server.tool(
      "uninstallTempTool",
      "Remove the temporary tool if present",
      {},
      async (): Promise<CallToolResult> => {
        if (this.tempToolHandle?.remove) {
          this.tempToolHandle.remove();
          this.tempToolHandle = undefined;
          return { content: [{ type: "text", text: "temp tool removed" }] };
        }
        return { content: [{ type: "text", text: "nothing to remove" }] };
      }
    );
  }
}

// Test email agents
export class TestEmailAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  // Override onError to avoid console.error which triggers queueMicrotask issues
  override onError(error: unknown): void {
    // Silently handle errors in tests
    throw error;
  }
}

export class TestCaseSensitiveAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export class TestUserNotificationAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

// An Agent that tags connections in onConnect,
// then echoes whether the tag was observed in onMessage
export class TestRaceAgent extends Agent<Env> {
  initialState = { hello: "world" };
  static options = { hibernate: true };

  async onConnect(conn: Connection<{ tagged: boolean }>) {
    // Simulate real async setup to widen the window a bit
    conn.setState({ tagged: true });
  }

  async onMessage(conn: Connection<{ tagged: boolean }>, _: WSMessage) {
    const tagged = !!conn.state?.tagged;
    // Echo a single JSON frame so the test can assert ordering
    conn.send(JSON.stringify({ type: "echo", tagged }));
  }
}

// Test Agent for OAuth client side flows
export class TestOAuthAgent extends Agent<Env> {
  async onRequest(_request: Request): Promise<Response> {
    return new Response("Test OAuth Agent");
  }

  async setupMockMcpConnection(
    serverId: string,
    _serverName: string,
    _serverUrl: string,
    callbackUrl: string
  ): Promise<void> {
    // Register the callback URL in memory (simulates non-hibernated state)
    this.mcp.registerCallbackUrl(`${callbackUrl}/${serverId}`);

    // Create a mock connection object in mcpConnections to fully simulate non-hibernated state
    // This prevents _handlePotentialOAuthCallback from trying to restore the connection
    this.mcp.mcpConnections[serverId] = {
      connectionState: "ready",
      tools: [],
      resources: [],
      prompts: [],
      options: {
        transport: {
          authProvider: {
            clientId: "test-client-id",
            authUrl: "http://example.com/oauth/authorize"
          }
        }
      },
      completeAuthorization: async (_code: string) => {
        // Mock successful authorization
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      }
    } as unknown as MCPClientConnection;
  }

  async setupMockOAuthState(
    serverId: string,
    _code: string,
    _state: string,
    options?: { createConnection?: boolean }
  ): Promise<void> {
    // Set up connection in authenticating state so OAuth callback can be processed

    // If requested, pre-create a connection in authenticating state
    // This is needed for non-hibernation tests where the connection already exists
    if (options?.createConnection) {
      this.mcp.mcpConnections[serverId] = {
        connectionState: "authenticating",
        tools: [],
        resources: [],
        prompts: [],
        options: {
          transport: {
            authProvider: {
              clientId: "test-client-id",
              authUrl: "http://example.com/oauth/authorize"
            }
          }
        },
        completeAuthorization: async (_code: string) => {
          // Mock successful authorization
          this.mcp.mcpConnections[serverId].connectionState = "ready";
        }
      } as unknown as MCPClientConnection;
    } else if (this.mcp.mcpConnections[serverId]) {
      // Set existing connection state to "authenticating" and mock completeAuthorization
      // so the callback can be processed
      this.mcp.mcpConnections[serverId].connectionState = "authenticating";
      this.mcp.mcpConnections[serverId].completeAuthorization = async (
        _code: string
      ) => {
        // Mock successful authorization
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      };
    }
  }

  getMcpServerFromDb(serverId: string) {
    const servers = this.sql<{
      id: string;
      name: string;
      server_url: string;
      client_id: string | null;
      auth_url: string | null;
      callback_url: string;
      server_options: string | null;
    }>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
      WHERE id = ${serverId}
    `;
    return servers.length > 0 ? servers[0] : null;
  }

  isCallbackUrlRegistered(callbackUrl: string): boolean {
    return this.mcp.isCallbackRequest(new Request(callbackUrl));
  }

  removeMcpConnection(serverId: string): void {
    delete this.mcp.mcpConnections[serverId];
  }

  hasMcpConnection(serverId: string): boolean {
    return !!this.mcp.mcpConnections[serverId];
  }
}

export class TestChatAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    // Simple echo response for testing
    return new Response("Hello from chat agent!", {
      headers: { "Content-Type": "text/plain" }
    });
  }

  @callable()
  getPersistedMessages(): ChatMessage[] {
    const rawMessages = (
      this.sql`select * from cf_ai_chat_agent_messages order by created_at` ||
      []
    ).map((row) => {
      return JSON.parse(row.message as string);
    });
    return rawMessages;
  }

  @callable()
  async testPersistToolCall(messageId: string, toolName: string) {
    const toolCallPart: ToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "input-available",
      input: { location: "London" }
    };

    const messageWithToolCall: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolCallPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithToolCall]);
    return messageWithToolCall;
  }

  @callable()
  async testPersistToolResult(
    messageId: string,
    toolName: string,
    output: string
  ) {
    const toolResultPart: ToolCallPart = {
      type: `tool-${toolName}`,
      toolCallId: `call_${messageId}`,
      state: "output-available",
      input: { location: "London" },
      output
    };

    const messageWithToolOutput: ChatMessage = {
      id: messageId,
      role: "assistant",
      parts: [toolResultPart] as ChatMessage["parts"]
    };
    await this.persistMessages([messageWithToolOutput]);
    return messageWithToolOutput;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // set some props that should be passed init
    // @ts-expect-error - this is fine for now
    ctx.props = {
      testValue: "123"
    };

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return TestMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return TestMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
