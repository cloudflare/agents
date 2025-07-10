import { AIChatAgent } from "agents/ai-chat-agent";
import { convertToCoreMessages, streamText } from "ai";
import { model } from "../model";
import type { Env } from "../server";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage() {
    const result = await streamText({
      messages: convertToCoreMessages(this.messages),
      model,
    });

    return result.toTextStreamResponse();
  }
}
