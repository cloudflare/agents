import { createOpenAI } from "@ai-sdk/openai";
import { AIChatAgent } from "agents-sdk/ai-chat-agent";
import type { StreamTextOnFinishCallback } from "ai";
import { createDataStreamResponse, streamText } from "ai";
import type { Env } from "../server";

export class Chat extends AIChatAgent<Env> {
  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const openai = createOpenAI({
          apiKey: this.env.OPENAI_API_KEY,
        });

        const result = streamText({
          model: openai("gpt-4o"),
          messages: this.messages,

          onFinish,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }
}
