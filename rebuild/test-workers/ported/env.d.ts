import type {
  TestAssistantAgentAgent,
  ThinkClientToolsAgent,
  ThinkExecuteHitlAgent,
  ThinkRecoveryTestAgent,
  ThinkToolsTestAgent,
  ThinkTestAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  OverflowRecoveryTestAgent,
  TestCaseSensitiveAgent,
  TestOAuthAgent,
  TestProtocolMessagesAgent,
  TestScheduleAgent,
  TestStateAgent,
  TestUserNotificationAgent,
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
      BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
      LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
      LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
      OverflowRecoveryTestAgent: DurableObjectNamespace<OverflowRecoveryTestAgent>;
      TestProtocolMessagesAgent: DurableObjectNamespace<TestProtocolMessagesAgent>;
      TestStateAgent: DurableObjectNamespace<TestStateAgent>;
      TestScheduleAgent: DurableObjectNamespace<TestScheduleAgent>;
      TestOAuthAgent: DurableObjectNamespace<TestOAuthAgent>;
      CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
      UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
    }
  }
}

export {};
