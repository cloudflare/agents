import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { routeAgentRequest } from "agents";
import { OpenCodeHarness } from "agents/harness/opencode";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/opencode";
import { Streams } from "agents/streams";
import { WebSockets } from "agents/websockets";
import { openCodeRequest } from "./cli";
import { OpenCodeSessionSockets } from "./sockets";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

const PREAMBLE =
  "You are a concise playground assistant. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. Paths are absolute. Use tools whenever they can answer the request, and explain their results plainly.";

/** Playable OpenCode session backed by one Durable Object. */
export class OpenCodeAgent extends DurableObject<Env> {
  // Workers AI over the AI binding, as OpenCode's own Workers AI provider.
  readonly ai = createAI({ binding: this.env.AI });
  // A durable filesystem on the object's SQLite, beside OpenCode's tables.
  // `exec` runs JavaScript modules in a fresh Dynamic Worker per call, with
  // no network of its own. `git` turns on `workspace.git`, which `ws:git`
  // calls in the host; `allowGitNetwork` lets it clone, fetch and push.
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: JAVASCRIPT_BACKEND,
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        allowGitNetwork: true
      })
    ]
  });
  // The Workspace tools, in place of OpenCode's local filesystem and shell.
  readonly tools = createWorkspaceTools(this.workspace);
  readonly streams = new Streams();
  readonly harness = new OpenCodeHarness({
    streams: this.streams,
    providers: [this.ai.provider],
    plugins: [this.tools.plugin],
    config: { agents: { build: { system: PREAMBLE } } },
    defaults: { model: this.ai(MODEL_ID) }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new OpenCodeSessionSockets(
    this.harness,
    this.tools.tools,
    (tag) => this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.streams)
    .use(this.webSockets);

  /** Host startup, after the harness has booted OpenCode. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }

  /** OpenCode's own HTTP API, for the OpenCode CLI. See `cli.ts`. */
  async onRequest(request: Request): Promise<Response> {
    return this.harness.fetch(openCodeRequest(request));
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
      console.error("OpenCode playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
