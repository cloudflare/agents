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
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI as createOpenAIGateway } from "ai-gateway-provider/providers/openai";
import { createAnthropic as createAnthropicGateway } from "ai-gateway-provider/providers/anthropic";
import { createGoogleGenerativeAI as createGoogleGateway } from "ai-gateway-provider/providers/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "cloudflare:workers";

// Gateway is now created per-request with accountId and gatewayId from state

const workersAi = createWorkersAI({
  binding: env.AI,
  gateway: {
    id: "playground"
  }
});

export interface PlaygroundState {
  model: string;
  temperature: number;
  stream: boolean;
  system: string;
  // External provider models mode
  useExternalProvider?: boolean;
  externalProvider?: "openai" | "anthropic" | "google" | "xai";
  externalModel?: string;
  authMethod?: "provider-key" | "gateway";
  // Provider key auth (BYOK)
  providerApiKey?: string;
  // Gateway auth (Unified Billing)
  gatewayAccountId?: string;
  gatewayId?: string;
  gatewayApiKey?: string;
}

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Playground extends AIChatAgent<Env, PlaygroundState> {
  initialState: PlaygroundState = {
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    temperature: 1,
    stream: true,
    system:
      "You are a helpful assistant that can do various tasks using MCP tools.",
    useExternalProvider: false,
    externalProvider: "openai",
    authMethod: "provider-key"
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

    await this.ensureDestroy();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        // Determine which model provider to use
        let modelProvider;

        if (
          this.state.useExternalProvider &&
          this.state.externalProvider &&
          this.state.externalModel
        ) {
          // Extract model name from provider/model format (e.g., "openai/gpt-5.2" -> "gpt-5.2")
          let modelName = this.state.externalModel;
          if (modelName.includes("/")) {
            modelName = modelName.split("/")[1];
          }

          if (
            this.state.authMethod === "gateway" &&
            this.state.gatewayAccountId &&
            this.state.gatewayId &&
            this.state.gatewayApiKey
          ) {
            // Use AI Gateway with unified billing
            const gateway = createAiGateway({
              accountId: this.state.gatewayAccountId,
              gateway: this.state.gatewayId,
              apiKey: this.state.gatewayApiKey
            });

            let baseModel;
            if (this.state.externalProvider === "openai") {
              const openai = createOpenAIGateway(); // No API key for unified billing
              baseModel = openai.chat(modelName);
            } else if (this.state.externalProvider === "anthropic") {
              const anthropic = createAnthropicGateway(); // No API key for unified billing
              baseModel = anthropic.chat(modelName);
            } else if (this.state.externalProvider === "google") {
              const google = createGoogleGateway(); // No API key for unified billing
              baseModel = google.chat(modelName);
            } else if (this.state.externalProvider === "xai") {
              // xAI uses OpenAI-compatible API, so use OpenAI gateway provider
              const openai = createOpenAIGateway(); // No API key for unified billing
              baseModel = openai.chat(modelName);
            } else {
              // Fallback to Workers AI
              const fallbackModel = this.state.model as Parameters<
                typeof workersAi
              >[0];
              baseModel = workersAi(fallbackModel);
            }

            modelProvider = gateway(baseModel);
          } else if (
            this.state.authMethod === "provider-key" &&
            this.state.providerApiKey
          ) {
            // Use provider SDK directly with user's API key (BYOK)
            if (this.state.externalProvider === "openai") {
              const openai = createOpenAI({
                apiKey: this.state.providerApiKey
              });
              modelProvider = openai(modelName);
            } else if (this.state.externalProvider === "anthropic") {
              const anthropic = createAnthropic({
                apiKey: this.state.providerApiKey
              });
              modelProvider = anthropic(modelName);
            } else if (this.state.externalProvider === "google") {
              const google = createGoogleGenerativeAI({
                apiKey: this.state.providerApiKey
              });
              modelProvider = google(modelName);
            } else if (this.state.externalProvider === "xai") {
              // xAI uses OpenAI-compatible API, so use OpenAI SDK with xAI base URL
              const xai = createOpenAI({
                apiKey: this.state.providerApiKey,
                baseURL: "https://api.x.ai/v1"
              });
              modelProvider = xai(modelName);
            } else {
              // Fallback to Workers AI
              modelProvider = workersAi(
                this.state.model as Parameters<typeof workersAi>[0]
              );
            }
          } else {
            // Missing required auth, fallback to Workers AI
            modelProvider = workersAi(
              this.state.model as Parameters<typeof workersAi>[0]
            );
          }
        } else {
          // Use Workers AI (default)
          modelProvider = workersAi(
            this.state.model as Parameters<typeof workersAi>[0]
          );
        }

        const result = streamText({
          system: this.state.system,
          messages: convertToModelMessages(cleanedMessages),
          model: modelProvider,
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
