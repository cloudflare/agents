import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { routeAgentRequest } from "agents";
import { PiHarness, type PiExtension } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { PiSessionSockets } from "./sockets";
import { JAVASCRIPT_BACKEND, workspaceTools } from "./workspace";

const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** The playground's system prompt. */
const playground: PiExtension = (ctx) =>
  ctx.prompt.transform((prompt) =>
    prompt.set("preamble", {
      render: () =>
        "You are a concise playground assistant. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. Paths are absolute. Use tools whenever they can answer the request, and explain their results plainly.",
      tag: false
    })
  );

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  // A durable filesystem on the object's SQLite, beside pi's own tables.
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
  readonly harness = new PiHarness({
    providers: [this.ai.provider],
    defaults: {
      model: this.ai(MODEL_ID),
      thinkingLevel: "low",
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 }
    },
    extensions: {
      playground,
      workspace: workspaceTools(this.workspace)
    },
    harnessOptions: {
      onReport: (error) => console.warn("pi report", error)
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
