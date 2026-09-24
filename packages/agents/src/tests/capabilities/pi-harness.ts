import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Type } from "typebox";
import { DurableToolRuns } from "../../driver";
import type { DurableToolInspection } from "../../driver";
import { Lifecycle } from "../../lifecycle";
import { createPiDurableTool } from "../../pi/durable-tools";
import { createModels } from "../../pi/models";
import { PiHarness } from "../../pi/pi-harness";
import type { PiMessage, PiTool, PiToolResult } from "../../pi/types";
import { Streams } from "../../streams";

const parameters = Type.Object({ value: Type.Number() });

type ToolContext = { multiplier: number };

function text(message: PiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function response(context: {
  readonly messages: readonly { role: string; content: unknown }[];
}) {
  const lastUser = context.messages.findLastIndex(
    (message) => message.role === "user"
  );
  if (
    context.messages
      .slice(lastUser + 1)
      .some((message) => message.role === "toolResult")
  ) {
    return fauxAssistantMessage("complete");
  }
  const prompt = context.messages
    .slice(lastUser)
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content))
    .join(" ");
  const value = Number(/multiply (-?\d+(?:\.\d+)?)/.exec(prompt)?.[1] ?? 0);
  const toolName = prompt.includes("durable multiply")
    ? "durable_multiply"
    : "multiply";
  return fauxAssistantMessage(fauxToolCall(toolName, { value }), {
    stopReason: "toolUse"
  });
}

export class PiDriverHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  readonly streams = new Streams();
  readonly durableTools = new DurableToolRuns<
    { value: number },
    PiToolResult<{ result: number }>
  >({
    id: "pi-multiply",
    runtime: {
      inspect: async (runId) =>
        (await this.ctx.storage.get<
          DurableToolInspection<PiToolResult<{ result: number }>>
        >(`external:${runId}`)) ?? { status: "not-started" },
      start: async (runId, input) => {
        const starts =
          (await this.ctx.storage.get<number>("durable-tool-starts")) ?? 0;
        await this.ctx.storage.put("durable-tool-starts", starts + 1);
        await this.ctx.storage.put("durable-tool-last", { runId, input });
        const hold =
          (await this.ctx.storage.get<boolean>("durable-tool-hold")) ?? false;
        await this.ctx.storage.put(
          `external:${runId}`,
          hold
            ? { status: "running" }
            : {
                status: "completed",
                result: {
                  content: [{ type: "text", text: String(input.value * 3) }],
                  details: { result: input.value * 3 }
                }
              }
        );
      },
      cancel: async (runId) => {
        await this.ctx.storage.put(`external:${runId}`, {
          status: "cancelled"
        });
      }
    },
    wake: (owner) => this.harness.driver.wake(owner.scope),
    heartbeatMs: 1
  });
  readonly harness = new PiHarness<ToolContext>({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    streams: this.streams,
    durableTools: this.durableTools,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    toolContext: { multiplier: 3 },
    tools: [this.#tool(), this.#durableTool()],
    systemPrompt: "Use the supplied tool."
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.durableTools)
    .use(this.harness.driver)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#faux.setResponses(
      Array.from(
        { length: 16 },
        () => (context: unknown) =>
          response(
            context as {
              messages: readonly { role: string; content: unknown }[];
            }
          )
      )
    );
  }

  async submitMultiply(lane: string, operationId: string, value: number) {
    return this.harness.submit(
      { kind: "prompt", prompt: `multiply ${value}` },
      { lane, operationId }
    );
  }

  async submitDurableMultiply(
    lane: string,
    operationId: string,
    value: number
  ) {
    return this.harness.submit(
      { kind: "prompt", prompt: `durable multiply ${value}` },
      { lane, operationId }
    );
  }

  holdDurableTools() {
    return this.ctx.storage.put("durable-tool-hold", true);
  }

  async completeDurableTool() {
    const last = await this.ctx.storage.get<{
      runId: string;
      input: { value: number };
    }>("durable-tool-last");
    if (!last) return false;
    await this.ctx.storage.put(`external:${last.runId}`, {
      status: "completed",
      result: {
        content: [{ type: "text", text: String(last.input.value * 3) }],
        details: { result: last.input.value * 3 }
      }
    });
    return true;
  }

  durableToolStarts() {
    return this.ctx.storage.get<number>("durable-tool-starts");
  }

  abort(lane: string, operationId: string) {
    return this.harness.abort({ lane, operationId });
  }

  result(lane: string, operationId: string) {
    return this.harness.getResult(operationId, { lane });
  }

  async messages(lane: string) {
    return (await this.harness.getMessages({ lane })).map(text);
  }

  pending(lane: string) {
    return this.harness.pending({ lane });
  }

  async streamEvents(lane: string, operationId: string) {
    const events: unknown[] = [];
    for await (const chunk of this.streams.read(
      this.harness.streamId(operationId, lane)
    )) {
      if (Array.isArray(chunk.chunk)) events.push(...chunk.chunk);
    }
    return events;
  }

  streamStatus(lane: string, operationId: string) {
    return this.streams.status(this.harness.streamId(operationId, lane));
  }

  #durableTool(): PiTool<ToolContext, typeof parameters, { result: number }> {
    return createPiDurableTool({
      name: "durable_multiply",
      label: "Durable multiply",
      description: "Multiply the input durably.",
      parameters,
      runs: this.durableTools,
      scope: async (_context, invocation) => {
        const pending = await this.harness.driver.pending();
        return (
          pending.find(
            (submission) => submission.operationId === invocation.operationId
          )?.scope ?? "main"
        );
      }
    });
  }

  #tool(): PiTool<ToolContext, typeof parameters, { result: number }> {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply the input.",
      parameters,
      replay: "safe",
      async execute(_id, input, _onUpdate, context) {
        const result = input.value * context.multiplier;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result }
        };
      }
    };
  }
}
