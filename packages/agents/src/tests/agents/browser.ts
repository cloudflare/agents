import type { AgentContext } from "../../index.ts";
import { Agent } from "../../index.ts";
import { BrowserSessions } from "../../browser/capability";
import { createBrowserExecuteTool } from "../../browser/ai";
import {
  createFakeBrowserBinding,
  type RecordedBrowserRequest
} from "../capabilities/browser";

/**
 * An Agent subclass with the `BrowserSessions` capability installed through
 * the Agent's own Lifecycle — the composition every agents-wiring host uses.
 * The capability auto-supplies its Durable Object store from the Agent's
 * storage; the binding is the in-memory fake.
 */
export class TestBrowserAgent extends Agent<Cloudflare.Env> {
  readonly #binding = createFakeBrowserBinding();
  readonly browserRequests: RecordedBrowserRequest[] = this.#binding.requests;
  readonly killBrowserSession = this.#binding.kill;
  readonly browser = new BrowserSessions({ browser: this.#binding.browser });

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.browser);
  }

  /** The host wiring the docs show: one capability, tools built per turn. */
  browserExecuteTool() {
    return createBrowserExecuteTool({
      ctx: this.ctx,
      sessions: this.browser,
      loader: (this.env as Cloudflare.Env & { LOADER: WorkerLoader }).LOADER
    }).browser_execute as unknown as {
      execute(input: { code: string }, options: unknown): Promise<unknown>;
      toModelOutput(options: { output: unknown }): unknown;
    };
  }
}
