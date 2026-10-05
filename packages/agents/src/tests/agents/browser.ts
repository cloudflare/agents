import type { AgentContext } from "../../index.ts";
import { Agent } from "../../index.ts";
import { Browser, browserRun } from "../../browser/browser";
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

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.browser);
  }

  /** The host wiring the docs show: one `Browser`, a tool built per turn. */
  browserTool(scope?: string): BrowserTool {
    return browserTool({
      ctx: this.ctx,
      browser: this.browser,
      loader: this.env.LOADER,
      scope
    });
  }

  /** The same browser, as a TanStack AI tool. */
  tanStackBrowserTool(name?: string) {
    return tanStackBrowserTool({
      ctx: this.ctx,
      browser: this.browser,
      loader: this.env.LOADER,
      name
    });
  }

  /** The same browser, as a pi-durable tool. */
  piBrowserTool(name?: string) {
    return piBrowserTool({
      ctx: this.ctx,
      browser: this.browser,
      loader: this.env.LOADER,
      name
    });
  }
}
