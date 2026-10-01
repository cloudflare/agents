import { DurableObject } from "cloudflare:workers";
import { ToolTask } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { PiHarness } from "./harness/pi-harness";
import { PiSessionSockets } from "./sockets";
import { createModels } from "./providers/models";
import { workersAI } from "./providers/workers-ai";
import { createTools, MAX_SLEEP_SECONDS, MODEL_ID } from "./tools";

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  readonly harness = new PiHarness({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    thinkingLevel: "low",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
    tools: createTools(),
    systemPrompt:
      "You are a concise playground assistant. You can read the current UTC time with current_time and wait with sleep. Use tools whenever they can answer the request, and explain their results plainly.",
    configure: (registry) => {
      registry.hooks.add(ToolTask, {
        beforeTool: (call) =>
          call.name === "sleep" &&
          typeof call.arguments.seconds === "number" &&
          call.arguments.seconds > MAX_SLEEP_SECONDS
            ? { block: `sleep is capped at ${MAX_SLEEP_SECONDS} seconds.` }
            : undefined
      });
    }
  });
  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(this.harness, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
