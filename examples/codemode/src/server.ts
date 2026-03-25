import { routeAgentRequest, callable } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createCodeTool, generateTypes } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
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
  }

  @callable({ description: "Get tool type definitions" })
  getToolTypes() {
    return generateTypes(this.tools);
  }

  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER
    });

    const codemode = createCodeTool({
      tools: this.tools,
      executor
    });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
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
      tools: { codemode },
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
