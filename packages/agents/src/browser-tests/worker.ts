import { Agent, callable, routeAgentRequest } from "agents";
import {
  CodemodeConnector,
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  type CodemodeRuntimeHandle,
  type ConnectorTools,
  type PendingAction,
  type ProxyToolOutput
} from "@cloudflare/codemode";
import { BrowserConnector } from "../browser/connector";
import {
  DurableBrowserSessionStore,
  type StoredBrowserSession
} from "../browser/session-manager";
import {
  listBrowserTargets,
  connectBrowserSession,
  deleteBrowserSession,
  BrowserRenderingError
} from "../browser/browser-run";

// The codemode runtime facet class must be exported from the worker entry so
// `ctx.exports.CodemodeRuntime` resolves (the vite plugin does this in apps).
export { CodemodeRuntime } from "@cloudflare/codemode";

type Env = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  BrowserTestAgent: DurableObjectNamespace<BrowserTestAgent>;
};

type SessionMode = "one-shot" | "reuse" | "dynamic";

/** Approval-gated connector used to pause executions mid-run in tests. */
class GateConnector extends CodemodeConnector<Env> {
  name(): string {
    return "gate";
  }

  protected tools(): ConnectorTools {
    return {
      confirm: {
        description: "Ask the user to confirm before continuing.",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          properties: { label: { type: "string" } }
        },
        execute: async (args) => ({ confirmed: true, args })
      }
    };
  }
}

export class BrowserTestAgent extends Agent<Env> {
  #store() {
    return new DurableBrowserSessionStore(this.ctx.storage);
  }

  #connector(mode: SessionMode): BrowserConnector {
    return new BrowserConnector(this.ctx, {
      browser: this.env.BROWSER,
      store: this.#store(),
      session: mode === "one-shot" ? undefined : { mode }
    });
  }

  #runtime(mode: SessionMode): CodemodeRuntimeHandle {
    return createCodemodeRuntime({
      ctx: this.ctx,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
      connectors: [
        this.#connector(mode),
        new GateConnector(this.ctx, this.env)
      ],
      name: `browser-${mode}`
    });
  }

  async #execute(
    runtime: CodemodeRuntimeHandle,
    code: string
  ): Promise<ProxyToolOutput> {
    const tool = runtime.tool();
    if (!tool.execute) throw new Error("runtime tool is not executable");
    return (await tool.execute(
      { code },
      { toolCallId: crypto.randomUUID(), messages: [] }
    )) as ProxyToolOutput;
  }

  @callable()
  async run(
    code: string,
    mode: SessionMode = "one-shot"
  ): Promise<ProxyToolOutput> {
    return this.#execute(this.#runtime(mode), code);
  }

  @callable()
  async approve(executionId: string, mode: SessionMode) {
    return this.#runtime(mode).approve({ executionId });
  }

  @callable()
  async pending(mode: SessionMode): Promise<PendingAction[]> {
    return this.#runtime(mode).pending();
  }

  @callable()
  async sessionInfo(mode: SessionMode) {
    return (await this.#connector(mode).sessionInfo()) ?? null;
  }

  @callable()
  async closeSession(mode: SessionMode): Promise<void> {
    await this.#connector(mode).closeSession();
  }

  @callable()
  async sweep(mode: SessionMode, maxIdleMs?: number) {
    return this.#connector(mode).sweep({ maxIdleMs });
  }

  /** All stored session entries (cdp:exec:* and cdp:reuse:*). */
  @callable()
  async storedSessions(): Promise<Record<string, StoredBrowserSession>> {
    return Object.fromEntries(await this.#store().list("cdp:"));
  }

  /** Delete a Browser Run session out-of-band (simulates expiry). */
  @callable()
  async killBrowserSession(sessionId: string): Promise<void> {
    await deleteBrowserSession(this.env.BROWSER, sessionId);
  }

  /**
   * Point a stored entry at a session id that doesn't exist — simulates
   * Browser Run reclaiming the session while a run is paused. (The local
   * simulator treats DELETE as a no-op, so killBrowserSession can't be used
   * to test expiry in `wrangler dev`.)
   */
  @callable()
  async corruptStoredSession(key: string): Promise<void> {
    const store = this.#store();
    const stored = await store.get(key);
    if (!stored) throw new Error(`No stored session under ${key}`);
    await store.set(key, {
      ...stored,
      sessionId: "00000000-0000-0000-0000-000000000000"
    });
  }

  /** Whether a Browser Run session id is still alive. */
  @callable()
  async sessionAlive(sessionId: string): Promise<boolean> {
    try {
      await listBrowserTargets(this.env.BROWSER, sessionId);
      return true;
    } catch (error) {
      if (error instanceof BrowserRenderingError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Probe whether Browser Run allows two concurrent WebSocket connections to
   * one session. Platform-dependent — the test records the answer rather than
   * asserting it.
   */
  @callable()
  async multiSocketProbe(sessionId: string): Promise<{
    concurrent: boolean;
    error?: string;
  }> {
    let first: Awaited<ReturnType<typeof connectBrowserSession>> | undefined;
    let second: Awaited<ReturnType<typeof connectBrowserSession>> | undefined;
    try {
      first = await connectBrowserSession(this.env.BROWSER, sessionId);
      second = await connectBrowserSession(this.env.BROWSER, sessionId);
      const [a, b] = await Promise.all([
        first.send("Browser.getVersion"),
        second.send("Browser.getVersion")
      ]);
      return { concurrent: !!a && !!b };
    } catch (error) {
      return {
        concurrent: false,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      first?.disconnect();
      second?.disconnect();
    }
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
