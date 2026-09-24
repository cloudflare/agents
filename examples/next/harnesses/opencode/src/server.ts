import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { WebSockets } from "agents/websockets";
import { OpenCodeHarness, type OCEvent } from "agents/opencode";
import { createSessionName } from "./session";

export class OpenCodeAgent extends DurableObject<Env> {
  readonly streams = new Streams();

  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    agent: "build",
    config: {
      model: "anthropic/claude-sonnet-4-5",
      permission: { bash: "deny", edit: "deny" }
    }
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.streams)
    .use(this.harness.driver)
    .use(this.webSockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.harness.on((event: OCEvent) => {
      if (event.type === "fault" || event.type === "operation_end") {
        console.log("opencode", event);
      }
    });
  }

  async prompt(text: string) {
    const { result, messages } = await this.harness.prompt(text);
    return { result, messages };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      return Response.json({ session: createSessionName() });
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
