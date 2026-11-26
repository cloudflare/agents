/**
 * Test agent that loads a hooks-only extension subscribing to all four
 * observation hooks (`beforeToolCall`, `afterToolCall`, `onStepFinish`,
 * `onChunk`). Each extension hook handler writes a marker file via the
 * host bridge, so the test can assert that Think actually dispatched the
 * hook to the extension worker.
 */

import type { LanguageModel, UIMessage, ToolSet } from "ai";
import { tool } from "ai";
import { Agent } from "agents";
import { z } from "zod";
import { Think } from "../../think";
import { createThinkExtensionManager } from "../../extensions/wiring";
import { WorkspaceFiles } from "../../workspace-files";
import type { StreamCallback, ThinkModel, TurnConfig } from "../../think";

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
  onStart(): void {}
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
      const entries = await new WorkspaceFiles(this.workspace).list(
        "/workspace/ext-log"
      );
      return entries.map((e: { name: string }) => e.name);
    } catch {
      return [];
    }
  }

  async readExtLogFile(name: string): Promise<unknown | null> {
    try {
      const content = await new WorkspaceFiles(this.workspace).readText(
        `/workspace/ext-log/${name}`
      );
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

const BEFORE_TURN_EXTENSION_SOURCE = `{
  tools: {},
  hooks: {
    beforeTurn: async (ctx, host) => {
      await host?.writeFile("ext-log/before-turn.json", JSON.stringify(ctx));
      return {};
    }
  }
}`;

/**
 * The default model is a Workers AI id and the test env has no `AI` binding,
 * so resolving the default throws. `beforeTurn` supplies its own model and a
 * `beforeTurn` extension is registered: the turn must never touch the default.
 */
export class ThinkExtensionBeforeTurnModelAgent extends Think {
  extensionLoader = this.env.LOADER;

  override getModel(): ThinkModel {
    return "@cf/qwen/qwen3.8-27b";
  }

  override beforeTurn(): TurnConfig {
    return { model: createMockToolModel() };
  }

  override getExtensions() {
    return [
      {
        manifest: {
          name: "turnrec",
          version: "1.0.0",
          description: "records beforeTurn snapshots",
          permissions: { workspace: "read-write" as const },
          hooks: ["beforeTurn" as const]
        },
        source: BEFORE_TURN_EXTENSION_SOURCE
      }
    ];
  }

  async testChat(message: string): Promise<{ done: boolean; error?: string }> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return { done: cb.doneCalled, error: cb.errorMessage };
  }

  async readBeforeTurnSnapshot(): Promise<{ modelId: string } | null> {
    const content = await new WorkspaceFiles(this.workspace).readText(
      "/workspace/ext-log/before-turn.json"
    );
    return content == null ? null : JSON.parse(content);
  }
}

const NETWORK_EXTENSION_SOURCE = `{
  tools: {
    get: {
      description: "Fetch a URL",
      parameters: { url: { type: "string" } },
      required: ["url"],
      execute: async (args) => {
        try {
          const response = await fetch(args.url);
          return { status: response.status, body: await response.text() };
        } catch (error) {
          return { thrown: String(error) };
        }
      }
    }
  }
}`;

/** An extension that may reach one listed host, through the host bridge. */
export class ThinkExtensionNetworkAgent extends Think {
  extensionLoader = this.env.LOADER;

  override getModel(): LanguageModel {
    return createMockToolModel();
  }

  override getExtensions() {
    return [
      {
        manifest: {
          name: "net",
          version: "1.0.0",
          permissions: { network: ["allowed.example", "127.0.0.1"] }
        },
        source: NETWORK_EXTENSION_SOURCE
      }
    ];
  }

  async fetchThroughExtension(url: string): Promise<unknown> {
    await this.__unsafe_ensureInitialized();
    const tool = this.extensionManager?.getTools().net_get;
    return tool?.execute?.(
      { url },
      { toolCallId: crypto.randomUUID(), messages: [], context: undefined }
    );
  }
}

const TURN_CONTROL_EXTENSION_SOURCE = `{
  tools: {},
  hooks: {
    beforeTurn: async (ctx, host) => {
      await host?.sendMessage("from the extension");
      return { toolChoice: "required", maxSteps: 1 };
    },
    onChunk: async (ctx, host) => {
      if (typeof ctx.text !== "string") return;
      const seen = (await host?.readFile("ext-log/text.txt")) ?? "";
      await host?.writeFile("ext-log/text.txt", seen + ctx.text);
    }
  }
}`;

/**
 * An extension that sets a turn's tool choice and step limit from
 * `beforeTurn`, sends a message from it, and records streamed text.
 */
type HostPropsSeen = {
  agentPath?: { className: string; name: string }[];
  rootJurisdiction?: string;
};

export class ThinkExtensionTurnAgent extends Think {
  extensionLoader = this.env.LOADER;
  readonly toolChoices: unknown[] = [];

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
    const toolChoices = this.toolChoices;
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "mock-turn-controls",
      supportedUrls: {},
      doGenerate() {
        throw new Error("doGenerate not implemented in mock");
      },
      doStream(options: Record<string, unknown>) {
        toolChoices.push(options.toolChoice);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "hel" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "lo" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "tool-call",
              toolCallId: `tc${toolChoices.length}`,
              toolName: "ping",
              input: JSON.stringify({ msg: "hi" })
            });
            controller.enqueue({
              type: "finish",
              finishReason: v3FinishReason("tool-calls"),
              usage: v3Usage(10, 5)
            });
            controller.close();
          }
        });
        return Promise.resolve({ stream });
      }
    } as LanguageModel;
  }

  override getExtensions() {
    return [
      {
        manifest: {
          name: "turnctl",
          version: "1.0.0",
          permissions: {
            workspace: "read-write" as const,
            session: { sendMessage: true }
          }
        },
        source: TURN_CONTROL_EXTENSION_SOURCE
      }
    ];
  }

  async testChat(message: string): Promise<{ done: boolean; error?: string }> {
    const cb = new TestCollectingCallback();
    await this.chat(message, cb);
    return { done: cb.doneCalled, error: cb.errorMessage };
  }

  /**
   * The props a host binding gets, for an agent at `agentPath` under a
   * root in `rootJurisdiction`. The loader stops the load after that.
   */
  async hostPropsForTest(
    agentPath: { className: string; name: string }[],
    rootJurisdiction: DurableObjectJurisdiction | undefined
  ): Promise<HostPropsSeen[]> {
    const seen: HostPropsSeen[] = [];
    const manager = createThinkExtensionManager({
      loader: {
        get() {
          throw new Error("stop after the host binding");
        }
      } as unknown as WorkerLoader,
      storage: this.ctx.storage,
      agentClassName: "Kid",
      agentId: "kid-id",
      agentPath,
      rootJurisdiction,
      exports: {
        HostBridgeLoopback: (options: { props: HostPropsSeen }) => {
          seen.push({
            agentPath: options.props.agentPath,
            rootJurisdiction: options.props.rootJurisdiction
          });
          return {};
        }
      }
    });
    await manager
      .load(
        {
          name: "probe",
          version: "1.0.0",
          permissions: { workspace: "read" }
        },
        "{ tools: {} }"
      )
      .catch(() => {});
    return seen;
  }

  modelCalls(): { count: number; toolChoices: unknown[] } {
    return { count: this.toolChoices.length, toolChoices: this.toolChoices };
  }

  async streamedText(): Promise<string | null> {
    return new WorkspaceFiles(this.workspace).readText(
      "/workspace/ext-log/text.txt"
    );
  }

  async activeTexts(): Promise<string[]> {
    return (await this.getMessages()).map(
      (message) =>
        `${message.role}: ${message.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")}`
    );
  }
}

/** Holds a ThinkExtensionTurnAgent as a sub-agent (a facet). */
export class ThinkExtensionTurnParent extends Agent<Cloudflare.Env> {
  #kid() {
    return this.subAgent(ThinkExtensionTurnAgent, "kid");
  }

  async kidChat(message: string) {
    return (await this.#kid()).testChat(message);
  }

  async kidCalls() {
    return (await this.#kid()).modelCalls();
  }

  async kidTexts() {
    return (await this.#kid()).activeTexts();
  }

  async kidStreamed() {
    return (await this.#kid()).streamedText();
  }
}
