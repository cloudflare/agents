import { describe, expect, it } from "vitest";
import {
  classifyRealtimeMessage,
  isRealtimeRequest,
  processNDJSONStream,
  resolveTextStream,
  type RealtimeRuntimeEventMessage,
  type SpeakResponseText
} from "../../realtime/utils";

describe("classifyRealtimeMessage", () => {
  const validMediaMessage = {
    type: "media",
    version: 1,
    identifier: "abc-123",
    payload: {
      content_type: "text",
      data: "hello world",
      context_id: null
    }
  };

  const validErrorEvent: RealtimeRuntimeEventMessage = {
    type: "event",
    version: 1,
    identifier: "evt-1",
    payload: {
      event_type: "error",
      message: "pipeline failed",
      source: "runtime",
      timestamp: 1730000000
    }
  };

  // -- returns null for non-realtime inputs --

  it("returns null for null", () => {
    expect(classifyRealtimeMessage(null)).toBe(null);
  });

  it("returns null for undefined", () => {
    expect(classifyRealtimeMessage(undefined)).toBe(null);
  });

  it("returns null for a string", () => {
    expect(classifyRealtimeMessage("not a message")).toBe(null);
  });

  it("returns null for a number", () => {
    expect(classifyRealtimeMessage(42)).toBe(null);
  });

  it("returns null when type is missing", () => {
    const { type: _, ...msg } = validMediaMessage;
    expect(classifyRealtimeMessage(msg)).toBe(null);
  });

  it("returns null when type is not a string", () => {
    expect(classifyRealtimeMessage({ ...validMediaMessage, type: 123 })).toBe(
      null
    );
  });

  it("returns null for unknown message type", () => {
    expect(
      classifyRealtimeMessage({ ...validMediaMessage, type: "control" })
    ).toBe(null);
  });

  it("returns null when version is missing", () => {
    const { version: _, ...msg } = validMediaMessage;
    expect(classifyRealtimeMessage(msg)).toBe(null);
  });

  it("returns null when version is not a number", () => {
    expect(
      classifyRealtimeMessage({ ...validMediaMessage, version: "1" })
    ).toBe(null);
  });

  it("returns null when identifier is missing", () => {
    const { identifier: _, ...msg } = validMediaMessage;
    expect(classifyRealtimeMessage(msg)).toBe(null);
  });

  it("returns null when identifier is not a string", () => {
    expect(
      classifyRealtimeMessage({ ...validMediaMessage, identifier: 123 })
    ).toBe(null);
  });

  it("returns null when payload is missing", () => {
    const { payload: _, ...msg } = validMediaMessage;
    expect(classifyRealtimeMessage(msg)).toBe(null);
  });

  it("returns null when payload is null", () => {
    expect(
      classifyRealtimeMessage({ ...validMediaMessage, payload: null })
    ).toBe(null);
  });

  it("returns null when payload is not an object", () => {
    expect(
      classifyRealtimeMessage({ ...validMediaMessage, payload: "not-object" })
    ).toBe(null);
  });

  // -- media classification --

  it("returns 'media' for a valid media message", () => {
    expect(classifyRealtimeMessage(validMediaMessage)).toBe("media");
  });

  it("returns 'media' with string context_id", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, context_id: "ctx-1" }
      })
    ).toBe("media");
  });

  it("returns 'media' when context_id is null", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, context_id: null }
      })
    ).toBe("media");
  });

  it("returns 'media' when context_id is undefined", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, context_id: undefined }
      })
    ).toBe("media");
  });

  it("returns 'media' when peer_id is string or null", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, peer_id: "peer-1" }
      })
    ).toBe("media");

    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, peer_id: null }
      })
    ).toBe("media");
  });

  it("returns null when peer_id is invalid", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, peer_id: 123 }
      })
    ).toBe(null);
  });

  it("returns 'media' when context_id is completely absent", () => {
    const { context_id: _, ...payloadWithoutContextId } =
      validMediaMessage.payload;
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: payloadWithoutContextId
      })
    ).toBe("media");
  });

  it("returns null when context_id is present but not a string/null", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, context_id: 42 }
      })
    ).toBe(null);
  });

  it("returns null when content_type is missing from payload", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { data: "hello" }
      })
    ).toBe(null);
  });

  it("returns null when content_type is not a string", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { content_type: 42, data: "hello" }
      })
    ).toBe(null);
  });

  it("returns null when data is missing from payload", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { content_type: "text" }
      })
    ).toBe(null);
  });

  it("returns null when data is not a string", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { content_type: "text", data: 42 }
      })
    ).toBe(null);
  });

  it("returns 'media' for any content_type string value", () => {
    for (const content_type of ["text", "audio", "video"]) {
      expect(
        classifyRealtimeMessage({
          ...validMediaMessage,
          payload: { ...validMediaMessage.payload, content_type }
        })
      ).toBe("media");
    }
  });

  it("returns 'media' with extra fields on the message", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        extraField: "extra"
      })
    ).toBe("media");
  });

  it("returns 'media' with extra fields on the payload", () => {
    expect(
      classifyRealtimeMessage({
        ...validMediaMessage,
        payload: { ...validMediaMessage.payload, extra: true }
      })
    ).toBe("media");
  });

  // -- event classification --

  it("returns 'event' for a valid error event", () => {
    expect(classifyRealtimeMessage(validErrorEvent)).toBe("event");
  });

  it("returns 'event' for warning/info events", () => {
    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "warning",
          message: "high latency",
          source: "runtime"
        }
      })
    ).toBe("event");

    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "info",
          message: "warmup complete",
          source: "runtime"
        }
      })
    ).toBe("event");
  });

  it("returns 'event' for a valid custom event", () => {
    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "custom",
          kind: "tool_call",
          data: { id: "abc" },
          source: "runtime"
        }
      })
    ).toBe("event");
  });

  it("returns null for event without source", () => {
    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "error",
          message: "oops"
        }
      })
    ).toBe(null);
  });

  it("returns null for error/warning/info without message", () => {
    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "error",
          source: "runtime"
        }
      })
    ).toBe(null);
  });

  it("returns null for custom without kind", () => {
    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "custom",
          source: "runtime"
        }
      })
    ).toBe(null);
  });

  it("returns null for unknown event_type", () => {
    expect(
      classifyRealtimeMessage({
        ...validErrorEvent,
        payload: {
          event_type: "status",
          source: "runtime"
        }
      })
    ).toBe(null);
  });
});

