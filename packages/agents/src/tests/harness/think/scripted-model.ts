import type { LanguageModel } from "ai";

/** One scripted model call. */
export type ModelTurn =
  | { readonly text: string }
  | {
      readonly calls: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly input: unknown;
      }>;
      readonly text?: string;
    }
  | { readonly error: string }
  /** Stream this text, then hang until the call is aborted. */
  | { readonly hang: string };

const finishReason = (unified: "stop" | "tool-calls") => ({
  unified,
  raw: undefined
});
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

/**
 * A v3 language model that answers each call with the next scripted turn and
 * records the prompt it was given. An exhausted script answers "(done)".
 */
export function scriptedModel(
  script: ModelTurn[],
  prompts: unknown[][]
): LanguageModel {
  let call = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not scripted");
    },
    doStream(options: { prompt: unknown[]; abortSignal?: AbortSignal }) {
      prompts.push(options.prompt);
      call += 1;
      const turn = script.shift() ?? { text: "(done)" };
      const id = `text-${call}`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if ("error" in turn) {
            controller.enqueue({ type: "error", error: new Error(turn.error) });
            controller.close();
            return;
          }
          const text =
            "text" in turn ? turn.text : "hang" in turn ? turn.hang : undefined;
          if (text) {
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: text });
          }
          if ("hang" in turn) {
            options.abortSignal?.addEventListener("abort", () => {
              controller.error(options.abortSignal?.reason);
            });
            return;
          }
          if (text) controller.enqueue({ type: "text-end", id });
          const calls = "calls" in turn ? turn.calls : [];
          for (const toolCall of calls) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              input: JSON.stringify(toolCall.input)
            });
          }
          controller.enqueue({
            type: "finish",
            finishReason: finishReason(
              calls.length > 0 ? "tool-calls" : "stop"
            ),
            usage
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as unknown as LanguageModel;
}
