import { describe, expect, it } from "vitest";
import {
  generateText,
  isStepCount,
  simulateReadableStream,
  streamText,
  tool
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { RecordingTracer } from "./recording-tracer";
import { createAISDKV7Telemetry } from "../../observability/ai/v7/telemetry";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 3,
    total: 3
  },
  outputTokens: {
    reasoning: undefined,
    text: 2,
    total: 2
  }
};

describe("createAISDKV7Telemetry with the real AI SDK", () => {
  it("parents a streaming model call under invoke_agent", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });
    const model = new MockLanguageModelV4({
      modelId: "stream-model",
      provider: "mock-provider",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "Hello" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { raw: "stop", unified: "stop" },
              logprobs: undefined,
              usage
            }
          ]
        })
      })
    });

    const result = streamText({
      model,
      prompt: "Say hello",
      telemetry: {
        functionId: "stream-agent",
        integrations: [telemetry]
      }
    });

    let text = "";
    for await (const chunk of result.textStream) text += chunk;

    expect(text).toBe("Hello");
    const operationSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    const chatSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    expect(tracing.rootSpans).toEqual([operationSpan]);
    expect(chatSpan?.parent).toBe(operationSpan);
    expect(chatSpan?.ended).toBe(true);
    expect(operationSpan?.ended).toBe(true);
  });

  it("parents model and tool work under one multi-step operation", async () => {
    const tracing = new RecordingTracer();
    const telemetry = createAISDKV7Telemetry({ tracer: tracing });
    const model = new MockLanguageModelV4({
      modelId: "tool-model",
      provider: "mock-provider",
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              input: JSON.stringify({ value: 21 }),
              toolCallId: "double-1",
              toolName: "double"
            }
          ],
          finishReason: { raw: "tool-calls", unified: "tool-calls" },
          usage,
          warnings: []
        },
        {
          content: [{ type: "text", text: "42" }],
          finishReason: { raw: "stop", unified: "stop" },
          usage,
          warnings: []
        }
      ]
    });

    const result = await generateText({
      model,
      prompt: "Double 21",
      stopWhen: isStepCount(2),
      telemetry: {
        functionId: "tool-agent",
        integrations: [telemetry]
      },
      tools: {
        double: tool({
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => {
            await tracing.withSpan("inside.tool", {}, (span) => {
              span.finish();
            });
            return value * 2;
          }
        })
      }
    });

    expect(result.text).toBe("42");
    const operationSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "invoke_agent"
    );
    const chatSpans = tracing.spans.filter(
      (span) => span.attributes["gen_ai.operation.name"] === "chat"
    );
    const toolSpan = tracing.spans.find(
      (span) => span.attributes["gen_ai.operation.name"] === "execute_tool"
    );

    expect(tracing.rootSpans).toEqual([operationSpan]);
    expect(chatSpans).toHaveLength(2);
    expect(chatSpans.every((span) => span.parent === operationSpan)).toBe(true);
    expect(toolSpan?.parent).toBe(operationSpan);
    expect(toolSpan?.children[0]?.name).toBe("inside.tool");
    expect(tracing.spans.every((span) => span.ended)).toBe(true);
  });
});
