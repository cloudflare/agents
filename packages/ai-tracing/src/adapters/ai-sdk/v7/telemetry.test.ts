import { describe, expect, it } from "vitest";
import { RecordingTracer } from "../../../test-support/recording-tracer.js";
import { createAISDKV7Telemetry } from "./telemetry.js";

describe("createAISDKV7Telemetry", () => {
  it("traces operation and model callbacks with call id correlation", () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });

    telemetry.onStart?.({
      callId: "call-1",
      functionId: "fixture-agent",
      maxOutputTokens: 20,
      metadata: {
        conversationId: "conversation-1"
      },
      modelId: "test-model",
      operationId: "ai.generateText",
      provider: "test-provider",
      runtimeContext: {
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
      modelId: "served-model",
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
    expect(tracing.spans[0]?.attributes).toMatchObject({
      "ai.call.id": "call-1",
      "ai.integration.name": "ai-sdk",
      "ai.operation.id": "generateText",
      "ai.output.has_text": true,
      "ai.response.finish_reason": "stop",
      "ai.runtime_context.requestId": "req-1",
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
      "gen_ai.response.model": "served-model",
      "gen_ai.usage.input_tokens": 4,
      "gen_ai.usage.output_tokens": 2
    });
    expect(tracing.spans[0]?.attributes).not.toHaveProperty(
      "ai.runtime_context.privateObject"
    );
    expect(tracing.spans[0]?.ended).toBe(true);
    expect(tracing.spans[1]?.attributes).toMatchObject({
      "ai.call.id": "call-1",
      "ai.operation.id": "doGenerate",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.stream": false,
      "gen_ai.response.id": "response-1"
    });
    expect(tracing.spans[1]?.ended).toBe(true);
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
      (span) => span.name === "gen_ai.execute_tool"
    );
    expect(toolSpan?.attributes).toMatchObject({
      "ai.call.id": "call-1",
      "ai.operation.id": "tool.execute",
      "ai.tool.call_id": "tool-call-1",
      "ai.tool_context.multiply.unit": "count",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "multiply",
      "gen_ai.tool.type": "function"
    });
    expect(toolSpan?.attributes).not.toHaveProperty(
      "ai.tool_context.multiply.token"
    );
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
      expect(span.attributes).not.toHaveProperty("error.message");
    }
    expect(tracing.spans[0]?.attributes).toMatchObject({
      error: true,
      "error.type": "Error"
    });
    expect(tracing.spans[1]?.attributes).toMatchObject({
      error: true,
      "error.type": "Error"
    });
    expect(tracing.spans[2]?.attributes).toMatchObject({
      error: true,
      "error.type": "Error"
    });
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
});
