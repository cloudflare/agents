import { routeAgentRequest, callable } from "agents";
import {
  AIChatAgent,
  createToolsFromClientSchemas,
  type ClientToolSchema
} from "@cloudflare/ai-chat";
import { generateTypes } from "@cloudflare/codemode/ai";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  pruneMessages
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { initDatabase, createTools } from "./tools";

export class Codemode extends AIChatAgent<Env> {
  tools!: ReturnType<typeof createTools>;

  async onStart() {
    initDatabase(this.ctx.storage.sql);
    this.tools = createTools(this.ctx.storage.sql);

    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable({ description: "Get tool type definitions" })
  getToolTypes() {
    const mcpTools = this.mcp.getAITools();
    const allTools = { ...this.tools, ...mcpTools };
    return generateTypes(allTools);
  }

  @callable({ description: "Add an MCP server to get additional tools" })
  async addMcp(url: string, name?: string) {
    const serverName = name || `mcp-${Date.now()}`;
    const result = await this.addMcpServer(serverName, url);
    return result;
  }

  @callable({ description: "List connected MCP servers and their tools" })
  listMcpTools() {
    const tools = this.mcp.listTools();
    return tools.map((t) => ({
      serverId: t.serverId,
      name: t.name,
      description: t.description
    }));
  }

  @callable({ description: "Remove an MCP server" })
  async removeMcp(serverId: string) {
    await this.removeMcpServer(serverId);
    return { success: true, removed: serverId };
  }

  async onChatMessage(
    _onFinish?: unknown,
    options?: { clientTools?: ClientToolSchema[] }
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system:
        "You are a helpful project management assistant. " +
        "You can create and manage projects, tasks, sprints, and comments using the codemode tool. " +
        "When you need to perform operations, use the codemode tool to write JavaScript " +
        "that calls the available functions on the `codemode` object.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: createToolsFromClientSchemas(options?.clientTools),
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
