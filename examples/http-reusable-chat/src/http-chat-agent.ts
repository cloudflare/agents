import { AIHttpChatAgent } from "../../../packages/agents/src/ai-chat-agent-http.js";
import {
  convertToModelMessages,
  streamText,
  createUIMessageStreamResponse,
  createUIMessageStream,
  type StreamTextOnFinishCallback
} from "ai";
import { openai } from "@ai-sdk/openai";
import type { Env } from "./index";

export class HttpChatAgent extends AIHttpChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<{}>,
    options?: { streamId?: string }
  ) {
    const model = openai("gpt-4o-mini");

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          messages: convertToModelMessages(this.messages),
          model,
          onFinish,
          // Add system message to demonstrate long responses for testing resumable streams
          system: `You are a helpful AI assistant. When asked to tell a story or provide long content, 
                   make your responses quite lengthy (at least 500 words) to demonstrate the resumable 
                   streaming functionality. Include multiple paragraphs and detailed descriptions.`
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
}
