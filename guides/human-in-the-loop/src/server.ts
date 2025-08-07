import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  type StreamTextOnFinishCallback,
  streamText,
  convertToModelMessages,
  type UIMessage as ChatMessage
} from "ai";
import { tools } from "./tools";
import { processToolCalls } from "./utils";

type Env = {
  OPENAI_API_KEY: string;
};

export class HumanInTheLoop extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<{}>,
    options?: { abortSignal: AbortSignal | undefined },
    uiMessageOnFinish?: (messages: ChatMessage[]) => Promise<void>
  ) {
    // Utility function to handle tools that require human confirmation
    // Checks for confirmation in last message and then runs associated tool
    const processedMessages = await processToolCalls(
      {
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
      messages: convertToModelMessages(processedMessages),
      model: openai("gpt-4o") as any,
      onFinish,
      tools,
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      originalMessages: this.messages,
      onFinish: ({ messages }) => {
        if (uiMessageOnFinish) {
          uiMessageOnFinish(messages);
        }
      }
    });
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
