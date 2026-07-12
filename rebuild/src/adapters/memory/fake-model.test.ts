import { describe, expect, it } from "vitest";
import { AbortedError } from "../../kernel/errors.js";
import type { ModelChunk, ModelRequest } from "../../ports/model.js";
import { createFakeModel } from "./fake-model.js";

const baseRequest: ModelRequest = { messages: [], tools: [] };

async function collect(iterable: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("createFakeModel — text turns", () => {
  it("streams text in at least 2 deltas then finish/stop", async () => {
    const model = createFakeModel([{ kind: "text", text: "hello world" }]);
    const chunks = await collect(model.stream(baseRequest));
    const deltas = chunks.filter((c) => c.type === "text-delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe("hello world");
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("emits reasoning deltas when reasoning is scripted", async () => {
    const model = createFakeModel([{ kind: "text", text: "answer", reasoning: "thinking it through" }]);
    const chunks = await collect(model.stream(baseRequest));
    const reasoning = chunks.filter((c) => c.type === "reasoning-delta");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.map((d) => (d as { text: string }).text).join("")).toBe("thinking it through");
  });
});

describe("createFakeModel — tool-call turns", () => {
  it("emits one tool-call chunk then finish/tool-calls", async () => {
    const model = createFakeModel([{ kind: "tool-call", toolName: "search", input: { q: "hi" } }]);
    const chunks = await collect(model.stream(baseRequest));
    const toolCalls = chunks.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ type: "tool-call", toolName: "search", input: { q: "hi" } });
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("uses a provided id or generates one", async () => {
    const model = createFakeModel([{ kind: "tool-call", toolName: "search", input: {}, id: "call_42" }]);
    const chunks = await collect(model.stream(baseRequest));
    const call = chunks.find((c) => c.type === "tool-call") as Extract<ModelChunk, { type: "tool-call" }>;
    expect(call.toolCallId).toBe("call_42");
  });
});

describe("createFakeModel — error turns", () => {
  it("throws from the async iterable", async () => {
    const model = createFakeModel([{ kind: "error", error: new Error("provider down") }]);
    await expect(collect(model.stream(baseRequest))).rejects.toThrow("provider down");
  });
});

describe("createFakeModel — hang turns", () => {
  it("never yields", async () => {
    const model = createFakeModel([{ kind: "hang" }]);
    const iterator = model.stream(baseRequest)[Symbol.asyncIterator]();
    const result = await Promise.race([
      iterator.next().then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(result).toBe("timeout");
  });

  it("respects an abort signal and throws AbortedError", async () => {
    const model = createFakeModel([{ kind: "hang" }]);
    const controller = new AbortController();
    const promise = collect(model.stream({ ...baseRequest, signal: controller.signal }));
    controller.abort();
    await expect(promise).rejects.toThrow(AbortedError);
  });
});

describe("createFakeModel — custom turns", () => {
  it("yields exactly the scripted chunks", async () => {
    const custom: ModelChunk[] = [
      { type: "text-delta", text: "a" },
      { type: "finish", finishReason: "stop" },
    ];
    const model = createFakeModel([{ kind: "custom", chunks: custom }]);
    const chunks = await collect(model.stream(baseRequest));
    expect(chunks).toEqual(custom);
  });
});

describe("createFakeModel — script sequencing", () => {
  it("advances through the script array on successive calls", async () => {
    const model = createFakeModel([
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    const first = await collect(model.stream(baseRequest));
    const second = await collect(model.stream(baseRequest));
    expect(first.filter((c) => c.type === "text-delta").map((c) => (c as { text: string }).text).join("")).toBe(
      "first"
    );
    expect(second.filter((c) => c.type === "text-delta").map((c) => (c as { text: string }).text).join("")).toBe(
      "second"
    );
  });

  it("supports a function script keyed by call count", async () => {
    const model = createFakeModel((_req, call) => ({ kind: "text", text: `call-${call}` }));
    const first = await collect(model.stream(baseRequest));
    const second = await collect(model.stream(baseRequest));
    const firstText = first
      .filter((c): c is Extract<ModelChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    const secondText = second
      .filter((c): c is Extract<ModelChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    expect(firstText).toBe("call-0");
    expect(secondText).toBe("call-1");
  });

  it("captures every request for assertions", async () => {
    const model = createFakeModel([{ kind: "text", text: "hi" }, { kind: "text", text: "there" }]);
    await collect(model.stream({ ...baseRequest, system: "one" }));
    await collect(model.stream({ ...baseRequest, system: "two" }));
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.system).toBe("one");
    expect(model.requests[1]?.system).toBe("two");
  });
});

describe("createFakeModel — abort behavior on normal turns", () => {
  it("stops yielding and throws AbortedError when the signal is already aborted", async () => {
    const model = createFakeModel([{ kind: "text", text: "hello world this is long" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(collect(model.stream({ ...baseRequest, signal: controller.signal }))).rejects.toThrow(
      AbortedError
    );
  });
});
