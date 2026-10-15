import { DurableObject } from "cloudflare:workers";
import {
  Workspace,
  WorkspaceProxy,
  type DurableObjectStorageLike
} from "@cloudflare/computer";
import {
  ContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { Browser, browserRun, type InternalHostMessage } from "agents/browser";
import { browserTool } from "agents/browser/pi";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { z } from "zod";
import { filesTarget, serveWorkspaceFolder } from "./files-host";
import {
  DOCS_HOST,
  FILES_HOST,
  MODEL_ID,
  PREVIEW_HOST,
  WORKSPACE_DAEMON_PORT,
  type BrowserState
} from "./shared";
import { PiSessionSockets } from "./sockets";
import { createWorkspaceTools } from "./workspace";

// Classes the runtime has to find in the Worker's main module:
// - InternalHostRouter: Browser Run calls back into this Worker through it
//   when the browser requests preview.internal or files.internal.
// - CodemodeRuntime: runs the browser tool's sandboxed code.
// - WorkspaceProxy: carries computerd's connection from the container back
//   to the agent that owns the workspace.
// - DocsSite: serves docs.internal.
export { CodemodeRuntime, InternalHostRouter } from "agents/browser";
export { WorkspaceProxy };
export { DocsSite } from "./docs-site";

const PREAMBLE = `You have a workspace with a Linux container (use exec for shell commands) and a browser that stays open between turns. Your instructions for building things are a website at http://${DOCS_HOST}/, not a file: open it in your browser with the browser tool before you start. Keep replies short.`;

/** What the model passes to `hosts.assign()` for preview.internal. */
const previewTarget = z.object({
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .refine((port) => port !== WORKSPACE_DAEMON_PORT, {
      message: `Port ${WORKSPACE_DAEMON_PORT} is the workspace daemon's; run the dev server on another port`
    })
    .describe(
      `The port a dev server listens on in the workspace container (1024 to 65535, not ${WORKSPACE_DAEMON_PORT})`
    )
});

// Pin DurableObject's generic before the mixin, so withWorkspaceContainer
// sees a concrete class.
class BrowserAgentBase extends DurableObject<Env> {}

/**
 * A pi agent with a container workspace and a persistent browser that can
 * open three sites nobody else can: the dev server in the container, a
 * workspace folder, and the docs Worker.
 */
export class BrowserAgent extends withWorkspaceContainer(BrowserAgentBase) {
  readonly ai = createAI({ binding: this.env.AI });

  /**
   * The container side of the workspace. The agent starts and owns the
   * container through `ctx.container`, and computerd inside it mounts the
   * workspace at /workspace.
   */
  readonly #container = new ContainerBackend({
    container: () => this,
    workspace: { binding: "BrowserAgent", id: this.ctx.id.toString() },
    // The container reaches the internet directly, for npm install.
    egress: { mode: "direct" },
    instance: "standard-2",
    // Kept on the container's disk instead of synced into the workspace.
    // `dist` is synced, so files.internal can serve a build.
    ignore: ["**/node_modules", "**/.vite"]
  });

  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [this.#container]
  });

  /** One browser that stays open between turns, with three internal hosts. */
  readonly browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      // No internet sites, only the internal hostnames (which guardrails
      // don't apply to). A page from the internet could otherwise send
      // requests to preview.internal and reach the container.
      guardrails: { allowedDomains: [] },
      internalHosts: {
        router: this.ctx.exports.InternalHostRouter,
        hosts: {
          [PREVIEW_HOST]: {
            description:
              "A dev server in your workspace container. Assign the port it listens on.",
            target: previewTarget,
            fetch: (request, { port }) => this.#fetchPreview(request, port)
          },
          [FILES_HOST]: {
            description:
              "Static files from a workspace folder, such as a production build. Assign the folder.",
            target: filesTarget,
            fetch: (request, { folder }) =>
              serveWorkspaceFolder(this.workspace, request, folder)
          },
          [DOCS_HOST]: {
            description: "Your instructions for building things.",
            fetcher: this.ctx.exports.DocsSite
          }
        }
      }
    })
  });

  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "browser-tools",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: [
          ...createWorkspaceTools(this.workspace),
          browserTool({
            ctx: this.ctx,
            browser: this.browser,
            loader: this.env.LOADER
          })
        ]
      });
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.ai(MODEL_ID), thinkingLevel: "low" }
  });

  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.browser)
    .use(this.harness);

  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }

  /** computerd's /api WebSocket arrives here through WorkspaceProxy. */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api") {
      return this.#container.handleFetch(request);
    }
    return this.lifecycle.fetch(request);
  }

  /**
   * Browser Run's requests for preview.internal and files.internal arrive
   * here from `InternalHostRouter`. An `Agent` has this method built in; a
   * plain Durable Object adds it and hands the request to its `Browser`.
   */
  fetchInternalHost(message: InternalHostMessage) {
    return this.browser.fetchInternalHost(message);
  }

  /** Serve one browser request to preview.internal from the container. */
  async #fetchPreview(request: Request, port: number): Promise<Response> {
    // Files the model wrote reach the container on the next sync. Sync on
    // page loads, so a reload always shows the latest files.
    if (request.headers.get("sec-fetch-dest") === "document") {
      try {
        for await (const _progress of this.workspace.push()) {
          // Drain the sync.
        }
      } catch (error) {
        console.warn("workspace sync failed", error);
      }
    }
    try {
      return await this.getWorkspaceContainer().fetchPort(port, request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return new Response(
        `Nothing answers on port ${port} in the workspace container. Start the dev server on 0.0.0.0:${port}, then reload.\n\n(${reason})\n`,
        {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" }
        }
      );
    }
  }

  // ── For the UI, over RPC from the Worker ───────────────────────────

  /**
   * Live View URLs for the browser's tabs (null before the browser exists)
   * and each internal host's target. Live View URLs are bearer credentials:
   * they go to the UI, never to the model.
   */
  async browserState(): Promise<BrowserState> {
    await this.lifecycle.start();
    const [liveView, hosts] = await Promise.all([
      this.browser.liveView({ mode: "tab" }),
      this.browser.internalHosts?.list() ?? []
    ]);
    return { liveView: liveView ?? null, hosts };
  }

  /** Close the browser. The next browser run starts a fresh one. */
  async closeBrowser(): Promise<boolean> {
    await this.lifecycle.start();
    return this.browser.close();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // /api/browser/<session>: the UI's browser panel.
    const browser = url.pathname.match(/^\/api\/browser\/([\w-]+)$/);
    if (browser) {
      const agent = env.BrowserAgent.getByName(browser[1]);
      if (request.method === "DELETE") {
        return Response.json({ closed: await agent.closeBrowser() });
      }
      return Response.json(await agent.browserState());
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
