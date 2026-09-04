import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { Type } from "typebox";
import { PiHarness } from "../harness/pi-harness";
import type { PiEvent, PiMessage, PiTool } from "../harness/types";
import { createModels } from "../providers/models";

const multiplyParameters = Type.Object({ value: Type.Number() });
const TOOL_REVISION_KEY = "test:pi:revision";

type ToolContext = {
  readonly revision: number;
};

function messageText(message: PiMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** Real Durable Object fixture using pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new PiHarness<ToolContext>({
    models: createModels({ providers: [this.#faux.provider] }),
    model: this.#faux.getModel(),
    tasks: this.tasks,
    streams: this.streams,
    thinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
    toolContext: async () => ({
      revision: (await this.ctx.storage.get<number>(TOOL_REVISION_KEY)) ?? 1
    }),
    tools: () => [this.#multiplyTool()],
    systemPrompt: "Use the supplied test tool."
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /** Run one pi-ai faux-provider turn containing a tool call. */
  async runMultiply(
    value: number,
    revision: number
  ): Promise<{
    readonly operationId: string;
    readonly status: string;
    readonly messages: readonly string[];
    readonly result: number | null;
  }> {
    await this.ctx.storage.put(TOOL_REVISION_KEY, revision);
    this.#faux.setResponses([
      fauxAssistantMessage(fauxToolCall("multiply", { value }), {
        stopReason: "toolUse"
      }),
      fauxAssistantMessage("tool complete")
    ]);
    const response = await this.harness.prompt(`multiply ${value}`);
    const resultPart = response.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-result")
      .at(-1);
    const result =
      resultPart?.type === "tool-result" &&
      typeof resultPart.details === "object" &&
      resultPart.details !== null &&
      "result" in resultPart.details &&
      typeof resultPart.details.result === "number"
        ? resultPart.details.result
        : null;
    return {
      operationId: response.operationId,
      status: response.status,
      messages: response.messages.map(messageText),
      result
    };
  }

  /** Read the durable transcript without starting another model turn. */
  async messages(): Promise<readonly string[]> {
    return (await this.harness.getMessages()).map(messageText);
  }

  /** Read projected event type names from one operation's durable stream. */
  async eventTypes(operationId: string): Promise<readonly string[]> {
    const events: PiEvent[] = [];
    for await (const chunk of this.streams.read(
      this.harness.streamId(operationId)
    )) {
      events.push(...(chunk.chunk as unknown as PiEvent[]));
    }
    return events.map((event) => event.type);
  }

  #multiplyTool(): PiTool<
    ToolContext,
    typeof multiplyParameters,
    { readonly result: number; readonly revision: number }
  > {
    return {
      name: "multiply",
      label: "Multiply",
      description: "Multiply by the current tool revision.",
      parameters: multiplyParameters,
      replay: "safe",
      async execute(_id, input, _onUpdate, context) {
        const result = input.value * context.revision;
        return {
          content: [{ type: "text", text: String(result) }],
          details: { result, revision: context.revision }
        };
      }
    };
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
