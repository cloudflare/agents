import { DurableObject } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  Channels,
  type GatewayEvent,
  type GatewayOrigin
} from "agents/experimental/channels";
import { WebChannel } from "agents/experimental/channels/web";
import { Lifecycle } from "agents/lifecycle";
import { createModels } from "@earendil-works/pi-ai/models";
import { PiHarness } from "agents/harness/pi";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { piChannelsHarness } from "./channels-harness";

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

function createAppRegistry() {
  const registry = createRegistry();
  registry.systemPrompt.section(
    "preamble",
    () =>
      "You are a concise assistant. Use current_time when asked about the time.",
    { tag: false }
  );
  registry.tools.add({
    name: "current_time",
    description: "Return the current UTC time.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      const iso = new Date().toISOString();
      return { content: [{ type: "text", text: iso }], details: { iso } };
    }
  });
  return registry;
}

/**
 * The pi harness served through Channels. `piChannelsHarness` puts
 * `PiHarness` behind the shared harness interface, and each harness session
 * is a conversation. pi rejects tool answers, so this agent has no client
 * tools or approvals.
 */
export class PiAgent extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createAppRegistry();
  readonly harness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: this.#models(),
          registry: this.registry,
          onReport: (error) => console.warn("pi report", error)
        },
        context
      ),
    defaults: {
      model: { provider: CLOUDFLARE_PROVIDER_ID, modelId: MODEL_ID },
      thinkingLevel: "low"
    }
  });
  readonly channels = Channels.forHarness(
    piChannelsHarness(this.harness, { kv: this.ctx.storage.kv }),
    { channels: { web: new WebChannel() } }
  );
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.channels.streams)
    .use(this.channels)
    .use(this.channels.websockets);

  /** Events from the gateway, such as Slack messages, arrive over RPC. */
  receive(event: GatewayEvent, origin: GatewayOrigin) {
    return this.channels.receive(event, origin);
  }

  #models() {
    const models = createModels();
    models.setProvider(this.ai.provider);
    return models;
  }
}
