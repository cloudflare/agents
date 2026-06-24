import { McpAgent } from "../mcp/index.ts";
import {
  getAgentByName,
  routeAgentRequest,
  routeSubAgentRequest
} from "../index.ts";

// Re-export all test agents so existing imports (e.g. `import { type Env } from "./worker"`)
// and wrangler bindings continue to work.
export {
  TestMcpAgent,
  TestMcpJurisdiction,
  TestAddMcpServerAgent,
  TestRpcMcpClientAgent,
  TestHttpMcpDedupAgent,
  TestEmailAgent,
  TestCaseSensitiveAgent,
  TestUserNotificationAgent,
  TestStateAgent,
  TestStateAgentNoInitial,
  TestThrowingStateAgent,
  TestPersistedStateAgent,
  TestBothHooksAgent,
  TestNoIdentityAgent,
  TestAlarmInitAgent,
  TestDestroyScheduleAgent,
  TestOnStartScheduleWarnAgent,
  TestOnStartScheduleNoWarnAgent,
  TestOnStartScheduleExplicitFalseAgent,
  TestScheduleAgent,
  TestWorkflowAgent,
  TestWorkflowOnStartSubAgent,
  TestWorkflowSubAgent,
  TestAgentToolReplayAgent,
  TestAgentToolStubChild,
  TestOAuthAgent,
  TestCustomOAuthAgent,
  TestReadonlyAgent,
  TestProtocolMessagesAgent,
  TestCallableAgent,
  TestParentAgent,
  TestChildAgent,
  TestChatSdkStateHostAgent,
  TestQueueAgent,
  TestRaceAgent,
  TestRetryAgent,
  TestRetryDefaultsAgent,
  TestKeepAliveAgent,
  TestMigrationAgent,
  TestSessionAgent,
  TestSessionAgentWithContext,
  TestSearchAgent,
  TestMultiSessionAgent,
  TestWaitConnectionsAgent,
  TestSubAgentParent,
  CustomBoundSubAgentParent,
  CounterSubAgent,
  OuterSubAgent,
  InnerSubAgent,
  LeafSubAgent,
  CallbackSubAgent,
  BroadcastSubAgent,
  TestConnectionUriAgent,
  SpikeSubParent,
  SpikeSubChild,
  HookingSubAgentParent,
  Sub,
  SUB,
  Sub_,
  ReservedClassParent,
  TestUnboundParentAgent,
  TestMinifiedNameParentAgent
} from "./agents";
export { ChatSdkStateAgent } from "./agents";
export { TestRunFiberAgent } from "./agents/run-fiber";
import type { TestRunFiberAgent } from "./agents/run-fiber";

export type { TestState } from "./agents";

// Re-export test workflows for wrangler
export {
  TestProcessingWorkflow,
  SimpleTestWorkflow,
  ThrowInRunWorkflow,
  ReportErrorThenThrowWorkflow,
  ReportErrorOnlyWorkflow,
  ThrowNonErrorWorkflow,
  FacetOriginWorkflow,
  FacetApprovalWorkflow,
  FacetEventStateWorkflow
} from "./test-workflow";

// ── Env type ─────────────────────────────────────────────────────────
// Uses import-type to reference agent classes without creating runtime
// circular dependencies.

import type {
  TestRpcMcpClientAgent,
  TestEmailAgent,
  TestCaseSensitiveAgent,
  TestUserNotificationAgent,
  TestOAuthAgent,
  TestCustomOAuthAgent,
  TestMcpJurisdiction,
  TestAlarmInitAgent,
  TestDestroyScheduleAgent,
  TestOnStartScheduleWarnAgent,
  TestOnStartScheduleNoWarnAgent,
  TestOnStartScheduleExplicitFalseAgent,
  TestReadonlyAgent,
  TestProtocolMessagesAgent,
  TestScheduleAgent,
  TestWorkflowAgent,
  TestAgentToolReplayAgent,
  TestAddMcpServerAgent,
  TestHttpMcpDedupAgent,
  TestStateAgent,
  TestStateAgentNoInitial,
  TestThrowingStateAgent,
  TestPersistedStateAgent,
  TestBothHooksAgent,
  TestNoIdentityAgent,
  TestCallableAgent,
  TestChildAgent,
  TestChatSdkStateHostAgent,
  TestQueueAgent,
  TestRetryAgent,
  TestRetryDefaultsAgent,
  TestKeepAliveAgent,
  TestMigrationAgent,
  TestSessionAgent,
  TestSessionAgentWithContext,
  TestSearchAgent,
  TestMultiSessionAgent,
  TestWaitConnectionsAgent,
  TestSubAgentParent,
  CustomBoundSubAgentParent,
  TestConnectionUriAgent,
  SpikeSubParent,
  HookingSubAgentParent,
  ReservedClassParent,
  TestUnboundParentAgent,
  TestMinifiedNameParentAgent
} from "./agents";

