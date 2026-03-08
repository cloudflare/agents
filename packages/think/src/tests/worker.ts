import { routeAgentRequest } from "agents";

export {
  TestAssistantToolsAgent,
  TestAssistantSessionAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  ThinkSessionTestAgent,
  ThinkSessionToolsTestAgent
} from "./agents";

import type {
  TestAssistantToolsAgent,
  TestAssistantSessionAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  ThinkSessionTestAgent,
  ThinkSessionToolsTestAgent
} from "./agents";

export type Env = {
  TestAssistantToolsAgent: DurableObjectNamespace<TestAssistantToolsAgent>;
  TestAssistantSessionAgent: DurableObjectNamespace<TestAssistantSessionAgent>;
  TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
  BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
  LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
  LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
  ThinkSessionTestAgent: DurableObjectNamespace<ThinkSessionTestAgent>;
  ThinkSessionToolsTestAgent: DurableObjectNamespace<ThinkSessionToolsTestAgent>;
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
