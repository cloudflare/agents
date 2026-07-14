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
      "cloudflare.agents.operation.name": "generateText",
      "cloudflare.agents.response.finish_reason": "stop",
      "cloudflare.agents.usage.total_tokens": 6,
      "gen_ai.agent.name": "fixture-agent",
      "gen_ai.conversation.id": "conversation-1",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.max_tokens": 20,
      "gen_ai.request.model": "test-model",
      "gen_ai.request.temperature": 0.2,
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
    // The chat span nests under the operation root.
    expect(modelCall?.parent).toBe(tracing.rootSpans[0]);
    expect(modelCall?.attributes).toMatchObject({
      "cloudflare.agents.operation.name": "doGenerate",
      "cloudflare.agents.usage.total_tokens": 6,
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.model": "test-model",
      "gen_ai.response.id": "response-1",
      "gen_ai.response.model": "served-model"
    });
    expect(modelCall?.attributes).not.toHaveProperty(["gen_ai.request.stream"]);
    expect(modelCall?.ended).toBe(true);
  });

  it.each([
    ["azure", "azure.ai.inference"],
    ["azure-openai.chat", "azure.ai.openai"],
    ["google-vertex.chat", "gcp.vertex_ai"],
    ["google.generative-ai", "gcp.gemini"],
    ["bedrock.converse", "aws.bedrock"],
    ["custom-provider", "custom-provider"]
  ])("maps provider %s to %s", async (provider, expected) => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "ok" })
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      model: { modelId: "model", provider },
      prompt: "hello"
    });

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "gen_ai.provider.name": expected
    });
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
      "error.type": "Error"
    });
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "error.message"
    ]);
    expect(tracing.rootSpans[0]?.children[0]?.attributes).toMatchObject({
      "error.type": "Error"
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
      "cloudflare.agents.operation.name": "streamText",
      "cloudflare.agents.response.finish_reason": "stop",
      "cloudflare.agents.usage.total_tokens": 12,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "test-provider",
      "gen_ai.request.model": "stream-model",
      "gen_ai.request.stream": true,
      "gen_ai.usage.cache_read.input_tokens": 1,
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "gen_ai.usage.reasoning.output_tokens": 2
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.name).toBe("chat stream-model");
    // The chat span nests under the operation root even though doStream runs
    // inside the caller-owned activation callback.
    expect(modelCall?.parent).toBe(tracing.rootSpans[0]);
    expect(modelCall?.attributes).toMatchObject({
      "cloudflare.agents.operation.name": "doStream",
      "cloudflare.agents.response.finish_reason": "stop",
      "cloudflare.agents.usage.total_tokens": 12,
      "gen_ai.usage.input_tokens": 8,
      "gen_ai.usage.output_tokens": 4,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.stream": true
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
      "error.type": "Error"
    });
    expect(tracing.rootSpans[0]?.ended).toBe(true);

    const modelCall = tracing.rootSpans[0]?.children[0];
    expect(modelCall?.attributes).toMatchObject({
      "error.type": "Error"
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
      "cloudflare.agents.operation.name": "streamText",
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
      "cloudflare.agents.operation.name": "generateObject",
      "gen_ai.output.type": "json"
    });
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
    expect(tracing.rootSpans[0]?.children[0]?.attributes).toMatchObject({
      "cloudflare.agents.operation.name": "doGenerate",
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
      "cloudflare.agents.operation.name": "streamObject",
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
      }
    });

    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.requestId"
    ]);

    const configuredTracing = new RecordingTracer();
    await createAISDKV6Wrapper(ai, {
      options: {
        includeRuntimeContext: ["requestId", "privateObject"]
      },
      tracer: configuredTracing
    }).generateText({
      experimental_context: {
        privateObject: { secret: true },
        requestId: "req-1"
      }
    });

    expect(configuredTracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.runtime_context.requestId": "req-1"
    });
    expect(configuredTracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.privateObject"
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

  it("runs streaming tool generator bodies under the tool span's context", async () => {
    const tracing = new RecordingTracer();
    const tools = {
      count: {
        async *execute(_input: object) {
          yield "chunk-1";
          // Opened between yields: the generator resumes at the CONSUMER's
          // next() call site, so without context re-entry this span would
          // become a root span instead of a child of the tool span.
          await tracing.withSpan("inner", {}, () => undefined);
          yield "chunk-2";
        }
      }
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const wrappedToolset = params.tools as typeof tools;
        return { output: wrappedToolset.count.execute({}), text: "ok" };
      }
    };

    const result = (await createAISDKV6Wrapper(ai, {
      tracer: tracing
    }).generateText({
      prompt: "count",
      tools
    })) as { readonly output: AsyncIterable<unknown> };

    const chunks = [];
    for await (const chunk of result.output) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["chunk-1", "chunk-2"]);
    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    const innerSpan = tracing.spans.find((span) => span.name === "inner");
    expect(innerSpan).toBeDefined();
    expect(innerSpan?.parent).toBe(toolSpan);
    expect(tracing.rootSpans).not.toContain(innerSpan);
    expect(innerSpan?.ended).toBe(true);
  });

  it("runs the tool generator's own cleanup when the consumer stops early", async () => {
    const tracing = new RecordingTracer();
    let cleanedUp = false;
    const tools = {
      count: {
        async *execute(_input: object) {
          try {
            yield "chunk-1";
            yield "chunk-2";
            yield "chunk-3";
          } finally {
            // Cleanup opens a span so the test can also assert it parents
            // under the execute_tool span (return() runs in span context).
            await tracing.withSpan("cleanup", {}, () => undefined);
            cleanedUp = true;
          }
        }
      }
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const wrappedToolset = params.tools as typeof tools;
        return { output: wrappedToolset.count.execute({}), text: "ok" };
      }
    };

    const result = (await createAISDKV6Wrapper(ai, {
      tracer: tracing
    }).generateText({
      prompt: "count",
      tools
    })) as { readonly output: AsyncIterable<unknown> };

    for await (const _chunk of result.output) {
      // Early consumer termination must still run the tool's finally block.
      break;
    }

    // return() forwarding is asynchronous; give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleanedUp).toBe(true);
    const toolSpan = tracing.rootSpans[0]?.children[0];
    expect(toolSpan?.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(toolSpan?.ended).toBe(true);
    expect(toolSpan?.attributes).not.toHaveProperty(["otel.status_code"]);
    expect(toolSpan?.attributes).not.toHaveProperty(["error.type"]);
    expect(toolSpan?.attributes).not.toHaveProperty([
      "cloudflare.agents.canceled"
    ]);
    const cleanupSpan = tracing.spans.find((span) => span.name === "cleanup");
    expect(cleanupSpan).toBeDefined();
    expect(cleanupSpan?.parent).toBe(toolSpan);
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

  it("falls back to the bare operation when the span name exceeds 64 bytes", async () => {
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

  it("lets explicit metadata agentName override functionId", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "ok" })
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      experimental_telemetry: {
        functionId: "function-agent",
        metadata: { agentName: "explicit-agent" }
      },
      prompt: "hello"
    });

    expect(tracing.rootSpans[0]?.name).toBe("invoke_agent explicit-agent");
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "gen_ai.agent.name": "explicit-agent"
    });
  });

  describe("telemetry metadata passthrough", () => {
    it("maps reserved turn keys to dedicated turn attributes", async () => {
      const tracing = new RecordingTracer();
      const ai: AISDKV6Namespace = {
        generateText: async () => ({ text: "ok" })
      };

      await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
        experimental_telemetry: {
          metadata: {
            "cloudflare.agents.turn.admission": "queue",
            "cloudflare.agents.turn.channel": "web",
            "cloudflare.agents.turn.continuation": true,
            "cloudflare.agents.turn.generation": 2,
            "cloudflare.agents.turn.request_id": "req-1",
            "cloudflare.agents.turn.trigger": "ws-chat"
          }
        },
        prompt: "hello"
      });

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "cloudflare.agents.turn.admission": "queue",
        "cloudflare.agents.turn.channel": "web",
        "cloudflare.agents.turn.continuation": true,
        "cloudflare.agents.turn.generation": 2,
        "cloudflare.agents.turn.request_id": "req-1",
        "cloudflare.agents.turn.trigger": "ws-chat"
      });
      // Reserved keys do not also pass through under the metadata prefix.
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.cloudflare.agents.turn.request_id"
      ]);
    });

    it("preserves an explicit user.id semantic attribute", async () => {
      const tracing = new RecordingTracer();
      const ai: AISDKV6Namespace = {
        generateText: async () => ({ text: "ok" })
      };

      await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
        experimental_telemetry: {
          metadata: { "user.id": "user-7" }
        },
        prompt: "hello"
      });

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "user.id": "user-7"
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.user.id"
      ]);
    });

    it("passes arbitrary scalar keys through under cloudflare.agents.metadata", async () => {
      const tracing = new RecordingTracer();
      const ai: AISDKV6Namespace = {
        generateText: async () => ({ text: "ok" })
      };

      await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
        experimental_telemetry: {
          metadata: {
            beta: true,
            priority: 3,
            requestId: "customer-request",
            toString: "safe-own-key",
            workspaceId: "ws-9"
          }
        },
        prompt: "hello"
      });

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "cloudflare.agents.metadata.beta": true,
        "cloudflare.agents.metadata.priority": 3,
        "cloudflare.agents.metadata.requestId": "customer-request",
        "cloudflare.agents.metadata.toString": "safe-own-key",
        "cloudflare.agents.metadata.workspaceId": "ws-9"
      });
    });

    it("drops object and array metadata values", async () => {
      const tracing = new RecordingTracer();
      const ai: AISDKV6Namespace = {
        generateText: async () => ({ text: "ok" })
      };

      await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
        experimental_telemetry: {
          metadata: { list: [1, 2], nested: { a: 1 } }
        },
        prompt: "hello"
      });

      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.nested"
      ]);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.list"
      ]);
    });

    it("consumes identity keys into semantic context without passthrough", async () => {
      const tracing = new RecordingTracer();
      const ai: AISDKV6Namespace = {
        generateText: async () => ({ text: "ok" })
      };

      await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
        experimental_telemetry: {
          metadata: { agentId: "a", agentName: "n", conversationId: "c" }
        },
        prompt: "hello"
      });

      expect(tracing.rootSpans[0]?.attributes).toMatchObject({
        "gen_ai.agent.id": "a",
        "gen_ai.agent.name": "n",
        "gen_ai.conversation.id": "c"
      });
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.agentId"
      ]);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.agentName"
      ]);
      expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
        "cloudflare.agents.metadata.conversationId"
      ]);
    });
  });

  it("returns identical wrapper functions on repeated property reads", () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({ text: "ok" }),
      streamText: () => ({ textStream: streamFrom([]) })
    };

    const wrapped = createAISDKV6Wrapper(ai, { tracer: tracing });

    expect(wrapped.generateText).toBe(wrapped.generateText);
    expect(wrapped.streamText).toBe(wrapped.streamText);
  });

  it("reads public-result usage details and response.modelId", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({
        finishReason: "stop",
        response: { id: "resp-9", modelId: "served-9" },
        text: "Hi",
        usage: {
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 2 },
          inputTokens: 10,
          outputTokenDetails: { reasoningTokens: 4 },
          outputTokens: 6,
          totalTokens: 16
        }
      })
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      prompt: "hello"
    });

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "cloudflare.agents.usage.total_tokens": 16,
      "gen_ai.response.id": "resp-9",
      "gen_ai.response.model": "served-9",
      "gen_ai.usage.cache_creation.input_tokens": 2,
      "gen_ai.usage.cache_read.input_tokens": 3,
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 6,
      "gen_ai.usage.reasoning.output_tokens": 4
    });
  });

  it("reads deprecated flat cachedInputTokens and reasoningTokens usage fields", async () => {
    const tracing = new RecordingTracer();
    const ai: AISDKV6Namespace = {
      generateText: async () => ({
        text: "Hi",
        usage: {
          cachedInputTokens: 5,
          inputTokens: 9,
          outputTokens: 3,
          reasoningTokens: 1,
          totalTokens: 12
        }
      })
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      prompt: "hello"
    });

    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "gen_ai.usage.cache_read.input_tokens": 5,
      "gen_ai.usage.input_tokens": 9,
      "gen_ai.usage.output_tokens": 3,
      "gen_ai.usage.reasoning.output_tokens": 1
    });
  });

  it("records string model ids on the root span", async () => {
    const tracing = new RecordingTracer();
    let receivedModel: unknown;
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        receivedModel = params.model;
        return { text: "ok" };
      },
      wrapLanguageModel({ model: rawModel }) {
        return rawModel;
      }
    };

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      model: "gateway/model-9",
      prompt: "hello"
    });

    expect(receivedModel).toBe("gateway/model-9");
    expect(tracing.rootSpans[0]?.attributes).toMatchObject({
      "gen_ai.request.model": "gateway/model-9"
    });
  });

  describe("untraced fast path", () => {
    it("never invokes wrapLanguageModel when the runtime is not tracing", async () => {
      const tracing = new RecordingTracer({ isTraced: false });
      let wrapLanguageModelCalls = 0;
      const model = {
        modelId: "test-model",
        provider: "test-provider",
        doGenerate: async () => ({ text: "ok" })
      };
      const ai: AISDKV6Namespace = {
        generateText: async (params) => {
          const currentModel = params.model as TestModel;
          return currentModel.doGenerate();
        },
        wrapLanguageModel({ model: rawModel }) {
          wrapLanguageModelCalls += 1;
          return rawModel;
        }
      };

      const result = await createAISDKV6Wrapper(ai, {
        tracer: tracing
      }).generateText({ model, prompt: "hello" });

      expect(result).toMatchObject({ text: "ok" });
      expect(wrapLanguageModelCalls).toBe(0);
    });

    it("passes the original tools through untouched when not tracing", async () => {
      const tracing = new RecordingTracer({ isTraced: false });
      const multiplyTool = {
        execute: async ({ a, b }: { readonly a: number; readonly b: number }) =>
          a * b
      };
      const originalExecute = multiplyTool.execute;
      let receivedTools: unknown;
      const ai: AISDKV6Namespace = {
        generateText: async (params) => {
          receivedTools = params.tools;
          return { text: "ok" };
        }
      };

      const tools = { multiply: multiplyTool };
      await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
        prompt: "multiply",
        tools
      });

      expect(receivedTools).toBe(tools);
      const received = receivedTools as
        | { readonly multiply: typeof multiplyTool }
        | undefined;
      expect(received?.multiply).toBe(multiplyTool);
      expect(received?.multiply.execute).toBe(originalExecute);
    });

    it("returns the exact original stream result when not tracing", async () => {
      const tracing = new RecordingTracer({ isTraced: false });
      const originalStream = streamFrom([{ type: "text-delta", delta: "Hi" }]);
      const originalResult = { textStream: originalStream };
      const ai: AISDKV6Namespace = {
        generateText: async () => ({ text: "unused" }),
        streamText: () => originalResult
      };

      const result = createAISDKV6Wrapper(ai, { tracer: tracing }).streamText?.(
        { prompt: "hello" }
      );

      expect(result).toBe(originalResult);
      // The stream field is left untouched — no patching on the fast path.
      expect(originalResult.textStream).toBe(originalStream);
      // The span closes immediately instead of waiting on consumption.
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });

    it("never enumerates telemetry metadata when not tracing", async () => {
      const tracing = new RecordingTracer({ isTraced: false });
      const originalResult = { text: "ok" };
      const ai: AISDKV6Namespace = {
        generateText: async () => originalResult
      };
      // Direct reads (agentName for the span name) are allowed; enumeration
      // (the attribute passthrough) must not happen on the untraced path.
      const hostileMetadata = new Proxy(
        { agentName: "safe-agent" },
        {
          getOwnPropertyDescriptor() {
            throw new Error("metadata must not be enumerated when untraced");
          },
          ownKeys(): ArrayLike<string | symbol> {
            throw new Error("metadata must not be enumerated when untraced");
          }
        }
      );

      const result = await createAISDKV6Wrapper(ai, {
        tracer: tracing
      }).generateText({
        experimental_telemetry: { metadata: hostileMetadata },
        prompt: "hello"
      });

      expect(result).toBe(originalResult);
      // The span name still uses the directly read agent name.
      expect(tracing.rootSpans[0]?.name).toBe("invoke_agent safe-agent");
      expect(tracing.rootSpans[0]?.ended).toBe(true);
    });
  });
});

