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
  ThinkClientToolsAgent,
  ThinkSessionTestAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkProgrammaticTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkSanitizeTestAgent,
  ThinkRecoveryTestAgent,
  ThinkNonRecoveryTestAgent
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
  ThinkClientToolsAgent,
  ThinkSessionTestAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkProgrammaticTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkSanitizeTestAgent,
  ThinkRecoveryTestAgent,
  ThinkNonRecoveryTestAgent
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
  ThinkSessionTestAgent: DurableObjectNamespace<ThinkSessionTestAgent>;
  ThinkAsyncConfigSessionAgent: DurableObjectNamespace<ThinkAsyncConfigSessionAgent>;
  ThinkConfigTestAgent: DurableObjectNamespace<ThinkConfigTestAgent>;
  ThinkProgrammaticTestAgent: DurableObjectNamespace<ThinkProgrammaticTestAgent>;
  ThinkAsyncHookTestAgent: DurableObjectNamespace<ThinkAsyncHookTestAgent>;
  ThinkSanitizeTestAgent: DurableObjectNamespace<ThinkSanitizeTestAgent>;
  ThinkRecoveryTestAgent: DurableObjectNamespace<ThinkRecoveryTestAgent>;
  ThinkNonRecoveryTestAgent: DurableObjectNamespace<ThinkNonRecoveryTestAgent>;
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
