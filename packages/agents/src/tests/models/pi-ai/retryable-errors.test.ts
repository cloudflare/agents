import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  asAi,
  collectEvents,
  fakeBinding,
  sseResponse,
  userContext
} from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";

/** A strict OpenAI chunk with no finish reason. */
function chunk(content: string): string {
  return JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null, index: 0 }],
    id: "chatcmpl-cut",
    model: MODEL,
    object: "chat.completion.chunk"
  });
}

/**
 * Transient transport failures the wires detect must end in an error pi's
 * retry policy recognizes; otherwise pi-durable settles the run as
 * unanswered instead of retrying it.
 */
describe("pi-ai: transient stream failures are retryable", () => {
  it("a stream cut off after partial output", async () => {
    const binding = fakeBinding(() =>
      sseResponse([chunk("Half an ans"), chunk("wer")])
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );

    expect(message.stopReason).toBe("error");
    expect(isRetryableAssistantError(message)).toBe(true);
  });

  it("a stream cut off before any output", async () => {
    const binding = fakeBinding(() => sseResponse([]));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );

    expect(message.stopReason).toBe("error");
    expect(isRetryableAssistantError(message)).toBe(true);
  });

  it("a stream that stops sending data", async () => {
    const binding = fakeBinding(
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => {} }), {
          headers: { "content-type": "text/event-stream" },
          status: 200
        })
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL, { streamIdleTimeoutMs: 50 }), userContext("hi"))
    );

    expect(message.stopReason).toBe("error");
    expect(isRetryableAssistantError(message)).toBe(true);
  });
});