describe("createAISDKV6Wrapper opt-in content recording", () => {
  const CONTENT_KEYS = [
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result"
  ] as const;

  function multiplyAI(): {
    readonly ai: AISDKV6Namespace;
    readonly model: TestModel;
    readonly tool: { readonly execute: (input: unknown) => Promise<number> };
  } {
    const tool = {
      execute: async (input: unknown) => {
        const { a, b } = input as { readonly a: number; readonly b: number };
        return a * b;
      }
    };
    const model: TestModel = {
      modelId: "content-model",
      provider: "content-provider",
      doGenerate: async () => ({
        finishReason: "stop",
        text: "model answer"
      })
    };
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const wrappedModel = params.model as TestModel;
        const modelResult = (await wrappedModel.doGenerate({
          messages: params.messages,
          prompt: params.prompt
        })) as { readonly text: string };
        const tools = params.tools as { readonly multiply: typeof tool };
        const toolResult = await tools.multiply.execute({ a: 6, b: 7 });
        return {
          finishReason: "stop",
          text: `${modelResult.text}: ${toolResult}`,
          toolCalls: [{ toolName: "multiply" }]
        };
      },
      wrapLanguageModel({ model: rawModel, middleware }) {
        const original = rawModel as TestModel;
        return {
          ...original,
          doGenerate: async (params?: unknown) =>
            middleware.wrapGenerate
              ? middleware.wrapGenerate({
                  doGenerate: () => original.doGenerate(params),
                  params: params ?? {}
                })
              : original.doGenerate(params)
        };
      }
    };
    return { ai, model, tool };
  }

  it("records NO content attribute by default (the privacy default)", async () => {
    const tracing = new RecordingTracer();
    const { ai, model, tool } = multiplyAI();

    // No options, no experimental_telemetry flag: content must be absent.
    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      messages: [{ content: "secret prompt", role: "user" }],
      model,
      prompt: "secret prompt",
      tools: { multiply: tool }
    });

    for (const span of tracing.spans) {
      for (const key of CONTENT_KEYS) {
        expect(span.attributes).not.toHaveProperty([key]);
      }
    }
    const recorded = tracing.spans.flatMap((span) =>
      Object.values(span.attributes)
    );
    expect(recorded).not.toContain("secret prompt");
  });

  it("records chat and tool content when the wrapper opts in", async () => {
    const tracing = new RecordingTracer();
    const { ai, model, tool } = multiplyAI();

    await createAISDKV6Wrapper(ai, {
      options: { recordInputs: true, recordOutputs: true },
      tracer: tracing
    }).generateText({
      messages: [{ content: "hello", role: "user" }],
      model,
      tools: { multiply: tool }
    });

    const root = tracing.rootSpans[0];
    expect(root?.attributes).not.toHaveProperty(["gen_ai.input.messages"]);
    expect(root?.attributes).not.toHaveProperty(["gen_ai.output.messages"]);
    const chatSpan = root?.children.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chatSpan?.attributes["gen_ai.input.messages"]).toBe(
      JSON.stringify([{ content: "hello", role: "user" }])
    );
    expect(chatSpan?.attributes["gen_ai.output.messages"]).toBe(
      JSON.stringify({ text: "model answer" })
    );

    const toolSpan = root?.children.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.attributes["gen_ai.tool.call.arguments"]).toBe(
      JSON.stringify({ a: 6, b: 7 })
    );
    expect(toolSpan?.attributes["gen_ai.tool.call.result"]).toBe("42");
  });

  it("opts in per call through experimental_telemetry (the Think path)", async () => {
    const tracing = new RecordingTracer();
    const { ai, model, tool } = multiplyAI();

    await createAISDKV6Wrapper(ai, { tracer: tracing }).generateText({
      experimental_telemetry: { recordInputs: true, recordOutputs: true },
      model,
      prompt: "hello there",
      tools: { multiply: tool }
    });

    const root = tracing.rootSpans[0];
    expect(root?.attributes).not.toHaveProperty(["gen_ai.input.messages"]);
    expect(root?.attributes).not.toHaveProperty(["gen_ai.output.messages"]);
    const chatSpan = root?.children.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chatSpan?.attributes["gen_ai.input.messages"]).toBe(
      JSON.stringify("hello there")
    );
    expect(chatSpan?.attributes["gen_ai.output.messages"]).toBe(
      JSON.stringify({ text: "model answer" })
    );
    const toolSpan = root?.children.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.attributes["gen_ai.tool.call.result"]).toBe("42");
  });

  it("lets an explicit per-call flag override the wrapper opt-in", async () => {
    const tracing = new RecordingTracer();
    const { ai, model, tool } = multiplyAI();

    // Wrapper opts in, but the call explicitly opts OUT of inputs.
    await createAISDKV6Wrapper(ai, {
      options: { recordInputs: true, recordOutputs: true },
      tracer: tracing
    }).generateText({
      experimental_telemetry: { recordInputs: false },
      model,
      prompt: "secret prompt",
      tools: { multiply: tool }
    });

    const root = tracing.rootSpans[0];
    expect(root?.attributes).not.toHaveProperty(["gen_ai.input.messages"]);
    expect(root?.attributes).not.toHaveProperty(["gen_ai.output.messages"]);
    const chatSpan = root?.children.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chatSpan?.attributes).not.toHaveProperty(["gen_ai.input.messages"]);
    // recordOutputs still applies (not overridden).
    expect(chatSpan?.attributes["gen_ai.output.messages"]).toBe(
      JSON.stringify({ text: "model answer" })
    );
  });

  it("truncates oversized content to a bounded, marked value", async () => {
    const tracing = new RecordingTracer();
    const bigPrompt = "x".repeat(70_000);
    const { ai, model, tool } = multiplyAI();

    await createAISDKV6Wrapper(ai, {
      options: { recordInputs: true },
      tracer: tracing
    }).generateText({
      model,
      prompt: bigPrompt,
      tools: { multiply: tool }
    });

    const root = tracing.rootSpans[0];
    expect(root?.attributes).not.toHaveProperty(["gen_ai.input.messages"]);
    const chatSpan = root?.children.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    const value = chatSpan?.attributes["gen_ai.input.messages"];
    expect(typeof value).toBe("string");
    const text = value as string;
    expect(text.endsWith("…[truncated]")).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(28_672);
    expect(text.length).toBeLessThan(bigPrompt.length);
  });
});

