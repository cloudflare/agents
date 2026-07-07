import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function finishText(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text-1" },
        { type: "text-delta" as const, id: "text-1", delta: text },
        { type: "text-end" as const, id: "text-1" },
        {
          type: "finish" as const,
          usage,
          finishReason: { unified: "stop" as const, raw: undefined }
        }
      ]
    })
  };
}

function callBash(command: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: crypto.randomUUID(),
          toolName: "bash",
          input: JSON.stringify({ command, backend: "container", timeout: 30 })
        },
        {
          type: "finish" as const,
          usage,
          finishReason: { unified: "tool-calls" as const, raw: undefined }
        }
      ]
    })
  };
}

/** The E2E suite's only adapter: inference. Everything else is production. */
export function mockInference(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const serialized = JSON.stringify(prompt);
      const hasToolResult = serialized.includes('"role":"tool"');
      if (serialized.includes("TEST: exhaust step budget")) {
        return callBash("true");
      }
      if (
        serialized.includes("TEST: hold active container lease") &&
        !hasToolResult
      ) {
        return callBash(
          "mkdir -p /workspace/temp; sleep 2; printf lifecycle-ok > /workspace/temp/lifecycle-marker"
        );
      }
      return finishText(`captured-run-context: ${serialized}`);
    }
  });
}
