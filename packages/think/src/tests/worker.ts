import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { createBrowserRuntime, createBrowserTools } from "../tools/browser";

export { HostBridgeLoopback } from "../extensions";

// Facet class behind tools built on createCodemodeRuntime (execute tool).
export { CodemodeRuntime } from "@cloudflare/codemode";

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
  ThinkNestedMiddleAgent,
  StuckThinkAgentToolChild,
  ThinkExtensionHookAgent,
  ThinkExecuteToolAgent,
  ThinkExecuteHitlAgent,
  ThinkFetchToolsTestAgent,
  ThinkMessengerRouteTestAgent,
  ThinkOnStartReconcileFailureAgent,
  ThinkOnStartHydrationFailureAgent,
  ThinkWindowedHydrationAgent,
  ThinkMediaEvictionAgent,
  ThinkMediaEvictionAutoAgent
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
  ThinkNestedMiddleAgent,
  StuckThinkAgentToolChild,
  ThinkExtensionHookAgent,
  ThinkExecuteToolAgent,
  ThinkExecuteHitlAgent,
  ThinkFetchToolsTestAgent,
  ThinkMessengerRouteTestAgent,
  ThinkOnStartReconcileFailureAgent,
  ThinkOnStartHydrationFailureAgent,
  ThinkWindowedHydrationAgent,
  ThinkMediaEvictionAgent,
  ThinkMediaEvictionAutoAgent
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
  ThinkNestedMiddleAgent: DurableObjectNamespace<ThinkNestedMiddleAgent>;
  StuckThinkAgentToolChild: DurableObjectNamespace<StuckThinkAgentToolChild>;
  ThinkExtensionHookAgent: DurableObjectNamespace<ThinkExtensionHookAgent>;
  ThinkMessengerRouteTestAgent: DurableObjectNamespace<ThinkMessengerRouteTestAgent>;
  ThinkExecuteToolAgent: DurableObjectNamespace<ThinkExecuteToolAgent>;
  ThinkExecuteHitlAgent: DurableObjectNamespace<ThinkExecuteHitlAgent>;
  ThinkFetchToolsTestAgent: DurableObjectNamespace<ThinkFetchToolsTestAgent>;
  ThinkOnStartReconcileFailureAgent: DurableObjectNamespace<ThinkOnStartReconcileFailureAgent>;
  ThinkOnStartHydrationFailureAgent: DurableObjectNamespace<ThinkOnStartHydrationFailureAgent>;
  ThinkWindowedHydrationAgent: DurableObjectNamespace<ThinkWindowedHydrationAgent>;
  ThinkMediaEvictionAgent: DurableObjectNamespace<ThinkMediaEvictionAgent>;
  ThinkMediaEvictionAutoAgent: DurableObjectNamespace<ThinkMediaEvictionAutoAgent>;
  BrowserToolsHost: DurableObjectNamespace<BrowserToolsHost>;
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
