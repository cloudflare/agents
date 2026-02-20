import { routeAgentRequest, getAgentByName, callable } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createCodeTool } from "@cloudflare/codemode/ai";
import {
  DynamicWorkerExecutor,
  generateTypes,
  type Executor
} from "@cloudflare/codemode";
import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  pruneMessages
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { initDatabase, createTools } from "./tools";
import {
  NodeServerExecutor,
  handleToolCallback
} from "./executors/node-server-client";

export type ExecutorType = "dynamic-worker" | "node-server";

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

export class Codemode extends AIChatAgent<Env> {
  nodeExecutorRegistry = new Map<string, ToolFns>();
  tools!: ReturnType<typeof createTools>;
  executorType: ExecutorType = "dynamic-worker";

  async onStart() {
    initDatabase(this.ctx.storage.sql);
    this.tools = createTools(this.ctx.storage.sql);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/node-executor-callback/")) {
      return handleToolCallback(request, this.nodeExecutorRegistry);
    }
    return new Response("Not found", { status: 404 });
  }

  @callable({ description: "Set the executor type" })
  setExecutor(executorType: ExecutorType) {
    this.executorType = executorType;
    return { executor: this.executorType };
  }

  @callable({ description: "Get tool type definitions" })
  getToolTypes() {
    return generateTypes(this.tools);
  }

  createExecutor(): Executor {
    switch (this.executorType) {
      case "node-server":
        return new NodeServerExecutor({
          serverUrl: "http://localhost:3001",
          callbackUrl: `http://localhost:5173/node-executor-callback/${this.name}`,
          registry: this.nodeExecutorRegistry
        });
      case "dynamic-worker":
      default:
        return new DynamicWorkerExecutor({
          loader: this.env.LOADER
        });
    }
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const executor = this.createExecutor();
    const codemode = createCodeTool({
      tools: this.tools,
      executor
    });

    const result = streamText({
      // @ts-expect-error -- model not yet in workers-ai-provider type list
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system:
        "You are a helpful project management assistant. " +
        "You can create and manage projects, tasks, sprints, and comments using the codemode tool. " +
        "When you need to perform operations, use the codemode tool to write JavaScript " +
        "that calls the available functions on the `codemode` object. " +
        `Current executor: ${this.executorType}`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: { codemode },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/node-executor-callback/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const agentName = parts[1];
      if (!agentName) {
        return Response.json(
          { error: "Missing agent name in callback URL" },
          { status: 400 }
        );
      }
      const agent = await getAgentByName(env.Codemode, agentName);
      return agent.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
