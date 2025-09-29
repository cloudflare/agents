import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIHttpChatAgent } from "agents/ai-chat-agent-http";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type StreamTextOnFinishCallback,
  type ToolSet,
  streamText
} from "ai";

type Env = {
  OPENAI_API_KEY: string;
};

export class ResumableChatAgent extends AIHttpChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    _options?: { streamId?: string }
  ): Promise<Response | undefined> {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          messages: convertToModelMessages(this.messages),
          model: openai("gpt-4o"),
          onFinish
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    const response = createUIMessageStreamResponse({ stream });
    return response;
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
