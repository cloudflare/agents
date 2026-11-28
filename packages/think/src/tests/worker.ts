import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { createBrowserRuntime, createBrowserTools } from "../tools/browser";

export { HostBridgeLoopback } from "../extensions";
export {
  ConnectionStateParent,
  ConnectionStateThink
} from "./agents/connection-state";

// Facet class behind tools built on createCodemodeRuntime (execute tool).
export { CodemodeRuntime } from "@cloudflare/codemode";
// Facet class behind the messenger runtime's Chat SDK state.
export { ThinkMessengerStateAgent } from "../messengers";

export {
  ThinkWorkspaceToolsAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  OverflowRecoveryTestAgent,
  OverflowReminderTestAgent,
  ThinkTestAgent,
  ThinkContinueOverrideTestAgent,
  ThinkPropsTestAgent,
  ThinkToolsTestAgent,
  ThinkRewriteContextTestAgent,
  ThinkFiberTestAgent,
  ThinkClientToolsAgent,
  ThinkSessionTestAgent,
  ThinkSystemPromptSkillsWarningAgent,
  ThinkDefaultSystemPromptSkillsAgent,
  ThinkInheritedSystemPromptSkillsAgent,
  ThinkSystemPromptFieldSkillsAgent,
  ThinkWorkspaceSkillsAgent,
  ThinkMissingClassifierWarningAgent,
  ThinkClassifierMethodAgent,
  ThinkInheritedClassifierAgent,
  ThinkClassifierFieldAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkConfigInSessionAgent,
  ThinkProgrammaticTestAgent,
  ThinkScheduledTasksTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkRecoveryTestAgent,
  ThinkStableToolsTestAgent,
  ThinkAdmissionTestAgent,
  ThinkLatestAdmissionTestAgent,
  ThinkNonRecoveryTestAgent,
  ThinkAgentToolParent,
  ThinkNestedMiddleAgent,
  StuckThinkAgentToolChild,
  ThinkExtensionHookAgent,
  ThinkExtensionNetworkAgent,
  ThinkExtensionTurnAgent,
  ThinkExtensionTurnParent,
  ThinkPrefixChangedAgent,
  ThinkHarnessActionsAgent,
  ThinkExtensionBeforeTurnModelAgent,
  ThinkExecuteToolAgent,
  ThinkExecuteHitlAgent,
  ThinkFetchToolsTestAgent,
  ThinkSkillsToolsTestAgent,
  ThinkMessengerDeliveryTestAgent,
  ThinkMessengerRouteTestAgent,
  ThinkMcpToolMaterializationAgent,
  ThinkOnStartReconcileFailureAgent,
  ThinkOnStartHydrationFailureAgent,
  ThinkWindowedHydrationAgent,
  ThinkMediaEvictionAgent,
  ThinkPromptCacheTestAgent,
  ThinkUpgradeTestAgent,
  ThinkUpgradeCustomStoreTestAgent,
  ThinkUpgradeResponseHookAgent,
  ThinkUpgradeFrozenPromptAgent,
  ThinkUpgradeRecoveryIncidentAgent,
  ThinkMediaEvictionAutoAgent,
  ThinkPointerHydrationAgent,
  ThinkLegacySessionApiAgent
} from "./agents";
export { ThinkConfigStoreProbe } from "./agents/config-store-probe";
import type { ThinkConfigStoreProbe } from "./agents/config-store-probe";

