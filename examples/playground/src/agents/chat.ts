import { AIChatAgent } from "agents/ai-chat-agent";
import type {
  StreamTextOnFinishCallback,
  UIMessage as ChatMessage,
  LanguageModel
} from "ai";
import { streamText, convertToModelMessages } from "ai";
import { model } from "../model";
import type { Env } from "../server";

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<{}>,
    options?: { abortSignal: AbortSignal | undefined },
    uiMessageOnFinish?: (messages: ChatMessage[]) => Promise<void>
  ) {
    const result = streamText({
      messages: convertToModelMessages(this.messages),
      model: model as unknown as LanguageModel,
      onFinish,
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      originalMessages: this.messages,
      onFinish: ({ messages }) => {
        // Call the callback provided by AIChatAgent
        if (uiMessageOnFinish) {
          uiMessageOnFinish(messages);
        }
      }
    });
  }
}
