import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { AbortedError } from "../../kernel/errors.js";
import type { ModelChunk, ModelRequest } from "../../ports/model.js";
import { createAiSdkModel } from "./model.js";

const usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

const baseRequest: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

async function collect(iterable: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("createAiSdkModel", () => {
  it("streams text deltas then finish/stop with usage", async () => {
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "hel" },
            { type: "text-delta", id: "text-1", delta: "lo" },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ],
        }),
      },
    });

    await expect(collect(createAiSdkModel(mock).stream(baseRequest))).resolves.toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  it("maps reasoning deltas", async () => {
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "reasoning-1" },
            { type: "reasoning-delta", id: "reasoning-1", delta: "think" },
            { type: "reasoning-end", id: "reasoning-1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ],
        }),
      },
    });

    const chunks = await collect(createAiSdkModel(mock).stream(baseRequest));
    expect(chunks).toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  it("converts tools/toolChoice and maps tool-call chunks", async () => {
    const inputSchema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
    };
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "lookup",
              input: "{\"q\":\"weather\"}",
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
          ],
        }),
      },
    });

    const chunks = await collect(
      createAiSdkModel(mock).stream({
        messages: [{ role: "user", content: [{ type: "text", text: "search" }] }],
        tools: [{ name: "lookup", description: "Look things up", inputSchema }],
        toolChoice: { toolName: "lookup" },
      }),
    );

    expect(chunks).toEqual([
      { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "weather" } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
    expect(mock.doStreamCalls[0]?.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Look things up",
        inputSchema,
      },
    ]);
    expect(mock.doStreamCalls[0]?.toolChoice).toEqual({ type: "tool", toolName: "lookup" });
  });

  it("converts all model message roles including file and error tool-result output", async () => {
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ],
        }),
      },
    });
    const request: ModelRequest = {
      messages: [
        { role: "system", content: "follow policy" },
        {
          role: "user",
          content: [
            { type: "text", text: "see attached" },
            { type: "file", mediaType: "image/png", data: "base64data" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a.txt" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read_file",
              output: { message: "missing" },
              isError: true,
            },
            {
              type: "tool-result",
              toolCallId: "call_2",
              toolName: "echo",
              output: "plain text",
            },
          ],
        },
      ],
      tools: [],
    };

    await collect(createAiSdkModel(mock).stream(request));
    expect(mock.doStreamCalls[0]?.prompt).toEqual([
      { role: "system", content: "follow policy" },
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "file", mediaType: "image/png", data: "base64data" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read_file",
            output: { type: "error-json", value: { message: "missing" } },
          },
          {
            type: "tool-result",
            toolCallId: "call_2",
            toolName: "echo",
            output: { type: "text", value: "plain text" },
          },
        ],
      },
    ]);
  });

  it("passes system, settings, headers, and providerOptions through", async () => {
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "finish", finishReason: { unified: "other", raw: "unknown" }, usage },
          ],
        }),
      },
    });
    const providerOptions = { workersAI: { reasoningEffort: "low" } };
    const settings = {
      temperature: 0.2,
      maxOutputTokens: 123,
      topP: 0.8,
      topK: 40,
      seed: 99,
      stopSequences: ["END"],
      maxRetries: 0,
      headers: { "x-test": "1" },
      providerOptions,
    };

    const chunks = await collect(
      createAiSdkModel(mock).stream({
        system: "top-level system",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        settings,
      }),
    );

    expect(chunks.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(mock.doStreamCalls[0]).toMatchObject({
      temperature: 0.2,
      maxOutputTokens: 123,
      topP: 0.8,
      topK: 40,
      seed: 99,
      stopSequences: ["END"],
      headers: { "x-test": "1" },
      providerOptions,
    });
    expect(mock.doStreamCalls[0]?.prompt).toEqual([
      { role: "system", content: "top-level system" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("maps mid-stream provider error parts to in-band error chunks", async () => {
    const error = new Error("provider down");
    const mock = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "before" },
            { type: "error", error },
          ],
        }),
      },
    });

    await expect(collect(createAiSdkModel(mock).stream(baseRequest))).resolves.toEqual([
      { type: "text-delta", text: "before" },
      { type: "error", error },
      {
        type: "finish",
        finishReason: "error",
        usage: { inputTokens: undefined, outputTokens: undefined },
      },
    ]);
  });

  it("normalizes aborts to AbortedError", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const mock = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(streamController) {
            markStarted();
            abortSignal?.addEventListener("abort", () => {
              streamController.error(new DOMException("cancelled", "AbortError"));
            });
          },
        }),
      }),
    });

    const promise = collect(createAiSdkModel(mock).stream({ ...baseRequest, signal: controller.signal }));
    await started;
    controller.abort("user cancelled");
    await expect(promise).rejects.toThrow(AbortedError);
  });
});
