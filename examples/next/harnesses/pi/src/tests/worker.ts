import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  PiHarness,
  createModels,
  type PiMessage,
  type PiTool
} from "agents/pi";
import { Streams } from "agents/streams";
import { Type } from "typebox";

const parameters = Type.Object({ value: Type.Number() });

type Env = {
  PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
};

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
  let lastUser = -1;
  for (let index = 0; index < context.messages.length; index++) {
    if (context.messages[index].role === "user") lastUser = index;
  }
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

export class PiHarnessTestObject extends DurableObject<Env> {
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

  constructor(ctx: DurableObjectState, env: Env) {
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

  submit(lane: string, operationId: string, value: number) {
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

export default { fetch: () => new Response("Not found", { status: 404 }) };
