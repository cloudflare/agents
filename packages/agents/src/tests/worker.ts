import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import { Agent, type AgentEmail } from "../index.ts";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
};

type State = unknown;

type Props = {
  testValue: string;
};

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {} } }
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
          content: [{ text: this.props.testValue, type: "text" }]
        };
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
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

    return new Response("Not found", { status: 404 });
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
