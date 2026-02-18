/**
 * AgentLoop unit tests — Node.js environment (no Workers runtime needed).
 *
 * Uses MockLanguageModelV3 from ai/test to simulate LLM responses
 * without making real network calls.
 */

import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { convertArrayToReadableStream } from "@ai-sdk/provider-utils/test";
import { tool } from "ai";
import { z } from "zod";
import { AgentLoop } from "../src/agent-loop";
import { DONE_TOOL_NAME, doneTool } from "../src/tools";
import type { ModelMessage } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

/** Build a single-text-response stream for a mock model. */
function textStream(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: ZERO_USAGE }
  ];
}

/**
 * Build a tool-call stream (no text — model only calls the tool).
 *
 * Uses a single `tool-call` provider stream event. This is the simplest
 * form and is sufficient for both single-step (done) and multi-step (execute)
 * tests. The SDK emits a `tool-call` event to fullStream in both cases.
 */
function toolCallStream(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId,
      toolName,
      input: JSON.stringify(input)
    },
    { type: "finish", finishReason: "tool-calls", usage: ZERO_USAGE }
  ];
}

/** Collect all NDJSON lines emitted by AgentLoop.stream(). */
async function collectNdjson(
  stream: ReadableStream<string>
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const lines: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(
      typeof value === "string" ? new TextEncoder().encode(value) : value,
      { stream: true }
    );
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    lines.push(...parts.filter((l) => l.trim()));
  }
  if (buf.trim()) lines.push(buf.trim());

  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const USER_MSG: ModelMessage = { role: "user", content: "hello" };

// ── run() — basic text response ───────────────────────────────────────────────

describe("AgentLoop.run() basic", () => {
  it("returns text from a single-step model response", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "Hello there!" }],
        finishReason: "stop",
        usage: ZERO_USAGE,
        warnings: []
      }
    });

    const loop = new AgentLoop({ model });
    const result = await loop.run([USER_MSG]);

    expect(result.type).toBe("text");
    expect(result.text).toBe("Hello there!");
  });

  it("executes a tool and continues to produce a text response", async () => {
    const executed = vi.fn().mockResolvedValue("tool output");

    const echoTool = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: executed
    });

    // Use a function-based mock to avoid the mock's 1-indexed array bug.
    // (MockLanguageModelV3 with an array uses doGenerateCalls.length after push,
    // so array[0] is never returned — the first call gets array[1].)
    let generateCall = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        generateCall++;
        if (generateCall === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "tc1",
                toolName: "echo",
                input: JSON.stringify({ msg: "hi" })
              }
            ],
            finishReason: "tool-calls" as const,
            usage: ZERO_USAGE,
            warnings: []
          };
        }
        return {
          content: [{ type: "text" as const, text: "Done!" }],
          finishReason: "stop" as const,
          usage: ZERO_USAGE,
          warnings: []
        };
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { echo: echoTool },
      maxSteps: 5
    });
    const result = await loop.run([USER_MSG]);

    expect(executed).toHaveBeenCalledOnce();
    expect(executed).toHaveBeenCalledWith({ msg: "hi" }, expect.anything());
    expect(result.text).toBe("Done!");
  });
});

// ── run() — done tool ─────────────────────────────────────────────────────────

describe("AgentLoop.run() — done tool", () => {
  it("stops when model calls done and records it as a tool-calls-pending result", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-done",
            toolName: DONE_TOOL_NAME,
            input: JSON.stringify({ summary: "All done!" })
          }
        ],
        finishReason: "tool-calls",
        usage: ZERO_USAGE,
        warnings: []
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { [DONE_TOOL_NAME]: doneTool },
      maxSteps: 5
    });
    const result = await loop.run([USER_MSG]);

    // done has no execute, so toolResults < toolCalls → tool-calls-pending
    expect(result.type).toBe("tool-calls-pending");
    // The done tool call is present
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe(DONE_TOOL_NAME);
    expect((result.toolCalls[0].args as { summary: string }).summary).toBe(
      "All done!"
    );
    // Only one model call — the loop stopped at `done`
    expect((model as MockLanguageModelV3).doGenerateCalls).toHaveLength(1);
  });
});

// ── stream() — NDJSON format ──────────────────────────────────────────────────

