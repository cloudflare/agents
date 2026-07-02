import { describe, expect, it } from "vitest";
import { RecordingTracer } from "../../../test-support/recording-tracer.js";
import { createAISDKV6Wrapper, type AISDKV6Namespace } from "./wrap.js";

type TestModel = {
  readonly doGenerate: (params?: unknown) => Promise<unknown>;
  readonly modelId: string;
  readonly provider: string;
};

describe("createAISDKV6Wrapper", () => {
  it("traces generateText and the child doGenerate model call", async () => {
    const tracing = new RecordingTracer();
    const model = {
      modelId: "test-model",
      provider: "test-provider",
      doGenerate: async (_params?: unknown) => ({
        finishReason: "stop",
        response: { id: "response-1", model: "served-model" },
        text: "Hello",
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
        },
      }),
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const wrappedModel = params.model as TestModel;
        return wrappedModel.doGenerate({ prompt: params.prompt });
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel;
        return {
          ...original,
          doGenerate: async () =>
            middleware.wrapGenerate
              ? middleware.wrapGenerate({
                  doGenerate: () => original.doGenerate(),
                  params: {},
                })
              : original.doGenerate(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = await wrapped.generateText({
      experimental_telemetry: {
        functionId: "fixture-agent",
        metadata: {
          conversationId: "conversation-1",
        },
      },
      maxOutputTokens: 20,
      model,
      prompt: "Say hello",
      temperature: 0.2,
    });

    expect(result).toMatchObject({ text: "Hello" });
    expect(tracing.rootSpans).toHaveLength(1);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.integration.name": "ai-sdk",
      "ai.operation.id": "generateText",
      "ai.output.has_text": true,
      "ai.response.finish_reason": "stop",
      "ai.usage.total_tokens": 6,
      "gen_ai.agent.name": "fixture-agent",
      "gen_ai.conversation.id": "conversation-1",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.max_tokens": 20,
      "gen_ai.request.model": "test-model",
      "gen_ai.request.stream": false,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.response.finish_reasons": '["stop"]',
      "gen_ai.response.id": "response-1",
      "gen_ai.response.model": "served-model",
      "gen_ai.usage.input_tokens": 4,
      "gen_ai.usage.output_tokens": 2,
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.attributes).toMatchObject({
      "ai.operation.id": "doGenerate",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.model": "test-model",
      "gen_ai.request.stream": false,
    });
    expect(modelCall?.ended).toBe(true);
  });

  it("marks both operation and child model span when doGenerate fails", async () => {
    const tracing = new RecordingTracer();
    const cause = new Error("model failed");
    const model = {
      modelId: "test-model",
      provider: "test-provider",
      doGenerate: async (_params?: unknown) => {
        throw cause;
      },
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const wrappedModel = params.model as TestModel;
        return wrappedModel.doGenerate({ prompt: params.prompt });
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel;
        return {
          ...original,
          doGenerate: async () =>
            middleware.wrapGenerate
              ? middleware.wrapGenerate({
                  doGenerate: () => original.doGenerate(),
                  params: {},
                })
              : original.doGenerate(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });

    await expect(
      wrapped.generateText({ model, prompt: "Say hello" }),
    ).rejects.toThrow(cause);

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "error": true,
      "error.type": "Error",
    });
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("error.message");
    expect(tracing.rootSpans[0]?.children[0]?.attributes).toMatchObject({
      "error": true,
      "error.type": "Error",
    });
    expect(tracing.rootSpans[0]?.children[0]?.attributes).not.toHaveProperty(
      "error.message",
    );
    expect(tracing.rootSpans[0]?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.children[0]?.ended).toBe(true);
  });

  it("keeps streamText spans open until the returned stream is consumed", async () => {
    const tracing = new RecordingTracer();
    const model = {
      modelId: "stream-model",
      provider: "test-provider",
      doGenerate: async () => ({ text: "unused" }),
      doStream: async () => ({
        stream: streamFrom([
          { type: "text-delta", delta: "Hello" },
          {
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: { cacheRead: 1, total: 8 },
              outputTokens: { reasoning: 2, total: 4 },
              totalTokens: 12,
            },
          },
        ]),
      }),
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{ readonly stream: AsyncIterable<unknown> }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })(),
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{ readonly stream: AsyncIterable<unknown> }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {},
                })
              : original.doStream(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello",
    })) as { readonly textStream: AsyncIterable<unknown> };

    expect(tracing.rootSpans[0]?.ended).toBe(false);

    const chunks = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.operation.id": "streamText",
      "ai.output.has_text": true,
      "ai.response.finish_reason": "stop",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.model": "stream-model",
      "gen_ai.request.stream": true,
      "gen_ai.response.finish_reasons": '["stop"]',
      "gen_ai.usage.cache_read.input_tokens": 1,
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "ai.usage.total_tokens": 12,
      "gen_ai.usage.reasoning.output_tokens": 2,
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.attributes).toMatchObject({
      "ai.operation.id": "doStream",
      "ai.output.has_text": true,
      "ai.response.finish_reason": "stop",
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.stream": true,
      "gen_ai.response.finish_reasons": '["stop"]',
    });
    expect(modelCall?.ended).toBe(true);
  });

  it("marks operation and model-call spans failed when the stream yields an in-band error chunk", async () => {
    const tracing = new RecordingTracer();
    const cause = new Error("model failed mid-stream");
    const model = {
      modelId: "stream-model",
      provider: "test-provider",
      doGenerate: async () => ({ text: "unused" }),
      doStream: async () => ({
        stream: streamFrom([
          { type: "text-delta", delta: "Hello" },
          { type: "error", error: cause },
        ]),
      }),
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{ readonly stream: AsyncIterable<unknown> }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })(),
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{ readonly stream: AsyncIterable<unknown> }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {},
                })
              : original.doStream(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello",
    })) as { readonly textStream: AsyncIterable<unknown> };

    for await (const _chunk of result.textStream) {
      // consume stream; the error arrives as a chunk, not a throw/rejection.
    }

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "error": true,
      "error.type": "Error",
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.attributes).toMatchObject({
      "error": true,
      "error.type": "Error",
    });
    expect(modelCall?.ended).toBe(true);
  });

  it("closes streamText spans when an async iterable consumer stops early", async () => {
    const tracing = new RecordingTracer();
    const model = {
      modelId: "stream-model",
      provider: "test-provider",
      doGenerate: async () => ({ text: "unused" }),
      doStream: async () => ({
        stream: streamFrom([
          { type: "text-delta", delta: "Hello" },
          { type: "text-delta", delta: " world" },
          {
            type: "finish",
            usage: {
              inputTokens: 8,
              outputTokens: 4,
              totalTokens: 12,
            },
          },
        ]),
      }),
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{ readonly stream: AsyncIterable<unknown> }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })(),
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{ readonly stream: AsyncIterable<unknown> }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {},
                })
              : original.doStream(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello",
    })) as { readonly textStream: AsyncIterable<unknown> };

    let chunkCount = 0;
    for await (const _chunk of result.textStream) {
      chunkCount += 1;
      break;
    }

    expect(chunkCount).toBe(1);
    expect(tracing.rootSpans[0]?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("ai.output.has_text");
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("ai.usage.total_tokens");

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.ended).toBe(true);
    expect(modelCall?.attributes).not.toHaveProperty("ai.output.has_text");
    expect(modelCall?.attributes).not.toHaveProperty("ai.usage.total_tokens");
  });

  it("preserves stream result methods such as toUIMessageStreamResponse", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: () => {
        const result = Object.create({
          toUIMessageStreamResponse() {
            return new Response("ok");
          },
        }) as {
          fullStream: AsyncIterable<unknown>;
          toUIMessageStreamResponse(): Response;
        };
        result.fullStream = streamFrom([{ type: "text-delta", delta: "Hello" }]);
        return result;
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({ prompt: "hello" }) as {
      readonly fullStream: AsyncIterable<unknown>;
      toUIMessageStreamResponse(): Response;
    };

    expect(result.toUIMessageStreamResponse()).toBeInstanceOf(Response);

    for await (const _chunk of result.fullStream) {
      // consume stream
    }

    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("cancels readable streams through the active reader and closes the span", async () => {
    const tracing = new RecordingTracer();
    let cancelledReason: unknown;
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: () => ({
        fullStream: readableStreamWaitingForCancel(
          { type: "text-delta", delta: "Hello" },
          (reason) => {
            cancelledReason = reason;
          },
        ),
      }),
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({ prompt: "hello" }) as {
      readonly fullStream: ReadableStream<unknown>;
    };
    const reader = result.fullStream.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", delta: "Hello" },
    });
    await expect(reader.cancel("client closed")).resolves.toBeUndefined();

    expect(cancelledReason).toBe("client closed");
    expect(tracing.rootSpans[0]?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty("ai.output.has_text");
  });

  it("preserves fullStream as a ReadableStream for AI SDK response helpers", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: () => {
        const result = {
          fullStream: readableStreamFrom([
            { type: "text-delta", delta: "Hello" },
            {
              type: "finish",
              usage: {
                inputTokens: 3,
                outputTokens: 2,
                totalTokens: 5,
              },
            },
          ]),
          toUIMessageStreamResponse() {
            return this.fullStream.pipeThrough(new TransformStream());
          },
        };
        return result;
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({ prompt: "hello" }) as {
      readonly fullStream: ReadableStream<unknown>;
      toUIMessageStreamResponse(): ReadableStream<unknown>;
    };

    const responseStream = result.toUIMessageStreamResponse();
    expect(responseStream).toBeInstanceOf(ReadableStream);

    await readAll(responseStream);

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.output.has_text": true,
      "ai.usage.total_tokens": 5,
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("wraps tool execution as child spans without mutating the original tools", async () => {
    const tracing = new RecordingTracer();
    const multiplyTool = {
      execute: async ({ a, b }: { readonly a: number; readonly b: number }) => a * b,
    };
    const originalExecute = multiplyTool.execute;
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const tools = params.tools as {
          readonly multiply: typeof multiplyTool;
        };
        const toolResult = await tools.multiply.execute({ a: 6, b: 7 });
        return {
          finishReason: "stop",
          text: `result: ${toolResult}`,
          toolCalls: [{ toolName: "multiply" }],
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    await wrapped.generateText({
      prompt: "multiply",
      tools: { multiply: multiplyTool },
    });

    expect(multiplyTool.execute).toBe(originalExecute);
    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.name).toBe("gen_ai.execute_tool");
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function",
    });
    expect(toolSpan?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.tool.count": 1,
    });
  });

  it("wraps streamText tool execution without mutating the original tools", async () => {
    const tracing = new RecordingTracer();
    const multiplyTool = {
      execute: async ({ a, b }: { readonly a: number; readonly b: number }) => a * b,
    };
    const originalExecute = multiplyTool.execute;
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const tools = params.tools as {
          readonly multiply: typeof multiplyTool;
        };
        const toolResult = tools.multiply.execute({ a: 6, b: 7 });

        return {
          textStream: (async function* () {
            yield { type: "text-delta", delta: `result: ${await toolResult}` };
          })(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({
      prompt: "multiply",
      tools: { multiply: multiplyTool },
    }) as { readonly textStream: AsyncIterable<unknown> };

    for await (const _chunk of result.textStream) {
      // consume stream
    }

    expect(multiplyTool.execute).toBe(originalExecute);
    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.name).toBe("gen_ai.execute_tool");
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function",
    });
    expect(toolSpan?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.operation.id": "streamText",
      "gen_ai.request.stream": true,
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("wraps optional generateObject calls", async () => {
    const tracing = new RecordingTracer();
    const model = {
      doGenerate: async () => ({ object: { answer: "Paris" } }),
      modelId: "object-model",
      provider: "test-provider",
    };
    const ai: AISDKV6Namespace = {
      generateObject: async (params) => {
        const wrappedModel = params.model as TestModel;
        return wrappedModel.doGenerate();
      },
      generateText: async () => ({ text: "unused" }),
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel;
        return {
          ...original,
          doGenerate: async () =>
            middleware.wrapGenerate
              ? middleware.wrapGenerate({
                  doGenerate: () => original.doGenerate(),
                  params: {},
                })
              : original.doGenerate(),
        };
      },
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = await wrapped.generateObject?.({ model });

    expect(result).toMatchObject({ object: { answer: "Paris" } });
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.operation.id": "generateObject",
      "ai.output.has_object": true,
      "gen_ai.output.type": "json",
      "gen_ai.request.stream": false,
    });
    expect(tracing.rootSpans[0]?.children[0]?.attributes).toMatchObject({
      "ai.operation.id": "doGenerate",
      "gen_ai.output.type": "json",
      "gen_ai.request.stream": false,
    });
  });

  it("wraps optional streamObject calls", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamObject: () => ({
        partialObjectStream: streamFrom([{ answer: "Paris" }]),
      }),
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamObject?.({ prompt: "object please" }) as {
      readonly partialObjectStream: AsyncIterable<unknown>;
    };

    expect(tracing.rootSpans[0]?.ended).toBe(false);

    const chunks = [];
    for await (const chunk of result.partialObjectStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ answer: "Paris" }]);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.operation.id": "streamObject",
      "gen_ai.output.type": "json",
      "gen_ai.request.stream": true,
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("omits context by default and emits only allowlisted scalar context attributes", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "ok" }),
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      experimental_context: {
        requestId: "req-1",
      },
      toolsContext: {
        weather: {
          defaultUnit: "fahrenheit",
        },
      },
    });

    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty(
      "ai.runtime_context.requestId",
    );
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty(
      "ai.tool_context.weather.defaultUnit",
    );

    const configuredTracing = new RecordingTracer();
    await createAISDKV6Wrapper(ai, {
      options: {
        includeRuntimeContext: ["requestId", "privateObject"],
        includeToolsContext: {
          weather: ["defaultUnit", "token"],
        },
      },
      tracer: configuredTracing,
    }).generateText({
      experimental_context: {
        privateObject: { secret: true },
        requestId: "req-1",
      },
      toolsContext: {
        weather: {
          defaultUnit: "fahrenheit",
          token: { secret: true },
        },
      },
    });

    expect(configuredTracing.rootSpans[0]?.attributes).toMatchObject({
      "ai.runtime_context.requestId": "req-1",
      "ai.tool_context.weather.defaultUnit": "fahrenheit",
    });
    expect(configuredTracing.rootSpans[0]?.attributes).not.toHaveProperty(
      "ai.runtime_context.privateObject",
    );
    expect(configuredTracing.rootSpans[0]?.attributes).not.toHaveProperty(
      "ai.tool_context.weather.token",
    );
  });
});

async function* streamFrom(chunks: readonly unknown[]): AsyncIterable<unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function readableStreamFrom(chunks: readonly unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function readableStreamWaitingForCancel(
  chunk: unknown,
  onCancel: (reason: unknown) => void,
): ReadableStream<unknown> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        return;
      }

      sent = true;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      onCancel(reason);
    },
  });
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) {
      return chunks;
    }
    chunks.push(result.value);
  }
}
