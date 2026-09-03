import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { createWorkersAI } from "workers-ai-provider";
import { SelfModifyingHarness } from "./self-modifying-harness";
import { handleSelfModifyingHarnessRequest } from "./http";

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
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);

  /** Serve the operator API and durable turn streams. */
  onRequest(request: Request): Promise<Response> {
    return handleSelfModifyingHarnessRequest(
      this.harness,
      this.streams,
      request
    );
  }
}

function objectRoute(url: URL): { name: string; path: string } | null {
  const match = url.pathname.match(/^\/api\/objects\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const name = decodeURIComponent(match[1] ?? "");
  if (name.trim() === "") return null;
  return { name, path: match[2] ?? "/state" };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = objectRoute(url);
    if (!route) return new Response("Not found", { status: 404 });
    const id = env.SELF_MODIFYING_HARNESS.idFromName(route.name);
    const stub = env.SELF_MODIFYING_HARNESS.get(id);
    url.pathname = route.path;
    return stub.fetch(new Request(url, request));
  }
} satisfies ExportedHandler<Env>;
