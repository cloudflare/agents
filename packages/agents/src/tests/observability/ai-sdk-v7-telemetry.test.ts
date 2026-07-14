import { describe, expect, it } from "vitest";
import { RecordingTracer } from "./recording-tracer";
import { createAISDKV7Telemetry } from "../../observability/ai/v7/telemetry";

describe("createAISDKV7Telemetry", () => {
  it("traces operation and model callbacks with call id correlation", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({
      callId: "call-1",
      functionId: "fixture-agent",
      maxOutputTokens: 20,
      modelId: "test-model",
      operationId: "ai.generateText",
      provider: "test-provider",
      runtimeContext: {
        conversationId: "conversation-1",
        privateObject: { secret: true },
        requestId: "req-1"
      },
      temperature: 0.2
    });
    telemetry.onLanguageModelCallStart?.({
      callId: "call-1",
      modelId: "test-model",
      provider: "test-provider"
    });
    telemetry.onLanguageModelCallEnd?.({
      callId: "call-1",
      finishReason: "stop",
      modelId: "test-model",
      performance: { timeToFirstOutputMs: 125 },
      responseId: "response-1",
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6
      }
    });
    telemetry.onEnd?.({
      callId: "call-1",
      finishReason: "stop",
      modelId: "served-model",
      operationId: "ai.generateText",
      text: "Hello",
      totalUsage: {
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6
      }
    });

    expect(tracing.spans).toHaveLength(2);
    expect(tracing.spans[0]?.name).toBe("invoke_agent fixture-agent");
    expect(tracing.spans[0]?.attributes).toMatchObject({
      "cloudflare.agents.call.id": "call-1",
      "cloudflare.agents.integration.name": "ai-sdk",
      "cloudflare.agents.operation.name": "generateText",
      "cloudflare.agents.response.finish_reason": "stop",
      "cloudflare.agents.runtime_context.requestId": "req-1",
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
    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.privateObject"
    ]);
    expect(tracing.spans[0]?.ended).toBe(true);
    expect(tracing.spans[1]?.name).toBe("chat test-model");
    expect(tracing.spans[1]?.attributes).toMatchObject({
      "cloudflare.agents.call.id": "call-1",
      "cloudflare.agents.operation.name": "doGenerate",
      "gen_ai.operation.name": "chat",
      "gen_ai.response.id": "response-1",
      "gen_ai.response.time_to_first_chunk": 0.125
    });
    expect(tracing.spans[1]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
    expect(tracing.spans[1]?.ended).toBe(true);
  });

  it("runs provider work under the v7 model-call span", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onLanguageModelCallStart?.({
      callId: "call-1",
      modelId: "test-model",
      provider: "openai"
    });

    const result = await telemetry.executeLanguageModelCall?.({
      callId: "call-1",
      execute: async () => {
        await tracing.withSpan("provider.fetch", {}, (span) => {
          span.finish();
        });
        return "ok";
      }
    });
    telemetry.onLanguageModelCallEnd?.({ callId: "call-1" });
    telemetry.onEnd?.({ callId: "call-1", operationId: "ai.generateText" });

    expect(result).toBe("ok");
    const modelSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(modelSpan?.children[0]?.name).toBe("provider.fetch");
    expect(modelSpan?.ended).toBe(true);
  });

  it("runs executeTool under the tool span and records only safe tool metadata", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({
      callId: "call-1",
      operationId: "ai.streamText"
    });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: {
        input: { secret: "do-not-record" },
        toolCallId: "tool-call-1",
        toolName: "multiply"
      },
      toolContext: {
        token: { secret: true },
        unit: "count"
      }
    });

    const result = await telemetry.executeTool?.({
      callId: "call-1",
      execute: async () => {
        await tracing.withSpan("inside.tool", {}, (span) => {
          span.finish();
        });
        return 42;
      },
      toolCallId: "tool-call-1"
    });

    telemetry.onToolExecutionEnd?.({
      callId: "call-1",
      toolCall: {
        toolCallId: "tool-call-1",
        toolName: "multiply"
      },
      toolOutput: {
        output: { secret: "do-not-record" },
        type: "tool-result"
      }
    });
    telemetry.onEnd?.({
      callId: "call-1",
      operationId: "ai.streamText"
    });

    expect(result).toBe(42);
    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.name).toBe("execute_tool multiply");
    expect(toolSpan?.attributes).toMatchObject({
      "cloudflare.agents.call.id": "call-1",
      "cloudflare.agents.operation.name": "tool.execute",
      "cloudflare.agents.tool_context.multiply.unit": "count",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": "tool-call-1",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function"
    });
    expect(toolSpan?.attributes).not.toHaveProperty([
      "cloudflare.agents.tool_context.multiply.token"
    ]);
    expect(toolSpan?.children[0]?.name).toBe("inside.tool");
    expect(toolSpan?.ended).toBe(true);
  });

  it("closes open operation, model, and tool spans on error without raw error messages", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });
    const cause = new Error("do not record this message");

    telemetry.onStart?.({
      callId: "call-1",
      operationId: "ai.generateText"
    });
    telemetry.onLanguageModelCallStart?.({
      callId: "call-1"
    });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: {
        toolCallId: "tool-call-1",
        toolName: "multiply"
      }
    });
    await expect(
      telemetry.executeTool?.({
        callId: "call-1",
        execute: async () => {
          throw cause;
        },
        toolCallId: "tool-call-1"
      })
    ).rejects.toThrow(cause);
    telemetry.onError?.({
      callId: "call-1",
      error: cause
    });

    for (const span of tracing.spans) {
      expect(span.ended).toBe(true);
      expect(span.attributes).not.toHaveProperty(["error.message"]);
    }
    expect(tracing.spans[0]?.attributes).toMatchObject({
      "error.type": "Error"
    });
    expect(tracing.spans[1]?.attributes).toMatchObject({
      "error.type": "Error"
    });
    expect(tracing.spans[2]?.attributes).toMatchObject({
      "error.type": "Error"
    });
  });

  it("closes open spans as canceled when v7 reports an abort", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.streamText" });
    telemetry.onLanguageModelCallStart?.({ callId: "call-1" });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: { toolCallId: "tool-1", toolName: "slowTool" }
    });
    telemetry.onAbort?.({ callId: "call-1", reason: "user canceled" });

    expect(tracing.spans).toHaveLength(3);
    for (const span of tracing.spans) {
      expect(span.ended).toBe(true);
      expect(span.attributes).toMatchObject({
        "cloudflare.agents.canceled": true
      });
      expect(span.attributes).not.toHaveProperty(["error.type"]);
    }
  });

  it("does not record raw prompt, tool input, tool output, or error content", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });
    const secretValues = [
      "secret prompt",
      "secret message",
      "secret tool input",
      "secret tool output",
      "secret error"
    ];

    telemetry.onStart?.({
      callId: "call-1",
      messages: [{ content: "secret message", role: "user" }],
      operationId: "ai.generateText",
      prompt: "secret prompt"
    });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: {
        input: { value: "secret tool input" },
        toolCallId: "tool-call-1",
        toolName: "unsafeTool"
      }
    });
    telemetry.onToolExecutionEnd?.({
      callId: "call-1",
      toolCall: {
        toolCallId: "tool-call-1",
        toolName: "unsafeTool"
      },
      toolOutput: {
        output: { value: "secret tool output" },
        type: "tool-result"
      }
    });
    telemetry.onError?.({
      callId: "call-1",
      error: new Error("secret error")
    });

    const recordedValues = tracing.spans.flatMap((span) =>
      Object.values(span.attributes)
    );
    for (const secret of secretValues) {
      expect(recordedValues).not.toContain(secret);
    }
  });

  it("projects only scalar SDK-filtered v7 runtime context", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({
      callId: "call-1",
      operationId: "ai.generateText",
      runtimeContext: {
        conversationId: "conversation-1",
        nested: { a: 1 },
        requestId: "req-1",
        workspaceId: "ws-9"
      }
    });
    telemetry.onEnd?.({
      callId: "call-1",
      operationId: "ai.generateText"
    });

    expect(tracing.spans[0]?.attributes).toMatchObject({
      "cloudflare.agents.runtime_context.requestId": "req-1",
      "cloudflare.agents.runtime_context.workspaceId": "ws-9",
      "gen_ai.conversation.id": "conversation-1"
    });
    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.nested"
    ]);
    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "cloudflare.agents.runtime_context.conversationId"
    ]);
    expect(tracing.spans[0]?.ended).toBe(true);
  });

  it("keeps tool spans separate when concurrent operations reuse a tool call id", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });
    const sharedToolCallId = "tool-call-shared";

    telemetry.onStart?.({ callId: "op-1", operationId: "ai.streamText" });
    telemetry.onStart?.({ callId: "op-2", operationId: "ai.streamText" });
    telemetry.onToolExecutionStart?.({
      callId: "op-1",
      toolCall: { toolCallId: sharedToolCallId, toolName: "first" }
    });
    telemetry.onToolExecutionStart?.({
      callId: "op-2",
      toolCall: { toolCallId: sharedToolCallId, toolName: "second" }
    });

    const [firstResult, secondResult] = await Promise.all([
      telemetry.executeTool?.({
        callId: "op-1",
        execute: async () => "from-op-1",
        toolCallId: sharedToolCallId
      }),
      telemetry.executeTool?.({
        callId: "op-2",
        execute: async () => "from-op-2",
        toolCallId: sharedToolCallId
      })
    ]);

    telemetry.onToolExecutionEnd?.({
      callId: "op-1",
      toolCall: { toolCallId: sharedToolCallId, toolName: "first" }
    });
    telemetry.onToolExecutionEnd?.({
      callId: "op-2",
      toolCall: { toolCallId: sharedToolCallId, toolName: "second" }
    });
    telemetry.onEnd?.({ callId: "op-1", operationId: "ai.streamText" });
    telemetry.onEnd?.({ callId: "op-2", operationId: "ai.streamText" });

    expect(firstResult).toBe("from-op-1");
    expect(secondResult).toBe("from-op-2");

    const toolSpans = tracing.spans.filter(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpans).toHaveLength(2);

    const firstSpan = toolSpans.find(
      (span) => span.attributes["cloudflare.agents.call.id"] === "op-1"
    );
    const secondSpan = toolSpans.find(
      (span) => span.attributes["cloudflare.agents.call.id"] === "op-2"
    );
    expect(firstSpan?.attributes).toMatchObject({
      "gen_ai.tool.call.id": sharedToolCallId,
      "gen_ai.tool.name": "first"
    });
    expect(secondSpan?.attributes).toMatchObject({
      "gen_ai.tool.call.id": sharedToolCallId,
      "gen_ai.tool.name": "second"
    });
    expect(firstSpan?.ended).toBe(true);
    expect(secondSpan?.ended).toBe(true);
    expect(firstSpan?.attributes).not.toHaveProperty(["otel.status_code"]);
    expect(secondSpan?.attributes).not.toHaveProperty(["otel.status_code"]);
  });

  it("reads public-result usage detail shapes on operation events", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onEnd?.({
      callId: "call-1",
      operationId: "ai.generateText",
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 2 },
        inputTokens: 10,
        outputTokenDetails: { reasoningTokens: 4 },
        outputTokens: 6,
        totalTokens: 16
      }
    });

    expect(tracing.spans[0]?.attributes).toMatchObject({
      "gen_ai.usage.cache_creation.input_tokens": 2,
      "gen_ai.usage.cache_read.input_tokens": 3,
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 6,
      "gen_ai.usage.reasoning.output_tokens": 4
    });
    expect(tracing.spans[0]?.ended).toBe(true);
  });

  it("reads deprecated flat usage fields on operation events", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onEnd?.({
      callId: "call-1",
      operationId: "ai.generateText",
      totalUsage: {
        cachedInputTokens: 5,
        inputTokens: 9,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 12
      }
    });

    expect(tracing.spans[0]?.attributes).toMatchObject({
      "gen_ai.usage.cache_read.input_tokens": 5,
      "gen_ai.usage.input_tokens": 9,
      "gen_ai.usage.output_tokens": 3,
      "gen_ai.usage.reasoning.output_tokens": 1
    });
  });

  it("does not present the requested model as the response model", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onLanguageModelCallStart?.({
      callId: "call-1",
      modelId: "requested-model"
    });
    telemetry.onLanguageModelCallEnd?.({
      callId: "call-1",
      modelId: "requested-model",
      responseId: "resp-1"
    });
    telemetry.onEnd?.({ callId: "call-1", operationId: "ai.generateText" });

    expect(tracing.spans[1]?.attributes).toMatchObject({
      "gen_ai.response.id": "resp-1"
    });
    expect(tracing.spans[1]?.attributes).not.toHaveProperty([
      "gen_ai.response.model"
    ]);
    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "gen_ai.response.id"
    ]);
  });
});

