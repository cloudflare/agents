/**
 * Integration tests for AgentWorkflow using Cloudflare's workflow testing APIs.
 *
 * These tests use introspectWorkflowInstance to mock step results and verify
 * the complete Agent-Workflow communication flow.
 */
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName, type WorkflowInfo } from "..";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Helper type for callback records
type CallbackRecord = {
  type: string;
  workflowName: string;
  workflowId: string;
  data: unknown;
};

// Helper to get typed agent stub
async function getTestAgent(name: string) {
  return getAgentByName(env.TestWorkflowAgent, name);
}

describe("AgentWorkflow integration", () => {
  describe("workflow lifecycle", () => {
    // Note: These tests are skipped because the durable step methods (step.reportComplete, etc.)
    // don't work well with the workflow introspection API when the step callbacks make RPC calls
    // to Durable Objects. The functionality is tested via workflow.test.ts.
    it.skip("should start a workflow and track it in the database", async () => {
      const agentStub = await getTestAgent("integration-lifecycle-1");

      // Clear any existing state
      await agentStub.clearCallbacks();
      await agentStub.clearWorkflowResults();

      // Use introspection to set up the workflow
      await using instance = await introspectWorkflowInstance(
        env.TEST_WORKFLOW,
        "lifecycle-test-wf-1"
      );

      // Mock the step results
      await instance.modify(async (m) => {
        await m.mockStepResult(
          { name: "process" },
          { processed: true, taskId: "task-123", timestamp: Date.now() }
        );
        await m.mockStepResult({ name: "notify-agent" }, { success: true });
        // Mock the internal durable step for reportComplete
        await m.mockStepResult({ name: "__agent_reportComplete_0" }, {});
      });

      // Start the workflow via the agent
      const workflowId = await agentStub.runWorkflowTest(
        "lifecycle-test-wf-1",
        {
          taskId: "task-123"
        }
      );

      expect(workflowId).toBe("lifecycle-test-wf-1");

      // Wait for the workflow to complete
      await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

      // Verify the workflow is tracked in the agent's database
      const trackedWorkflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(trackedWorkflow).toBeDefined();
      expect(trackedWorkflow?.workflowId).toBe(workflowId);
      expect(trackedWorkflow?.status).toBe("queued"); // Initial status when created
    });

    it.skip("should receive progress callbacks from workflow", async () => {
      const agentStub = await getTestAgent("integration-progress-1");

      await agentStub.clearCallbacks();

      await using instance = await introspectWorkflowInstance(
        env.TEST_WORKFLOW,
        "progress-test-wf-1"
      );

      await instance.modify(async (m) => {
        await m.mockStepResult(
          { name: "process" },
          { processed: true, taskId: "task-456", timestamp: Date.now() }
        );
        await m.mockStepResult({ name: "notify-agent" }, { success: true });
        // Mock the internal durable step for reportComplete
        await m.mockStepResult({ name: "__agent_reportComplete_0" }, {});
      });

      await agentStub.runWorkflowTest("progress-test-wf-1", {
        taskId: "task-456"
      });

      await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

      // Check that progress callbacks were received
      // Note: reportProgress() is non-durable and makes direct RPC calls,
      // so progress callbacks ARE received even with mocked steps.
      // However, reportComplete() is now durable (via step.do), so
      // completion callbacks are NOT received when the step is mocked.
      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];

      // Should have multiple progress callbacks
      const progressCallbacks = callbacks.filter(
        (c: CallbackRecord) => c.type === "progress"
      );

      expect(progressCallbacks.length).toBeGreaterThan(0);

      // Verify progress values - now progress is an object with percent field
      type ProgressData = { progress: { percent?: number; step?: string } };
      expect(
        progressCallbacks.some(
          (c: CallbackRecord) =>
            (c.data as ProgressData).progress?.percent === 0.1
        )
      ).toBe(true);
      expect(
        progressCallbacks.some(
          (c: CallbackRecord) =>
            (c.data as ProgressData).progress?.percent === 0.9
        )
      ).toBe(true);
    });
  });

  describe("workflow with approval flow", () => {
    // Note: These tests are skipped because step.waitForEvent mocking
    // requires more complex setup with the introspection API.
    // The approval flow functionality is tested indirectly through the
    // sendWorkflowEvent tests in workflow.test.ts

    it.skip("should handle approval event and continue workflow", async () => {
      const agentStub = await getTestAgent("integration-approval-1");

      await agentStub.clearCallbacks();

      await using instance = await introspectWorkflowInstance(
        env.TEST_WORKFLOW,
        "approval-test-wf-1"
      );

      await instance.modify(async (m) => {
        // Mock the approval event that the workflow is waiting for
        await m.mockEvent({
          type: "approval",
          payload: { approved: true }
        });
        await m.mockStepResult(
          { name: "process" },
          { processed: true, taskId: "task-789", timestamp: Date.now() }
        );
        await m.mockStepResult({ name: "notify-agent" }, { success: true });
      });

      await agentStub.runWorkflowTest("approval-test-wf-1", {
        taskId: "task-789",
        waitForApproval: true
      });

      await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.some((c: CallbackRecord) => c.type === "complete")).toBe(
        true
      );
    });

    it.skip("should handle rejection and report error", async () => {
      const agentStub = await getTestAgent("integration-rejection-1");

      await agentStub.clearCallbacks();

      await using instance = await introspectWorkflowInstance(
        env.TEST_WORKFLOW,
        "rejection-test-wf-1"
      );

      await instance.modify(async (m) => {
        // Mock a rejection event
        await m.mockEvent({
          type: "approval",
          payload: { approved: false, reason: "Budget exceeded" }
        });
      });

      await agentStub.runWorkflowTest("rejection-test-wf-1", {
        taskId: "task-rejected",
        waitForApproval: true
      });

      // Workflow should error out due to rejection
      await expect(instance.waitForStatus("errored")).resolves.not.toThrow();

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      const errorCallbacks = callbacks.filter(
        (c: CallbackRecord) => c.type === "error"
      );
      expect(errorCallbacks.length).toBe(1);
      expect((errorCallbacks[0].data as { error: string }).error).toContain(
        "Budget exceeded"
      );
    });
  });

  describe("simple workflow", () => {
    // Note: Skipped - the durable step methods don't work with workflow introspection
    it.skip("should run a simple workflow and complete", async () => {
      const agentStub = await getTestAgent("integration-simple-1");

      await agentStub.clearCallbacks();

      await using instance = await introspectWorkflowInstance(
        env.SIMPLE_WORKFLOW,
        "simple-test-wf-1"
      );

      await instance.modify(async (m) => {
        await m.mockStepResult({ name: "echo" }, { echoed: "hello world" });
        // Mock the internal durable step for reportComplete
        // (won't actually send callback to agent when mocked)
        await m.mockStepResult({ name: "__agent_reportComplete_0" }, {});
      });

      const workflowId = await agentStub.runSimpleWorkflowTest(
        "simple-test-wf-1",
        {
          value: "hello world"
        }
      );

      expect(workflowId).toBe("simple-test-wf-1");

      await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

      // Note: When using mocked steps, the completion callback is not actually sent
      // to the agent. The callback verification is tested in workflow.test.ts
      // via the RPC endpoint tests.
    });
  });

  describe("workflow error handling", () => {
    it("should track workflow that completes with errors in metadata", async () => {
      // This test verifies that workflows with shouldFail=true are tracked
      // Note: Mocking step errors requires special handling in the workflow itself
      const agentStub = await getTestAgent("integration-error-1");

      await agentStub.clearCallbacks();

      // Just verify tracking works - actual error handling is tested via the
      // HTTP callback endpoints in workflow.test.ts
      await agentStub.insertTestWorkflow(
        "error-test-wf-1",
        "TEST_WORKFLOW",
        "errored",
        { taskId: "task-fail", shouldFail: true }
      );

      const workflow = (await agentStub.getWorkflowById(
        "error-test-wf-1"
      )) as WorkflowInfo | null;
      expect(workflow).toBeDefined();
      expect(workflow?.status).toBe("errored");
      expect(workflow?.metadata).toEqual({
        taskId: "task-fail",
        shouldFail: true
      });
    });
  });

  describe("workflow tracking queries", () => {
    it("should track multiple workflows and query them", async () => {
      const agentStub = await getTestAgent("integration-tracking-1");

      // Insert test records directly for query testing
      await agentStub.insertTestWorkflow(
        "query-wf-1",
        "TEST_WORKFLOW",
        "complete"
      );
      await agentStub.insertTestWorkflow(
        "query-wf-2",
        "TEST_WORKFLOW",
        "running"
      );
      await agentStub.insertTestWorkflow(
        "query-wf-3",
        "SIMPLE_WORKFLOW",
        "complete"
      );

      // Query all workflows
      const allWorkflows = (await agentStub.getWorkflowsForTest(
        {}
      )) as WorkflowInfo[];
      expect(allWorkflows.length).toBe(3);

      // Query by status
      const completeWorkflows = (await agentStub.getWorkflowsForTest({
        status: "complete"
      })) as WorkflowInfo[];
      expect(completeWorkflows.length).toBe(2);

      // Query by workflow name
      const testWorkflows = (await agentStub.getWorkflowsForTest({
        workflowName: "TEST_WORKFLOW"
      })) as WorkflowInfo[];
      expect(testWorkflows.length).toBe(2);
    });
  });
});
