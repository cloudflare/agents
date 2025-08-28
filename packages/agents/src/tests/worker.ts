import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  RequestInfo
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent, type ResolveAuthInfoArgs } from "../mcp/index.ts";
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

function asHeaders(headers: RequestInfo["headers"]): Headers {
  const headersCopy: Headers = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headersCopy.append(key, v);
    } else if (value) headersCopy.append(key, value);
  }
  return headersCopy;
}

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );
  async resolveAuthInfo({ headers }: ResolveAuthInfoArgs) {
    const authHeader = asHeaders(headers).get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return undefined;
    const token = authHeader.substring(7);
    return { token, clientId: "test-user", scopes: ["read", "write"] };
  }

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

    this.server.tool(
      "getRequestInfo",
      "Get request info for testing",
      {},
      async (params, extra): Promise<CallToolResult> => {
        // This should have access to requestInfo
        return {
          content: [
            {
              text: JSON.stringify({
                hasRequestInfo: !!extra.requestInfo,
                requestInfo: extra.requestInfo
              }),
              type: "text"
            }
          ]
        };
      }
    );

    this.server.tool(
      "getAuthInfo",
      "Get auth info for testing",
      {},
      async (params, extra): Promise<CallToolResult> => {
        // This should have access to authInfo
        const result = {
          hasAuthInfo: !!extra.authInfo,
          authInfo: extra.authInfo || null // Use null instead of undefined for JSON serialization
        };
        return {
          content: [
            {
              text: JSON.stringify(result),
              type: "text"
            }
          ]
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
