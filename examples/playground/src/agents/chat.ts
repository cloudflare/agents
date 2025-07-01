import { AIChatAgent } from "agents/ai-chat-agent";
import type { StreamTextOnFinishCallback } from "ai";
import { createDataStreamResponse, streamText } from "ai";
import { model } from "../model";
import type { Env } from "../server";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const result = streamText({
          messages: this.messages,
          model,

          onFinish,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }
}
