import { createOpenAI } from "@ai-sdk/openai";
import { createDataStreamResponse, type Message, streamText } from "ai";
import { processToolCalls } from "./utils";
import { tools } from "./tools";
// import { Agent } from "@cloudflare/agents";

// Allow streaming responses up to 30 seconds
export const maxDuration = 30;

type Env = {
  OPENAI_API_KEY: string;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /api/use-chat-human-in-the-loop": {
        const { messages }: { messages: Message[] } = await request.json();

        return createDataStreamResponse({
          execute: async (dataStream) => {
            // Utility function to handle tools that require human confirmation
            // Checks for confirmation in last message and then runs associated tool
            const processedMessages = await processToolCalls(
              {
                messages,
                dataStream,
                tools,
              },
              {
                // type-safe object for tools without an execute function
                getWeatherInformation: async ({ city }) => {
                  const conditions = ["sunny", "cloudy", "rainy", "snowy"];
                  return `The weather in ${city} is ${
                    conditions[Math.floor(Math.random() * conditions.length)]
                  }.`;
                },
              }
            );

            const openai = createOpenAI({
              apiKey: env.OPENAI_API_KEY,
            });

            const result = streamText({
              model: openai("gpt-4o"),
              messages: processedMessages,
              tools,
            });

            result.mergeIntoDataStream(dataStream);
          },
        });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
