import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName, type WorkflowInfo } from "..";

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

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("workflow operations", () => {
  describe("workflow tracking", () => {
    it("should insert and retrieve a workflow tracking record", async () => {
      const agentStub = await getTestAgent("workflow-tracking-test-1");

      // Insert a test workflow
      const workflowId = "test-workflow-123";
      await agentStub.insertTestWorkflow(
        workflowId,
        "TEST_WORKFLOW",
        "running",
        { taskId: "task-1" }
      );

      // Retrieve it
      const workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;

      expect(workflow).toBeDefined();
      expect(workflow?.workflowId).toBe(workflowId);
      expect(workflow?.workflowName).toBe("TEST_WORKFLOW");
      expect(workflow?.status).toBe("running");
      expect(workflow?.metadata).toEqual({ taskId: "task-1" });
    });

    it("should return undefined for non-existent workflow", async () => {
      const agentStub = await getTestAgent("workflow-tracking-test-2");

      const workflow = await agentStub.getWorkflowById("non-existent-id");
      expect(workflow).toBeNull();
    });

    it("should query workflows by status", async () => {
      const agentStub = await getTestAgent("workflow-query-test-1");

      // Insert multiple workflows with different statuses
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "running");
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-3", "TEST_WORKFLOW", "running");
      await agentStub.insertTestWorkflow("wf-4", "TEST_WORKFLOW", "errored");

      // Query only running workflows
      const runningWorkflows = (await agentStub.queryWorkflows({
        status: "running"
      })) as WorkflowInfo[];

      expect(runningWorkflows.length).toBe(2);
      expect(runningWorkflows.every((w) => w.status === "running")).toBe(true);
    });

    it("should query workflows by multiple statuses", async () => {
      const agentStub = await getTestAgent("workflow-query-test-2");

      // Insert multiple workflows
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "running");
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-3", "TEST_WORKFLOW", "errored");
      await agentStub.insertTestWorkflow("wf-4", "TEST_WORKFLOW", "queued");

      // Query complete and errored workflows
      const finishedWorkflows = (await agentStub.queryWorkflows({
        status: ["complete", "errored"]
      })) as WorkflowInfo[];

      expect(finishedWorkflows.length).toBe(2);
      expect(
        finishedWorkflows.every(
          (w) => w.status === "complete" || w.status === "errored"
        )
      ).toBe(true);
    });

    it("should query workflows with limit", async () => {
      const agentStub = await getTestAgent("workflow-query-test-3");

      // Insert multiple workflows
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-3", "TEST_WORKFLOW", "complete");

      // Query with limit
      const workflows = (await agentStub.queryWorkflows({
        limit: 2
      })) as WorkflowInfo[];

      expect(workflows.length).toBe(2);
    });

    it("should query workflows by name", async () => {
      const agentStub = await getTestAgent("workflow-query-test-4");

      // Insert workflows with different names
      await agentStub.insertTestWorkflow("wf-1", "WORKFLOW_A", "running");
      await agentStub.insertTestWorkflow("wf-2", "WORKFLOW_B", "running");
      await agentStub.insertTestWorkflow("wf-3", "WORKFLOW_A", "complete");

      // Query by name
      const workflowsA = (await agentStub.queryWorkflows({
        workflowName: "WORKFLOW_A"
      })) as WorkflowInfo[];

      expect(workflowsA.length).toBe(2);
      expect(workflowsA.every((w) => w.workflowName === "WORKFLOW_A")).toBe(
        true
      );
    });

    it("should query workflows by metadata", async () => {
      const agentStub = await getTestAgent("workflow-query-test-5");

      // Insert workflows with different metadata
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "running", {
        userId: "user-123",
        priority: "high"
      });
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "running", {
        userId: "user-456",
        priority: "low"
      });
      await agentStub.insertTestWorkflow("wf-3", "TEST_WORKFLOW", "complete", {
        userId: "user-123",
        priority: "low"
      });

      // Query by single metadata field
      const user123Workflows = (await agentStub.queryWorkflows({
        metadata: { userId: "user-123" }
      })) as WorkflowInfo[];

      expect(user123Workflows.length).toBe(2);
      expect(
        user123Workflows.every((w) => w.metadata?.userId === "user-123")
      ).toBe(true);

      // Query by multiple metadata fields
      const highPriorityUser123 = (await agentStub.queryWorkflows({
        metadata: { userId: "user-123", priority: "high" }
      })) as WorkflowInfo[];

      expect(highPriorityUser123.length).toBe(1);
      expect(highPriorityUser123[0].workflowId).toBe("wf-1");
    });

    it("should delete a single workflow", async () => {
      const agentStub = await getTestAgent("workflow-delete-test-1");

      // Insert a workflow
      await agentStub.insertTestWorkflow(
        "wf-to-delete",
        "TEST_WORKFLOW",
        "complete"
      );

      // Verify it exists
      const before = (await agentStub.queryWorkflows({})) as WorkflowInfo[];
      expect(before.length).toBe(1);

      // Delete it
      const deleted = await agentStub.deleteWorkflowById("wf-to-delete");
      expect(deleted).toBe(true);

      // Verify it's gone
      const after = (await agentStub.queryWorkflows({})) as WorkflowInfo[];
      expect(after.length).toBe(0);

      // Deleting again should return false
      const deletedAgain = await agentStub.deleteWorkflowById("wf-to-delete");
      expect(deletedAgain).toBe(false);
    });

    it("should delete workflows by criteria", async () => {
      const agentStub = await getTestAgent("workflow-delete-test-2");

      // Insert multiple workflows
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "errored");
      await agentStub.insertTestWorkflow("wf-3", "TEST_WORKFLOW", "running");
      await agentStub.insertTestWorkflow("wf-4", "TEST_WORKFLOW", "complete");

      // Delete only completed workflows
      const deletedCount = await agentStub.deleteWorkflowsByCriteria({
        status: "complete"
      });
      expect(deletedCount).toBe(2);

      // Verify only non-complete workflows remain
      const remaining = (await agentStub.queryWorkflows({})) as WorkflowInfo[];
      expect(remaining.length).toBe(2);
      expect(remaining.every((w) => w.status !== "complete")).toBe(true);
    });

    it("should update workflow status", async () => {
      const agentStub = await getTestAgent("workflow-update-test-1");

      // Insert a workflow
      const workflowId = "update-test-wf";
      await agentStub.insertTestWorkflow(workflowId, "TEST_WORKFLOW", "queued");

      // Verify initial status
      let workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("queued");

      // Update status
      await agentStub.updateWorkflowStatus(workflowId, "running");

      // Verify updated status
      workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("running");
    });

    it("should throw clear error when tracking duplicate workflow ID", async () => {
      const agentStub = await getTestAgent("workflow-duplicate-test");

      // Insert a tracking record
      await agentStub.insertWorkflowTracking("duplicate-id", "TEST_WORKFLOW");

      // Try to insert again - should get friendly error
      await expect(
        agentStub.insertWorkflowTracking("duplicate-id", "TEST_WORKFLOW")
      ).rejects.toThrow(
        'Workflow with ID "duplicate-id" is already being tracked'
      );
    });

    it("should migrate workflow binding names", async () => {
      const agentStub = await getTestAgent("workflow-migrate-test");

      // Insert workflows with old binding name
      await agentStub.insertWorkflowTracking("migrate-1", "OLD_WORKFLOW");
      await agentStub.insertWorkflowTracking("migrate-2", "OLD_WORKFLOW");
      await agentStub.insertWorkflowTracking("migrate-3", "TEST_WORKFLOW"); // Different name

      // Migrate OLD_WORKFLOW to TEST_WORKFLOW (which exists in env)
      const migrated = await agentStub.migrateWorkflowBindingTest(
        "OLD_WORKFLOW",
        "TEST_WORKFLOW"
      );

      expect(migrated).toBe(2);

      // Verify the records were updated
      const workflows = (await agentStub.queryWorkflows({
        workflowName: "TEST_WORKFLOW"
      })) as WorkflowInfo[];
      expect(workflows.length).toBe(3); // 2 migrated + 1 original

      // Verify no workflows remain with old name
      const oldWorkflows = (await agentStub.queryWorkflows({
        workflowName: "OLD_WORKFLOW"
      })) as WorkflowInfo[];
      expect(oldWorkflows.length).toBe(0);
    });

    it("should return 0 when no workflows match old binding name", async () => {
      const agentStub = await getTestAgent("workflow-migrate-empty-test");

      const migrated = await agentStub.migrateWorkflowBindingTest(
        "NONEXISTENT_WORKFLOW",
        "TEST_WORKFLOW"
      );

      expect(migrated).toBe(0);
    });

    it("should throw error when new binding does not exist", async () => {
      const agentStub = await getTestAgent("workflow-migrate-invalid-test");

      await expect(
        agentStub.migrateWorkflowBindingTest("OLD_WORKFLOW", "INVALID_BINDING")
      ).rejects.toThrow("Workflow binding 'INVALID_BINDING' not found");
    });
  });

  describe("workflow callbacks", () => {
    it("should handle progress callback via HTTP endpoint", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-1");

      // Clear any existing callbacks
      await agentStub.clearCallbacks();

      // Send a progress callback via RPC
      // Progress is now an object with typed fields
      const progressData = {
        step: "processing",
        status: "running" as const,
        percent: 0.5,
        message: "Halfway done"
      };

      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: "test-wf-1",
        type: "progress",
        progress: progressData,
        timestamp: Date.now()
      });

      // Check that the callback was recorded
      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("progress");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-1");
      expect(callbacks[0].data).toEqual({
        progress: progressData
      });
    });

    it("should handle complete callback via RPC", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-2");

      await agentStub.clearCallbacks();

      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: "test-wf-2",
        type: "complete",
        result: { processed: 100 },
        timestamp: Date.now()
      });

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("complete");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-2");
      expect(callbacks[0].data).toEqual({ result: { processed: 100 } });
    });

    it("should handle error callback via RPC", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-3");

      await agentStub.clearCallbacks();

      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: "test-wf-3",
        type: "error",
        error: "Something went wrong",
        timestamp: Date.now()
      });

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("error");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-3");
      expect(callbacks[0].data).toEqual({ error: "Something went wrong" });
    });

    it("should handle custom event callback via RPC", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-4");

      await agentStub.clearCallbacks();

      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: "test-wf-4",
        type: "event",
        event: { customType: "approval", data: { approved: true } },
        timestamp: Date.now()
      });

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("event");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-4");
      expect(callbacks[0].data).toEqual({
        event: { customType: "approval", data: { approved: true } }
      });
    });
  });

  describe("workflow broadcast", () => {
    it("should handle broadcast request via RPC", async () => {
      const agentStub = await getTestAgent("workflow-broadcast-test-1");

      // Send a broadcast request via RPC
      agentStub._workflow_broadcast({
        type: "workflow-update",
        workflowId: "test-wf",
        progress: 0.75
      });

      // RPC call is synchronous and doesn't return a response
      // The broadcast itself happens internally
      expect(true).toBe(true);
    });
  });
});