describe("AgentLoop.stream() NDJSON format", () => {
  it("emits text-delta events as {t:text,d:...}", async () => {
    const model = new MockLanguageModelV3({
      doStream: {
        stream: convertArrayToReadableStream(textStream("Hello world"))
      }
    });

    const loop = new AgentLoop({ model });
    const { textStream: stream } = loop.stream([USER_MSG]);
    const events = await collectNdjson(stream);

    const textEvents = events.filter((e) => e.t === "text");
    expect(textEvents.length).toBeGreaterThan(0);
    const combined = textEvents.map((e) => e.d).join("");
    expect(combined).toBe("Hello world");
  });

  it("emits tool events as {t:tool,n:name,a:{...}} when model calls a tool", async () => {
    const echoTool = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: vi.fn().mockResolvedValue("done")
    });

    // Function-based mock avoids the 1-indexed array bug in MockLanguageModelV3.
    let streamCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCall++;
        if (streamCall === 1) {
          return {
            stream: convertArrayToReadableStream(
              toolCallStream("tc1", "echo", { msg: "hi" })
            )
          };
        }
        return {
          stream: convertArrayToReadableStream(textStream("Finished"))
        };
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { echo: echoTool },
      maxSteps: 5
    });
    const { textStream: stream } = loop.stream([USER_MSG]);
    const events = await collectNdjson(stream);

    const toolEvents = events.filter((e) => e.t === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].n).toBe("echo");
    expect((toolEvents[0].a as { msg: string }).msg).toBe("hi");
  });

  it("executes tools mid-stream and produces text in the final step", async () => {
    const executed = vi.fn().mockResolvedValue("tool result");
    const echoTool = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: executed
    });

    let streamCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCall++;
        if (streamCall === 1) {
          return {
            stream: convertArrayToReadableStream(
              toolCallStream("tc1", "echo", { msg: "test" })
            )
          };
        }
        return {
          stream: convertArrayToReadableStream(
            textStream("Result: tool result")
          )
        };
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { echo: echoTool },
      maxSteps: 5
    });
    const { textStream: stream, result } = loop.stream([USER_MSG]);

    // Drain the stream
    await collectNdjson(stream);
    const final = await result;

    expect(executed).toHaveBeenCalledOnce();
    expect(final.text).toBe("Result: tool result");
  });
});

// ── stream() — done tool ──────────────────────────────────────────────────────