import type {
  ThinkWorkspaceToolsAgent,
  TestAssistantAgentAgent,
  BareAssistantAgent,
  LoopTestAgent,
  LoopToolTestAgent,
  OverflowRecoveryTestAgent,
  OverflowReminderTestAgent,
  ThinkTestAgent,
  ThinkContinueOverrideTestAgent,
  ThinkPropsTestAgent,
  ThinkToolsTestAgent,
  ThinkRewriteContextTestAgent,
  ThinkFiberTestAgent,
  ThinkClientToolsAgent,
  ThinkSessionTestAgent,
  ThinkSystemPromptSkillsWarningAgent,
  ThinkDefaultSystemPromptSkillsAgent,
  ThinkInheritedSystemPromptSkillsAgent,
  ThinkSystemPromptFieldSkillsAgent,
  ThinkWorkspaceSkillsAgent,
  ThinkMissingClassifierWarningAgent,
  ThinkClassifierMethodAgent,
  ThinkInheritedClassifierAgent,
  ThinkClassifierFieldAgent,
  ThinkAsyncConfigSessionAgent,
  ThinkConfigTestAgent,
  ThinkLegacyConfigMigrationAgent,
  ThinkConfigInSessionAgent,
  ThinkProgrammaticTestAgent,
  ThinkScheduledTasksTestAgent,
  ThinkAsyncHookTestAgent,
  ThinkRecoveryTestAgent,
  ThinkStableToolsTestAgent,
  ThinkAdmissionTestAgent,
  ThinkLatestAdmissionTestAgent,
  ThinkNonRecoveryTestAgent,
  ThinkAgentToolParent,
  ThinkNestedMiddleAgent,
  StuckThinkAgentToolChild,
  ThinkExtensionHookAgent,
  ThinkExtensionNetworkAgent,
  ThinkExtensionTurnAgent,
  ThinkExtensionTurnParent,
  ThinkPrefixChangedAgent,
  ThinkHarnessActionsAgent,
  ThinkExtensionBeforeTurnModelAgent,
  ThinkExecuteToolAgent,
  ThinkExecuteHitlAgent,
  ThinkFetchToolsTestAgent,
  ThinkSkillsToolsTestAgent,
  ThinkMessengerDeliveryTestAgent,
  ThinkMessengerRouteTestAgent,
  ThinkMcpToolMaterializationAgent,
  ThinkOnStartReconcileFailureAgent,
  ThinkOnStartHydrationFailureAgent,
  ThinkWindowedHydrationAgent,
  ThinkMediaEvictionAgent,
  ThinkPromptCacheTestAgent,
  ThinkUpgradeTestAgent,
  ThinkUpgradeCustomStoreTestAgent,
  ThinkUpgradeResponseHookAgent,
  ThinkUpgradeFrozenPromptAgent,
  ThinkUpgradeRecoveryIncidentAgent,
  ThinkMediaEvictionAutoAgent,
  ThinkPointerHydrationAgent,
  ThinkLegacySessionApiAgent
} from "./agents";

type BrowserRunTestBinding = Fetcher & {
  quickAction(action: string, options: unknown): Promise<Response>;
};

export class TestBrowserRunBinding extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return Response.json({ ok: true });
  }

  quickAction(action: string): Response {
    const result =
      action === "links" || action === "scrape" || action === "json" ? [] : "";
    return Response.json({ success: true, result });
  }
}

function browserToolSummary(tools: Record<string, unknown>) {
  const execute = tools.browser_execute as
    | { execute?: unknown; description?: string }
    | undefined;
  return {
    keys: Object.keys(tools).sort(),
    hasExecute: typeof execute?.execute === "function",
    description: execute?.description ?? ""
  };
}

