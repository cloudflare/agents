import { openai } from "@ai-sdk/openai";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse
} from "ai";

/**
 * Resumable Streaming Chat Agent
 *
 * This example demonstrates automatic resumable streaming built into AIChatAgent.
 * When a client disconnects and reconnects during streaming:
 * 1. The server automatically detects the active stream
 * 2. Sends CF_AGENT_STREAM_RESUMING notification
 * 3. Client ACKs and receives all buffered chunks
 *
 * No special setup required - just use onChatMessage() as usual.
 */
export class ResumableStreamingChat extends AIChatAgent {
  /**
   * Handle incoming chat messages.
   */
  async onChatMessage() {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages: await convertToModelMessages(this.messages)
        });

        writer.merge(result.toUIMessageStream());
      }
    });
    return createUIMessageStreamResponse({ stream });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
