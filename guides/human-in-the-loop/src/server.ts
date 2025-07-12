import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  type StreamTextOnFinishCallback,
  createDataStreamResponse,
  streamText
} from "ai";
import { tools } from "./tools";
import { processToolCalls } from "./utils";

type Env = {
  OPENAI_API_KEY: string;
};

export class HumanInTheLoop extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
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

        const result = streamText({
          messages: processedMessages,
          model: openai("gpt-4o"),
          onFinish,
          tools
        });

        result.mergeIntoDataStream(dataStream);
      }
    });

    return dataStreamResponse;
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
