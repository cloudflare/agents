import { routeAgentRequest } from "agents";
import {
  AIChatAgent,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import type { UIMessage } from "ai";

type Env = {
  ReproChat: DurableObjectNamespace<ReproChat>;
};

const FIRST_CONTINUATION_BYTES = "already streamed";
const FINAL_CONTINUATION_BYTES = " | after reconnect";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Encode one AI SDK UI-message SSE frame as its own network chunk. */
function event(encoder: TextEncoder, value: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

/**
 * A deterministic AIChatAgent continuation: no model, API key, or external
 * service. The first continuation delta is held open for 12 seconds so the
 * browser can reconnect and receive the complete resumable-stream replay.
 */
export class ReproChat extends AIChatAgent<Env> {
  async onChatMessage(
    _onFinish?: unknown,
    options?: OnChatMessageOptions
  ): Promise<Response> {
    if (!options?.continuation) {
      return new Response("This repro only starts programmatic continuations.");
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          event(encoder, {
            type: "start",
            messageId: "provider-message-id"
          })
        );
        controller.enqueue(
          event(encoder, { type: "text-start", id: "continuation-text" })
        );
        controller.enqueue(
          event(encoder, {
            type: "text-delta",
            id: "continuation-text",
            delta: FIRST_CONTINUATION_BYTES
          })
        );

        // Keep the continuation active while the client calls reconnect().
        await sleep(12_000);

        controller.enqueue(
          event(encoder, {
            type: "text-delta",
            id: "continuation-text",
            delta: FINAL_CONTINUATION_BYTES
          })
        );
        controller.enqueue(
          event(encoder, { type: "text-end", id: "continuation-text" })
        );
        controller.enqueue(
          event(encoder, { type: "finish", finishReason: "stop" })
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      }
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/trigger")) {
      return new Response("POST /trigger to run the reproduction", {
        status: 404
      });
    }

    const seed: UIMessage[] = [
      {
        id: "user-before-continuation",
        role: "user",
        parts: [{ type: "text", text: "start deterministic continuation" }]
      },
      {
        id: "assistant-under-test",
        role: "assistant",
        parts: [
          { type: "text", text: "before continuation | " },
          {
            type: "dynamic-tool",
            toolName: "completedStep",
            toolCallId: "completed-tool-call",
            state: "output-available",
            input: {},
            output: { ok: true }
          }
        ] as UIMessage["parts"]
      }
    ];

    // Broadcast a stable pre-continuation baseline, then start the real
    // continuation machinery in the background. A fresh room is used on every
    // page load, so this remains deterministic without unrelated reset logic.
    await this.persistMessages(seed, [], { _deleteStaleRows: true });
    const continuation = this.continueLastTurn({ repro: "issue-1951" });
    this.ctx.waitUntil(
      continuation.catch((error) => {
        console.error("continuation failed", error);
      })
    );

    return Response.json({
      started: true,
      expectedLiveText: FIRST_CONTINUATION_BYTES,
      holdOpenMs: 12_000
    });
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
