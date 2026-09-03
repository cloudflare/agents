import assert from "node:assert/strict";
import test from "node:test";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";
import type { KernelAction, KernelJson } from "../src/kernel-types";
import { completeCodexModel } from "../src/language-model-v4";

const modelAction: Extract<KernelAction, { type: "model" }> = {
  type: "model",
  effect_id: "model:0",
  request: {
    model: "@cf/moonshotai/kimi-k2.7-code",
    instructions: "Use the available Workspace tools.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Write the requested files." }]
      }
    ],
    tools: [
      {
        type: "function",
        name: "workspace_write",
        description: "Write a UTF-8 file.",
        strict: false,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          },
          required: ["path", "content"]
        }
      }
    ]
  }
};

function fixtureModel(
  parts: LanguageModelV4StreamPart[],
  onCall: (options: LanguageModelV4CallOptions) => void = () => {}
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "fixture-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("fixture only supports streaming");
    },
    async doStream(options) {
      onCall(options);
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          }
        })
      };
    }
  };
}

test("maps four LanguageModelV4 tool calls without dropping a batch", async () => {
  let captured: LanguageModelV4CallOptions | undefined;
  const calls = Array.from({ length: 4 }, (_, index) => ({
    type: "tool-call" as const,
    toolCallId: `call-${index + 1}`,
    toolName: "workspace_write",
    input: JSON.stringify({
      path: `/codex/${index + 1}.txt`,
      content: `${index + 1}\n`
    })
  }));
  const model = fixtureModel(
    [
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "response-four-calls" },
      ...calls,
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: {
            total: 20,
            noCache: 20,
            cacheRead: 0,
            cacheWrite: 0
          },
          outputTokens: { total: 12, text: 0, reasoning: 0 }
        }
      }
    ],
    (options) => {
      captured = options;
    }
  );

  const result = await completeCodexModel(model, modelAction);

  assert.ok(captured);
  assert.deepEqual(captured.prompt, [
    {
      role: "system",
      content: "Use the available Workspace tools."
    },
    {
      role: "user",
      content: [{ type: "text", text: "Write the requested files." }]
    }
  ]);
  assert.deepEqual(captured.tools, [
    {
      type: "function",
      name: "workspace_write",
      description: "Write a UTF-8 file.",
      strict: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  ]);
  assert.deepEqual(result, {
    type: "model",
    frames: [
      ...calls.map((call) => ({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: call.toolCallId,
          name: call.toolName,
          arguments: call.input
        }
      })),
      {
        type: "response.completed",
        response: { id: "response-four-calls", end_turn: false }
      }
    ]
  });
});

test("groups prior call batches and tool results in the V4 prompt", async () => {
  const action: Extract<KernelAction, { type: "model" }> = {
    ...modelAction,
    request: {
      model: "@cf/moonshotai/kimi-k2.7-code",
      instructions: "Use the available Workspace tools.",
      tools: (modelAction.request as { tools: KernelJson[] }).tools,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Write the requested files." }]
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "workspace_write",
          arguments: '{"path":"/codex/1.txt","content":"one"}'
        },
        {
          type: "function_call",
          call_id: "call-2",
          name: "workspace_write",
          arguments: '{"path":"/codex/2.txt","content":"two"}'
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: '{"bytes":3}'
        },
        {
          type: "function_call_output",
          call_id: "call-2",
          output: '{"bytes":3}'
        }
      ]
    }
  };
  let captured: LanguageModelV4CallOptions | undefined;
  const model = fixtureModel(
    [
      { type: "reasoning-start", id: "reasoning-1" },
      {
        type: "reasoning-delta",
        id: "reasoning-1",
        delta: "Both writes "
      },
      {
        type: "reasoning-delta",
        id: "reasoning-1",
        delta: "were verified."
      },
      { type: "reasoning-end", id: "reasoning-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Do" },
      { type: "text-delta", id: "text-1", delta: "ne." },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: 30,
            noCache: 30,
            cacheRead: 0,
            cacheWrite: 0
          },
          outputTokens: { total: 2, text: 2, reasoning: 0 }
        }
      }
    ],
    (options) => {
      captured = options;
    }
  );

  const result = await completeCodexModel(model, action);

  assert.ok(captured);
  assert.deepEqual(captured.prompt.slice(2), [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "workspace_write",
          input: { path: "/codex/1.txt", content: "one" }
        },
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "workspace_write",
          input: { path: "/codex/2.txt", content: "two" }
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "workspace_write",
          output: { type: "text", value: '{"bytes":3}' }
        },
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "workspace_write",
          output: { type: "text", value: '{"bytes":3}' }
        }
      ]
    }
  ]);
  assert.deepEqual(result, {
    type: "model",
    frames: [
      {
        type: "response.reasoning_summary_text.delta",
        delta: "Both writes were verified."
      },
      { type: "response.output_text.delta", delta: "Done." },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }]
        }
      },
      {
        type: "response.completed",
        response: { id: "model:0", end_turn: true }
      }
    ]
  });
});
