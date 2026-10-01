import type { AgentContext } from "../../index.ts";
import { Agent } from "../../index.ts";
import { Browser, browserRun } from "../../browser/browser";
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
  readonly browser = new Browser({
    provider: browserRun(this.#binding.browser)
  });

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.browser);
  }
}