describe("createAISDKV6Wrapper tool approval spans", () => {
  function approvalMessages(approved: boolean): Array<Record<string, unknown>> {
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "approval-call-1",
            toolName: "deploy"
          },
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "approval-call-1"
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "approval-1",
            approved
          }
        ]
      }
    ];
  }

  function approvalAI(mode: "approved" | "denied" | "requested") {
    let executions = 0;
    const tool = {
      needsApproval: (_input: unknown, _options?: unknown) => true,
      execute: async (_input: unknown, _options?: unknown) => {
        executions += 1;
        return "deployed";
      }
    };
    const messages =
      mode === "requested" ? [] : approvalMessages(mode === "approved");
    const ai: AISDKV6Namespace = {
      generateText: async (params) => {
        const wrapped = (params.tools as { deploy: typeof tool }).deploy;
        const options = {
          messages,
          toolCallId: "approval-call-1"
        };
        await wrapped.needsApproval({}, options);
        if (mode === "approved") {
          await wrapped.execute({}, options);
        }
        return { finishReason: "stop" };
      }
    };
    return { ai, executions: () => executions, messages, tool };
  }

  it.each([
    ["requested", "requested", 0],
    ["approved", "approved", 1],
    ["denied", "denied", 0]
  ] as const)(
    "records a %s approval as a child of execute_tool",
    async (mode, expectedState, expectedExecutions) => {
      const tracing = new RecordingTracer();
      const fixture = approvalAI(mode);

      await createAISDKV6Wrapper(fixture.ai, { tracer: tracing }).generateText({
        messages: fixture.messages,
        tools: { deploy: fixture.tool }
      });

      expect(fixture.executions()).toBe(expectedExecutions);
      const approval = tracing.spans.find(
        (span) => span.name === "tool_approval deploy"
      );
      expect(approval?.attributes).toMatchObject({
        "cloudflare.agents.operation.name": "tool.approval",
        "cloudflare.agents.tool.approval.state": expectedState,
        "gen_ai.tool.call.id": "approval-call-1",
        "gen_ai.tool.name": "deploy"
      });
      expect(approval?.ended).toBe(true);
      expect(approval?.parent?.attributes).toMatchObject({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.call.id": "approval-call-1",
        "gen_ai.tool.name": "deploy"
      });
      expect(approval?.parent?.ended).toBe(true);
    }
  );
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
