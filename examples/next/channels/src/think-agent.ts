import { DurableObject } from "cloudflare:workers";
import {
  Channels,
  type GatewayEvent,
  type GatewayOrigin
} from "agents/experimental/channels";
import { WebChannel } from "agents/experimental/channels/web";
import { ThinkHarness } from "agents/harness/think";
import { Lifecycle } from "agents/lifecycle";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const tools = {
  // No execute: the browser of the participant who asked runs it.
  getLocation: tool({
    description: "Get the user's location",
    inputSchema: z.object({})
  }),
  // Harmless, so the example can show an approval without side effects.
  flipCoin: tool({
    description: "Flip a coin, once the user approves",
    inputSchema: z.object({}),
    needsApproval: true,
    execute: async () => (Math.random() < 0.5 ? "Heads" : "Tails")
  })
};

/**
 * A Think agent served to browsers and terminals through Channels. The
 * harness keeps the transcript and runs one message at a time, queueing the
 * rest; Channels carries events in and responses out.
 */
export class ThinkAgent extends DurableObject<Env> {
  readonly harness = new ThinkHarness({
    model: createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code"
    ),
    tools,
    maxSteps: 5
  });
  readonly channels = Channels.forHarness(this.harness, {
    channels: { web: new WebChannel() }
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.channels.streams)
    .use(this.channels)
    .use(this.channels.websockets);

  /** Inbound events the gateway routes here. */
  receive(event: GatewayEvent, origin: GatewayOrigin) {
    return this.channels.receive(event, origin);
  }
}
