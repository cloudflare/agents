import type { LanguageModel, ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type { MediaEvictionConfig } from "../../think";

/**
 * Prompt-cache prefix measurement (#2200). Providers cache on a byte-identical
 * prompt prefix, so for each turn this records how much of the first model
 * request is a prefix of the request sent before it.
 */
export type PromptCacheScenario = {
  turns: number;
  /** Size of the `lookup` tool output called once per turn. 0 skips the tool. */
  toolOutputChars?: number;
  /** Size of each user message. */
  userTextChars?: number;
  /** Attach a data-URL image of this size to the first user message. */
  firstTurnMediaChars?: number;
  /** Run a Think media eviction pass after each turn. */
  mediaEviction?: MediaEvictionConfig;
  /** Compact every older message into one summary past this token estimate. */
  compactAfterTokens?: number;
  /** Override `truncationStep`. */
  truncationStep?: number;
};

export type PromptCacheTurn = {
  turn: number;
  messages: number;
  requestChars: number;
  /** Chars of this turn's first request shared with the previous request. */
  sharedPrefixChars: number;
  /** Index of the first model message that differs, or null if none did. */
  firstChangedMessage: number | null;
  compactionCalls?: number[];
};

const v3Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

export class ThinkPromptCacheTestAgent extends Think {
  override mediaEviction: MediaEvictionConfig | boolean = false;
  private _requests: unknown[][] = [];
  private _toolOutputChars = 0;
  private _compactionCalls: number[] = [];

  override getModel(): LanguageModel {
    const requests = this._requests;
    const useTool = () => this._toolOutputChars > 0;
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "prompt-cache-mock",
      supportedUrls: {},
      doGenerate() {
        throw new Error("doGenerate not implemented in mock");
      },
      doStream(options: { prompt: unknown[] }) {
        requests.push(options.prompt);
        const call = requests.length;
        const last = options.prompt.at(-1) as { role?: string } | undefined;
        const callTool = useTool() && last?.role === "user";
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (callTool) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `lookup-${call}`,
                toolName: "lookup",
                input: "{}"
              });
            } else {
              controller.enqueue({ type: "text-start", id: `t${call}` });
              controller.enqueue({
                type: "text-delta",
                id: `t${call}`,
                delta: "Here is the answer."
              });
              controller.enqueue({ type: "text-end", id: `t${call}` });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: callTool ? "tool-calls" : "stop",
                raw: undefined
              },
              usage: v3Usage
            });
            controller.close();
          }
        });
        return Promise.resolve({ stream });
      }
    } as LanguageModel;
  }

  override getTools(): ToolSet {
    return {
      lookup: tool({
        description: "Look something up",
        inputSchema: z.object({}),
        execute: async () => "r".repeat(this._toolOutputChars)
      })
    };
  }

  async measurePromptCacheForTest(
    scenario: PromptCacheScenario
  ): Promise<PromptCacheTurn[]> {
    this._toolOutputChars = scenario.toolOutputChars ?? 0;
    if (scenario.mediaEviction) this.mediaEviction = scenario.mediaEviction;
    if (scenario.truncationStep !== undefined) {
      this.truncationStep = scenario.truncationStep;
    }
    if (scenario.compactAfterTokens !== undefined) {
      this.session
        .onCompaction(async (messages) => {
          this._compactionCalls.push(messages.length);
          const older = messages.slice(0, -4);
          if (older.length < 2) return null;
          return {
            summary: `summary of ${older.length} messages`,
            fromMessageId: older[0].id,
            toMessageId: older[older.length - 1].id
          };
        })
        .compactAfter(scenario.compactAfterTokens);
    }

    const report: PromptCacheTurn[] = [];
    for (let turn = 0; turn < scenario.turns; turn++) {
      const before = this._requests.length;
      const text = `question ${turn} ${"q".repeat(scenario.userTextChars ?? 0)}`;
      const parts: UIMessage["parts"] = [{ type: "text", text }];
      if (turn === 0 && scenario.firstTurnMediaChars) {
        parts.push({
          type: "file",
          mediaType: "image/png",
          url: `data:image/png;base64,${"A".repeat(scenario.firstTurnMediaChars)}`
        });
      }
      await this.saveMessages([{ id: `u${turn}`, role: "user", parts }]);
      if (scenario.mediaEviction) await this._evictAgedMediaBestEffort();

      const current = this._requests[before];
      const previous = this._requests[before - 1];
      const currentJson = current.map((message) => JSON.stringify(message));
      const serialized = JSON.stringify(current);
      let sharedPrefixChars = 0;
      let firstChangedMessage: number | null = null;
      if (previous) {
        const previousSerialized = JSON.stringify(previous);
        while (
          sharedPrefixChars < serialized.length &&
          serialized[sharedPrefixChars] ===
            previousSerialized[sharedPrefixChars]
        ) {
          sharedPrefixChars++;
        }
        const previousJson = previous.map((message) => JSON.stringify(message));
        const index = previousJson.findIndex(
          (message, i) => message !== currentJson[i]
        );
        firstChangedMessage = index === -1 ? null : index;
      }
      report.push({
        turn,
        messages: current.length,
        requestChars: serialized.length,
        sharedPrefixChars,
        firstChangedMessage,
        compactionCalls: [...this._compactionCalls]
      });
    }
    return report;
  }
}
