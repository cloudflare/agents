import { routeAgentRequest } from "agents";

export { HostBridgeLoopback } from "../extensions";

export {
  TestAssistantToolsAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  OverflowRecoveryTestAgent,
  ThinkTestAgent,
  ThinkToolsTestAgent,
  ThinkFiberTestAgent,
  ThinkClientToolsAgent,
  ThinkSessionTestAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkConfigInSessionAgent,
  ThinkProgrammaticTestAgent,
  ThinkScheduledTasksTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkRecoveryTestAgent,
  ThinkNonRecoveryTestAgent,
  ThinkAgentToolParent,
  StuckThinkAgentToolChild,
  ThinkExtensionHookAgent,
  ThinkMessengerRouteTestAgent
} from "./agents";

import type {
  TestAssistantToolsAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  OverflowRecoveryTestAgent,
  ThinkTestAgent,
  ThinkToolsTestAgent,
  ThinkFiberTestAgent,
  ThinkClientToolsAgent,
  ThinkSessionTestAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkConfigInSessionAgent,
  ThinkProgrammaticTestAgent,
  ThinkScheduledTasksTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkRecoveryTestAgent,
  ThinkNonRecoveryTestAgent,
  ThinkAgentToolParent,
  StuckThinkAgentToolChild,
  ThinkExtensionHookAgent,
  ThinkMessengerRouteTestAgent
} from "./agents";

export type Env = {
  TestAssistantToolsAgent: DurableObjectNamespace<TestAssistantToolsAgent>;
  TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
  BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
  LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
  LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
  OverflowRecoveryTestAgent: DurableObjectNamespace<OverflowRecoveryTestAgent>;
  ThinkTestAgent: DurableObjectNamespace<ThinkTestAgent>;
  ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
  ThinkFiberTestAgent: DurableObjectNamespace<ThinkFiberTestAgent>;
  ThinkClientToolsAgent: DurableObjectNamespace<ThinkClientToolsAgent>;
  ThinkSessionTestAgent: DurableObjectNamespace<ThinkSessionTestAgent>;
  ThinkAsyncConfigSessionAgent: DurableObjectNamespace<ThinkAsyncConfigSessionAgent>;
  ThinkConfigTestAgent: DurableObjectNamespace<ThinkConfigTestAgent>;
  ThinkLegacyConfigMigrationAgent: DurableObjectNamespace<ThinkLegacyConfigMigrationAgent>;
  ThinkConfigInSessionAgent: DurableObjectNamespace<ThinkConfigInSessionAgent>;
  ThinkProgrammaticTestAgent: DurableObjectNamespace<ThinkProgrammaticTestAgent>;
  ThinkScheduledTasksTestAgent: DurableObjectNamespace<ThinkScheduledTasksTestAgent>;
  ThinkAsyncHookTestAgent: DurableObjectNamespace<ThinkAsyncHookTestAgent>;
  ThinkRecoveryTestAgent: DurableObjectNamespace<ThinkRecoveryTestAgent>;
  ThinkNonRecoveryTestAgent: DurableObjectNamespace<ThinkNonRecoveryTestAgent>;
  ThinkAgentToolParent: DurableObjectNamespace<ThinkAgentToolParent>;
  StuckThinkAgentToolChild: DurableObjectNamespace<StuckThinkAgentToolChild>;
  ThinkExtensionHookAgent: DurableObjectNamespace<ThinkExtensionHookAgent>;
  ThinkMessengerRouteTestAgent: DurableObjectNamespace<ThinkMessengerRouteTestAgent>;
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
