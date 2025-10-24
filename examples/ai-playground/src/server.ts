import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import type { MCPClientOAuthResult } from "agents/mcp";
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
  HOST?: string;
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
    modelName: "@cf/meta/llama-4-scout-17b-16e-instruct",
    temperature: 1
  };

  onStart() {
    console.log("[Playground] onStart called - configuring OAuth callback");
    // Configure OAuth callback to close popup window after authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result: MCPClientOAuthResult) => {
        console.log("[Playground] OAuth callback triggered:", result);
        if (result.authSuccess) {
          console.log("[Playground] OAuth authentication successful");
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        } else {
          console.log(
            "[Playground] OAuth authentication failed:",
            result.authError
          );
          return new Response(
            `<script>alert('Authentication failed: ${result.authError}'); window.close();</script>`,
            {
              headers: { "content-type": "text/html" },
              status: 200
            }
          );
        }
      }
    });
  }

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

    await this.ensureDestroy();
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

  async ensureDestroy() {
    const schedules = this.getSchedules();
    if (schedules.length > 0) {
      // Cancel previously set destroy schedules
      for (const s of schedules) {
        await this.cancelSchedule(s.id);
      }
    }
    // Destroy after 15 minutes of inactivity
    await this.schedule(60 * 15, "destroy");
  }

  // fix the the types here
  @callable()
  async connectMCPServer(url: string, options: any) {
    console.log(
      "[Playground] connectMCPServer called with url:",
      url,
      "options:",
      options
    );
    await this.mcp.closeAllConnections();
    console.log(
      "[Playground] Closed all connections, attempting to connect..."
    );
    // Call the base class addMcpServer method - returns { id, authURL }
    const result = await this.addMcpServer("mcp-server", url, this.env.HOST);
    console.log("[Playground] MCP connect result:", result);
    return result;
  }

  @callable()
  async disconnectMCPServer(serverId?: string) {
    console.log(
      "[Playground] disconnectMCPServer called with serverId:",
      serverId
    );

    if (serverId) {
      // Disconnect specific server
      await this.removeMcpServer(serverId);
      console.log("[Playground] Removed MCP server:", serverId);
    } else {
      // Disconnect all servers if no serverId provided
      const mcpState = this.getMcpServers();
      const serverIds = Object.keys(mcpState.servers);
      console.log("[Playground] Removing all MCP servers:", serverIds);
      for (const id of serverIds) {
        await this.removeMcpServer(id);
      }
    }

    // broadcastMcpServers() is called automatically by removeMcpServer
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
