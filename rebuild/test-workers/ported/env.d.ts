import type {
  TestAssistantAgentAgent,
  ThinkClientToolsAgent,
  ThinkExecuteHitlAgent,
  ThinkRecoveryTestAgent,
  ThinkToolsTestAgent,
  ThinkTestAgent,
} from "./fixtures/index.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
      ThinkClientToolsAgent: DurableObjectNamespace<ThinkClientToolsAgent>;
      ThinkTestAgent: DurableObjectNamespace<ThinkTestAgent>;
      ThinkExecuteHitlAgent: DurableObjectNamespace<ThinkExecuteHitlAgent>;
      ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
      ThinkRecoveryTestAgent: DurableObjectNamespace<ThinkRecoveryTestAgent>;
    }
  }
}

export {};
