import type { AgentContext } from "../../index.ts";
import { Agent } from "../../index.ts";
import { Browser } from "../../browser/browser";
import { browserRun } from "../../browser/providers/browser-run";
import {
  proxyTo,
  type InternalHostRouterLoopback,
  type InternalHostRouterProps
} from "../../browser/internal-hosts";
import { browserTool, type BrowserTool } from "../../browser/tools/ai-sdk";
import { browserTool as piBrowserTool } from "../../browser/tools/pi";
import { browserTool as tanStackBrowserTool } from "../../browser/tools/tanstack-ai";
import {
  createFakeBrowserBinding,
  type RecordedBrowserRequest
} from "../capabilities/browser";

/**
 * An Agent subclass with a `Browser` installed through the Agent's own
 * Lifecycle — the composition every agents-wiring host uses. The `Browser`
 * auto-supplies its Durable Object store from the Agent's
 * storage; the binding is the in-memory fake.
 */
export class TestBrowserAgent extends Agent<Cloudflare.Env> {
  readonly #binding = createFakeBrowserBinding();
  readonly browserRequests: RecordedBrowserRequest[] = this.#binding.requests;
  readonly killBrowserSession = this.#binding.kill;
  readonly browserEvents = this.#binding.events;
  readonly browser = new Browser({
    provider: browserRun(this.#binding.browser)
  });

  /** A second browser with internal hostnames, on a typed binding. */
  readonly #internalBinding = createFakeBrowserBinding({ typed: true });
  readonly internalAcquired = this.#internalBinding.acquired;
  /** HTTP requests to the internal browser's binding, e.g. session closes. */
  readonly internalBindingRequests = this.#internalBinding.requests;
  /** Every request the `echo.internal` host served. */
  readonly internalRequests: string[] = [];
  readonly #exports = (
    this.ctx as unknown as { exports: Record<string, unknown> }
  ).exports;
  readonly internalHostsConfig = {
    router: this.#exports.InternalHostRouter as InternalHostRouterLoopback,
    hosts: {
      "echo.internal": {
        description: "Echoes the request",
        fetch: async (request: Request) => {
          this.internalRequests.push(request.url);
          const body = await request.text();
          return new Response(
            `echo ${request.method} ${new URL(request.url).pathname} from ${this.name}` +
              (body
                ? ` body=${body} x-test=${request.headers.get("x-test")}`
                : "")
          );
        }
      },
      "docs.internal": {
        // Passed as is: the SDK calls it to get a Fetcher.
        worker: this.#exports.InternalHostsDocsSite as Fetcher
      },
      "preview.internal": {
        description: "A port",
        target: {
          type: "object",
          properties: { port: { type: "integer", minimum: 1024 } },
          required: ["port"],
          additionalProperties: false
        },
        fetch: async (_request: Request, target: unknown) =>
          new Response(`port ${(target as { port: number }).port}`)
      },
      "broken.internal": {
        fetch: async (): Promise<Response> => {
          throw new Error("dev server not listening");
        }
      },
      "upstream.internal": {
        fetch: proxyTo("https://docs.example.com/base")
      }
    }
  };
  readonly internalBrowser = new Browser({
    name: "internal",
    provider: browserRun(this.#internalBinding.browser, {
      guardrails: { allowedDomains: [] },
      internalHosts: this.internalHostsConfig
    })
  });

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.browser);
    this.lifecycle.use(this.internalBrowser);
  }

  /** Resolve the internal browser and fetch `url` through its route. */
  async internalHostFetch(
    url: string,
    init?: RequestInit
  ): Promise<{ status: number; text: string; headers: [string, string][] }> {
    await this.internalBrowser.resolve();
    const host = new URL(url).hostname;
    const latest = this.internalAcquired.at(-1);
    const route = latest?.outboundByHost?.[host];
    if (!route) throw new Error(`no route for ${host}`);
    const response = await route.fetch(url, init);
    return {
      status: response.status,
      text: await response.text(),
      headers: [...response.headers]
    };
  }

  /** Fetch `url` through `InternalHostRouter` with the given props. */
  async routerFetch(
    props: Partial<InternalHostRouterProps> | undefined,
    url: string
  ): Promise<{ status: number; text: string }> {
    const router = this.internalHostsConfig.router as unknown as (init: {
      props: unknown;
    }) => Fetcher;
    const response = await router({ props }).fetch(url);
    return { status: response.status, text: await response.text() };
  }

  internalHostsAssign(host: string, target: unknown) {
    return this.internalBrowser.internalHosts!.assign(host, target);
  }

  internalHostsClear(host: string) {
    return this.internalBrowser.internalHosts!.clear(host);
  }

  internalHostsList() {
    return this.internalBrowser.internalHosts!.list();
  }

  /** The route props each internal host got at the last acquire. */
  internalRouteHosts(): string[] {
    return Object.keys(this.internalAcquired.at(-1)?.outboundByHost ?? {});
  }

  /** Resolve the internal browser, returning what the caller sees. */
  async internalResolve() {
    const { sessionId, restarted } = await this.internalBrowser.resolve();
    return { sessionId, restarted };
  }

  /** The internal browser's tool. */
  internalBrowserTool(): BrowserTool {
    return browserTool({
      browser: this.internalBrowser,
      loader: this.env.LOADER
    });
  }

  /** The host wiring the docs show: one `Browser`, a tool built per turn. */
  browserTool(scope?: string): BrowserTool {
    return browserTool({
      browser: this.browser,
      loader: this.env.LOADER,
      scope
    });
  }

  /** The same browser, as a TanStack AI tool. */
  tanStackBrowserTool(name?: string) {
    return tanStackBrowserTool({
      browser: this.browser,
      loader: this.env.LOADER,
      name
    });
  }

  /** The same browser, as a pi-durable tool. */
  piBrowserTool(name?: string) {
    return piBrowserTool({
      browser: this.browser,
      loader: this.env.LOADER,
      name
    });
  }
}
