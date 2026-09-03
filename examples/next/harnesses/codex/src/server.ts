import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { createWorkersAI } from "workers-ai-provider";
import { CodexHarness } from "./codex-harness";

type PromptRequest = {
  readonly prompt?: unknown;
  readonly operationId?: unknown;
};

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
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.codex);

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // /sessions/:session/<route>/<operationId?>
    const [route, operationId] = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(2);

    if (request.method === "POST" && route === "submit") {
      const body = (await request.json().catch(() => ({}))) as PromptRequest;
      if (typeof body.prompt !== "string") {
        return json({ error: "prompt must be a string" }, 400);
      }
      const receipt = await this.codex.submit({
        prompt: body.prompt,
        ...(typeof body.operationId === "string"
          ? { operationId: body.operationId }
          : {})
      });
      return json(receipt, receipt.accepted ? 202 : 200);
    }

    if (request.method === "GET" && route === "operations" && operationId) {
      const snapshot = await this.codex.snapshot(operationId);
      return snapshot
        ? json(snapshot)
        : json({ error: "operation not found" }, 404);
    }

    if (request.method === "GET" && route === "events" && operationId) {
      const snapshot = await this.codex.snapshot(operationId);
      return snapshot
        ? json({ events: await this.codex.events(operationId) })
        : json({ error: "operation not found" }, 404);
    }

    if (request.method === "GET" && route === "file") {
      const path = url.searchParams.get("path");
      if (!path) return json({ error: "path is required" }, 400);
      const content = await this.workspace.readFile(path);
      return json(
        content === null
          ? { path, found: false }
          : { path, found: true, content }
      );
    }

    if (request.method === "POST" && route === "restart") {
      // Abort the Durable Object after the response is sent so the demo can
      // show the operation and Workspace surviving a fresh incarnation.
      setTimeout(() => this.ctx.abort("restart requested from the demo"), 50);
      return json({ restarting: true });
    }

    return json({ error: "unknown route" }, 404);
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [root, session] = url.pathname.split("/").filter(Boolean);
    if (root !== "sessions" || session === undefined) {
      return Promise.resolve(
        json({ error: "use /sessions/:session/<route>" }, 404)
      );
    }
    return env.Coder.getByName(session).fetch(request);
  }
} satisfies ExportedHandler<Env>;