describe("createAISDKV7Telemetry opt-in content recording", () => {
  const CONTENT_KEYS = [
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result"
  ] as const;

  function driveOperation(
    telemetry: ReturnType<typeof createAISDKV7Telemetry>
  ) {
    telemetry.onStart?.({
      callId: "call-1",
      messages: [{ content: "secret message", role: "user" }],
      operationId: "ai.generateText",
      prompt: "secret prompt"
    });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: {
        input: { a: 6, b: 7 },
        toolCallId: "tool-call-1",
        toolName: "multiply"
      }
    });
    telemetry.onToolExecutionEnd?.({
      callId: "call-1",
      toolCall: { toolCallId: "tool-call-1", toolName: "multiply" },
      toolOutput: { output: { product: 42 }, type: "tool-result" }
    });
    telemetry.onEnd?.({
      callId: "call-1",
      operationId: "ai.generateText",
      text: "the answer is 42",
      toolCalls: [{ toolName: "multiply" }]
    });
  }

  it("records NO content attribute by default (the privacy default)", () => {
    const tracing = new RecordingTracer();
    driveOperation(createAISDKV7Telemetry({ tracer: tracing }));

    for (const span of tracing.spans) {
      for (const key of CONTENT_KEYS) {
        expect(span.attributes).not.toHaveProperty([key]);
      }
    }
  });

  it("records chat and tool content when the caller opts in", () => {
    const tracing = new RecordingTracer();
    driveOperation(
      createAISDKV7Telemetry({
        options: { recordInputs: true, recordOutputs: true },
        tracer: tracing
      })
    );

    const operationSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    expect(operationSpan?.attributes["gen_ai.input.messages"]).toBe(
      JSON.stringify([{ content: "secret message", role: "user" }])
    );
    expect(operationSpan?.attributes["gen_ai.output.messages"]).toBe(
      JSON.stringify({
        text: "the answer is 42",
        toolCalls: [{ toolName: "multiply" }]
      })
    );

    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.attributes["gen_ai.tool.call.arguments"]).toBe(
      JSON.stringify({ a: 6, b: 7 })
    );
    expect(toolSpan?.attributes["gen_ai.tool.call.result"]).toBe(
      JSON.stringify({ product: 42 })
    );
  });

  it("records only inputs when only recordInputs is set", () => {
    const tracing = new RecordingTracer();
    driveOperation(
      createAISDKV7Telemetry({
        options: { recordInputs: true },
        tracer: tracing
      })
    );

    const operationSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    expect(operationSpan?.attributes).toHaveProperty(["gen_ai.input.messages"]);
    expect(operationSpan?.attributes).not.toHaveProperty([
      "gen_ai.output.messages"
    ]);
    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.attributes).toHaveProperty(["gen_ai.tool.call.arguments"]);
    expect(toolSpan?.attributes).not.toHaveProperty([
      "gen_ai.tool.call.result"
    ]);
  });

  it("truncates oversized content to a bounded, marked value", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({
      options: { recordInputs: true },
      tracer: tracing
    });

    telemetry.onStart?.({
      callId: "call-1",
      operationId: "ai.generateText",
      prompt: "x".repeat(70_000)
    });
    telemetry.onEnd?.({ callId: "call-1", operationId: "ai.generateText" });

    const value = tracing.spans[0]?.attributes["gen_ai.input.messages"];
    expect(typeof value).toBe("string");
    const text = value as string;
    expect(text.endsWith("…[truncated]")).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(28_672);
  });

  it("never records tool output on the error path", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({
      options: { recordInputs: true, recordOutputs: true },
      tracer: tracing
    });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.streamText" });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: { toolCallId: "tool-1", toolName: "boom" }
    });
    telemetry.onToolExecutionEnd?.({
      callId: "call-1",
      toolCall: { toolCallId: "tool-1", toolName: "boom" },
      toolOutput: { error: new Error("secret error"), type: "tool-error" }
    });

    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(toolSpan?.attributes).not.toHaveProperty([
      "gen_ai.tool.call.result"
    ]);
  });
});
