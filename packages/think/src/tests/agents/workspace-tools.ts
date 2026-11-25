/**
 * Test agent for Think's workspace tools: the `@cloudflare/computer` tool
 * set Think adds to every turn, shaped by the backends on `workspace`.
 * `beforeTurn` captures the assembled tools and
 * system prompt so tests can inspect them and call the tools directly.
 */
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import {
  createAITools,
  forAISDKTools
} from "@cloudflare/computer/tools/ai-sdk";
import { streamText, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { Think } from "../../think";
import type { StreamCallback, TurnContext } from "../../think";

/** The tool definitions each model request carried, in order. */
type RequestTools = { name?: string }[] | undefined;

function createTextModel(requests: RequestTools[] = []): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-workspace-tools",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: { tools?: { name?: string }[] }) {
      requests.push(options.tools);
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
  #overrideRead = false;
  readonly #requests: RequestTools[] = [];

  override getModel(): LanguageModel {
    return createTextModel(this.#requests);
  }

  /**
   * The workspace tools' definitions as a turn sent them to the model, and
   * as `streamText` sends `createAITools()` given directly: both as JSON.
   */
  async workspaceToolRequests(): Promise<{
    turn: string;
    direct: string;
    order: (string | undefined)[];
  }> {
    await this.chat("hello", noopCallback);
    const turn = this.#requests.at(-1) ?? [];
    const directRequests: RequestTools[] = [];
    const result = streamText({
      model: createTextModel(directRequests),
      tools: createAITools({ workspace: this.workspace }),
      prompt: "hello"
    });
    await result.consumeStream();
    const direct = directRequests[0] ?? [];
    const names = new Set(direct.map((entry) => entry.name));
    return {
      turn: JSON.stringify(turn.filter((entry) => names.has(entry.name))),
      direct: JSON.stringify(direct),
      order: turn.map((entry) => entry.name)
    };
  }

  override getSystemPrompt(): string {
    return "You are a test assistant.";
  }

  override getTools(): ToolSet {
    const tools: ToolSet = {
      shout: tool({
        description: "Upper-case some text.",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => text.toUpperCase()
      })
    };
    if (this.#overrideRead) {
      tools.read = tool({
        description: "The agent's own read tool.",
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => `custom read of ${path}`
      });
    }
    return tools;
  }

  override beforeTurn(ctx: TurnContext): void {
    this.#tools = ctx.tools;
    this.#system = ctx.system;
  }

  /** Add a `read` tool of the agent's own through `getTools()`. */
  async overrideRead(): Promise<void> {
    this.#overrideRead = true;
  }

  /** Give the Workspace a JavaScript backend so `exec` appears. */
  async addCodemodeBackend(): Promise<void> {
    this.workspace = new Workspace({
      storage: this.ctx.storage,
      backends: [
        new CodemodeBackend({
          loader: this.env.LOADER,
          modules: {
            "codemode:tools": createToolBindings(
              forAISDKTools(() => this.getTools())
            )
          }
        })
      ]
    });
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
