import { Workspace } from "@cloudflare/shell";
import { Harness } from "@cloudflare/agents-next-harness";
import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { createWorkersAI } from "workers-ai-provider";
import { CODEX_DEMO_FILE, CodexRuntime } from "./codex-runtime";
import type {
  CodexKernelSnapshot,
  CodexProtocol,
  CodexRestartAck,
  CodexRouteError,
  CodexWorkspaceFile
} from "./protocol";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";

/**
 * Plain Durable Object composing the shared Harness over the Codex runtime.
 *
 * The harness serves the whole conversation over its own browser link. The
 * two routes below are the demo's own: reading the Workspace file the tools
 * write, and aborting the object so the UI can watch a turn resume from
 * durable state.
 */
export class Coder extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex",
    // Files past the inline threshold spill to R2; SQLite rows cannot hold
    // them.
    r2: this.env.WORKSPACE,
    r2Prefix: this.ctx.id.toString()
  });
  readonly codex = new CodexRuntime({
    sessions: this.sessions,
    workspace: this.workspace,
    model: createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" }
    })(MODEL)
  });
  readonly harness = new Harness<CodexProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.codex
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.webSockets)
    .use(this.harness);

  /**
   * The demo's HTTP routes. Lifecycle offers every request to the installed
   * capabilities first and dispatches what they decline here, and
   * `routeAgentRequest` forwards the whole path, so these are reached at
   * `/agents/coder/<name>/<route>`.
   */
  async onRequest(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname
      .split("/")
      .filter(Boolean)
      .slice(3);
    if (request.method === "POST" && route[0] === "restart") {
      // Abort after the reply is sent so the client can watch the operation
      // and the Workspace survive a fresh incarnation.
      setTimeout(() => this.ctx.abort("restart requested from the demo"), 50);
      return json<CodexRestartAck>({ restarting: true });
    }
    if (request.method === "GET" && route[0] === "file") {
      return json<CodexWorkspaceFile>(
        await this.codex.readFile(CODEX_DEMO_FILE)
      );
    }
    if (request.method === "GET" && route[0] === "operation" && route[1]) {
      const snapshot = this.codex.kernelSnapshot(route[1]);
      return snapshot === null
        ? json<CodexRouteError>({ error: `Unknown operation ${route[1]}` }, 404)
        : json<CodexKernelSnapshot>(snapshot);
    }
    return json<CodexRouteError>(
      { error: `Unknown route /${route.join("/")}` },
      404
    );
  }
}

function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
