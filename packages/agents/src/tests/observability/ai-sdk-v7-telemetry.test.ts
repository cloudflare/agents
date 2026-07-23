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
      "gen_ai.agent.name": "fixture-agent",
      "gen_ai.conversation.id": "conversation-1",
      "gen_ai.operation.name": "chat",
      "gen_ai.response.id": "response-1",
      "gen_ai.response.time_to_first_chunk": 0.125
    });
    expect(tracing.spans[1]?.attributes).not.toHaveProperty([
      "gen_ai.request.stream"
    ]);
    expect(tracing.spans[1]?.ended).toBe(true);
  });

  it("records an exposed AI Gateway log id on the chat span only", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({
      callId: "call-1",
      operationId: "ai.generateText"
    });
    telemetry.onLanguageModelCallStart?.({
      callId: "call-1",
      modelId: "gateway-model"
    });
    telemetry.onLanguageModelCallEnd?.({
      callId: "call-1",
      providerMetadata: {
        cloudflare: { aiGatewayLogId: "gateway-log-v7" }
      }
    });
    telemetry.onEnd?.({
      callId: "call-1",
      operationId: "ai.generateText"
    });

    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "cloudflare.ai_gateway.log.id"
    ]);
    expect(tracing.spans[1]?.attributes).toMatchObject({
      "cloudflare.ai_gateway.log.id": "gateway-log-v7",
      "gen_ai.operation.name": "chat"
    });
  });

  it.each([
    {
      headers: { "cf-aig-log-id": "caller-controlled-request-header" }
    },
    {
      providerMetadata: { provider: { logId: "not-an-aig-id" } }
    },
    {
      providerMetadata: {
        cloudflare: { aiGatewayLogId: "x".repeat(300) }
      }
    }
  ])("omits untrusted or oversized log ids", (event) => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onLanguageModelCallStart?.({ callId: "call-1" });
    telemetry.onLanguageModelCallEnd?.({ callId: "call-1", ...event });
    telemetry.onEnd?.({ callId: "call-1", operationId: "ai.generateText" });

    expect(tracing.spans[1]?.attributes).not.toHaveProperty([
      "cloudflare.ai_gateway.log.id"
    ]);
  });

  it("stores full messages and tool calls on chat", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({
      options: { storeMessages: true },
      tracer: tracing
    });
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            input: { prior: true },
            toolCallId: "prior-call",
            toolName: "save"
          }
        ]
      }
    ];

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onLanguageModelCallStart?.({ callId: "call-1", messages });
    telemetry.onLanguageModelCallEnd?.({
      callId: "call-1",
      finishReason: "stop",
      content: [
        { type: "text", text: "done" },
        {
          type: "tool-call",
          input: { value: 42 },
          toolCallId: "call-1",
          toolName: "save"
        }
      ]
    });
    telemetry.onEnd?.({ callId: "call-1", operationId: "ai.generateText" });

    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "gen_ai.input.messages"
    ]);
    expect(tracing.spans[0]?.attributes).not.toHaveProperty([
      "gen_ai.output.messages"
    ]);
    const allAttributes = JSON.stringify(
      tracing.spans.map((span) => span.attributes)
    );
    expect(allAttributes).not.toContain("storeMessages");
    expect(allAttributes).not.toContain("storeTools");
    expect(
      JSON.parse(
        tracing.spans[1]?.attributes["gen_ai.input.messages"] as string
      )
    ).toEqual([
      {
        parts: [{ type: "text", content: "hello" }],
        role: "user"
      },
      {
        parts: [
          {
            type: "tool_call",
            id: "prior-call",
            name: "save",
            arguments: { prior: true }
          }
        ],
        role: "assistant"
      }
    ]);
    expect(
      JSON.parse(
        tracing.spans[1]?.attributes["gen_ai.output.messages"] as string
      )
    ).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "done" },
          {
            type: "tool_call",
            id: "call-1",
            name: "save",
            arguments: { value: 42 }
          }
        ],
        finish_reason: "stop"
      }
    ]);
  });

  it("stores tool payloads only on execute_tool", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({
      options: { storeTools: true },
      tracer: tracing
    });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onToolExecutionStart?.({
      callId: "call-1",
      toolCall: {
        input: { value: 42 },
        toolCallId: "tool-1",
        toolName: "save"
      }
    });
    telemetry.onToolExecutionEnd?.({
      callId: "call-1",
      toolCall: { toolCallId: "tool-1", toolName: "save" },
      toolOutput: { output: { saved: true }, type: "tool-result" }
    });
    telemetry.onEnd?.({ callId: "call-1", operationId: "ai.generateText" });

    const chat = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );
    expect(chat).toBeUndefined();
    expect(toolSpan?.attributes["gen_ai.tool.call.arguments"]).toBe(
      JSON.stringify({ value: 42 })
    );
    expect(toolSpan?.attributes["gen_ai.tool.call.result"]).toBe(
      JSON.stringify({ saved: true })
    );
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

  it("records a gateway log id exposed by a provider-call error", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });
    const cause = Object.assign(new Error("provider failed"), {
      responseHeaders: { "cf-aig-log-id": "gateway-log-error-v7" }
    });

    telemetry.onStart?.({ callId: "call-1", operationId: "ai.generateText" });
    telemetry.onLanguageModelCallStart?.({ callId: "call-1" });
    await expect(
      telemetry.executeLanguageModelCall?.({
        callId: "call-1",
        execute: async () => {
          throw cause;
        }
      })
    ).rejects.toThrow(cause);
    telemetry.onError?.({ callId: "call-1", error: cause });

    const chatSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(chatSpan?.attributes).toMatchObject({
      "cloudflare.ai_gateway.log.id": "gateway-log-error-v7",
      "error.type": "Error"
    });
    expect(tracing.rootSpans[0]?.attributes).not.toHaveProperty([
      "cloudflare.ai_gateway.log.id"
    ]);
  });

  it("runs executeTool under the tool span and records only safe tool metadata", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({
      callId: "call-1",
      functionId: "fixture-agent",
      operationId: "ai.streamText",
      runtimeContext: { conversationId: "conversation-1" }
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
      "gen_ai.agent.name": "fixture-agent",
      "gen_ai.conversation.id": "conversation-1",
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
