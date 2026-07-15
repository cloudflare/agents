import type {
  TestAssistantAgentAgent,
  TestAssistantToolsAgent,
  ThinkClientToolsAgent,
  ThinkExecuteHitlAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkAsyncHookTestAgent,
  ThinkConfigInSessionAgent,
  ThinkConfigTestAgent,
  ThinkAgentToolParent,
  ThinkNestedMiddleAgent,
  ThinkFiberTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkNonRecoveryTestAgent,
  ThinkProgrammaticTestAgent,
  ThinkRecoveryTestAgent,
  ThinkScheduledTasksTestAgent,
  ThinkOnStartReconcileFailureAgent,
  ThinkOnStartHydrationFailureAgent,
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
  TestRunFiberAgent,
  TestScheduleAgent,
  TestStateAgent,
  TestUserNotificationAgent
} from "./fixtures/index.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
      TestAssistantToolsAgent: DurableObjectNamespace<TestAssistantToolsAgent>;
      ThinkClientToolsAgent: DurableObjectNamespace<ThinkClientToolsAgent>;
      ThinkTestAgent: DurableObjectNamespace<ThinkTestAgent>;
      ThinkExecuteHitlAgent: DurableObjectNamespace<ThinkExecuteHitlAgent>;
      ThinkAsyncConfigSessionAgent: DurableObjectNamespace<ThinkAsyncConfigSessionAgent>;
      ThinkAsyncHookTestAgent: DurableObjectNamespace<ThinkAsyncHookTestAgent>;
      ThinkConfigInSessionAgent: DurableObjectNamespace<ThinkConfigInSessionAgent>;
      ThinkConfigTestAgent: DurableObjectNamespace<ThinkConfigTestAgent>;
      ThinkAgentToolParent: DurableObjectNamespace<ThinkAgentToolParent>;
      ThinkNestedMiddleAgent: DurableObjectNamespace<ThinkNestedMiddleAgent>;
      ThinkFiberTestAgent: DurableObjectNamespace<ThinkFiberTestAgent>;
      ThinkLegacyConfigMigrationAgent: DurableObjectNamespace<ThinkLegacyConfigMigrationAgent>;
      ThinkNonRecoveryTestAgent: DurableObjectNamespace<ThinkNonRecoveryTestAgent>;
      ThinkProgrammaticTestAgent: DurableObjectNamespace<ThinkProgrammaticTestAgent>;
      ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
      ThinkRecoveryTestAgent: DurableObjectNamespace<ThinkRecoveryTestAgent>;
      ThinkScheduledTasksTestAgent: DurableObjectNamespace<ThinkScheduledTasksTestAgent>;
      ThinkOnStartReconcileFailureAgent: DurableObjectNamespace<ThinkOnStartReconcileFailureAgent>;
      ThinkOnStartHydrationFailureAgent: DurableObjectNamespace<ThinkOnStartHydrationFailureAgent>;
      ThinkSessionRecoveryAgent: DurableObjectNamespace<ThinkSessionRecoveryAgent>;
      ThinkSessionTestAgent: DurableObjectNamespace<ThinkSessionTestAgent>;
      ThinkSessionThinkTestAgent: DurableObjectNamespace<ThinkSessionThinkTestAgent>;
      BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
      LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
      LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
      OverflowRecoveryTestAgent: DurableObjectNamespace<OverflowRecoveryTestAgent>;
      TestProtocolMessagesAgent: DurableObjectNamespace<TestProtocolMessagesAgent>;
      TestRunFiberAgent: DurableObjectNamespace<TestRunFiberAgent>;
      TestStateAgent: DurableObjectNamespace<TestStateAgent>;
      TestScheduleAgent: DurableObjectNamespace<TestScheduleAgent>;
      TestOAuthAgent: DurableObjectNamespace<TestOAuthAgent>;
      CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
      UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
    }
  }
}

export {};