export class BrowserToolsHost extends DurableObject<Env> {
  #browser(): BrowserRunTestBinding {
    return this.ctx.exports.TestBrowserRunBinding as BrowserRunTestBinding;
  }

  toolsWithBinding() {
    return browserToolSummary(
      createBrowserTools({
        ctx: this.ctx,
        browser: this.#browser(),
        loader: this.env.LOADER
      })
    );
  }

  toolsWithoutQuickActions() {
    return browserToolSummary(
      createBrowserTools({
        ctx: this.ctx,
        browser: this.#browser(),
        loader: this.env.LOADER,
        quickActions: false
      })
    );
  }

  toolsWithCdpUrl() {
    return browserToolSummary(
      createBrowserTools({
        ctx: this.ctx,
        cdpUrl: "http://localhost:9222",
        loader: this.env.LOADER
      })
    );
  }

  toolsWithOptions() {
    return browserToolSummary(
      createBrowserTools({
        ctx: this.ctx,
        browser: this.#browser(),
        loader: this.env.LOADER,
        timeout: 60_000,
        session: { mode: "dynamic" }
      })
    );
  }

  missingBrowserOrCdpUrlError() {
    try {
      createBrowserTools({
        ctx: this.ctx,
        loader: this.env.LOADER
      });
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  runtimeShape() {
    const { runtime, connector, tools } = createBrowserRuntime({
      ctx: this.ctx,
      browser: this.#browser(),
      loader: this.env.LOADER
    });

    return {
      connectorName: connector.name(),
      runtimeApprove: typeof runtime.approve,
      runtimeExpirePaused: typeof runtime.expirePaused,
      connectorSweep: typeof connector.sweep,
      hasExecute: "browser_execute" in tools
    };
  }
}

export type Env = {
  ThinkWorkspaceToolsAgent: DurableObjectNamespace<ThinkWorkspaceToolsAgent>;
  TestAssistantAgentAgent: DurableObjectNamespace<TestAssistantAgentAgent>;
  BareAssistantAgent: DurableObjectNamespace<BareAssistantAgent>;
  LoopTestAgent: DurableObjectNamespace<LoopTestAgent>;
  LoopToolTestAgent: DurableObjectNamespace<LoopToolTestAgent>;
  OverflowRecoveryTestAgent: DurableObjectNamespace<OverflowRecoveryTestAgent>;
  OverflowReminderTestAgent: DurableObjectNamespace<OverflowReminderTestAgent>;
  ThinkTestAgent: DurableObjectNamespace<ThinkTestAgent>;
  ThinkContinueOverrideTestAgent: DurableObjectNamespace<ThinkContinueOverrideTestAgent>;
  ThinkPropsTestAgent: DurableObjectNamespace<ThinkPropsTestAgent>;
  ThinkToolsTestAgent: DurableObjectNamespace<ThinkToolsTestAgent>;
  ThinkRewriteContextTestAgent: DurableObjectNamespace<ThinkRewriteContextTestAgent>;
  ThinkFiberTestAgent: DurableObjectNamespace<ThinkFiberTestAgent>;
  ThinkClientToolsAgent: DurableObjectNamespace<ThinkClientToolsAgent>;
  ThinkSessionTestAgent: DurableObjectNamespace<ThinkSessionTestAgent>;
  ThinkSystemPromptSkillsWarningAgent: DurableObjectNamespace<ThinkSystemPromptSkillsWarningAgent>;
  ThinkDefaultSystemPromptSkillsAgent: DurableObjectNamespace<ThinkDefaultSystemPromptSkillsAgent>;
  ThinkInheritedSystemPromptSkillsAgent: DurableObjectNamespace<ThinkInheritedSystemPromptSkillsAgent>;
  ThinkSystemPromptFieldSkillsAgent: DurableObjectNamespace<ThinkSystemPromptFieldSkillsAgent>;
  ThinkWorkspaceSkillsAgent: DurableObjectNamespace<ThinkWorkspaceSkillsAgent>;
  ThinkMissingClassifierWarningAgent: DurableObjectNamespace<ThinkMissingClassifierWarningAgent>;
  ThinkClassifierMethodAgent: DurableObjectNamespace<ThinkClassifierMethodAgent>;
  ThinkInheritedClassifierAgent: DurableObjectNamespace<ThinkInheritedClassifierAgent>;
  ThinkClassifierFieldAgent: DurableObjectNamespace<ThinkClassifierFieldAgent>;
  ThinkAsyncConfigSessionAgent: DurableObjectNamespace<ThinkAsyncConfigSessionAgent>;
  ThinkConfigTestAgent: DurableObjectNamespace<ThinkConfigTestAgent>;
  ThinkLegacyConfigMigrationAgent: DurableObjectNamespace<ThinkLegacyConfigMigrationAgent>;
  ThinkConfigInSessionAgent: DurableObjectNamespace<ThinkConfigInSessionAgent>;
  ThinkProgrammaticTestAgent: DurableObjectNamespace<ThinkProgrammaticTestAgent>;
  ThinkScheduledTasksTestAgent: DurableObjectNamespace<ThinkScheduledTasksTestAgent>;
  ThinkAsyncHookTestAgent: DurableObjectNamespace<ThinkAsyncHookTestAgent>;
  ThinkRecoveryTestAgent: DurableObjectNamespace<ThinkRecoveryTestAgent>;
  ThinkStableToolsTestAgent: DurableObjectNamespace<ThinkStableToolsTestAgent>;
  ThinkAdmissionTestAgent: DurableObjectNamespace<ThinkAdmissionTestAgent>;
  ThinkLatestAdmissionTestAgent: DurableObjectNamespace<ThinkLatestAdmissionTestAgent>;
  ThinkNonRecoveryTestAgent: DurableObjectNamespace<ThinkNonRecoveryTestAgent>;
  ThinkAgentToolParent: DurableObjectNamespace<ThinkAgentToolParent>;
  ThinkNestedMiddleAgent: DurableObjectNamespace<ThinkNestedMiddleAgent>;
  StuckThinkAgentToolChild: DurableObjectNamespace<StuckThinkAgentToolChild>;
  ThinkExtensionHookAgent: DurableObjectNamespace<ThinkExtensionHookAgent>;
  ThinkExtensionNetworkAgent: DurableObjectNamespace<ThinkExtensionNetworkAgent>;
  ThinkExtensionTurnAgent: DurableObjectNamespace<ThinkExtensionTurnAgent>;
  ThinkExtensionTurnParent: DurableObjectNamespace<ThinkExtensionTurnParent>;
  ThinkPrefixChangedAgent: DurableObjectNamespace<ThinkPrefixChangedAgent>;
  ThinkHarnessActionsAgent: DurableObjectNamespace<ThinkHarnessActionsAgent>;
  ThinkExtensionBeforeTurnModelAgent: DurableObjectNamespace<ThinkExtensionBeforeTurnModelAgent>;
  ThinkMessengerDeliveryTestAgent: DurableObjectNamespace<ThinkMessengerDeliveryTestAgent>;
  ThinkMessengerRouteTestAgent: DurableObjectNamespace<ThinkMessengerRouteTestAgent>;
  ThinkMcpToolMaterializationAgent: DurableObjectNamespace<ThinkMcpToolMaterializationAgent>;
  ThinkExecuteToolAgent: DurableObjectNamespace<ThinkExecuteToolAgent>;
  ThinkExecuteHitlAgent: DurableObjectNamespace<ThinkExecuteHitlAgent>;
  ThinkFetchToolsTestAgent: DurableObjectNamespace<ThinkFetchToolsTestAgent>;
  ThinkSkillsToolsTestAgent: DurableObjectNamespace<ThinkSkillsToolsTestAgent>;
  ThinkOnStartReconcileFailureAgent: DurableObjectNamespace<ThinkOnStartReconcileFailureAgent>;
  ThinkOnStartHydrationFailureAgent: DurableObjectNamespace<ThinkOnStartHydrationFailureAgent>;
  ThinkWindowedHydrationAgent: DurableObjectNamespace<ThinkWindowedHydrationAgent>;
  ThinkMediaEvictionAgent: DurableObjectNamespace<ThinkMediaEvictionAgent>;
  ThinkPromptCacheTestAgent: DurableObjectNamespace<ThinkPromptCacheTestAgent>;
  ThinkUpgradeTestAgent: DurableObjectNamespace<ThinkUpgradeTestAgent>;
  ThinkUpgradeCustomStoreTestAgent: DurableObjectNamespace<ThinkUpgradeCustomStoreTestAgent>;
  ThinkUpgradeResponseHookAgent: DurableObjectNamespace<ThinkUpgradeResponseHookAgent>;
  ThinkUpgradeFrozenPromptAgent: DurableObjectNamespace<ThinkUpgradeFrozenPromptAgent>;
  ThinkUpgradeRecoveryIncidentAgent: DurableObjectNamespace<ThinkUpgradeRecoveryIncidentAgent>;
  ThinkMediaEvictionAutoAgent: DurableObjectNamespace<ThinkMediaEvictionAutoAgent>;
  ThinkPointerHydrationAgent: DurableObjectNamespace<ThinkPointerHydrationAgent>;
  ThinkLegacySessionApiAgent: DurableObjectNamespace<ThinkLegacySessionApiAgent>;
  ThinkConfigStoreProbe: DurableObjectNamespace<ThinkConfigStoreProbe>;
  BrowserToolsHost: DurableObjectNamespace<BrowserToolsHost>;
  LOADER: WorkerLoader;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const options = new URL(request.url).pathname.startsWith(
      "/agents/think-props-test-agent/"
    )
      ? { cors: true, props: { tenantId: "tenant-1" } }
      : { cors: true };
    return (
      (await routeAgentRequest(request, env, options)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
