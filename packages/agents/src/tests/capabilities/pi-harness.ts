import { DurableObject } from "cloudflare:workers";
import { PiHarness, Type, type PiMessage, type PiTool } from "agents/harness";
import {
  createFauxPiRuntime,
  fauxPiAssistantMessage,
  fauxPiToolCall
} from "agents/harness/testing";
import { Lifecycle } from "agents/lifecycle";

const TOOL_REVISION_KEY = "test:pi-harness:tool-revision";
const numberParameters = Type.Object({ value: Type.Number() });

type ToolContext = {
  readonly revision: number;
};

type ToolResultSnapshot = {
  readonly text: string;
  readonly revision: number;
  readonly result: number;
};

function toolResultSnapshots(
  messages: readonly PiMessage[]
): ToolResultSnapshot[] {
  const snapshots: ToolResultSnapshot[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type !== "tool-result" ||
        typeof part.details !== "object" ||
        part.details === null ||
        !("revision" in part.details) ||
        typeof part.details.revision !== "number" ||
        !("result" in part.details) ||
        typeof part.details.result !== "number"
      ) {
        continue;
      }
      const text = part.content.find((content) => content.type === "text");
      if (!text || text.type !== "text") continue;
      snapshots.push({
        text: text.text,
        revision: part.details.revision,
        result: part.details.result
      });
    }
  }
  return snapshots;
}

function toolInputValue(event: unknown): number | undefined {
  if (typeof event !== "object" || event === null || !("args" in event)) {
    return undefined;
  }
  const args = event.args;
  if (typeof args !== "object" || args === null || !("value" in args)) {
    return undefined;
  }
  return typeof args.value === "number" ? args.value : undefined;
}

/** Real Durable Object fixture for the pi harness capability. */
export class PiHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = createFauxPiRuntime();
  readonly pi: PiHarness<ToolContext>;
  readonly lifecycle: Lifecycle;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.pi = new PiHarness<ToolContext>({
      models: this.#faux.models,
      model: this.#faux.model,
      compaction: {
        enabled: false,
        reserveTokens: 0,
        keepRecentTokens: 0
      },
      toolContext: async () => ({
        revision: (await ctx.storage.get<number>(TOOL_REVISION_KEY)) ?? 1
      }),
      tools: () => [this.#multiplyTool()],
      configure: (hooks) => {
        hooks.on("before_tool", (event) => {
          const value = toolInputValue(event);
          return value === undefined
            ? undefined
            : { args: { value: value + 1 } };
        });
      }
    });
    this.lifecycle = Lifecycle.install(this).use(this.pi);
  }

  /** Change behavior behind the same tool name without replacing the harness. */
  async setToolRevision(revision: number): Promise<void> {
    await this.ctx.storage.put(TOOL_REVISION_KEY, revision);
  }

  /** Run a real pi model turn containing one tool call and a final response. */
  async runTool(value: number): Promise<{
    status: string;
    kind: string;
    toolResults: ToolResultSnapshot[];
  }> {
    this.#faux.setResponses([
      fauxPiAssistantMessage(fauxPiToolCall("multiply", { value }), {
        stopReason: "toolUse"
      }),
      fauxPiAssistantMessage("tool finished")
    ]);
    const response = await this.pi.prompt(`multiply ${value}`);
    return {
      status: response.status,
      kind: "kind" in response ? response.kind : "run",
      toolResults: toolResultSnapshots(response.messages)
    };
  }

  /** Read durable tool results without running another model turn. */
  async toolResults(): Promise<ToolResultSnapshot[]> {
    return toolResultSnapshots(await this.pi.getMessages());
  }

  #multiplyTool(): PiTool<
    ToolContext,
    typeof numberParameters,
    { readonly revision: number; readonly result: number }
  > {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply a number by the current tool revision.",
      parameters: numberParameters,
      replay: "safe",
      execute: async (_toolCallId, parameters, onUpdate, toolContext) => {
        const result = parameters.value * toolContext.revision;
        onUpdate(
          {
            content: [{ type: "text", text: `working:${result}` }],
            details: { revision: toolContext.revision, result }
          },
          { checkpoint: true }
        );
        return {
          content: [{ type: "text", text: String(result) }],
          details: { revision: toolContext.revision, result }
        };
      }
    };
  }
}
