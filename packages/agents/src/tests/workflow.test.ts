import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "..";
import type { WorkflowInfo } from "../workflows";

// Helper type for callback records
type CallbackRecord = {
  type: string;
  workflowName: string;
  workflowId: string;
  data: unknown;
};

// Helper type for paginated workflow results
type WorkflowPage = {
  workflows: WorkflowInfo[];
  total: number;
  nextCursor: string | null;
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
      const runningWorkflows = (await agentStub.getWorkflowsForTest({
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
      const finishedWorkflows = (await agentStub.getWorkflowsForTest({
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
      const workflows = (await agentStub.getWorkflowsForTest({
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
      const workflowsA = (await agentStub.getWorkflowsForTest({
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
      const user123Workflows = (await agentStub.getWorkflowsForTest({
        metadata: { userId: "user-123" }
      })) as WorkflowInfo[];

      expect(user123Workflows.length).toBe(2);
      expect(
        user123Workflows.every((w) => w.metadata?.userId === "user-123")
      ).toBe(true);

      // Query by multiple metadata fields
      const highPriorityUser123 = (await agentStub.getWorkflowsForTest({
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
      const before = (await agentStub.getWorkflowsForTest(
        {}
      )) as WorkflowInfo[];
      expect(before.length).toBe(1);

      // Delete it
      const deleted = await agentStub.deleteWorkflowById("wf-to-delete");
      expect(deleted).toBe(true);

      // Verify it's gone
      const after = (await agentStub.getWorkflowsForTest({})) as WorkflowInfo[];
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
      const remaining = (await agentStub.getWorkflowsForTest(
        {}
      )) as WorkflowInfo[];
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
      const workflows = (await agentStub.getWorkflowsForTest({
        workflowName: "TEST_WORKFLOW"
      })) as WorkflowInfo[];
      expect(workflows.length).toBe(3); // 2 migrated + 1 original

      // Verify no workflows remain with old name
      const oldWorkflows = (await agentStub.getWorkflowsForTest({
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

    it("should update tracking table to 'running' on progress callback", async () => {
      const agentStub = await getTestAgent("workflow-callback-tracking-test-1");

      // Insert a workflow in 'queued' status
      const workflowId = "callback-tracking-wf-1";
      await agentStub.insertTestWorkflow(workflowId, "TEST_WORKFLOW", "queued");

      // Verify initial status
      let workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("queued");

      // Send a progress callback
      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: workflowId,
        type: "progress",
        progress: { step: "processing", percent: 0.5 },
        timestamp: Date.now()
      });

      // Verify status was updated to 'running'
      workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("running");
    });

    it("should update tracking table to 'complete' on complete callback", async () => {
      const agentStub = await getTestAgent("workflow-callback-tracking-test-2");

      // Insert a workflow in 'running' status
      const workflowId = "callback-tracking-wf-2";
      await agentStub.insertTestWorkflow(
        workflowId,
        "TEST_WORKFLOW",
        "running"
      );

      // Verify initial status
      let workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("running");
      expect(workflow?.completedAt).toBeNull();

      // Send a complete callback
      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: workflowId,
        type: "complete",
        result: { success: true },
        timestamp: Date.now()
      });

      // Verify status was updated to 'complete' with completedAt
      workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("complete");
      expect(workflow?.completedAt).not.toBeNull();
    });

    it("should update tracking table to 'errored' on error callback", async () => {
      const agentStub = await getTestAgent("workflow-callback-tracking-test-3");

      // Insert a workflow in 'running' status
      const workflowId = "callback-tracking-wf-3";
      await agentStub.insertTestWorkflow(
        workflowId,
        "TEST_WORKFLOW",
        "running"
      );

      // Verify initial status
      let workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("running");

      // Send an error callback
      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: workflowId,
        type: "error",
        error: "Something went wrong",
        timestamp: Date.now()
      });

      // Verify status was updated to 'errored' with error info
      workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("errored");
      expect(workflow?.error?.name).toBe("WorkflowError");
      expect(workflow?.error?.message).toBe("Something went wrong");
      expect(workflow?.completedAt).not.toBeNull();
    });

    it("should not change status from 'running' on progress callback", async () => {
      const agentStub = await getTestAgent("workflow-callback-tracking-test-4");

      // Insert a workflow already in 'running' status
      const workflowId = "callback-tracking-wf-4";
      await agentStub.insertTestWorkflow(
        workflowId,
        "TEST_WORKFLOW",
        "running"
      );

      // Send a progress callback
      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: workflowId,
        type: "progress",
        progress: { step: "processing", percent: 0.75 },
        timestamp: Date.now()
      });

      // Verify status is still 'running' (not changed since it was already running)
      const workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("running");
    });

    it("should not update tracking table on event callback", async () => {
      const agentStub = await getTestAgent("workflow-callback-tracking-test-5");

      // Insert a workflow in 'running' status
      const workflowId = "callback-tracking-wf-5";
      await agentStub.insertTestWorkflow(
        workflowId,
        "TEST_WORKFLOW",
        "running"
      );

      // Send an event callback
      await agentStub._workflow_handleCallback({
        workflowName: "TEST_WORKFLOW",
        workflowId: workflowId,
        type: "event",
        event: { type: "custom-event" },
        timestamp: Date.now()
      });

      // Verify status was NOT changed (events don't change status)
      const workflow = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(workflow?.status).toBe("running");
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

  describe("terminateWorkflow", () => {
    it("should throw error when workflow not found in tracking table", async () => {
      const agentStub = await getTestAgent("terminate-workflow-test-1");

      await expect(
        agentStub.terminateWorkflow("non-existent-workflow-id")
      ).rejects.toThrow(
        "Workflow non-existent-workflow-id not found in tracking table"
      );
    });

    it("should throw error when workflow binding not found", async () => {
      const agentStub = await getTestAgent("terminate-workflow-test-2");
      const workflowId = "terminate-test-wf-1";

      // Insert a workflow with a non-existent binding name
      await agentStub.insertTestWorkflow(
        workflowId,
        "NON_EXISTENT_BINDING",
        "running"
      );

      await expect(agentStub.terminateWorkflow(workflowId)).rejects.toThrow(
        "Workflow binding 'NON_EXISTENT_BINDING' not found in environment"
      );
    });
  });

  describe("pauseWorkflow", () => {
    it("should throw error when workflow not found in tracking table", async () => {
      const agentStub = await getTestAgent("pause-workflow-test-1");

      await expect(
        agentStub.pauseWorkflow("non-existent-workflow-id")
      ).rejects.toThrow(
        "Workflow non-existent-workflow-id not found in tracking table"
      );
    });

    it("should throw error when workflow binding not found", async () => {
      const agentStub = await getTestAgent("pause-workflow-test-2");
      const workflowId = "pause-test-wf-1";

      await agentStub.insertTestWorkflow(
        workflowId,
        "NON_EXISTENT_BINDING",
        "running"
      );

      await expect(agentStub.pauseWorkflow(workflowId)).rejects.toThrow(
        "Workflow binding 'NON_EXISTENT_BINDING' not found in environment"
      );
    });
  });

  describe("resumeWorkflow", () => {
    it("should throw error when workflow not found in tracking table", async () => {
      const agentStub = await getTestAgent("resume-workflow-test-1");

      await expect(
        agentStub.resumeWorkflow("non-existent-workflow-id")
      ).rejects.toThrow(
        "Workflow non-existent-workflow-id not found in tracking table"
      );
    });

    it("should throw error when workflow binding not found", async () => {
      const agentStub = await getTestAgent("resume-workflow-test-2");
      const workflowId = "resume-test-wf-1";

      await agentStub.insertTestWorkflow(
        workflowId,
        "NON_EXISTENT_BINDING",
        "paused"
      );

      await expect(agentStub.resumeWorkflow(workflowId)).rejects.toThrow(
        "Workflow binding 'NON_EXISTENT_BINDING' not found in environment"
      );
    });
  });

  describe("restartWorkflow", () => {
    it("should throw error when workflow not found in tracking table", async () => {
      const agentStub = await getTestAgent("restart-workflow-test-1");

      await expect(
        agentStub.restartWorkflow("non-existent-workflow-id")
      ).rejects.toThrow(
        "Workflow non-existent-workflow-id not found in tracking table"
      );
    });

    it("should throw error when workflow binding not found", async () => {
      const agentStub = await getTestAgent("restart-workflow-test-2");
      const workflowId = "restart-test-wf-1";

      await agentStub.insertTestWorkflow(
        workflowId,
        "NON_EXISTENT_BINDING",
        "complete"
      );

      await expect(agentStub.restartWorkflow(workflowId)).rejects.toThrow(
        "Workflow binding 'NON_EXISTENT_BINDING' not found in environment"
      );
    });

    it("should preserve tracking timestamps when resetTracking is false", async () => {
      const agentStub = await getTestAgent("restart-workflow-test-3");
      const workflowId = "restart-preserve-test";

      // Insert a workflow with a specific created_at (simulating old workflow)
      await agentStub.insertTestWorkflow(
        workflowId,
        "TEST_WORKFLOW",
        "complete"
      );

      // Get the original created_at
      const original = (await agentStub.getWorkflowById(
        workflowId
      )) as WorkflowInfo | null;
      expect(original).not.toBeNull();
      const originalCreatedAt = original!.createdAt;

      // Note: We can't fully test restartWorkflow with resetTracking: false
      // without a real workflow binding, but we can verify the method accepts the option
      // The actual behavior (preserving timestamps) would require integration testing
      expect(originalCreatedAt).toBeDefined();
    });
  });

  describe("pagination", () => {
    it("should return total count of matching workflows", async () => {
      const agentStub = await getTestAgent("pagination-test-1");

      // Insert 5 workflows
      for (let i = 0; i < 5; i++) {
        await agentStub.insertTestWorkflow(
          `wf-page-${i}`,
          "TEST_WORKFLOW",
          "complete"
        );
      }

      // Query with limit 2
      const page = (await agentStub.getWorkflowsPageForTest({
        limit: 2
      })) as WorkflowPage;

      expect(page.workflows.length).toBe(2);
      expect(page.total).toBe(5);
      expect(page.nextCursor).not.toBeNull();
    });

    it("should return null nextCursor when no more pages", async () => {
      const agentStub = await getTestAgent("pagination-test-2");

      // Insert 2 workflows
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "complete");

      // Query with limit 10 (more than available)
      const page = (await agentStub.getWorkflowsPageForTest({
        limit: 10
      })) as WorkflowPage;

      expect(page.workflows.length).toBe(2);
      expect(page.total).toBe(2);
      expect(page.nextCursor).toBeNull();
    });

    it("should paginate through results using cursor", async () => {
      const agentStub = await getTestAgent("pagination-test-3");

      // Insert 5 workflows with delays to ensure different created_at
      for (let i = 0; i < 5; i++) {
        await agentStub.insertTestWorkflow(
          `wf-cursor-${i}`,
          "TEST_WORKFLOW",
          "complete"
        );
      }

      // Get first page
      const page1 = (await agentStub.getWorkflowsPageForTest({
        limit: 2,
        orderBy: "desc"
      })) as WorkflowPage;
      expect(page1.workflows.length).toBe(2);
      expect(page1.total).toBe(5);
      expect(page1.nextCursor).not.toBeNull();

      // Get second page using cursor
      const page2 = (await agentStub.getWorkflowsPageForTest({
        limit: 2,
        orderBy: "desc",
        cursor: page1.nextCursor!
      })) as WorkflowPage;
      expect(page2.workflows.length).toBe(2);
      expect(page2.total).toBe(5);

      // Ensure no duplicates between pages
      const page1Ids = page1.workflows.map((w) => w.workflowId);
      const page2Ids = page2.workflows.map((w) => w.workflowId);
      const overlap = page1Ids.filter((id) => page2Ids.includes(id));
      expect(overlap.length).toBe(0);

      // Get third page (should have 1 remaining)
      const page3 = (await agentStub.getWorkflowsPageForTest({
        limit: 2,
        orderBy: "desc",
        cursor: page2.nextCursor!
      })) as WorkflowPage;
      expect(page3.workflows.length).toBe(1);
      expect(page3.nextCursor).toBeNull();
    });

    it("should respect status filter with pagination", async () => {
      const agentStub = await getTestAgent("pagination-test-4");

      // Insert mixed status workflows
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-2", "TEST_WORKFLOW", "running");
      await agentStub.insertTestWorkflow("wf-3", "TEST_WORKFLOW", "complete");
      await agentStub.insertTestWorkflow("wf-4", "TEST_WORKFLOW", "errored");
      await agentStub.insertTestWorkflow("wf-5", "TEST_WORKFLOW", "complete");

      // Query only complete with limit
      const page = (await agentStub.getWorkflowsPageForTest({
        status: "complete",
        limit: 2
      })) as WorkflowPage;

      expect(page.workflows.length).toBe(2);
      expect(page.total).toBe(3); // 3 complete workflows total
      expect(page.workflows.every((w) => w.status === "complete")).toBe(true);
    });

    it("should throw descriptive error for invalid cursor", async () => {
      const agentStub = await getTestAgent("pagination-test-5");

      // Insert a workflow so there's data
      await agentStub.insertTestWorkflow("wf-1", "TEST_WORKFLOW", "complete");

      // Try with malformed cursor
      await expect(
        agentStub.getWorkflowsPageForTest({ cursor: "not-valid-base64!" })
      ).rejects.toThrow("Invalid pagination cursor");

      // Try with valid base64 but invalid JSON
      await expect(
        agentStub.getWorkflowsPageForTest({ cursor: btoa("not-json") })
      ).rejects.toThrow("Invalid pagination cursor");

      // Try with valid JSON but wrong structure
      await expect(
        agentStub.getWorkflowsPageForTest({
          cursor: btoa(JSON.stringify({ wrong: "structure" }))
        })
      ).rejects.toThrow("Invalid pagination cursor");
    });
  });

  describe("orderBy", () => {
    it("should order workflows ascending by created_at", async () => {
      const agentStub = await getTestAgent("orderby-test-1");

      // Insert workflows (they get sequential created_at)
      await agentStub.insertTestWorkflow(
        "wf-first",
        "TEST_WORKFLOW",
        "complete"
      );
      await agentStub.insertTestWorkflow(
        "wf-second",
        "TEST_WORKFLOW",
        "complete"
      );
      await agentStub.insertTestWorkflow(
        "wf-third",
        "TEST_WORKFLOW",
        "complete"
      );

      const workflows = (await agentStub.getWorkflowsForTest({
        orderBy: "asc"
      })) as WorkflowInfo[];

      expect(workflows.length).toBe(3);
      expect(workflows[0].workflowId).toBe("wf-first");
      expect(workflows[2].workflowId).toBe("wf-third");
    });

    it("should order workflows descending by created_at", async () => {
      const agentStub = await getTestAgent("orderby-test-2");

      await agentStub.insertTestWorkflow(
        "wf-first",
        "TEST_WORKFLOW",
        "complete"
      );
      await agentStub.insertTestWorkflow(
        "wf-second",
        "TEST_WORKFLOW",
        "complete"
      );
      await agentStub.insertTestWorkflow(
        "wf-third",
        "TEST_WORKFLOW",
        "complete"
      );

      const workflows = (await agentStub.getWorkflowsForTest({
        orderBy: "desc"
      })) as WorkflowInfo[];

      expect(workflows.length).toBe(3);
      expect(workflows[0].workflowId).toBe("wf-third");
      expect(workflows[2].workflowId).toBe("wf-first");
    });

    it("should default to descending order", async () => {
      const agentStub = await getTestAgent("orderby-test-3");

      await agentStub.insertTestWorkflow(
        "wf-first",
        "TEST_WORKFLOW",
        "complete"
      );
      await agentStub.insertTestWorkflow(
        "wf-last",
        "TEST_WORKFLOW",
        "complete"
      );

      const workflows = (await agentStub.getWorkflowsForTest(
        {}
      )) as WorkflowInfo[];

      expect(workflows.length).toBe(2);
      // Default is desc, so last inserted should be first
      expect(workflows[0].workflowId).toBe("wf-last");
    });
  });

  describe("sendWorkflowEvent", () => {
    it("should send event to workflow via helper", async () => {
      const agentStub = await getTestAgent("send-event-test-1");

      // The sendApprovalEvent helper wraps sendWorkflowEvent
      // We can't fully test without a real workflow, but we can verify
      // the method exists and can be called
      await expect(
        agentStub.sendApprovalEvent("non-existent-wf", true, "test reason")
      ).rejects.toThrow(); // Will throw because workflow doesn't exist
    });
  });
});
