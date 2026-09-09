import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { createWorkersAI } from "workers-ai-provider";
import { SelfModifyingHarness } from "./self-modifying-harness";

/** Plain Durable Object hosting the self-modifying Lifecycle capability. */
export class SelfModifyingHarnessObject extends DurableObject<Env> {
  readonly workersAI = createWorkersAI({ binding: this.env.AI });
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "self_modifying"
  });
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new SelfModifyingHarness({
    tasks: this.tasks,
    streams: this.streams,
    workspace: this.workspace,
    loader: this.env.LOADER,
    model: this.workersAI("@cf/moonshotai/kimi-k2.7-code")
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
