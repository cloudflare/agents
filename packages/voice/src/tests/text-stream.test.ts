/**
 * Tests for text-stream.ts — iterateText and SSE/NDJSON parsing.
 */
import { describe, expect, it } from "vitest";
import { iterateText } from "../text-stream";

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
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

  it("prefers an explicit async iterator on dual-protocol streams", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("not valid sse or ndjson\n"));
        controller.close();
      }
    }) as ReadableStream<Uint8Array> & AsyncIterable<string>;

    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: true,
      value: async function* () {
        yield "hello ";
        yield "world";
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["hello ", "world"]);
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
});
