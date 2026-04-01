import { routeAgentRequest } from "agents";

export {
  TestAssistantToolsAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  ThinkTestAgent,
  ThinkToolsTestAgent,
  ThinkFiberTestAgent,
  ThinkClientToolsAgent
} from "./agents";

import type {
  TestAssistantToolsAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  ThinkTestAgent,
  ThinkToolsTestAgent,
  ThinkFiberTestAgent,
  ThinkClientToolsAgent
} from "./agents";

export type Env = {
  TestAssistantToolsAgent: DurableObjectNamespace<TestAssistantToolsAgent>;
  TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
  BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
  LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
  LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
  ThinkTestAgent: DurableObjectNamespace<ThinkTestAgent>;
  ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
  ThinkFiberTestAgent: DurableObjectNamespace<ThinkFiberTestAgent>;
  ThinkClientToolsAgent: DurableObjectNamespace<ThinkClientToolsAgent>;
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
