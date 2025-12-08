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
import { nanoid } from "nanoid";

interface Env {
  AI: Ai;
  HOST?: string;
}

export interface PlaygroundState {
  model: string;
  temperature: number;
  stream: boolean;
  system: string;
}

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Playground extends AIChatAgent<Env, PlaygroundState> {
  initialState = {
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    temperature: 1,
    stream: true,
    system:
      "You are a helpful assistant that can do various tasks using MCP tools."
  };

  onStart() {
    // Configure OAuth callback to close popup window after authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result: MCPClientOAuthResult) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `<script>alert('Authentication failed: ${result.authError}'); window.close();</script>`,
          {
            headers: { "content-type": "text/html" },
            status: 200
          }
        );
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
    let tools: ToolSet = {};
    try {
      tools = this.mcp.getAITools();
    } catch (e) {
      console.error("Failed to get AI tools", e);
    }

    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: {
        id: "playground"
      }
    });

    await this.ensureDestroy();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        const result = streamText({
          system: this.state.system,
          messages: convertToModelMessages(cleanedMessages),
          model: workersai(this.state.model as Parameters<typeof workersai>[0]),
          tools,
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof tools
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
    const schedules = this.getSchedules().filter(
      (s) => s.callback === "destroy"
    );
    if (schedules.length > 0) {
      // Cancel previously set destroy schedules
      for (const s of schedules) {
        await this.cancelSchedule(s.id);
      }
    }
    // Destroy after 15 minutes of inactivity
    await this.schedule(60 * 15, "destroy");
  }

  @callable()
  async connectMCPServer(url: string, headers?: Record<string, string>) {
    const { servers } = await this.getMcpServers();

    // Check for duplicate URL
    const existingServer = Object.values(servers).find(
      (server) => server.server_url === url
    );
    if (existingServer) {
      throw new Error(`Server with URL "${url}" is already connected`);
    }

    // Generate unique server ID
    const serverId = `mcp-${nanoid(8)}`;

    if (!headers) {
      return await this.addMcpServer(serverId, url, this.env.HOST);
    }
    return await this.addMcpServer(serverId, url, this.env.HOST, "agents", {
      transport: {
        type: "auto",
        headers
      }
    });
  }

  @callable()
  async disconnectMCPServer(serverId?: string) {
    if (serverId) {
      // Disconnect specific server
      await this.removeMcpServer(serverId);
    } else {
      // Disconnect all servers if no serverId provided
      const { servers } = await this.getMcpServers();
      for (const id of Object.keys(servers)) {
        await this.removeMcpServer(id);
      }
    }
  }

  @callable()
  async refreshMcpTools(serverId: string) {
    await this.mcp.discoverIfConnected(serverId);
  }

  @callable()
  async getModels() {
    // TODO: get finetunes when the binding supports finetunes.public.list endpoint
    return await this.env.AI.models({ per_page: 1000 });
  }

  onStateUpdate() {}
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
