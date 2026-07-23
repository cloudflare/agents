import { describe, expect, it } from "vitest";
import {
  createStreamMessages,
  inputMessageAttributes,
  outputMessageAttributes
} from "../../observability/ai/content";
import type { TraceAttributes } from "../../observability/tracing/tracer";

const INPUT_MESSAGES = "gen_ai.input.messages";
const OUTPUT_MESSAGES = "gen_ai.output.messages";

// These assertions pin the message contract from OpenTelemetry's
// gen-ai-input-messages.json and gen-ai-output-messages.json schemas.
describe("genai_semantics", () => {
  it("formats input history as role/parts messages", () => {
    const attributes = inputMessageAttributes(
      {
        prompt: [
          { role: "system", content: "Keep this instruction in history" },
          {
            role: "user",
            content: [{ type: "text", text: "Find the answer" }]
          },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "I should use the lookup tool" },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "lookup",
                input: { query: "answer" }
              }
            ]
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "lookup",
                output: { type: "json", value: { answer: 42 } }
              }
            ]
          }
        ]
      },
      true
    );

    expect(parseMessages(attributes, INPUT_MESSAGES)).toEqual([
      {
        role: "system",
        parts: [{ type: "text", content: "Keep this instruction in history" }]
      },
      {
        role: "user",
        parts: [{ type: "text", content: "Find the answer" }]
      },
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            content: "I should use the lookup tool"
          },
          {
            type: "tool_call",
            id: "call-1",
            name: "lookup",
            arguments: { query: "answer" }
          }
        ]
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "call-1",
            response: { answer: 42 }
          }
        ]
      }
    ]);
  });

  it("formats buffered output parts and embeds finish_reason", () => {
    const attributes = outputMessageAttributes(
      {
        content: [
          { type: "reasoning", text: "I found it" },
          { type: "text", text: "The answer is 42" },
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "save",
            input: { value: 42 }
          },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "save",
            output: { type: "text", value: "saved" }
          }
        ],
        finishReason: "tool-calls"
      },
      true
    );

    expect(parseMessages(attributes, OUTPUT_MESSAGES)).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "I found it" },
          { type: "text", content: "The answer is 42" },
          {
            type: "tool_call",
            id: "call-2",
            name: "save",
            arguments: { value: 42 }
          },
          {
            type: "tool_call_response",
            id: "call-2",
            response: "saved"
          }
        ],
        finish_reason: "tool_call"
      }
    ]);
  });

  it("keeps output valid when the model returns no content parts", () => {
    const attributes = outputMessageAttributes(
      {
        content: [],
        finishReason: { raw: "content_filter", unified: "content-filter" }
      },
      true
    );

    expect(parseMessages(attributes, OUTPUT_MESSAGES)).toEqual([
      {
        role: "assistant",
        parts: [],
        finish_reason: "content_filter"
      }
    ]);
  });

  it("formats streamed reasoning, text, and tool calls with finish_reason", () => {
    const output = createStreamMessages();
    output.observe({ type: "reasoning-delta", delta: "Checking" });
    output.observe({ type: "text-delta", delta: "Done" });
    output.observe({
      type: "tool-call",
      toolCallId: "call-3",
      toolName: "notify",
      input: { status: "done" }
    });

    expect(output.messages("tool-calls")).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", content: "Checking" },
          { type: "text", content: "Done" },
          {
            type: "tool_call",
            id: "call-3",
            name: "notify",
            arguments: { status: "done" }
          }
        ],
        finish_reason: "tool_call"
      }
    ]);
  });
});

function parseMessages(attributes: TraceAttributes, key: string): unknown {
  const value = attributes[key];
  expect(typeof value).toBe("string");
  return JSON.parse(value as string) as unknown;
}
