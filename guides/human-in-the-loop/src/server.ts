import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type StreamTextOnFinishCallback,
  createDataStreamResponse,
  streamText
} from "ai";
import { tools } from "./tools";
import { processToolCalls, hasToolConfirmation, getWeatherInformation } from "./utils";

type Env = {
  OPENAI_API_KEY: string;
};

export class HumanInTheLoop extends AIChatAgent<Env> {
  override async onRequest(request: Request): Promise<Response> {
    if (request.method === "POST") {
      return new Response("", { status: 200 });
    }
    
    return super.onRequest(request);
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const lastMessage = this.messages[this.messages.length - 1];
        
        if (hasToolConfirmation(lastMessage)) {
          // Process tool confirmations and return early if any tool was executed
          await processToolCalls(
            { writer, messages: this.messages, tools },
            { getWeatherInformation }
          );
          return;
        }

        const result = streamText({
          messages: convertToModelMessages(this.messages),
          model: openai("gpt-4o"),
          onFinish,
          tools
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const response = await routeAgentRequest(request, env, {
      cors: true,
    });
    
    return response || new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