export type Env = {
  LOADER: WorkerLoader;
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
  TestOAuthAgent: DurableObjectNamespace<TestOAuthAgent>;
  TestCustomOAuthAgent: DurableObjectNamespace<TestCustomOAuthAgent>;
  TEST_MCP_JURISDICTION: DurableObjectNamespace<TestMcpJurisdiction>;
  TestAlarmInitAgent: DurableObjectNamespace<TestAlarmInitAgent>;
  TestDestroyScheduleAgent: DurableObjectNamespace<TestDestroyScheduleAgent>;
  TestOnStartScheduleWarnAgent: DurableObjectNamespace<TestOnStartScheduleWarnAgent>;
  TestOnStartScheduleNoWarnAgent: DurableObjectNamespace<TestOnStartScheduleNoWarnAgent>;
  TestOnStartScheduleExplicitFalseAgent: DurableObjectNamespace<TestOnStartScheduleExplicitFalseAgent>;
  TestReadonlyAgent: DurableObjectNamespace<TestReadonlyAgent>;
  TestProtocolMessagesAgent: DurableObjectNamespace<TestProtocolMessagesAgent>;
  TestScheduleAgent: DurableObjectNamespace<TestScheduleAgent>;
  TestWorkflowAgent: DurableObjectNamespace<TestWorkflowAgent>;
  TestAgentToolReplayAgent: DurableObjectNamespace<TestAgentToolReplayAgent>;
  TestAddMcpServerAgent: DurableObjectNamespace<TestAddMcpServerAgent>;
  TestRpcMcpClientAgent: DurableObjectNamespace<TestRpcMcpClientAgent>;
  TestHttpMcpDedupAgent: DurableObjectNamespace<TestHttpMcpDedupAgent>;
  TestStateAgent: DurableObjectNamespace<TestStateAgent>;
  TestStateAgentNoInitial: DurableObjectNamespace<TestStateAgentNoInitial>;
  TestThrowingStateAgent: DurableObjectNamespace<TestThrowingStateAgent>;
  TestPersistedStateAgent: DurableObjectNamespace<TestPersistedStateAgent>;
  TestBothHooksAgent: DurableObjectNamespace<TestBothHooksAgent>;
  TestNoIdentityAgent: DurableObjectNamespace<TestNoIdentityAgent>;
  TestCallableAgent: DurableObjectNamespace<TestCallableAgent>;
  TestChildAgent: DurableObjectNamespace<TestChildAgent>;
  TestChatSdkStateHostAgent: DurableObjectNamespace<TestChatSdkStateHostAgent>;
  TestQueueAgent: DurableObjectNamespace<TestQueueAgent>;
  TestRetryAgent: DurableObjectNamespace<TestRetryAgent>;
  TestRetryDefaultsAgent: DurableObjectNamespace<TestRetryDefaultsAgent>;
  TestRunFiberAgent: DurableObjectNamespace<TestRunFiberAgent>;
  TestKeepAliveAgent: DurableObjectNamespace<TestKeepAliveAgent>;
  TestMigrationAgent: DurableObjectNamespace<TestMigrationAgent>;
  TestSessionAgent: DurableObjectNamespace<TestSessionAgent>;
  TestSessionAgentWithContext: DurableObjectNamespace<TestSessionAgentWithContext>;
  TestSearchAgent: DurableObjectNamespace<TestSearchAgent>;
  TestMultiSessionAgent: DurableObjectNamespace<TestMultiSessionAgent>;
  TestWaitConnectionsAgent: DurableObjectNamespace<TestWaitConnectionsAgent>;
  TestSubAgentParent: DurableObjectNamespace<TestSubAgentParent>;
  CUSTOM_BOUND_SUB_AGENT_PARENT: DurableObjectNamespace<CustomBoundSubAgentParent>;
  TestUnboundParentAgent: DurableObjectNamespace<TestUnboundParentAgent>;
  TestMinifiedNameParentAgent: DurableObjectNamespace<TestMinifiedNameParentAgent>;
  SpikeSubParent: DurableObjectNamespace<SpikeSubParent>;
  HookingSubAgentParent: DurableObjectNamespace<HookingSubAgentParent>;
  ReservedClassParent: DurableObjectNamespace<ReservedClassParent>;
  TestConnectionUriAgent: DurableObjectNamespace<TestConnectionUriAgent>;
  // SubAgent classes (CounterSubAgent, OuterSubAgent, InnerSubAgent) are
  // accessed via ctx.exports as facet classes — no standalone bindings needed.
  // Workflow bindings for integration testing
  TEST_WORKFLOW: Workflow;
  SIMPLE_WORKFLOW: Workflow;
  FACET_ORIGIN_WORKFLOW: Workflow;
  FACET_APPROVAL_WORKFLOW: Workflow;
  FACET_EVENT_STATE_WORKFLOW: Workflow;
  THROW_IN_RUN_WORKFLOW: Workflow;
  REPORT_ERROR_THEN_THROW_WORKFLOW: Workflow;
  REPORT_ERROR_ONLY_WORKFLOW: Workflow;
  THROW_NON_ERROR_WORKFLOW: Workflow;
};

