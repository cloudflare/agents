import productionWorker, {
  AgentThink,
  CommandCenterAgent,
  Sandbox,
  WarmPool as ProductionWarmPool,
  WorkspaceProxy,
  WorkspaceServiceProxy
} from "../src/index";
import {
  type AgentThinkEnv,
  ThinkAgent as ProductionThinkAgent
} from "../src/agent";
import { mockInference } from "./mock-inference";

/** Production agent with deterministic inference for real-container E2E. */
export class ThinkAgent extends ProductionThinkAgent {
  override maxSteps = 2;

  override getModel() {
    return mockInference();
  }
}

/** Test adapter exposing the real maintenance operation over RPC. */
export class WarmPool extends ProductionWarmPool {
  async runMaintenance() {
    await this.alarm();
    return this.getStats();
  }
}

export {
  AgentThink,
  CommandCenterAgent,
  Sandbox,
  WorkspaceProxy,
  WorkspaceServiceProxy
};

function pool(env: Env) {
  return env.WarmPool.get(env.WarmPool.idFromName("global-pool"));
}

/** Test-only HTTP adapter over real production interfaces. */
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/pool-stats") {
      return Response.json(await pool(env).getStats());
    }
    if (request.method === "POST" && url.pathname === "/__test/pool-alarm") {
      const testPool = pool(env) as unknown as {
        runMaintenance(): Promise<unknown>;
      };
      return Response.json(await testPool.runMaintenance());
    }
    return productionWorker.fetch(request, env as AgentThinkEnv);
  },
  scheduled(controller, env, ctx) {
    return productionWorker.scheduled(controller, env as AgentThinkEnv, ctx);
  }
} satisfies ExportedHandler<Env>;
