import { McpAgent } from "../mcp/index.ts";
import { getAgentByName, routeAgentRequest } from "../index.ts";

// Re-export all test agents so existing imports (e.g. `import { type Env } from "./worker"`)
// and wrangler bindings continue to work.
export {
  TestMcpAgent,
  TestMcpJurisdiction,
  TestAddMcpServerAgent,
  TestRpcMcpClientAgent,
  TestEmailAgent,
  TestCaseSensitiveAgent,
  TestUserNotificationAgent,
  TestStateAgent,
  TestStateAgentNoInitial,
  TestThrowingStateAgent,
  TestPersistedStateAgent,
  TestBothHooksAgent,
  TestNoIdentityAgent,
  TestDestroyScheduleAgent,
  TestScheduleAgent,
  TestWorkflowAgent,
  TestOAuthAgent,
  TestCustomOAuthAgent,
  TestReadonlyAgent,
  TestProtocolMessagesAgent,
  TestCallableAgent,
  TestParentAgent,
  TestChildAgent,
  TestQueueAgent,
  TestRaceAgent,
  TestRetryAgent,
  TestRetryDefaultsAgent,
  TestFiberAgent
} from "./agents";

export type { TestState } from "./agents";

// Re-export test workflows for wrangler
export { TestProcessingWorkflow, SimpleTestWorkflow } from "./test-workflow";

// ── Env type ─────────────────────────────────────────────────────────
// Uses import-type to reference agent classes without creating runtime
// circular dependencies.

import type {
  TestMcpAgent,
  TestRpcMcpClientAgent,
  TestEmailAgent,
  TestCaseSensitiveAgent,
  TestUserNotificationAgent,
  TestOAuthAgent,
  TestCustomOAuthAgent,
  TestMcpJurisdiction,
  TestDestroyScheduleAgent,
  TestReadonlyAgent,
  TestProtocolMessagesAgent,
  TestScheduleAgent,
  TestWorkflowAgent,
  TestAddMcpServerAgent,
  TestStateAgent,
  TestStateAgentNoInitial,
  TestThrowingStateAgent,
  TestPersistedStateAgent,
  TestBothHooksAgent,
  TestNoIdentityAgent,
  TestCallableAgent,
  TestChildAgent,
  TestQueueAgent,
  TestRetryAgent,
  TestRetryDefaultsAgent,
  TestFiberAgent
} from "./agents";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
  TestOAuthAgent: DurableObjectNamespace<TestOAuthAgent>;
  TestCustomOAuthAgent: DurableObjectNamespace<TestCustomOAuthAgent>;
  TEST_MCP_JURISDICTION: DurableObjectNamespace<TestMcpJurisdiction>;
  TestDestroyScheduleAgent: DurableObjectNamespace<TestDestroyScheduleAgent>;
  TestReadonlyAgent: DurableObjectNamespace<TestReadonlyAgent>;
  TestProtocolMessagesAgent: DurableObjectNamespace<TestProtocolMessagesAgent>;
  TestScheduleAgent: DurableObjectNamespace<TestScheduleAgent>;
  TestWorkflowAgent: DurableObjectNamespace<TestWorkflowAgent>;
  TestAddMcpServerAgent: DurableObjectNamespace<TestAddMcpServerAgent>;
  TestRpcMcpClientAgent: DurableObjectNamespace<TestRpcMcpClientAgent>;
  TestStateAgent: DurableObjectNamespace<TestStateAgent>;
  TestStateAgentNoInitial: DurableObjectNamespace<TestStateAgentNoInitial>;
  TestThrowingStateAgent: DurableObjectNamespace<TestThrowingStateAgent>;
  TestPersistedStateAgent: DurableObjectNamespace<TestPersistedStateAgent>;
  TestBothHooksAgent: DurableObjectNamespace<TestBothHooksAgent>;
  TestNoIdentityAgent: DurableObjectNamespace<TestNoIdentityAgent>;
  TestCallableAgent: DurableObjectNamespace<TestCallableAgent>;
  TestChildAgent: DurableObjectNamespace<TestChildAgent>;
  TestQueueAgent: DurableObjectNamespace<TestQueueAgent>;
  TestRetryAgent: DurableObjectNamespace<TestRetryAgent>;
  TestRetryDefaultsAgent: DurableObjectNamespace<TestRetryDefaultsAgent>;
  TestFiberAgent: DurableObjectNamespace<TestFiberAgent>;
  // Workflow bindings for integration testing
  TEST_WORKFLOW: Workflow;
  SIMPLE_WORKFLOW: Workflow;
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

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
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
