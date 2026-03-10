import { routeAgentRequest } from "agents";

export {
  TestAssistantToolsAgent,
  TestAssistantSessionAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  ThinkTestAgent,
  ThinkToolsTestAgent
} from "./agents";

import type {
  TestAssistantToolsAgent,
  TestAssistantSessionAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  ThinkTestAgent,
  ThinkToolsTestAgent
} from "./agents";

export type Env = {
  TestAssistantToolsAgent: DurableObjectNamespace<TestAssistantToolsAgent>;
  TestAssistantSessionAgent: DurableObjectNamespace<TestAssistantSessionAgent>;
  TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
  BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
  LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
  LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
  ThinkTestAgent: DurableObjectNamespace<ThinkTestAgent>;
  ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
  LOADER: WorkerLoader;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  }
};
