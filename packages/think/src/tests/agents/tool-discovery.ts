import type { LanguageModel, ModelMessage, ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { action, Think } from "../../think";
import type {
  Action,
  ActionAuthorizationDecision,
  PrepareStepContext,
  StepConfig,
  ToolCallContext,
  ToolDiscovery,
  TurnConfig
} from "../../think";

/** One scripted model response: call a tool, or answer in text. */
export type DiscoveryScriptStep =
  | { tool: string; input?: Record<string, unknown> }
  | { text: string };

export type DiscoveryTurnOptions = {
  /** `activeTools` returned from `beforeTurn`. */
  activeTools?: string[];
  /** Swap the default search for one that also names an unauthorized tool. */
  customSearch?: boolean;
  /** Tool the turn's `toolChoice` forces, from `beforeTurn`. */
  forceTool?: string;
  /** Tool `beforeStep` forces on the first step. */
  forceFirstStepTool?: string;
  /**
   * Plain tools `beforeTurn` adds, replacing any of the same name. Each
   * returns `{ activated: ["tool_5"] }`, the shape of a discovery result.
   */
  extraTools?: string[];
  /** From this step on, `beforeStep` replaces the messages with the prompt alone. */
  trimMessagesFromStep?: number;
};

export type DiscoveryOutput = {
  kind: string;
  activated: string[];
  note?: string;
};

export type DiscoveryTurnReport = {
  /** Tool names in each model request of the turn. */
  requests: string[][];
  /** Tools `beforeToolCall` saw. */
  beforeToolCalls: string[];
  /** Tools whose `execute` ran. */
  executed: string[];
  /** Outputs of the turn's discovery calls. */
  discoveryOutputs: DiscoveryOutput[];
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

/**
 * 100 deferred synthetic tools, one deferred action that needs a permission
 * the turn never grants, and one eager tool (#2277).
 */
export class ThinkToolDiscoveryAgent extends Think {
  override toolDiscovery: false | ToolDiscovery = {
    defer: (name) => name.startsWith("tool_") || name === "admin_action"
  };
  private _script: DiscoveryScriptStep[] = [];
  private _requests: string[][] = [];
  private _beforeToolCalls: string[] = [];
  private _executed: string[] = [];
  private _options: DiscoveryTurnOptions = {};

  override getModel(): LanguageModel {
    const next = () => this._script.shift() ?? { text: "done" };
    const requests = this._requests;
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "tool-discovery-mock",
      supportedUrls: {},
      doGenerate() {
        throw new Error("doGenerate not implemented in mock");
      },
      doStream(options: { tools?: Array<{ name: string }> }) {
        requests.push((options.tools ?? []).map((t) => t.name));
        const step = next();
        const call = requests.length;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if ("tool" in step) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call-${call}`,
                toolName: step.tool,
                input: JSON.stringify(step.input ?? {})
              });
            } else {
              controller.enqueue({ type: "text-start", id: `t${call}` });
              controller.enqueue({
                type: "text-delta",
                id: `t${call}`,
                delta: step.text
              });
              controller.enqueue({ type: "text-end", id: `t${call}` });
            }
            controller.enqueue({
              type: "finish",
              finishReason: {
                unified: "tool" in step ? "tool-calls" : "stop",
                raw: undefined
              },
              usage
            });
            controller.close();
          }
        });
        return Promise.resolve({ stream });
      }
    } as LanguageModel;
  }

  override getTools(): ToolSet {
    const tools: ToolSet = {
      eager_echo: tool({
        description: "Echo",
        inputSchema: z.object({}),
        execute: async () => "echo"
      })
    };
    for (let i = 0; i < 100; i++) {
      const name = `tool_${i}`;
      tools[name] = tool({
        description:
          i === 42 ? "Weather forecasts for a city" : `Synthetic tool ${i}`,
        inputSchema: z.object({}),
        execute: async () => {
          this._executed.push(name);
          return `result ${i}`;
        }
      });
    }
    return tools;
  }

  override getActions(): Record<string, Action> {
    return {
      admin_action: action({
        description: "Administer weather stations",
        inputSchema: z.object({}),
        permissions: ["admin"],
        execute: async () => {
          this._executed.push("admin_action");
          return "administered";
        }
      })
    };
  }

  override authorizeTurn(): ActionAuthorizationDecision {
    return { allowed: true, grantedPermissions: [] };
  }

  override beforeTurn(): TurnConfig | void {
    const { activeTools, forceTool, extraTools } = this._options;
    const config: TurnConfig = {};
    if (activeTools) config.activeTools = activeTools;
    if (forceTool) config.toolChoice = { type: "tool", toolName: forceTool };
    if (extraTools) {
      config.tools = Object.fromEntries(
        extraTools.map((name) => [
          name,
          tool({
            description: `Replacement ${name}`,
            inputSchema: z.object({}),
            execute: async () => {
              this._executed.push(name);
              return { activated: ["tool_5"] };
            }
          })
        ])
      );
    }
    return config;
  }

  override beforeStep(ctx: PrepareStepContext):
    | (StepConfig & {
        toolChoice?: { type: "tool"; toolName: string };
        messages?: ModelMessage[];
      })
    | void {
    const { forceFirstStepTool: forced, trimMessagesFromStep } = this._options;
    if (forced && ctx.stepNumber === 0) {
      return { toolChoice: { type: "tool", toolName: forced } };
    }
    if (
      trimMessagesFromStep !== undefined &&
      ctx.stepNumber >= trimMessagesFromStep
    ) {
      return { messages: [{ role: "user", content: "go" }] };
    }
  }

  override beforeToolCall(ctx: ToolCallContext): void {
    this._beforeToolCalls.push(ctx.toolName);
  }

  async runTurnForTest(
    script: DiscoveryScriptStep[],
    options: DiscoveryTurnOptions = {}
  ): Promise<DiscoveryTurnReport> {
    this._script = [...script];
    this._requests.length = 0;
    this._beforeToolCalls = [];
    this._executed = [];
    this._options = options;
    if (options.customSearch && this.toolDiscovery) {
      this.toolDiscovery = {
        ...this.toolDiscovery,
        search: () => ["admin_action", "tool_7", "not_a_tool"]
      };
    }
    const before = this.messages.length;
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "go" }]
      }
    ]);
    const discoveryOutputs = this.messages
      .slice(before)
      .flatMap((message: UIMessage) => message.parts)
      .flatMap((part) =>
        /^tool-discover_tools(?:_\d+)?$/.test(part.type) && "output" in part
          ? [part.output as DiscoveryOutput]
          : []
      );
    return {
      requests: this._requests.map((names) => [...names]),
      beforeToolCalls: this._beforeToolCalls,
      executed: this._executed,
      discoveryOutputs
    };
  }
}