describe("isRealtimeRequest", () => {
  function makeRequest(url: string): Request {
    return new Request(url);
  }

  it("should return true for a URL with /realtime/ segment", () => {
    expect(
      isRealtimeRequest(
        makeRequest("https://example.com/agents/my-agent/123/realtime/start")
      )
    ).toBe(true);
  });

  it("should return true for /realtime/stop", () => {
    expect(
      isRealtimeRequest(
        makeRequest("https://example.com/agents/my-agent/123/realtime/stop")
      )
    ).toBe(true);
  });

  it("should return true for /realtime/ws", () => {
    expect(
      isRealtimeRequest(
        makeRequest("https://example.com/agents/my-agent/123/realtime/ws")
      )
    ).toBe(true);
  });

  it("should return true for /realtime/ping", () => {
    expect(
      isRealtimeRequest(
        makeRequest("https://example.com/agents/my-agent/123/realtime/ping")
      )
    ).toBe(true);
  });

  it("should return false for a URL without /realtime/", () => {
    expect(
      isRealtimeRequest(makeRequest("https://example.com/agents/my-agent/123"))
    ).toBe(false);
  });

  it("should return false for a URL with /realtime at the end (no trailing slash or path)", () => {
    expect(
      isRealtimeRequest(
        makeRequest("https://example.com/agents/my-agent/123/realtime")
      )
    ).toBe(false);
  });

  it("should return true when /realtime/ appears anywhere in the path", () => {
    expect(
      isRealtimeRequest(makeRequest("https://example.com/realtime/something"))
    ).toBe(true);
  });

  it("should return false for root URL", () => {
    expect(isRealtimeRequest(makeRequest("https://example.com/"))).toBe(false);
  });
});

