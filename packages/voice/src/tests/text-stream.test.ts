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

  it("keeps parsing OpenAI-style assistant content after role is omitted", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            '{"choices":[{"delta":{"role":"assistant","content":"before tool"}}]}\n'
          )
        );
        controller.enqueue(
          encoder.encode('{"choices":[{"delta":{"content":" after tool"}}]}\n')
        );
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual(["before tool", " after tool"]);
  });

  it("keeps OpenRouter-style text flowing around two tool calls", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"role":"assistant","content":"Some intro text. "}}]}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-1","type":"function","function":{"name":"first_tool","arguments":"{}"}}]}}]}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Here is what the first tool found. "}}]}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool-2","type":"function","function":{"name":"second_tool","arguments":"{}"}}]}}]}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Here is the conclusion."}}]}\n'
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual([
      "Some intro text. ",
      "Here is what the first tool found. ",
      "Here is the conclusion."
    ]);
  });

  it("keeps AI SDK UI message text deltas flowing around tool parts", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"text-start","id":"t1"}\n')
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"text-delta","id":"t1","delta":"Some intro text. "}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"tool-input-start","toolCallId":"tool-1","toolName":"first_tool"}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"tool-input-available","toolCallId":"tool-1","toolName":"first_tool","input":{}}\n'
          )
        );
        controller.enqueue(
          encoder.encode('data: {"type":"text-start","id":"t2"}\n')
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"text-delta","id":"t2","delta":"Here is what the first tool found. "}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"tool-input-start","toolCallId":"tool-2","toolName":"second_tool"}\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"tool-input-available","toolCallId":"tool-2","toolName":"second_tool","input":{}}\n'
          )
        );
        controller.enqueue(
          encoder.encode('data: {"type":"text-start","id":"t3"}\n')
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"text-delta","id":"t3","delta":"Here is the conclusion."}\n'
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      }
    });

    const chunks = await collect(iterateText(stream));
    expect(chunks).toEqual([
      "Some intro text. ",
      "Here is what the first tool found. ",
      "Here is the conclusion."
    ]);
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
