import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { routeAgentRequest } from "agents";

type State = { counter: number };
type Props = { userId: string; role: string };

export class MyMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({ name: "Demo", version: "1.0.0" });
  initialState: State = { counter: 1 };

  async init() {
    this.server.tool(
      "add",
      "Add to the counter, stored in the MCP",
      { a: z.number() },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });
        return {
          content: [
            {
              type: "text",
              text: `Added ${a}, total is now ${this.state.counter}`
            }
          ]
        };
      }
    );

    this.server.tool(
      "whoami",
      "Get information about the current user from props",
      {},
      async () => ({
        content: [
          {
            type: "text",
            text: `User ID: ${this.props?.userId || "anonymous"}, Role: ${this.props?.role || "guest"}`
          }
        ]
      })
    );
  }
}

export class Chat extends AIChatAgent<Env> {
  async onStart() {
    await this.addMcpServer("test-server", this.env.MyMCP, {
      props: { userId: "demo-user-123", role: "admin" }
    });
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const allTools = this.mcp.getAITools();

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a helpful assistant. The current date and time is ${new Date().toISOString()}.\n`,
      messages: await convertToModelMessages(this.messages),
      tools: allTools,
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
