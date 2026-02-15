import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages } from "ai";

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
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // @ts-expect-error — model not yet in workers-ai-provider types
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
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
