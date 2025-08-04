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
<<<<<<< HEAD
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        // Utility function to handle tools that require human confirmation
        // Checks for confirmation in last message and then runs associated tool
        const processedMessages = await processToolCalls(
          {
            dataStream,
            messages: this.messages,
            tools
          },
          {
            // type-safe object for tools without an execute function
            getWeatherInformation: async ({ city }) => {
              const conditions = ["sunny", "cloudy", "rainy", "snowy"];
              return `The weather in ${city} is ${
                conditions[Math.floor(Math.random() * conditions.length)]
              }.`;
            }
          }
        );
=======
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
>>>>>>> 869706b (fixed human in the loop)

        const result = streamText({
          messages: convertToModelMessages(this.messages),
          model: openai("gpt-4o"),
          onFinish,
          tools
        });

<<<<<<< HEAD
        result.mergeIntoDataStream(dataStream);
=======
        writer.merge(result.toUIMessageStream());
>>>>>>> 869706b (fixed human in the loop)
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
<<<<<<< HEAD
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
=======
    const response = await routeAgentRequest(request, env, {
      cors: true,
    });
    
    return response || new Response("Not found", { status: 404 });
  },
>>>>>>> 869706b (fixed human in the loop)
} satisfies ExportedHandler<Env>;
