import { env } from "cloudflare:workers";
import { openai } from "@ai-sdk/openai";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type StreamTextOnFinishCallback,
  stepCountIs,
  streamText,
  type ToolSet
} from "ai";
import { cleanupMessages } from "./utils";

const model = openai("gpt-4o-2024-11-20");

interface State {
  openaiApiKey?: string;
}

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Playground extends AIChatAgent<Env, State> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // Collect all tools, including MCP tools
    const allTools = this.mcp.getAITools();

    if (!this.state.openaiApiKey) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        const result = streamText({
          system:
            "You are a helpful assistant that can do various tasks using MCP tools.",

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

  // fix the the types here
  @callable()
  async addMCPServer(url: string, options: unknown) {
    await this.mcp.closeAllConnections();
    await this.mcp.connect(url, options);
  }

  @callable()
  async addApiKey(key: string) {
    this.setState({
      openaiApiKey: key
    });
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
