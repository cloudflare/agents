import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import {
  Agent,
  routeAgentRequest,
  type AgentEmail,
  type Connection,
  type WSMessage
} from "../index.ts";
import { AIHttpChatAgent } from "../ai-chat-agent-http.ts";
import type { UIMessage as ChatMessage } from "ai";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
  ResumableStreamAgent: DurableObjectNamespace<TestResumableStreamAgent>;
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

// Test agent for resumable streaming functionality
export class TestResumableStreamAgent extends AIHttpChatAgent<
  Env,
  unknown,
  ChatMessage
> {
  // Mock AI response for testing
  private mockResponses: Map<string, string> = new Map();

  // Track requests for testing
  requestHistory: Array<{ method: string; url: string; body?: unknown }> = [];

  constructor(ctx: any, env: Env) {
    super(ctx, env);

    // Set up some mock responses
    this.mockResponses.set("hello", "Hello! How can I help you today?");
    this.mockResponses.set(
      "test",
      "This is a test response for resumable streaming."
    );
    this.mockResponses.set(
      "long",
      "This is a much longer response that will be streamed in multiple chunks. It contains enough text to demonstrate the chunking behavior of the resumable streaming system. The response continues with more content to ensure we have sufficient data for testing resumption scenarios."
    );
  }

  async onChatMessage(
    onFinish: any,
    options?: { streamId?: string }
  ): Promise<Response | undefined> {
    // Track the request
    this.requestHistory.push({
      method: "chat",
      url: options?.streamId || "unknown",
      body: { messages: this.messages }
    });

    // Get the last user message
    const lastMessage = this.messages.filter((m) => m.role === "user").pop();

    if (!lastMessage || !lastMessage.parts) {
      return new Response("No message content", { status: 400 });
    }

    const content = lastMessage.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ");

    // Find mock response or use default
    let responseText =
      this.mockResponses.get(content.toLowerCase()) || `Echo: ${content}`;

    // Create a streaming response
    const stream = new ReadableStream({
      async start(controller) {
        const chunks = responseText.match(/.{1,10}/g) || [responseText];

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const sseData = `data: ${JSON.stringify({
            type: "text-delta",
            delta: chunk
          })}\n\n`;

          controller.enqueue(new TextEncoder().encode(sseData));

          // Small delay to simulate real streaming
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // End the stream
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();

        // Call onFinish
        await onFinish();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  }

  // Helper method to set mock response for testing
  setMockResponse(input: string, response: string) {
    this.mockResponses.set(input.toLowerCase(), response);
  }

  // Helper method to get request history for testing
  getRequestHistory() {
    return [...this.requestHistory];
  }

  // Helper method to clear history
  clearHistory() {
    this.requestHistory = [];
    this.messages = [];
  }

  override onError(error: unknown): void {
    // Don't console.error in tests to avoid queueMicrotask issues
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // set some props that should be passed init
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
