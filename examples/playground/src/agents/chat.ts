import { AIChatAgent } from "agents/ai-chat-agent";
import type { StreamTextOnFinishCallback } from "ai";
import { createDataStreamResponse, streamText } from "ai";
import type { Env } from "../server";
import { model } from "../model";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const result = streamText({
          model,
          messages: this.messages,

          onFinish,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }
}