// ── Fetch handler ────────────────────────────────────────────────────

import { TestMcpAgent as McpAgentImpl } from "./agents";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // set some props that should be passed init
    // @ts-expect-error - this is fine for now
    ctx.props = {
      testValue: "123"
    };

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return McpAgentImpl.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return McpAgentImpl.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/auto" || url.pathname === "/auto/message") {
      return McpAgentImpl.serve("/auto", { transport: "auto" }).fetch(
        request,
        env,
        ctx
      );
    }

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
    }

    // Custom routing exercising `routeSubAgentRequest` directly —
    // URL shape: /custom-sub/{parent}/sub/{child-class-kebab}/{child-name}
    // The test worker parses the outer shape itself and delegates
    // to `routeSubAgentRequest` for the sub-agent hop.
    if (url.pathname.startsWith("/custom-sub/")) {
      const match = url.pathname.match(/^\/custom-sub\/([^/]+)(\/.*)$/);
      if (!match) return new Response("Bad custom-sub path", { status: 400 });
      const [, parentName, rest] = match;
      const parent = await getAgentByName(
        env.HookingSubAgentParent,
        parentName
      );
      return routeSubAgentRequest(request, parent, { fromPath: rest });
    }

    // Workflow facet routing exercising `routeSubAgentRequest` directly.
    // URL shape: /wf-sub/{parent}/sub/{child-class-kebab}/{child-name}[/...]
    // Proves the documented HTTP escape hatch reaches a workflow facet.
    if (url.pathname.startsWith("/wf-sub/")) {
      const match = url.pathname.match(/^\/wf-sub\/([^/]+)(\/.*)$/);
      if (!match) return new Response("Bad wf-sub path", { status: 400 });
      const [, parentName, rest] = match;
      const parent = await getAgentByName(env.TestWorkflowAgent, parentName);
      return routeSubAgentRequest(request, parent, { fromPath: rest });
    }

    // Spike: sub-agent routing through parent DO.
    // URL shape: /spike-sub/{parent}/sub/{child-class}/{child-name}[/...]
    // Forwards the request to the parent DO, which in turn forwards
    // into the facet. Purpose is to confirm WS upgrade + HTTP work
    // through the two-hop `fetch()` chain.
    if (url.pathname.startsWith("/spike-sub/")) {
      const match = url.pathname.match(/^\/spike-sub\/([^/]+)(\/.*)$/);
      if (!match) return new Response("Bad spike path", { status: 400 });
      const [, parentName, rest] = match;
      const parent = await getAgentByName(env.SpikeSubParent, parentName);
      const rewritten = new URL(request.url);
      rewritten.pathname = rest;
      return parent.fetch(new Request(rewritten, request));
    }

    // Custom basePath routing for testing - routes /custom-state/{name} to TestStateAgent
    if (url.pathname.startsWith("/custom-state/")) {
      const instanceName = url.pathname.replace("/custom-state/", "");
      const agent = await getAgentByName(env.TestStateAgent, instanceName);
      return agent.fetch(request);
    }

    // Custom basePath routing with simulated auth - routes /user to TestStateAgent with "auth-user" instance
    if (url.pathname === "/user" || url.pathname.startsWith("/user?")) {
      // Simulate server-side auth that determines the instance name
      const simulatedUserId = "auth-user";
      const agent = await getAgentByName(env.TestStateAgent, simulatedUserId);
      return agent.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
