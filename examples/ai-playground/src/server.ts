import { createWorkersAI } from "workers-ai-provider";
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

interface Env {
  AI: Ai;
}

interface State {
  modelName: string;
  temperature: number;
}

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Playground extends AIChatAgent<Env, State> {
  initialState = {
    modelName: "@cf/openai/gpt-oss-120b",
    temperature: 1
  };

  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { abortSignal?: AbortSignal }
  ) {
    // Collect all tools, including MCP tools
    const allTools = this.mcp.getAITools();

    console.log({ tools: allTools });

    console.log({ model: this.state.modelName });

    // Create workersai instance inside the handler where env.AI is available
    const workersai = createWorkersAI({ binding: this.env.AI });

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        const result = streamText({
          system:
            "You are a helpful assistant that can do various tasks using MCP tools.",

          messages: convertToModelMessages(cleanedMessages),
          model: workersai(this.state.modelName as any),
          // model: model,
          tools: allTools,
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          temperature: this.state.temperature,
          stopWhen: stepCountIs(10)
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  // fix the the types here
  @callable()
  async addMCPServer(url: string, options: any) {
    await this.mcp.closeAllConnections();
    await this.mcp.connect(url, options);
  }

  // fix the the types here
  @callable()
  async getModels() {
    return await this.env.AI.models({ per_page: 1000 });
  }

  @callable()
  async setModel(modelName: string) {
    this.state.modelName = modelName;
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
