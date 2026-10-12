/**
 * Test agent for Think's workspace tools: the `@cloudflare/computer` tool
 * set Think adds to every turn, configured through `workspaceTools` and the
 * backends on `workspace`. `beforeTurn` captures the assembled tools and
 * system prompt so tests can inspect them and call the tools directly.
 */
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forAISDKTools } from "@cloudflare/computer/tools/ai-sdk";
import { tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type { StreamCallback, TurnContext } from "../../think";

function createTextModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-workspace-tools",
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
                total: 10,
                noCache: 10,
                cacheRead: 0,
                cacheWrite: 0
              },
              outputTokens: { total: 5, text: 5, reasoning: 0 }
            }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

const noopCallback: StreamCallback = {
  onStart() {},
  onEvent() {},
  onDone() {},
  onError() {}
};

export class ThinkWorkspaceToolsAgent extends Think {
  override maxSteps = 1;
  #tools: ToolSet = {};
  #system = "";

  override getModel(): LanguageModel {
    return createTextModel();
  }

  override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  override getTools(): ToolSet {
    return {
      shout: tool({
        description: "Upper-case some text.",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => text.toUpperCase()
      })
    };
  }

  override beforeTurn(ctx: TurnContext): void {
    this.#tools = ctx.tools;
    this.#system = ctx.system;
  }

  /** Turn the workspace tools off. */
  async disableWorkspaceTools(): Promise<void> {
    this.workspaceTools = false;
  }

  /** Give the Workspace a JavaScript backend so `exec` appears. */
  async addJavaScriptBackend(description?: string): Promise<void> {
    this.workspace = new Workspace({
      storage: this.ctx.storage,
      backends: [
        new WorkerJavaScriptBackend({
          id: "js",
          loader: this.env.LOADER,
          modules: {
            "ws:tools": createToolBindings(forAISDKTools(() => this.getTools()))
          }
        })
      ]
    });
    if (description) this.workspaceTools = { exec: { js: { description } } };
  }

  /** Run one turn and report the assembled tool names and system prompt. */
  async captureTurn(): Promise<{ toolNames: string[]; system: string }> {
    await this.chat("hello", noopCallback);
    return { toolNames: Object.keys(this.#tools).sort(), system: this.#system };
  }

  /** The description the model sees for one captured tool. */
  async toolDescription(name: string): Promise<string | null> {
    const description = this.#tools[name]?.description;
    return typeof description === "string" ? description : null;
  }

  /**
   * Call one tool from the last captured turn. The result is returned as
   * JSON so it crosses RPC whatever its shape.
   */
  async callTool(name: string, input: unknown): Promise<string> {
    const execute = this.#tools[name]?.execute;
    if (!execute) throw new Error(`No tool named ${name}`);
    let output: unknown = await execute(
      input as never,
      {
        toolCallId: "test",
        messages: [],
        context: {}
      } as never
    );
    // A streaming tool yields progress; the last value is its result.
    if (
      typeof output === "object" &&
      output !== null &&
      Symbol.asyncIterator in output
    ) {
      let last: unknown;
      for await (const value of output as AsyncIterable<unknown>) last = value;
      output = last;
    }
    return JSON.stringify(output);
  }
}
