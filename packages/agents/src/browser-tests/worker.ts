import { Agent, callable, routeAgentRequest } from "agents";
import { createBrowserToolHandlers, type ToolResult } from "../browser/shared";

type Env = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  BrowserTestAgent: DurableObjectNamespace<BrowserTestAgent>;
};

export class BrowserTestAgent extends Agent<Env> {
  #getHandlers() {
    return createBrowserToolHandlers({
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    });
  }

  @callable()
  async testSearch(code: string): Promise<ToolResult> {
    return this.#getHandlers().search(code);
  }

  @callable()
  async testExecute(code: string): Promise<ToolResult> {
    return this.#getHandlers().execute(code);
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
