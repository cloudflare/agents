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

function callBash(command: string, backend: "container" | null = "container") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: crypto.randomUUID(),
          toolName: "bash",
          input: JSON.stringify({
            command,
            ...(backend ? { backend } : {}),
            timeout: 30
          })
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
      if (serialized.includes("TEST: use default shell") && !hasToolResult) {
        return callBash("printf shell-ok", null);
      }
      if (serialized.includes("TEST: hold container turn") && !hasToolResult) {
        return callBash(
          "mkdir -p /temp; sleep 2; printf lifecycle-ok > /temp/lifecycle-marker"
        );
      }
      if (
        serialized.includes("TEST: repository install recovery") &&
        !hasToolResult
      ) {
        return callBash(
          [
            "set -e",
            "root=/workspace/recovery-fixture",
            'mkdir -p "$root/vendor/tiny" /temp',
            "count=0; test ! -f /temp/recovery-command-count || count=$(cat /temp/recovery-command-count)",
            "printf '%s' $((count + 1)) > /temp/recovery-command-count",
            'printf \'%s\' \'{"name":"fixture","private":true,"dependencies":{"tiny":"file:vendor/tiny"}}\' > "$root/package.json"',
            'printf \'%s\' \'{"name":"tiny","version":"1.0.0","main":"index.js"}\' > "$root/vendor/tiny/package.json"',
            'printf "module.exports = \'installed\';\\n" > "$root/vendor/tiny/index.js"',
            'cd "$root"',
            "npm install --ignore-scripts --no-package-lock --no-audit --no-fund >/temp/recovery-install.log 2>&1",
            "mkdir -p dist",
            "node -e \"require('node:fs').writeFileSync('dist/result.txt', require('tiny'))\"",
            "printf 'recovery-command-ok count='; cat /temp/recovery-command-count"
          ].join("\n")
        );
      }
      if (serialized.includes("TEST: repository install recovery")) {
        // Leave a visible non-terminal window after the durable tool result is
        // recorded, so the E2E can prove recovery does not replay the command.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return finishText("repository-install-recovered");
      }
      return finishText(`captured-run-context: ${serialized}`);
    }
  });
}
