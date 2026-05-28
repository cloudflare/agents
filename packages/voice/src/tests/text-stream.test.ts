/**
 * Tests for text-stream.ts — iterateText and SSE/NDJSON parsing.
 */
import { describe, expect, it, vi } from "vitest";
import { iterateText, iterateTextEvents } from "../text-stream";
import type { TextStreamEvent } from "../text-stream";

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
}

async function collectEvents(
  source: AsyncIterable<TextStreamEvent>
): Promise<TextStreamEvent[]> {
  const events: TextStreamEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

describe("iterateText", () => {
  it("yields a plain string", async () => {
    const chunks = await collect(iterateText("hello"));
    expect(chunks).toEqual(["hello"]);
  });

  it("yields nothing for empty string", async () => {
    const chunks = await collect(iterateText(""));
    expect(chunks).toEqual([]);
  });

  it("iterates an AsyncIterable<string>", async () => {
    async function* gen() {
      yield "a";
      yield "b";
      yield "c";
    }
    const chunks = await collect(iterateText(gen()));
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("iterates a ReadableStream<string>", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("hello ");
        controller.enqueue("world");
        controller.close();
      }
    });
    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello ", "world"]);
  });

  it("prefers a custom async iterator on a dual-protocol stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("not an SSE/NDJSON payload"));
        controller.close();
      }
    }) as ReadableStream<Uint8Array> & AsyncIterable<string>;

    Object.defineProperty(stream, Symbol.asyncIterator, {
      value: async function* () {
        yield "hello ";
        yield "world";
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello ", "world"]);
  });

  it("warns when using an AI SDK textStream-like source", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.close();
      }
    }) as ReadableStream<string> & AsyncIterable<string>;

    Object.defineProperty(stream, Symbol.asyncIterator, {
      value: async function* () {
        yield "hello";
      }
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const chunks = await collect(iterateText(stream));
      expect(chunks).toEqual(["hello"]);
      expect(warn).toHaveBeenCalledWith(
        "[voice] AI SDK textStream is not recommended because non-adjacent text parts may be joined incorrectly. Return result.fullStream from onTurn() instead."
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("iterates AI SDK fullStream text deltas", async () => {
    async function* fullStream() {
      yield { type: "start" };
      yield { type: "text-start", id: "a" };
      yield { type: "text-delta", id: "a", text: "hello" };
      yield { type: "text-delta", id: "a", text: " world" };
      yield { type: "text-end", id: "a" };
      yield { type: "finish" };
    }

    const chunks = await collect(iterateText(fullStream()));
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("adds spaces between fullStream text deltas separated by tool calls", async () => {
    async function* fullStream() {
      yield { type: "text-start", id: "a" };
      yield { type: "text-delta", id: "a", text: "I can help." };
      yield { type: "text-end", id: "a" };
      yield { type: "tool-call", toolName: "getWeather" };
      yield { type: "tool-result", toolName: "getWeather" };
      yield { type: "text-start", id: "b" };
      yield { type: "text-delta", id: "b", text: "The weather is warm" };
      yield { type: "text-end", id: "b" };
    }

    const chunks = await collect(iterateText(fullStream()));
    expect(chunks).toEqual(["I can help.", " ", "The weather is warm"]);
  });

  it("emits stream boundaries before later fullStream text deltas", async () => {
    async function* fullStream() {
      yield { type: "text-start", id: "a" };
      yield { type: "text-delta", id: "a", text: "I can help." };
      yield { type: "text-end", id: "a" };
      yield { type: "tool-call", toolName: "getWeather" };
      yield { type: "text-start", id: "b" };
      yield { type: "text-delta", id: "b", text: "The weather is warm" };
      yield { type: "text-end", id: "b" };
    }

    const events = await collectEvents(iterateTextEvents(fullStream()));
    expect(events).toEqual([
      { type: "text", text: "I can help." },
      { type: "boundary" },
      { type: "text", text: " " },
      { type: "text", text: "The weather is warm" }
    ]);
  });
});

describe("SSE parsing resilience", () => {
  it("survives malformed SSE lines without crashing", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"hello"}\n'));
        controller.enqueue(encoder.encode("data: {malformed json}\n"));
        controller.enqueue(encoder.encode('data: {"response":" world"}\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      }
    });
    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("handles data: [DONE] sentinel", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"hi"}\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.enqueue(encoder.encode('data: {"response":"ignored"}\n'));
        controller.close();
      }
    });
    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hi"]);
  });

  it("handles data lines without a space after the colon", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data:{"response":"hi"}\n'));
        controller.enqueue(encoder.encode("data:[DONE]\n"));
        controller.enqueue(encoder.encode('data:{"response":"ignored"}\n'));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hi"]);
  });
});

describe("NDJSON parsing resilience", () => {
  it("parses raw newline-delimited JSON response chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"hello"}\n'));
        controller.enqueue(encoder.encode('{"response":" world"}\n'));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("parses raw OpenAI-style newline-delimited JSON chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"choices":[{"delta":{"role":"assistant","content":"hello"}}]}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            '{"choices":[{"delta":{"role":"assistant","content":" world"}}]}\n'
          )
        );
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("survives malformed raw JSON lines without crashing", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"hello"}\n'));
        controller.enqueue(encoder.encode("{malformed json}\n"));
        controller.enqueue(encoder.encode('{"response":" world"}\n'));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("buffers raw JSON split across byte chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"hel'));
        controller.enqueue(encoder.encode('lo"}\n{"response":" wor'));
        controller.enqueue(encoder.encode('ld"}\n'));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello", " world"]);
  });

  it("parses the final raw JSON line without a trailing newline", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"hello"}\n'));
        controller.enqueue(encoder.encode('{"response":" world"}'));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello", " world"]);
  });
});
