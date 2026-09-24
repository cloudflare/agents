import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Type } from "typebox";
import { Lifecycle } from "../../lifecycle";
import { createModels } from "../../pi/models";
import { PiHarness } from "../../pi/pi-harness";
import type { PiMessage, PiTool } from "../../pi/types";
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
  return fauxAssistantMessage(fauxToolCall("multiply", { value }), {
    stopReason: "toolUse"
  });
}

export class PiDriverHarnessObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = fauxProvider();
  readonly streams = new Streams();
  readonly harness = new PiHarness<ToolContext>({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    streams: this.streams,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    toolContext: { multiplier: 3 },
    tools: [this.#tool()],
    systemPrompt: "Use the supplied tool."
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
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
