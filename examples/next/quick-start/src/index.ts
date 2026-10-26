import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { webFetchTool } from "agents/webfetch/pi";

export class Assistant extends DurableObject<Env> {
  // Workers AI, and other providers through AI Gateway, as a Pi provider.
  readonly ai = createAI({ binding: this.env.AI });
  // Pi's tools and system prompt live in a registry.
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    // Opens Pi when the object starts. Pi keeps every step of every
    // conversation in this object's SQLite database.
    harness: ({ storage, context, onWake }) => {
      this.registry.install({
        name: "assistant",
        tools: [webFetchTool({ binding: this.env.AI })]
      });
      const models = createModels();
      models.setProvider(this.ai.provider);
      // Pi calls onWake when it next needs to run, and the harness sets the
      // object's alarm for then, so Pi carries on after the object sleeps.
      return Harness.open(
        storage,
        { models, registry: this.registry, onWake },
        context
      );
    },
    defaults: { model: this.ai("@cf/zai-org/glm-5.3-flash") }
  });

  // Class fields run top to bottom, so the Lifecycle comes after the
  // capabilities it uses.
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async ask(prompt: string) {
    return (await this.harness.prompt(prompt)).text;
  }
}

export default {
  // Anyone with this URL can use your AI quota. Add auth before you deploy.
  async fetch(request: Request, env: Env) {
    // One agent per name. Use a user id to give each user their own agent.
    const assistant = env.Assistant.getByName("default");
    return new Response(await assistant.ask(await request.text()));
  }
} satisfies ExportedHandler<Env>;
