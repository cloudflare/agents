import type {
  TestAssistantAgentAgent,
  ThinkClientToolsAgent,
  ThinkExecuteHitlAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkAsyncHookTestAgent,
  ThinkConfigInSessionAgent,
  ThinkConfigTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkNonRecoveryTestAgent,
  ThinkProgrammaticTestAgent,
  ThinkRecoveryTestAgent,
  ThinkSessionRecoveryAgent,
  ThinkSessionTestAgent,
  ThinkSessionThinkTestAgent,
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
      ThinkAsyncConfigSessionAgent: DurableObjectNamespace<ThinkAsyncConfigSessionAgent>;
      ThinkAsyncHookTestAgent: DurableObjectNamespace<ThinkAsyncHookTestAgent>;
      ThinkConfigInSessionAgent: DurableObjectNamespace<ThinkConfigInSessionAgent>;
      ThinkConfigTestAgent: DurableObjectNamespace<ThinkConfigTestAgent>;
      ThinkLegacyConfigMigrationAgent: DurableObjectNamespace<ThinkLegacyConfigMigrationAgent>;
      ThinkNonRecoveryTestAgent: DurableObjectNamespace<ThinkNonRecoveryTestAgent>;
      ThinkProgrammaticTestAgent: DurableObjectNamespace<ThinkProgrammaticTestAgent>;
      ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
      ThinkRecoveryTestAgent: DurableObjectNamespace<ThinkRecoveryTestAgent>;
      ThinkSessionRecoveryAgent: DurableObjectNamespace<ThinkSessionRecoveryAgent>;
      ThinkSessionTestAgent: DurableObjectNamespace<ThinkSessionTestAgent>;
      ThinkSessionThinkTestAgent: DurableObjectNamespace<ThinkSessionThinkTestAgent>;
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
