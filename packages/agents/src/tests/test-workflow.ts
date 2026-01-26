/**
 * Test Workflow for integration testing AgentWorkflow functionality
 */
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { AgentWorkflow } from "../workflow";
import type { AgentWorkflowParams } from "../workflow-types";
import type { TestWorkflowAgent } from "./worker";

/**
 * Parameters for the test processing workflow
 */
export type TestProcessingParams = {
  taskId: string;
  shouldFail?: boolean;
  waitForApproval?: boolean;
};

/**
 * A test workflow that extends AgentWorkflow for integration testing.
 * Tests various features:
 * - Progress reporting
 * - Completion reporting
 * - Error handling
 * - Agent RPC calls
 * - Event waiting (waitForApproval)
 */
export class TestProcessingWorkflow extends AgentWorkflow<
  TestWorkflowAgent,
  TestProcessingParams
> {
  async run(
    event: WorkflowEvent<AgentWorkflowParams<TestProcessingParams>>,
    step: WorkflowStep
  ) {
    const params = this.getUserParams(event);

    // Step 1: Report start
    await this.reportProgress(0.1, "Starting processing");

    // Step 2: If waiting for approval, pause and wait for event
    if (params.waitForApproval) {
      await this.reportProgress(0.3, "Waiting for approval");

      const approval = await step.waitForEvent<{
        approved: boolean;
        reason?: string;
      }>("wait-for-approval", { type: "approval", timeout: "1 minute" });

      if (!approval.payload.approved) {
        await this.reportError(
          `Rejected: ${approval.payload.reason || "No reason given"}`
        );
        throw new Error("Workflow rejected");
      }
    }

    // Step 3: Process the task
    await this.reportProgress(0.5, "Processing task");

    const result = await step.do("process", async () => {
      if (params.shouldFail) {
        throw new Error("Intentional failure for testing");
      }
      return {
        processed: true,
        taskId: params.taskId,
        timestamp: Date.now()
      };
    });

    // Step 4: Call agent method via RPC (if agent is available)
    await step.do("notify-agent", async () => {
      try {
        // This tests the this.agent RPC functionality
        await this.agent.recordWorkflowResult(params.taskId, result);
      } catch (e) {
        // Agent RPC might fail in some test scenarios, that's okay
        console.log("Agent RPC call failed (expected in some tests):", e);
      }
    });

    // Step 5: Broadcast to clients
    await this.broadcastToClients({
      type: "workflow-progress",
      taskId: params.taskId,
      status: "completing"
    });

    // Step 6: Report completion
    await this.reportProgress(0.9, "Almost done");
    await this.reportComplete(result);

    return result;
  }
}

/**
 * A simpler test workflow for basic testing scenarios
 */
export class SimpleTestWorkflow extends AgentWorkflow<
  TestWorkflowAgent,
  { value: string }
> {
  async run(
    event: WorkflowEvent<AgentWorkflowParams<{ value: string }>>,
    step: WorkflowStep
  ) {
    const params = this.getUserParams(event);

    const result = await step.do("echo", async () => {
      return { echoed: params.value };
    });

    await this.reportComplete(result);
    return result;
  }
}
