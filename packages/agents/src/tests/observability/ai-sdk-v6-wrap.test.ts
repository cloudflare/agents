import { describe, expect, it } from "vitest";
import { RecordingTracer } from "./recording-tracer";
import {
  createAISDKV6Wrapper,
  type AISDKV6Namespace
} from "../../observability/ai/v6/wrap";

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
          totalTokens: 6
        }
      })
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
                  params: {}
                })
              : original.doGenerate()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = await wrapped.generateText({
      experimental_telemetry: {
        functionId: "fixture-agent",
        metadata: {
          conversationId: "conversation-1"
        }
      },
      maxOutputTokens: 20,
      model,
      prompt: "Say hello",
      temperature: 0.2
    });

    expect(result).toMatchObject({ text: "Hello" });
    expect(tracing.rootSpans).toHaveLength(1);
    expect(tracing.rootSpans[0]?.name).toBe("invoke_agent fixture-agent");
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.integration.name": "ai-sdk",
      "cloudflare.agents.operation.id": "generateText",
      "cloudflare.agents.output.has_text": true,
      "cloudflare.agents.response.finish_reason": "stop",
      "cloudflare.agents.usage.total_tokens": 6,
      "gen_ai.agent.name": "fixture-agent",
      "gen_ai.conversation.id": "conversation-1",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.max_tokens": 20,
      "gen_ai.request.model": "test-model",
      "gen_ai.request.temperature": 0.2,
      "gen_ai.response.finish_reasons": '["stop"]',
      "gen_ai.response.id": "response-1",
      "gen_ai.response.model": "served-model",
      "gen_ai.usage.input_tokens": 4,
      "gen_ai.usage.output_tokens": 2
    });
    // gen_ai.request.stream is only emitted on streaming operations.
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.name).toBe("chat test-model");
    expect(modelCall?.attributes).toMatchObject({
      "cloudflare.agents.operation.id": "doGenerate",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.model": "test-model"
    });
    expect(modelCall?.attributes).not.toHaveProperty(["gen_ai.request.stream"]);
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
      }
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
                  params: {}
                })
              : original.doGenerate()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });

    await expect(
      wrapped.generateText({ model, prompt: "Say hello" })
    ).rejects.toThrow(cause);

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "error.type": "Error",
      "otel.status_code": "ERROR"
    });
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "error.message"
    ]);
    expect(tracing.rootSpans[0]?.children[0]?.attributes).toMatchObject({
      "error.type": "Error",
      "otel.status_code": "ERROR"
    });
    expect(tracing.rootSpans[0]?.children[0]?.attributes).not.toHaveProperty([
      "error.message"
    ]);
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
              totalTokens: 12
            }
          }
        ])
      })
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })()
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {}
                })
              : original.doStream()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello"
    })) as { readonly textStream: AsyncIterable<unknown> };

    expect(tracing.rootSpans[0]?.ended).toBe(false);

    const chunks = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    // No agent name is configured, so the root span name falls back to the
    // bare operation.
    expect(tracing.rootSpans[0]?.name).toBe("invoke_agent");
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.operation.id": "streamText",
      "cloudflare.agents.output.has_text": true,
      "cloudflare.agents.response.finish_reason": "stop",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.model": "stream-model",
      "gen_ai.request.stream": true,
      "gen_ai.response.finish_reasons": '["stop"]',
      "gen_ai.usage.cache_read.input_tokens": 1,
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "cloudflare.agents.usage.total_tokens": 12,
      "gen_ai.usage.reasoning.output_tokens": 2
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.name).toBe("chat stream-model");
    expect(modelCall?.attributes).toMatchObject({
      "cloudflare.agents.operation.id": "doStream",
      "cloudflare.agents.output.has_text": true,
      "cloudflare.agents.response.finish_reason": "stop",
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.stream": true,
      "gen_ai.response.finish_reasons": '["stop"]'
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
          { type: "error", error: cause }
        ])
      })
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })()
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {}
                })
              : original.doStream()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello"
    })) as { readonly textStream: AsyncIterable<unknown> };

    for await (const _chunk of result.textStream) {
      // consume stream; the error arrives as a chunk, not a throw/rejection.
    }

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "error.type": "Error",
      "otel.status_code": "ERROR"
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.attributes).toMatchObject({
      "error.type": "Error",
      "otel.status_code": "ERROR"
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
              totalTokens: 12
            }
          }
        ])
      })
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })()
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {}
                })
              : original.doStream()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello"
    })) as { readonly textStream: AsyncIterable<unknown> };

    let chunkCount = 0;
    for await (const _chunk of result.textStream) {
      chunkCount += 1;
      break;
    }

    expect(chunkCount).toBe(1);
    expect(tracing.rootSpans[0]?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.output.has_text"
    ]);
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.usage.total_tokens"
    ]);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.ended).toBe(true);
    expect(modelCall?.attributes).not.toHaveProperty([
      "cloudflare.agents.output.has_text"
    ]);
    expect(modelCall?.attributes).not.toHaveProperty([
      "cloudflare.agents.usage.total_tokens"
    ]);
  });

  it("preserves stream result methods such as toUIMessageStreamResponse", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: () => {
        const result = Object.create({
          toUIMessageStreamResponse() {
            return new Response("ok");
          }
        }) as {
          fullStream: AsyncIterable<unknown>;
          toUIMessageStreamResponse(): Response;
        };
        result.fullStream = streamFrom([
          { type: "text-delta", delta: "Hello" }
        ]);
        return result;
      }
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
          }
        )
      })
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({ prompt: "hello" }) as {
      readonly fullStream: ReadableStream<unknown>;
    };
    const reader = result.fullStream.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", delta: "Hello" }
    });
    await expect(reader.cancel("client closed")).resolves.toBeUndefined();

    expect(cancelledReason).toBe("client closed");
    expect(tracing.rootSpans[0]?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.output.has_text"
    ]);
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
                totalTokens: 5
              }
            }
          ]),
          toUIMessageStreamResponse() {
            return this.fullStream.pipeThrough(new TransformStream());
          }
        };
        return result;
      }
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
      "cloudflare.agents.output.has_text": true,
      "cloudflare.agents.usage.total_tokens": 5,
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("wraps tool execution as child spans without mutating the original tools", async () => {
    const tracing = new RecordingTracer();
    const multiplyTool = {
      execute: async ({ a, b }: { readonly a: number; readonly b: number }) =>
        a * b
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
          toolCalls: [{ toolName: "multiply" }]
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    await wrapped.generateText({
      prompt: "multiply",
      tools: { multiply: multiplyTool }
    });

    expect(multiplyTool.execute).toBe(originalExecute);
    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.name).toBe("execute_tool multiply");
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function"
    });
    expect(toolSpan?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.tool.count": 1
    });
  });

  it("wraps streamText tool execution without mutating the original tools", async () => {
    const tracing = new RecordingTracer();
    const multiplyTool = {
      execute: async ({ a, b }: { readonly a: number; readonly b: number }) =>
        a * b
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
          })()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({
      prompt: "multiply",
      tools: { multiply: multiplyTool }
    }) as { readonly textStream: AsyncIterable<unknown> };

    for await (const _chunk of result.textStream) {
      // consume stream
    }

    expect(multiplyTool.execute).toBe(originalExecute);
    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function"
    });
    expect(toolSpan?.ended).toBe(true);
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.operation.id": "streamText",
      "gen_ai.request.stream": true
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("wraps optional generateObject calls", async () => {
    const tracing = new RecordingTracer();
    const model = {
      doGenerate: async () => ({ object: { answer: "Paris" } }),
      modelId: "object-model",
      provider: "test-provider"
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
                  params: {}
                })
              : original.doGenerate()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = await wrapped.generateObject?.({ model });

    expect(result).toMatchObject({ object: { answer: "Paris" } });
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.operation.id": "generateObject",
      "cloudflare.agents.output.has_object": true,
      "gen_ai.output.type": "json"
    });
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
    expect(tracing.rootSpans[0]?.children[0]?.attributes).toMatchObject({
      "cloudflare.agents.operation.id": "doGenerate",
      "gen_ai.output.type": "json"
    });
    expect(tracing.rootSpans[0]?.children[0]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
  });

  it("wraps optional streamObject calls", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamObject: () => ({
        partialObjectStream: streamFrom([{ answer: "Paris" }])
      })
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
      "cloudflare.agents.operation.id": "streamObject",
      "gen_ai.output.type": "json",
      "gen_ai.request.stream": true
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("omits context by default and emits only allowlisted scalar context attributes", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "ok" })
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      experimental_context: {
        requestId: "req-1"
      },
      toolsContext: {
        weather: {
          defaultUnit: "fahrenheit"
        }
      }
    });

    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.requestId"
    ]);
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.tool_context.weather.defaultUnit"
    ]);

    const configuredTracing = new RecordingTracer();
    await createAISDKV6Wrapper(ai, {
      options: {
        includeRuntimeContext: ["requestId", "privateObject"],
        includeToolsContext: {
          weather: ["defaultUnit", "token"]
        }
      },
      tracer: configuredTracing
    }).generateText({
      experimental_context: {
        privateObject: { secret: true },
        requestId: "req-1"
      },
      toolsContext: {
        weather: {
          defaultUnit: "fahrenheit",
          token: { secret: true }
        }
      }
    });

    expect(configuredTracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.runtime_context.requestId": "req-1",
      "cloudflare.agents.tool_context.weather.defaultUnit": "fahrenheit"
    });
    expect(configuredTracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.privateObject"
    ]);
    expect(configuredTracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.tool_context.weather.token"
    ]);
  });

  it("finishes stream spans as canceled when the stream yields an in-band abort chunk", async () => {
    const tracing = new RecordingTracer();
    const model = {
      modelId: "stream-model",
      provider: "test-provider",
      doGenerate: async () => ({ text: "unused" }),
      doStream: async () => ({
        stream: streamFrom([
          { type: "text-delta", delta: "Hel" },
          { type: "abort" }
        ])
      })
    };
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: (params) => {
        const wrappedModel = params.model as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        const providerResult = wrappedModel.doStream();
        return {
          textStream: (async function* () {
            const resolvedProviderResult = await providerResult;
            for await (const chunk of resolvedProviderResult.stream) {
              yield chunk;
            }
          })()
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel & {
          readonly doStream: () => Promise<{
            readonly stream: AsyncIterable<unknown>;
          }>;
        };
        return {
          ...original,
          doStream: async () =>
            middleware.wrapStream
              ? middleware.wrapStream({
                  doStream: () => original.doStream(),
                  params: {}
                })
              : original.doStream()
        };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.streamText?.({
      model,
      prompt: "Say hello"
    })) as { readonly textStream: AsyncIterable<unknown> };

    for await (const _chunk of result.textStream) {
      // The abort arrives as an in-band chunk; the stream completes normally.
    }

    const rootSpan = tracing.rootSpans[0];
    const modelCall = rootSpan?.children[0];
    for (const span of [rootSpan, modelCall]) {
      expect(span?.attributes).toMatchObject({
        "cloudflare.agents.canceled": true
      });
      expect(span?.attributes).not.toHaveProperty(["otel.status_code"]);
      expect(span?.attributes).not.toHaveProperty(["error.type"]);
      expect(span?.ended).toBe(true);
    }
  });

  it("keeps a streaming tool's span open until its iterable is fully consumed", async () => {
    const tracing = new RecordingTracer();
    const countTool = {
      async *execute(_input: object) {
        yield "chunk-1";
        yield "chunk-2";
      }
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const tools = params.tools as { readonly count: typeof countTool };
        return { output: tools.count.execute({}), text: "ok" };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = (await wrapped.generateText({
      prompt: "count",
      tools: { count: countTool }
    })) as { readonly output: AsyncIterable<unknown> };

    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "count"
    });
    expect(toolSpan?.ended).toBe(false);

    const chunks = [];
    for await (const chunk of result.output) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["chunk-1", "chunk-2"]);
    expect(toolSpan?.ended).toBe(true);
  });

  it("records gen_ai.tool.call.id when the SDK passes a toolCallId to execute", async () => {
    const tracing = new RecordingTracer();
    const multiplyTool = {
      execute: async (
        { a, b }: { readonly a: number; readonly b: number },
        _options?: { readonly toolCallId?: string }
      ) => a * b
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const tools = params.tools as {
          readonly multiply: typeof multiplyTool;
        };
        const product = await tools.multiply.execute(
          { a: 6, b: 7 },
          { toolCallId: "call-123" }
        );
        return { text: `result: ${product}` };
      }
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    await wrapped.generateText({
      prompt: "multiply",
      tools: { multiply: multiplyTool }
    });

    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": "call-123",
      "gen_ai.tool.name": "multiply"
    });
    expect(toolSpan?.ended).toBe(true);
  });

  it("records a numeric time to first chunk on streamed operations", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "unused" }),
      streamText: () => ({
        textStream: streamFrom([
          { type: "text-delta", delta: "Hello" },
          { type: "finish", finishReason: "stop" }
        ])
      })
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });
    const result = wrapped.streamText?.({ prompt: "hello" }) as {
      readonly textStream: AsyncIterable<unknown>;
    };

    for await (const _chunk of result.textStream) {
      // consume stream
    }

    const timeToFirstChunk =
      tracing.rootSpans[0]?.attributes["gen_ai.response.time_to_first_chunk"];
    expect(typeof timeToFirstChunk).toBe("number");
    expect(timeToFirstChunk).toBeGreaterThanOrEqual(0);
    expect(tracing.rootSpans[0]?.ended).toBe(true);
  });

  it("falls back to the bare invoke_agent name for agent names over 64 bytes", async () => {
    const tracing = new RecordingTracer();
    const agentName = "a".repeat(65);
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "ok" })
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      experimental_telemetry: { metadata: { agentName } },
      prompt: "hello"
    });

    expect(tracing.rootSpans[0]?.name).toBe("invoke_agent");
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "gen_ai.agent.name": agentName,
      "gen_ai.operation.name": "invoke_agent"
    });
  });
});

async function* streamFrom(chunks: readonly unknown[]): AsyncIterable<unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function readableStreamFrom(
  chunks: readonly unknown[]
): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}

function readableStreamWaitingForCancel(
  chunk: unknown,
  onCancel: (reason: unknown) => void
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
    }
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
