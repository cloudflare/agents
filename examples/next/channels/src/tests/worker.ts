import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import type { InputPart } from "agents/experimental/channels";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { piChannelsHarness } from "../pi/channels-harness";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join(" ");
}

/** Echoes the last user message, so tests can see what pi was given. */
function script(context: TranscriptContext) {
  const last = context.messages.filter((m) => m.role === "user").at(-1);
  return fauxAssistantMessage([fauxText(`echo: ${textOf(last?.content)}`)]);
}

/** `piChannelsHarness` over a real `PiHarness` with pi-ai's faux provider. */
export class PiChannelsTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider();
  readonly pi = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createModels();
      models.setProvider(this.#faux.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: createRegistry(),
          settings: {
            retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly harness = piChannelsHarness(this.pi, { kv: this.ctx.storage.kv });
  readonly lifecycle = Lifecycle.install(this).use(this.pi);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 200 }, () => script));
  }

  /** Submit and wait; the result as JSON, or the submit error's message. */
  async send(
    parts: InputPart[],
    messageId: string,
    session?: string
  ): Promise<string> {
    const target = this.harness.session(session);
    let receipt;
    try {
      receipt = await target.submit({ parts, messageId });
    } catch (error) {
      return `rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
    return JSON.stringify(await target.wait(receipt.operationId));
  }

  async fork(from: string): Promise<string> {
    return (await this.harness.sessions.fork(from)).id;
  }

  rootId(): string {
    return this.harness.session().id;
  }

  /** User message ids in a session's transcript, as a client sees them. */
  async userIds(session?: string): Promise<string[]> {
    const watch = await this.harness.session(session).watch();
    await watch.stop();
    return watch.state.messages
      .filter((m) => m.role === "user")
      .map((m) => m.id);
  }
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
