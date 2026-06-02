import { Agent, callable, routeAgentRequest } from "agents";
import { resolveProvider, truncateResponse } from "@cloudflare/codemode";
import { DurableBrowserSessionStore } from "../browser/session-manager";
import {
  createBrowserExecutor,
  createBrowserProvider,
  type BrowserToolsOptions
} from "../browser/shared";

interface ToolResult {
  text: string;
  isError?: boolean;
}

type Env = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  BrowserTestAgent: DurableObjectNamespace<BrowserTestAgent>;
};

export class BrowserTestAgent extends Agent<Env> {
  #browserSessionStore?: DurableBrowserSessionStore;

  async #execute(
    code: string,
    options: BrowserToolsOptions
  ): Promise<ToolResult> {
    try {
      const result = await createBrowserExecutor(options).execute(code, [
        resolveProvider(createBrowserProvider(options))
      ]);
      if (result.error) {
        return { text: result.error, isError: true };
      }
      return { text: truncateResponse(result.result) };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }
  }

  #getReusableOptions(): BrowserToolsOptions {
    this.#browserSessionStore ??= new DurableBrowserSessionStore(
      this.ctx.storage
    );
    return {
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      session: {
        mode: "reuse",
        store: this.#browserSessionStore
      }
    };
  }

  #getDynamicOptions(): BrowserToolsOptions {
    this.#browserSessionStore ??= new DurableBrowserSessionStore(
      this.ctx.storage
    );
    return {
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      session: {
        mode: "dynamic",
        key: "dynamic",
        store: this.#browserSessionStore
      }
    };
  }

  @callable()
  async testExecute(code: string): Promise<ToolResult> {
    return this.#execute(code, {
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    });
  }

  @callable()
  async testExecuteCombinedProviders(code: string): Promise<ToolResult> {
    const options = {
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    } satisfies BrowserToolsOptions;

    try {
      const result = await createBrowserExecutor(options).execute(code, [
        resolveProvider(createBrowserProvider(options)),
        resolveProvider({
          name: "state",
          types: `declare const state: { echo: (value: unknown) => Promise<unknown>; };`,
          tools: {
            echo: {
              description: "Echo a value from the host state provider",
              execute: async (value: unknown) => ({ provider: "state", value })
            }
          }
        })
      ]);
      if (result.error) {
        return { text: result.error, isError: true };
      }
      return { text: truncateResponse(result.result) };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }
  }

  @callable()
  async testExecuteReuse(code: string): Promise<ToolResult> {
    return this.#execute(code, this.#getReusableOptions());
  }

  @callable()
  async testExecuteDynamic(code: string): Promise<ToolResult> {
    return this.#execute(code, this.#getDynamicOptions());
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