describe("processNDJSONStream", () => {
  /**
   * Helper to create a ReadableStream from an array of string chunks
   */
  function createStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    });
  }

  it("should parse a single data line", async () => {
    const stream = createStream(['data: {"response":"hello"}\n']);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "hello" }]);
  });

  it("should parse multiple data lines", async () => {
    const stream = createStream([
      'data: {"response":"one"}\ndata: {"response":"two"}\n'
    ]);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "one" }, { response: "two" }]);
  });

  it("should handle data split across multiple chunks", async () => {
    const stream = createStream(['data: {"resp', 'onse":"split"}\n']);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "split" }]);
  });

  it("should stop on data: [DONE]", async () => {
    const stream = createStream([
      'data: {"response":"first"}\ndata: [DONE]\ndata: {"response":"should-not-appear"}\n'
    ]);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "first" }]);
  });

  it("should skip empty lines", async () => {
    const stream = createStream(['\n\ndata: {"response":"hello"}\n\n']);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "hello" }]);
  });

  it("should skip non-data lines", async () => {
    const stream = createStream([
      'event: message\ndata: {"response":"hello"}\n'
    ]);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "hello" }]);
  });

  it("should handle leftover buffer at end of stream", async () => {
    // No trailing newline, data stays in buffer until stream ends
    const stream = createStream(['data: {"response":"buffered"}']);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "buffered" }]);
  });

  it("should handle empty stream", async () => {
    const stream = createStream([]);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([]);
  });

  it("should parse choices format (OpenAI-style)", async () => {
    const stream = createStream([
      'data: {"choices":[{"delta":{"content":"hi","role":"assistant"}}]}\n'
    ]);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([
      { choices: [{ delta: { content: "hi", role: "assistant" } }] }
    ]);
  });

  it("should handle [DONE] in leftover buffer", async () => {
    const stream = createStream(["data: [DONE]"]);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(stream.getReader())) {
      results.push(chunk);
    }
    expect(results).toEqual([]);
  });

  it("should accept initial leftOverBuffer parameter", async () => {
    const stream = createStream(['ello"}\n']);
    const results: unknown[] = [];
    for await (const chunk of processNDJSONStream(
      stream.getReader(),
      'data: {"response":"h'
    )) {
      results.push(chunk);
    }
    expect(results).toEqual([{ response: "hello" }]);
  });
});

describe("resolveTextStream", () => {
  async function collect(text: SpeakResponseText): Promise<string[]> {
    const result: string[] = [];
    for await (const chunk of resolveTextStream(text)) {
      result.push(chunk);
    }
    return result;
  }

  function makeNDJSONStream(
    objects: Record<string, unknown>[]
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const obj of objects) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n"));
        controller.close();
      }
    });
  }

  it("should yield a plain string", async () => {
    expect(await collect("hello")).toEqual(["hello"]);
  });

  it("should yield nothing for an empty string", async () => {
    expect(await collect("")).toEqual([]);
  });

  it("should yield each chunk from a ReadableStream<string>", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("Hello ");
        controller.enqueue("world");
        controller.close();
      }
    });
    expect(
      await collect(stream as AsyncIterable<string> & ReadableStream<string>)
    ).toEqual(["Hello ", "world"]);
  });

  it("should skip empty string chunks from a ReadableStream<string>", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("");
        controller.enqueue("b");
        controller.close();
      }
    });
    expect(
      await collect(stream as AsyncIterable<string> & ReadableStream<string>)
    ).toEqual(["a", "b"]);
  });

  it("should yield nothing from an empty ReadableStream", async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.close();
      }
    });
    expect(
      await collect(stream as AsyncIterable<string> & ReadableStream<string>)
    ).toEqual([]);
  });

  it("should parse NDJSON response field from ReadableStream<Uint8Array>", async () => {
    const stream = makeNDJSONStream([
      { response: "first" },
      { response: "second" }
    ]);
    expect(await collect(stream as unknown as SpeakResponseText)).toEqual([
      "first",
      "second"
    ]);
  });

  it("should parse OpenAI-style choices from NDJSON", async () => {
    const stream = makeNDJSONStream([
      { choices: [{ delta: { content: "hi", role: "assistant" } }] }
    ]);
    expect(await collect(stream as unknown as SpeakResponseText)).toEqual([
      "hi"
    ]);
  });

  it("should ignore non-assistant roles in NDJSON choices", async () => {
    const stream = makeNDJSONStream([
      { choices: [{ delta: { content: "sys", role: "system" } }] },
      { choices: [{ delta: { content: "ok", role: "assistant" } }] }
    ]);
    expect(await collect(stream as unknown as SpeakResponseText)).toEqual([
      "ok"
    ]);
  });

  it("should yield each chunk from a pure AsyncIterable<string>", async () => {
    async function* gen() {
      yield "one";
      yield "two";
    }
    expect(await collect(gen() as unknown as SpeakResponseText)).toEqual([
      "one",
      "two"
    ]);
  });
});
