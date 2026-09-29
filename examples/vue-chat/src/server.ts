import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class ChatAgent extends AIChatAgent {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersAI = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersAI("@cf/moonshotai/kimi-k2.7-code"),
      messages: await convertToModelMessages(this.messages),
      system: "You are a concise, helpful assistant."
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
