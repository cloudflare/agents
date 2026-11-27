/**
 * The harness-backed Think (always, under either test config): its tools
 * change when a test says so, so a turn's prefix changes.
 */
import type { LanguageModel, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Think } from "../../harness/think";
import type { StreamCallback } from "../../think";

const LATE_KEY = "test:late";

function textModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-prefix-changed",
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
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 }
            }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

const quiet: StreamCallback = {
  onStart() {},
  onEvent() {},
  onDone() {},
  onError() {}
};

export class ThinkPrefixChangedAgent extends Think {
  override getModel(): LanguageModel {
    return textModel();
  }

  override getTools(): ToolSet {
    return this.ctx.storage.kv.get<boolean>(LATE_KEY)
      ? {
          late: tool({
            description: "Added later",
            inputSchema: z.object({}),
            execute: async () => "late"
          })
        }
      : {};
  }

  addLateTool(): void {
    this.ctx.storage.kv.put(LATE_KEY, true);
  }

  async say(text: string): Promise<void> {
    await this.chat(text, quiet);
  }

  lastText(): string {
    const last = this.messages[this.messages.length - 1];
    return last.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("");
  }
}
