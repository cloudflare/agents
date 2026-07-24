/**
 * Test agent for Think's built-in fetch-tools integration. Verifies that the
 * opt-in `fetchTools` property registers `fetch_url` in the assembled tool set
 * and that the capability prompt advertises it, while staying absent when
 * unconfigured. `beforeTurn` captures the assembled tools/system prompt.
 */
import type { LanguageModel } from "ai";
import { Think } from "../../think";
import type { StreamCallback, TurnContext } from "../../think";

const v3FinishReason = (unified: "stop" | "tool-calls") => ({
  unified,
  raw: undefined
});
const v3Usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens,
    cacheRead: 0,
    cacheWrite: 0
  },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
});

class CollectingCallback implements StreamCallback {
  doneCalled = false;
  errorMessage?: string;
  onStart(): void {}
  onEvent(): void {}
  onDone(): void {
    this.doneCalled = true;
  }
  onError(error: string): void {
    this.errorMessage = error;
  }
}

function createTextModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-fetch-tools",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason("stop"),
            usage: v3Usage(10, 5)
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

export class ThinkFetchToolsTestAgent extends Think {
  override maxSteps = 1;
  private _lastToolNames: string[] = [];
  private _lastSystem = "";

  override getModel(): LanguageModel {
    return createTextModel();
  }

  override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  override beforeTurn(ctx: TurnContext): void {
    this._lastToolNames = Object.keys(ctx.tools);
    this._lastSystem = ctx.system;
  }

  /** Enable fetch tools with a public allowlist before the next turn. */
  async enableFetch(): Promise<void> {
    this.fetchTools = { allowlist: ["https://developers.cloudflare.com/**"] };
  }

  /** Run one turn and report the assembled tool names + system prompt. */
  async captureTurn(): Promise<{ toolNames: string[]; system: string }> {
    const cb = new CollectingCallback();
    await this.chat("hello", cb);
    return { toolNames: this._lastToolNames, system: this._lastSystem };
  }
}
