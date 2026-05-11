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
