/**
 * Test agent that loads a hooks-only extension subscribing to all four
 * observation hooks (`beforeToolCall`, `afterToolCall`, `onStepFinish`,
 * `onChunk`). Each extension hook handler writes a marker file via the
 * host bridge, so the test can assert that Think actually dispatched the
 * hook to the extension worker.
 */

import type { LanguageModel, UIMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type { StreamCallback } from "../../think";

// AI SDK v3 LanguageModel spec helpers — keep in sync with the helpers
// in `assistant-agent-loop.ts` / `think-session.ts`.
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

class TestCollectingCallback implements StreamCallback {
  events: string[] = [];
  doneCalled = false;
  errorMessage?: string;
  onEvent(json: string): void {
    this.events.push(json);
  }
  onDone(): void {
    this.doneCalled = true;
  }
  onError(error: string): void {
    this.errorMessage = error;
  }
}

function createMockToolModel(): LanguageModel {
  let toolCallCount = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-tool-model-ext-hooks",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: Record<string, unknown>) {
      toolCallCount++;
      const messages = (options as { prompt?: unknown[] }).prompt ?? [];
      const hasToolResult = messages.some(
        (m: unknown) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "tool"
      );

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (!hasToolResult && toolCallCount === 1) {
            controller.enqueue({
              type: "tool-input-start",
              id: "tc1",
              toolName: "ping"
            });
            controller.enqueue({
              type: "tool-input-delta",
              id: "tc1",
              delta: JSON.stringify({ msg: "hi" })
            });
            controller.enqueue({ type: "tool-input-end", id: "tc1" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "ping",
              input: JSON.stringify({ msg: "hi" })
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
          } else {
            controller.enqueue({ type: "text-start", id: "tfin" });
            controller.enqueue({
              type: "text-delta",
              id: "tfin",
              delta: "ok"
            });
            controller.enqueue({ type: "text-end", id: "tfin" });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("stop"),
              usage: v3Usage(20, 10)
            });
          }
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

// Extension that subscribes to all four observation hooks. Each handler
// appends a marker file to the workspace so the test can read them back.
const HOOKS_EXTENSION_SOURCE = `{
  tools: {},
  hooks: {
    beforeToolCall: async (ctx, host) => {
      // host is null when 'workspace' permission is "none"; we set
      // "read-write" in the manifest so it should be available.
      await host?.writeFile("ext-log/before-" + ctx.toolName + ".json", JSON.stringify(ctx));
    },
    afterToolCall: async (ctx, host) => {
      await host?.writeFile("ext-log/after-" + ctx.toolName + ".json", JSON.stringify(ctx));
    },
    onStepFinish: async (ctx, host) => {
      await host?.writeFile("ext-log/step-" + ctx.stepNumber + ".json", JSON.stringify(ctx));
    },
    onChunk: async (ctx, host) => {
      // High-frequency — only record one marker per chunk type so the
      // workspace doesn't fill up with hundreds of files.
      await host?.writeFile("ext-log/chunk-" + ctx.type + ".json", JSON.stringify(ctx));
    }
  }
}`;

export class ThinkExtensionHookAgent extends Think {
  override maxSteps = 3;
  extensionLoader = this.env.LOADER;

  override getTools(): ToolSet {
    return {
      ping: tool({
        description: "ping",
        inputSchema: z.object({ msg: z.string() }),
        execute: async ({ msg }: { msg: string }) => `pong: ${msg}`
      })
    };
  }

  override getModel(): LanguageModel {
    return createMockToolModel();
  }

  override getExtensions() {
    return [
      {
        manifest: {
          name: "hookrec",
          version: "1.0.0",
          description: "records hook invocations",
          permissions: { workspace: "read-write" as const },
          hooks: [
            "beforeToolCall" as const,
            "afterToolCall" as const,
            "onStepFinish" as const,
            "onChunk" as const
          ]
        },
        source: HOOKS_EXTENSION_SOURCE
      }
    ];
  }

  async testChat(message: string): Promise<{ done: boolean; error?: string }> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return { done: cb.doneCalled, error: cb.errorMessage };
  }

  async listExtLogFiles(): Promise<string[]> {
    try {
      const entries = await this.workspace.readDir("ext-log");
      return entries.map((e: { name: string }) => e.name);
    } catch {
      return [];
    }
  }

  async readExtLogFile(name: string): Promise<unknown | null> {
    try {
      const content = await this.workspace.readFile(`ext-log/${name}`);
      if (content == null) return null;
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }
}
