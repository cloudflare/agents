import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import {
  toResponseChunks,
  toTranscriptMessage,
  toUIMessage,
  toUIMessageChunk
} from "../projections/ai-sdk";
import type { ResponseChunk } from "../protocol";
import { responseWriter } from "../response";

/** Append every chunk to a response, which throws on a grammar error. */
function record(chunks: readonly ResponseChunk[]): ResponseChunk[] {
  const recorded: ResponseChunk[] = [];
  const response = responseWriter({
    streamId: "response",
    cursor: 0,
    append: (chunk) => recorded.push(chunk as unknown as ResponseChunk),
    close: () => {},
    error: () => {}
  });
  for (const chunk of chunks) response.append(chunk);
  response.end();
  return recorded;
}

async function collect(
  chunks: readonly UIMessageChunk[]
): Promise<ResponseChunk[]> {
  async function* stream(): AsyncGenerator<UIMessageChunk> {
    yield* chunks;
  }
  const out: ResponseChunk[] = [];
  for await (const chunk of toResponseChunks(stream())) out.push(chunk);
  return out;
}

const generation: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta: "Look it up" },
  { type: "reasoning-end", id: "r" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "Checking" },
  { type: "text-end", id: "t" },
  { type: "tool-input-start", toolCallId: "c", toolName: "weather" },
  { type: "tool-input-delta", toolCallId: "c", inputTextDelta: '{"city":' },
  {
    type: "tool-input-available",
    toolCallId: "c",
    toolName: "weather",
    input: { city: "Lisbon" }
  },
  { type: "tool-output-available", toolCallId: "c", output: { temp: 21 } },
  { type: "data-progress", id: "p", data: { done: 1 } },
  { type: "finish-step" },
  { type: "finish", messageMetadata: { tokens: 12 } }
];

describe("AI SDK projection", () => {
  it("projects a generation into grammatical response chunks", async () => {
    const chunks = await collect(generation);
    expect(record(chunks)).toEqual(chunks);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-available",
      "tool-output-available",
      "data",
      "metadata"
    ]);
  });

  it("projects response chunks back into the UI chunks they came from", async () => {
    const chunks = await collect(generation);
    expect(chunks.map(toUIMessageChunk)).toEqual([
      ...generation.slice(2, 13),
      { type: "message-metadata", messageMetadata: { tokens: 12 } }
    ]);
  });

  it("round-trips a saved UI message through a transcript message", () => {
    const message = {
      id: "m1",
      role: "assistant",
      metadata: { model: "test" },
      parts: [
        { type: "reasoning", text: "Look it up" },
        { type: "text", text: "Checking" },
        {
          type: "tool-weather",
          toolCallId: "c",
          state: "output-available",
          input: { city: "Lisbon" },
          output: { temp: 21 }
        },
        {
          type: "dynamic-tool",
          toolName: "search",
          toolCallId: "d",
          state: "output-error",
          input: { q: "x" },
          errorText: "offline"
        },
        { type: "data-progress", id: "p", data: { done: 1 } }
      ]
    } as UIMessage;
    expect(toUIMessage(toTranscriptMessage(message))).toEqual(message);
  });

  it("throws after an aborted stream, keeping what it produced", async () => {
    async function* stream(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "a" };
      yield { type: "text-delta", id: "a", delta: "Half" };
      yield { type: "abort" };
    }
    const seen: string[] = [];
    await expect(async () => {
      for await (const chunk of toResponseChunks(stream())) {
        seen.push(chunk.type);
      }
    }).rejects.toThrow("aborted");
    expect(seen).toEqual(["text-start", "text-delta"]);
  });
});
