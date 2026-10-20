import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, it } from "vitest";
import { createAI } from "../../../models/pi-ai";
import {
  asAi,
  collectEvents,
  fakeBinding,
  openaiModel,
  responsesTextStream,
  sseResponse,
  userContext
} from "./helpers";

const MODEL = "@cf/zai-org/glm-4.7-flash";

/** A chat-completions chunk with no finish reason. */
function chunk(content: string): string {
  return JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null, index: 0 }],
    id: "chatcmpl-cut",
    model: MODEL,
    object: "chat.completion.chunk"
  });
}

/**
 * A transport failure the wires detect themselves must end in an error that
 * pi's retry policy treats as transient. Otherwise pi fails the turn on the
 * first attempt, whatever its retry settings.
 */
describe("pi-ai: cut-off model streams are retryable", () => {
  it("a chat-completions stream cut off after partial output", async () => {
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

  it("a chat-completions stream cut off before any output", async () => {
    const binding = fakeBinding(() => sseResponse([]));
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(MODEL), userContext("hi"))
    );

    expect(message.stopReason).toBe("error");
    expect(isRetryableAssistantError(message)).toBe(true);
  });

  it("a Responses stream cut off before its terminal event", async () => {
    const binding = fakeBinding(() =>
      sseResponse(responsesTextStream().slice(0, -1))
    );
    const ai = createAI({ binding: asAi(binding) });
    const { message } = await collectEvents(
      ai.stream(ai(openaiModel("gpt-5-mini")), userContext("hi"))
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
    expect(message.errorMessage).toContain("no data received");
    expect(isRetryableAssistantError(message)).toBe(true);
  });
});
