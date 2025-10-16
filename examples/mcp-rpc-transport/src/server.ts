import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  type ToolSet,
  createUIMessageStreamResponse
} from "ai";
import { openai } from "@ai-sdk/openai";
import { cleanupMessages } from "./utils";
import { routeAgentRequest } from "agents";

type State = {
  counter: number;
};

type Env = {
  MyMCP: DurableObjectNamespace<MyMCP>;
};

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "Demo",
    version: "1.0.0"
  });

  initialState: State = {
    counter: 1
  };

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
              text: String(`Added ${a}, total is now ${this.state.counter}`),
              type: "text"
            }
          ]
        };
      }
    );
  }

  onStateUpdate(state: State) {
    console.log({ stateUpdate: state });
  }

  onError(_: unknown, error?: unknown): void | Promise<void> {
    console.error("MyMCP initialization error:", error);
  }
}

const model = openai("gpt-4o-2024-11-20");

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  async onStart(): Promise<void> {
    // Connect to MCP server via RPC
    await this.addMcpServer("test-server", this.env.MyMCP, {
      transport: { type: "rpc" }
    });
  }

  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _onFinish?: { abortSignal?: AbortSignal }
  ) {
    const allTools = this.mcp.getAITools();
    console.log("Available tools:", Object.keys(allTools));

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        const result = streamText({
          system: `You are a helpful assistant. The current date and time is ${new Date().toISOString()}.\n`,
          messages: convertToModelMessages(cleanedMessages),
          model,
          tools: allTools,
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          stopWhen: stepCountIs(10)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    console.log("Incoming request:", url.pathname);

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
      return Response.json({
        success: hasOpenAIKey
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }

    // external mcp inspector route
    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
    }

    const response = await routeAgentRequest(request, env);
    if (response) {
      console.log("Agent handled request");
      return response;
    }

    console.log("No route matched, returning 404");
    return new Response("Not found", { status: 404 });
  }
};
