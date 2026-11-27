import type { LanguageModel } from "ai";

/**
 * Scripted fake model. The last user text picks the script:
 *   "long <n> [delay <ms>]"  n text deltas, optional delay before each
 *   "tool"                   step 1 calls getWeather, step 2 answers
 *   "client"                 calls getUserLocation (client tool, no execute)
 *   "approve"                calls deleteFile (needs approval)
 *   anything else            one short text delta
 */

type Prompt = Array<{
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}>;

function lastUserText(prompt: Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

function hasToolResult(prompt: Prompt): boolean {
  const last = prompt[prompt.length - 1];
  return last?.role === "tool";
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

let calls = 0;
const failed = new Set<string>();

/** Text deltas the fake model has streamed in this isolate, for scenarios that act mid-reply. */
export const streamed = { deltas: 0 };

export function fakeModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "perf",
    modelId: "perf-fake",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream(options: { prompt: Prompt; abortSignal?: AbortSignal }) {
      calls++;
      const id = `t-${calls}`;
      const text = lastUserText(options.prompt).trim();
      const toolDone = hasToolResult(options.prompt);
      const signal = options.abortSignal;
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          const callTool = (name: string, input: unknown) => {
            const tid = `call-${calls}`;
            const json = JSON.stringify(input);
            controller.enqueue({
              type: "tool-input-start",
              id: tid,
              toolName: name
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: tid,
              delta: json
            });
            controller.enqueue({ type: "tool-input-end", id: tid });
            controller.enqueue({
              type: "tool-call",
              toolCallId: tid,
              toolName: name,
              input: json
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage
            });
            controller.close();
          };
          if (!toolDone) {
            if (text === "tool")
              return callTool("getWeather", { city: "Paris" });
            if (text === "client") return callTool("getUserLocation", {});
            if (text === "approve")
              return callTool("deleteFile", { path: "/tmp/x" });
          }
          // "overloaded <nonce>": the first call for a nonce streams three deltas and
          // then fails as a provider does when overloaded (transient); later calls answer.
          if (text.startsWith("overloaded ") && !failed.has(text)) {
            failed.add(text);
            controller.enqueue({ type: "text-start", id });
            for (let i = 0; i < 3; i++)
              controller.enqueue({ type: "text-delta", id, delta: `p${i} ` });
            controller.error(
              Object.assign(new Error("Overloaded"), { statusCode: 529 })
            );
            return;
          }
          const m = /^long (\d+)(?: delay (\d+))?/.exec(text);
          const n = m ? Number(m[1]) : 1;
          const delay = m?.[2] ? Number(m[2]) : 0;
          controller.enqueue({ type: "text-start", id });
          for (let i = 0; i < n; i++) {
            if (signal?.aborted) break;
            if (delay) await new Promise((r) => setTimeout(r, delay));
            controller.enqueue({
              type: "text-delta",
              id,
              delta: m ? `w${i} ` : "ok"
            });
            streamed.deltas++;
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as unknown as LanguageModel;
}
