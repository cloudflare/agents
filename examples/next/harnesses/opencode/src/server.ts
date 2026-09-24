import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { WebSockets } from "agents/websockets";
import { OpenCodeHarness } from "./harness/opencode-harness";
import type { OCEvent } from "./harness/types";

/**
 * An OpenCode session hosted by one Durable Object.
 *
 * The composition is intentionally identical in shape to the pi harness
 * example in cloudflare/agents#2338 — that is the point of the proof of
 * concept. Swapping the third-party runtime changes only the capability, not
 * the way durability, streaming, and transport are wired.
 */
export class OpenCodeAgent extends DurableObject<Env> {
  readonly streams = new Streams();

  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    agent: "build",
    permissions: "ask",
    config: {
      // No filesystem exists in a Durable Object, so config is inline.
      model: "anthropic/claude-sonnet-4-5",
      // Tools that need an execution plane are unavailable under the workerd
      // profile; leaving them enabled would surface as a clear defect at call
      // time rather than a silent hang, but disabling them is honest.
      permission: { bash: "deny", edit: "deny" }
    }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.stateMachine)
    .use(this.webSockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Surface durable turn lifecycle in the tail log for local `wrangler
    // dev` observability; a real host would forward these to its own sink.
    this.harness.on((event: OCEvent) => {
      if (event.type === "fault" || event.type === "operation_end") {
        console.log("opencode", event);
      }
    });
  }

  /** Convenience RPC for a non-browser caller. */
  async ask(text: string) {
    const { result, messages } = await this.harness.prompt(text);
    return { result, messages };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("OpenCode harness request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
