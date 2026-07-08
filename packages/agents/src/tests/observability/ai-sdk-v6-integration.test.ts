import { describe, expect, it } from "vitest";
import * as ai from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { RecordingTracer } from "./recording-tracer";
import { createAISDKV6Wrapper } from "../../observability/ai/v6/wrap";

type ProviderStreamResult = Awaited<
  ReturnType<MockLanguageModelV3["doStream"]>
>;
type ProviderStreamPart =
  ProviderStreamResult["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

/** A mock model whose stream produces "Hello world" plus usage metadata. */
function textStreamModel(): MockLanguageModelV3 {
  const parts: ProviderStreamPart[] = [
    { type: "stream-start", warnings: [] },
    {
      type: "response-metadata",
      id: "resp-1",
      modelId: "mock-model-served",
      timestamp: new Date(0)
    },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", delta: "Hello", id: "text-1" },
    { type: "text-delta", delta: " world", id: "text-1" },
    { type: "text-end", id: "text-1" },
    {
      type: "finish",
      finishReason: { raw: "stop", unified: "stop" },
      usage: {
        inputTokens: { cacheRead: 1, cacheWrite: 0, noCache: 7, total: 8 },
        outputTokens: { reasoning: 2, text: 2, total: 4 }
      }
    }
  ];

  return new MockLanguageModelV3({
    modelId: "mock-model",
    provider: "mock-provider",
    doStream: async () => ({
      stream: convertArrayToReadableStream(parts)
    })
  });
}

describe("createAISDKV6Wrapper with the real AI SDK", () => {
  it("traces a streamText call end to end", async () => {
    const tracing = new RecordingTracer();
    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });

    const result = wrapped.streamText({
      model: textStreamModel(),
      prompt: "Say hello"
    });

    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
    }

    expect(text).toBe("Hello world");

    const rootSpan = tracing.rootSpans[0];
    expect(rootSpan?.attributes).toMatchObject({
      "cloudflare.agents.integration.name": "ai-sdk",
      "cloudflare.agents.operation.name": "streamText",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "mock-provider",
      "gen_ai.request.model": "mock-model",
      "gen_ai.request.stream": true,
      "gen_ai.usage.cache_read.input_tokens": 1,
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "gen_ai.usage.reasoning.output_tokens": 2
    });
    expect(rootSpan?.attributes).not.toHaveProperty([
      "gen_ai.response.time_to_first_chunk"
    ]);
    expect(rootSpan?.ended).toBe(true);

    const chatSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chatSpan?.attributes).toMatchObject({
      "cloudflare.agents.operation.name": "doStream",
      // Populated from the provider-level response-metadata stream part.
      "gen_ai.response.id": "resp-1",
      "gen_ai.response.model": "mock-model-served"
    });
    const timeToFirstChunk =
      chatSpan?.attributes["gen_ai.response.time_to_first_chunk"];
    expect(typeof timeToFirstChunk).toBe("number");
    expect(timeToFirstChunk).toBeGreaterThanOrEqual(0);
    expect(chatSpan?.ended).toBe(true);
  });

  it("stays lazy: nothing consumes the stream before the caller does", async () => {
    const tracing = new RecordingTracer();
    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const model = textStreamModel();

    const result = wrapped.streamText({ model, prompt: "lazy" });

    // Give any hidden eager consumption a chance to run before checking.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(model.doStreamCalls.length).toBeLessThanOrEqual(1);
    // The old eager result-getter touching consumed the stream and closed the
    // span here; the root span must still be open before consumption.
    expect(tracing.rootSpans[0]?.ended).toBe(false);

    let text = "";
    for await (const chunk of result.textStream) {
      text += chunk;
    }

    expect(text).toBe("Hello world");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("traces tool execution with the SDK-provided tool call id", async () => {
    const tracing = new RecordingTracer();
    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const executions: Array<readonly [number, number]> = [];
    const parts: ProviderStreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        input: JSON.stringify({ a: 6, b: 7 }),
        toolCallId: "call-1",
        toolName: "multiply"
      },
      {
        type: "finish",
        finishReason: { raw: "tool-calls", unified: "tool-calls" },
        usage: {
          inputTokens: {
            cacheRead: undefined,
            cacheWrite: undefined,
            noCache: undefined,
            total: 3
          },
          outputTokens: { reasoning: undefined, text: undefined, total: 2 }
        }
      }
    ];
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      provider: "mock-provider",
      doStream: async () => ({
        stream: convertArrayToReadableStream(parts)
      })
    });

    const result = wrapped.streamText({
      model,
      prompt: "multiply 6 by 7",
      tools: {
        multiply: ai.tool({
          description: "Multiply two numbers",
          inputSchema: ai.jsonSchema<{ a: number; b: number }>({
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
            type: "object"
          }),
          execute: async ({ a, b }) => {
            executions.push([a, b]);
            return a * b;
          }
        })
      }
    });

    for await (const _part of result.fullStream) {
      // Consume the stream so the SDK executes the tool call.
    }

    expect(executions).toEqual([[6, 7]]);

    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.tool.call.id": "call-1",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function"
    });
    expect(toolSpan?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("marks the root span errored when the provider emits an in-band error part", async () => {
    const tracing = new RecordingTracer();
    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const parts: ProviderStreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", delta: "Hel", id: "text-1" },
      { type: "error", error: new Error("provider blew up") }
    ];
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      provider: "mock-provider",
      doStream: async () => ({
        stream: convertArrayToReadableStream(parts)
      })
    });

    const result = wrapped.streamText({
      model,
      onError: () => {
        // Swallow the SDK's default console logging for the expected error.
      },
      prompt: "fail please"
    });

    for await (const _part of result.fullStream) {
      // The error arrives as an in-band part; the stream completes normally.
    }

    const rootSpan = tracing.rootSpans[0];
    expect(rootSpan?.attributes).toMatchObject({
      "error.type": "Error"
    });
    expect(rootSpan?.attributes).not.toHaveProperty([
      "cloudflare.agents.canceled"
    ]);
    expect(rootSpan?.ended).toBe(true);
  });

  it("finishes the root span as canceled when the caller aborts mid-stream", async () => {
    const tracing = new RecordingTracer();
    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const abortController = new AbortController();
    const model = new MockLanguageModelV3({
      modelId: "mock-model",
      provider: "mock-provider",
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<ProviderStreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({
              type: "text-delta",
              delta: "Hel",
              id: "text-1"
            });
            // Behave like a real provider fetch: reject the hanging read when
            // the caller aborts.
            abortSignal?.addEventListener("abort", () => {
              controller.error(abortSignal.reason);
            });
          }
        })
      })
    });

    const result = wrapped.streamText({
      abortSignal: abortController.signal,
      model,
      prompt: "abort me"
    });

    const seenPartTypes: string[] = [];
    for await (const part of result.fullStream) {
      seenPartTypes.push(part.type);
      if (part.type === "text-delta") {
        abortController.abort();
      }
    }

    // The real SDK surfaces the abort as an in-band part, then completes.
    expect(seenPartTypes).toContain("abort");

    const rootSpan = tracing.rootSpans[0];
    expect(rootSpan?.attributes).toMatchObject({
      "cloudflare.agents.canceled": true
    });
    expect(rootSpan?.attributes).not.toHaveProperty(["otel.status_code"]);
    expect(rootSpan?.attributes).not.toHaveProperty(["error.type"]);
    expect(rootSpan?.ended).toBe(true);

    const chatSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chatSpan?.ended).toBe(true);
  });
});