describe("AgentLoop.stream() — done tool", () => {
  it("extracts the done tool summary as the final text when model produces no text", async () => {
    const model = new MockLanguageModelV3({
      doStream: {
        stream: convertArrayToReadableStream(
          toolCallStream("tc-done", DONE_TOOL_NAME, {
            summary: "Created 3 files successfully."
          })
        )
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { [DONE_TOOL_NAME]: doneTool },
      maxSteps: 5
    });
    const { textStream: stream, result } = loop.stream([USER_MSG]);

    await collectNdjson(stream);
    const final = await result;

    expect(final.text).toBe("Created 3 files successfully.");
  });

  it("emits a tool event for the done call", async () => {
    const model = new MockLanguageModelV3({
      doStream: {
        stream: convertArrayToReadableStream(
          toolCallStream("tc-done", DONE_TOOL_NAME, { summary: "Done." })
        )
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { [DONE_TOOL_NAME]: doneTool },
      maxSteps: 5
    });
    const { textStream: stream } = loop.stream([USER_MSG]);
    const events = await collectNdjson(stream);

    const toolEvents = events.filter((e) => e.t === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].n).toBe(DONE_TOOL_NAME);
  });

  it("only makes one model call when done is invoked (no follow-up step)", async () => {
    const model = new MockLanguageModelV3({
      doStream: {
        stream: convertArrayToReadableStream(
          toolCallStream("tc-done", DONE_TOOL_NAME, { summary: "Finished." })
        )
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { [DONE_TOOL_NAME]: doneTool },
      maxSteps: 5
    });
    const { textStream: stream } = loop.stream([USER_MSG]);
    await collectNdjson(stream);

    expect((model as MockLanguageModelV3).doStreamCalls).toHaveLength(1);
  });
});

// ── Context trimming ──────────────────────────────────────────────────────────

describe("AgentLoop context trimming", () => {
  it("trims message count: passes only first + 25 recent when > 40 messages", async () => {
    const receivedPrompts: number[] = [];

    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        receivedPrompts.push(options.prompt.length);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: ZERO_USAGE,
          warnings: []
        };
      }
    });

    // Build 45 alternating user/assistant messages
    const messages: ModelMessage[] = Array.from({ length: 45 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`
    }));

    const loop = new AgentLoop({ model, maxSteps: 1 });
    await loop.run(messages);

    // 1 (first) + 25 (recent) = 26
    expect(receivedPrompts[0]).toBe(26);
  });

  it("does not trim when message count is at or below the threshold", async () => {
    const receivedPrompts: number[] = [];

    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        receivedPrompts.push(options.prompt.length);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: ZERO_USAGE,
          warnings: []
        };
      }
    });

    // 40 messages — exactly at the threshold, should NOT be trimmed
    const messages: ModelMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`
    }));

    const loop = new AgentLoop({ model, maxSteps: 1 });
    await loop.run(messages);

    expect(receivedPrompts[0]).toBe(40);
  });

  it("truncates oversized tool results before sending to the model", async () => {
    const TOOL_RESULT_MAX_CHARS = 8_000;
    const bigOutput = "x".repeat(TOOL_RESULT_MAX_CHARS + 500);
    const receivedPrompts: unknown[][] = [];

    const bigOutputTool = tool({
      description: "returns a big string",
      inputSchema: z.object({}),
      execute: async () => bigOutput
    });

    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        receivedPrompts.push(options.prompt as unknown[]);
        // First call: return a tool call. Second call: return text.
        if (receivedPrompts.length === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "tc1",
                toolName: "bigOutputTool",
                input: JSON.stringify({})
              }
            ],
            finishReason: "tool-calls" as const,
            usage: ZERO_USAGE,
            warnings: []
          };
        }
        return {
          content: [{ type: "text" as const, text: "done" }],
          finishReason: "stop" as const,
          usage: ZERO_USAGE,
          warnings: []
        };
      }
    });

    const loop = new AgentLoop({
      model,
      tools: { bigOutputTool },
      maxSteps: 5
    });
    await loop.run([USER_MSG]);

    // There should have been 2 calls: one for the tool call, one after
    expect(receivedPrompts).toHaveLength(2);

    // In the second call, find the tool result message and check its content is truncated
    const secondPrompt = receivedPrompts[1] as Array<{
      role: string;
      content: unknown;
    }>;
    const toolMsg = secondPrompt.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();

    // The tool result content should be truncated — stringify it and check length
    const toolContent = JSON.stringify(toolMsg?.content ?? "");
    expect(toolContent.length).toBeLessThan(
      bigOutput.length + 200 // much less than the original 8500 chars
    );
    expect(toolContent).toContain("[truncated");
  });

  it("context trimming preserves the first USER message, not just index 0", async () => {
    const receivedPrompts: Array<Array<{ role: string; content: unknown }>> =
      [];

    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        receivedPrompts.push(
          options.prompt as Array<{ role: string; content: unknown }>
        );
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: "stop" as const,
          usage: ZERO_USAGE,
          warnings: []
        };
      }
    });

    // Build 45 messages where index 0 is an ASSISTANT message (e.g. a system
    // injection that ended up as an assistant turn). The first USER message
    // is at index 1. Trimming should anchor to index 1, not index 0.
    const messages: ModelMessage[] = [
      { role: "assistant", content: "I am your assistant" }, // index 0 — NOT a user msg
      { role: "user", content: "original task" }, // index 1 — first user msg
      ...Array.from({ length: 43 }, (_, i) => ({
        role: (i % 2 === 0 ? "assistant" : "user") as "assistant" | "user",
        content: `msg ${i}`
      }))
    ];
    // Total: 45 messages → triggers trimming

    const loop = new AgentLoop({ model, maxSteps: 1 });
    await loop.run(messages);

    const prompt = receivedPrompts[0];
    // Anchor should be the first USER message, not the assistant at index 0
    expect(prompt[0].role).toBe("user");
    // The provider receives structured content parts, so we stringify to check
    // the original task string is present rather than asserting exact equality.
    expect(JSON.stringify(prompt[0].content)).toContain("original task");
    // Total trimmed count: 1 anchor + 25 recent = 26
    expect(prompt).toHaveLength(26);
  });
});
