import { describe, it, expect } from "vitest";
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart
} from "@ai-sdk/provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createWorkersAI } from "workers-ai-provider";
import { createReplayModel } from "./replay-model";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sse(...lines: string[]): string {
  return lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
}

function mockBuffer(data: string) {
  return {
    fetch: async () =>
      new Response(data, {
        headers: { "Content-Type": "text/event-stream" }
      })
  } as unknown as Fetcher;
}

async function collectStream(
  model: LanguageModelV3
): Promise<LanguageModelV3StreamPart[]> {
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    inputFormat: "messages" as never
  } as never);
  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function types(parts: LanguageModelV3StreamPart[]): string[] {
  return parts.map((p) => p.type);
}

function textContent(parts: LanguageModelV3StreamPart[]): string {
  return parts
    .filter((p) => p.type === "text-delta")
    .map((p) => (p as { delta: string }).delta)
    .join("");
}

// ---------------------------------------------------------------------------
// OpenAI (Responses API — default model factory)
// ---------------------------------------------------------------------------

describe("OpenAI Responses API replay", () => {
  it("replays text deltas", async () => {
    const raw = sse(
      '{"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5.4"}}',
      '{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}',
      '{"type":"response.output_text.delta","item_id":"item_1","delta":"Hello"}',
      '{"type":"response.output_text.delta","item_id":"item_1","delta":" world"}',
      '{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5}}}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch })("gpt-5.4")
    });
    const parts = await collectStream(model);
    expect(textContent(parts)).toBe("Hello world");
    expect(types(parts)).toContain("finish");
  });

  it("replays function calls", async () => {
    const raw = sse(
      '{"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5.4"}}',
      '{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"getWeather","arguments":""}}',
      '{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"city\\":\\"Paris\\"}"}',
      '{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"getWeather","arguments":"{\\"city\\":\\"Paris\\"}"}}',
      '{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":15}}}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch })("gpt-5.4")
    });
    const parts = await collectStream(model);
    const toolTypes = types(parts);
    // The Responses API model may emit tool calls as tool-call or
    // tool-input-start + tool-input-end depending on the SDK version
    const hasToolCall =
      toolTypes.includes("tool-call") || toolTypes.includes("tool-input-start");
    expect(hasToolCall).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

describe("OpenAI Chat Completions replay", () => {
  it("replays text deltas", async () => {
    const raw = sse(
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch }).chat("gpt-4.1")
    });
    const parts = await collectStream(model);
    expect(textContent(parts)).toBe("Hello world");
  });

  it("replays tool calls", async () => {
    const raw = sse(
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"getWeather","arguments":""}}]},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch }).chat("gpt-4.1")
    });
    const parts = await collectStream(model);
    const toolCall = parts.find((p) => p.type === "tool-call");
    expect(toolCall).toBeDefined();
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "getWeather"
    });
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("Anthropic replay", () => {
  it("replays text deltas", async () => {
    const raw = sse(
      '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":0}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createAnthropic({ apiKey: "replay", fetch })("claude-sonnet-4-6")
    });
    const parts = await collectStream(model);
    expect(textContent(parts)).toBe("Hello world");
  });

  it("replays thinking blocks", async () => {
    const raw = sse(
      '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":0}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}',
      '{"type":"content_block_stop","index":1}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}',
      '{"type":"message_stop"}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createAnthropic({ apiKey: "replay", fetch })("claude-sonnet-4-6")
    });
    const parts = await collectStream(model);
    expect(types(parts)).toContain("reasoning-start");
    expect(types(parts)).toContain("reasoning-delta");
    expect(types(parts)).toContain("reasoning-end");
    expect(textContent(parts)).toBe("Answer");
  });

  it("replays tool use", async () => {
    const raw = sse(
      '{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":0}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"getWeather","input":{}}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"ci"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ty\\": \\"Paris\\"}"}}',
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}',
      '{"type":"message_stop"}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createAnthropic({ apiKey: "replay", fetch })("claude-sonnet-4-6")
    });
    const parts = await collectStream(model);
    const toolCall = parts.find((p) => p.type === "tool-call");
    expect(toolCall).toBeDefined();
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolCallId: "toolu_1",
      toolName: "getWeather"
    });
  });
});

// ---------------------------------------------------------------------------
// Workers AI (via fake binding)
// ---------------------------------------------------------------------------

describe("Workers AI replay", () => {
  it("replays OpenAI-compatible format", async () => {
    const raw = sse(
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello from Workers AI"},"finish_reason":null}]}',
      '{"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createWorkersAI({
          accountId: "replay",
          apiKey: "replay",
          fetch
        })("@cf/moonshotai/kimi-k2.5")
    });
    const parts = await collectStream(model);
    expect(textContent(parts)).toBe("Hello from Workers AI");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("second doStream returns empty finish (single-use)", async () => {
    const raw = sse(
      '{"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5.4"}}',
      '{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}',
      '{"type":"response.output_text.delta","item_id":"item_1","delta":"Hello"}',
      '{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5}}}'
    );
    const model = createReplayModel({
      buffer: mockBuffer(raw),
      bufferId: "test",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch })("gpt-5.4")
    });

    // First call has content
    const parts1 = await collectStream(model);
    expect(parts1.some((p) => p.type === "text-delta")).toBe(true);

    // Second call is empty finish
    const parts2 = await collectStream(model);
    expect(types(parts2)).toEqual(["stream-start", "finish"]);
  });

  it("doStream throws on buffer fetch failure", async () => {
    const model = createReplayModel({
      buffer: {
        fetch: async () => new Response("Not found", { status: 404 })
      } as unknown as Fetcher,
      bufferId: "missing",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch })("gpt-5.4")
    });

    await expect(
      model.doStream({ prompt: [], inputFormat: "prompt" as never } as never)
    ).rejects.toThrow("Buffer resume failed (404)");
  });

  it("doGenerate throws", async () => {
    const model = createReplayModel({
      buffer: mockBuffer(""),
      bufferId: "test",
      createModel: (fetch) =>
        createOpenAI({ apiKey: "replay", fetch })("gpt-5.4")
    });
    await expect(model.doGenerate({ prompt: [] } as never)).rejects.toThrow(
      "stream-only"
    );
  });
});
