import { routeAgentRequest } from "agents";
import { AIChatAgent, createToolsFromClientSchemas } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class BrowserCodemode extends AIChatAgent<Env> {
  async onChatMessage(
    _onFinish?: unknown,
    options?: {
      clientTools?: Parameters<typeof createToolsFromClientSchemas>[0];
    }
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system:
        "You are a browser codemode assistant. " +
        "Use the codemode tool to write JavaScript that calls functions on the `codemode` object. " +
        "The generated code runs in an iframe sandbox in the user's browser and can call browser-provided tools.",
      messages: await convertToModelMessages(this.messages),
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
