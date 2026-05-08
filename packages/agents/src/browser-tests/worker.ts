import { Agent, callable, routeAgentRequest } from "agents";
import { createBrowserToolHandlers, type ToolResult } from "../browser/shared";

type Env = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  BrowserTestAgent: DurableObjectNamespace<BrowserTestAgent>;
};

export class BrowserTestAgent extends Agent<Env> {
  #reuseHandlers?: ReturnType<typeof createBrowserToolHandlers>;

  #getHandlers() {
    return createBrowserToolHandlers({
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    });
  }

  #getReuseHandlers() {
    this.#reuseHandlers ??= createBrowserToolHandlers({
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      session: {
        mode: "reuse",
        key: "browser-test",
        liveView: true,
        keepAliveMs: 600_000
      }
    });
    return this.#reuseHandlers;
  }

  @callable()
  async testSearch(code: string): Promise<ToolResult> {
    return this.#getHandlers().search(code);
  }

  @callable()
  async testExecute(code: string): Promise<ToolResult> {
    return this.#getHandlers().execute(code);
  }

  @callable()
  async testExecuteReuse(code: string): Promise<ToolResult> {
    return this.#getReuseHandlers().execute(code);
  }

  @callable()
  async testReuseInfo(): Promise<ToolResult> {
    return this.#getReuseHandlers().sessionInfo();
  }

  @callable()
  async testCloseReuse(): Promise<ToolResult> {
    return this.#getReuseHandlers().closeSession();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
