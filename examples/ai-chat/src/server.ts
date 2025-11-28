import { openai } from "@ai-sdk/openai";
import { type AgentNamespace, routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse
} from "ai";

type Env = {
  OPENAI_API_KEY: string;
  ResumableStreamingChat: AgentNamespace<ResumableStreamingChat>;
};

export class ResumableStreamingChat extends AIChatAgent<Env> {
  async onChatMessage() {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: convertToModelMessages(this.messages)
        });

        writer.merge(result.toUIMessageStream());
      }
    });
    return createUIMessageStreamResponse({ stream });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
