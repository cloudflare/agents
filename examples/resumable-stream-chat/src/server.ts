import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
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
 *
 * It also demonstrates data parts — typed JSON blobs attached to messages
 * alongside text. Three patterns are shown:
 *
 * 1. data-sources  — reconciliation (loading → found, same type+id updates in-place)
 * 2. data-thinking — ephemeral status (transient, not persisted)
 * 3. data-usage    — persisted metadata (token counts & latency, survives reload)
 */
export class ResumableStreamingChat extends AIChatAgent {
  /**
   * Handle incoming chat messages.
   */
  async onChatMessage() {
    // Grab the last user message for the simulated source lookup
    let lastUserMsg;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") {
        lastUserMsg = this.messages[i];
        break;
      }
    }
    const query =
      lastUserMsg?.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("") || "unknown";

    const workersai = createWorkersAI({ binding: this.env.AI });
    const modelId = "@cf/zai-org/glm-4.7-flash";
    const startTime = Date.now();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: workersai(modelId),
          messages: await convertToModelMessages(this.messages)
        });

        // Merge the LLM stream first — subsequent writer.write() calls
        // interleave into the same message on the client.
        writer.merge(result.toUIMessageStream());

        // First write: "searching" state
        writer.write({
          type: "data-sources",
          id: "src-1",
          data: { query, status: "searching", results: [] }
        });

        // Simulate a lookup delay
        await new Promise((r) => setTimeout(r, 1000));

        // Second write with same type+id: replaces "searching" in-place.
        // Results are hardcoded here to keep the example focused on the
        // data parts plumbing — in a real app you'd query a vector DB or
        // search index and return actual results.
        writer.write({
          type: "data-sources",
          id: "src-1",
          data: {
            query,
            status: "found",
            results: [
              "Cloudflare Agents SDK docs",
              "AI SDK streaming reference",
              "Durable Objects SQLite guide"
            ]
          }
        });

        // Transient "thinking" data part — not persisted to message.parts
        await new Promise((r) => setTimeout(r, 300));
        writer.write({
          transient: true,
          type: "data-thinking",
          data: { model: modelId, startedAt: new Date().toISOString() }
        });

        // Wait for the LLM to finish so we can report token counts
        const usage = await result.usage;

        writer.write({
          type: "data-usage",
          data: {
            model: modelId,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            latencyMs: Date.now() - startTime
          }
        });
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
