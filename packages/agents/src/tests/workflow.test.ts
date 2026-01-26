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
  });

  describe("workflow callbacks", () => {
    it("should handle progress callback via HTTP endpoint", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-1");

      // Clear any existing callbacks
      await agentStub.clearCallbacks();

      // Send a progress callback via the Agent's HTTP endpoint
      const response = await agentStub.fetch(
        "https://agent.internal/_workflow/callback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowName: "TEST_WORKFLOW",
            workflowId: "test-wf-1",
            type: "progress",
            progress: 0.5,
            message: "Halfway done",
            timestamp: Date.now()
          })
        }
      );

      expect(response.ok).toBe(true);

      // Check that the callback was recorded
      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("progress");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-1");
      expect(callbacks[0].data).toEqual({
        progress: 0.5,
        message: "Halfway done"
      });
    });

    it("should handle complete callback via HTTP endpoint", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-2");

      await agentStub.clearCallbacks();

      const response = await agentStub.fetch(
        "https://agent.internal/_workflow/callback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowName: "TEST_WORKFLOW",
            workflowId: "test-wf-2",
            type: "complete",
            result: { processed: 100 },
            timestamp: Date.now()
          })
        }
      );

      expect(response.ok).toBe(true);

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("complete");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-2");
      expect(callbacks[0].data).toEqual({ result: { processed: 100 } });
    });

    it("should handle error callback via HTTP endpoint", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-3");

      await agentStub.clearCallbacks();

      const response = await agentStub.fetch(
        "https://agent.internal/_workflow/callback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowName: "TEST_WORKFLOW",
            workflowId: "test-wf-3",
            type: "error",
            error: "Something went wrong",
            timestamp: Date.now()
          })
        }
      );

      expect(response.ok).toBe(true);

      const callbacks =
        (await agentStub.getCallbacksReceived()) as CallbackRecord[];
      expect(callbacks.length).toBe(1);
      expect(callbacks[0].type).toBe("error");
      expect(callbacks[0].workflowName).toBe("TEST_WORKFLOW");
      expect(callbacks[0].workflowId).toBe("test-wf-3");
      expect(callbacks[0].data).toEqual({ error: "Something went wrong" });
    });

    it("should handle custom event callback via HTTP endpoint", async () => {
      const agentStub = await getTestAgent("workflow-callback-test-4");

      await agentStub.clearCallbacks();

      const response = await agentStub.fetch(
        "https://agent.internal/_workflow/callback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowName: "TEST_WORKFLOW",
            workflowId: "test-wf-4",
            type: "event",
            event: { customType: "approval", data: { approved: true } },
            timestamp: Date.now()
          })
        }
      );

      expect(response.ok).toBe(true);

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
    it("should handle broadcast request via HTTP endpoint", async () => {
      const agentStub = await getTestAgent("workflow-broadcast-test-1");

      // Send a broadcast request
      const response = await agentStub.fetch(
        "https://agent.internal/_workflow/broadcast",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "workflow-update",
            workflowId: "test-wf",
            progress: 0.75
          })
        }
      );

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result).toEqual({ success: true });
    });
  });
});
