import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { createWorkersAI } from "workers-ai-provider";
import { CodexHarness } from "./codex-harness";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** Plain Durable Object composed with the Codex Lifecycle capability. */
export class Coder extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex"
  });
  readonly codex = new CodexHarness({
    tasks: this.tasks,
    streams: this.streams,
    workspace: this.workspace,
    model: createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" }
    })(MODEL)
  });
  readonly webSockets = new WebSockets(
    this.codex.webSockets({
      // Abort the object after the reply is sent so the client can watch the
      // operation and Workspace survive a fresh incarnation.
      restart: () =>
        setTimeout(() => this.ctx.abort("restart requested from the demo"), 50)
    })
  );
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.codex);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
