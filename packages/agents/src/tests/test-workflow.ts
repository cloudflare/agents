/**
 * Test Workflow for integration testing AgentWorkflow functionality
 */
import { AgentWorkflow } from "../workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "../workflows";
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
    event: AgentWorkflowEvent<TestProcessingParams>,
    step: AgentWorkflowStep
  ) {
    const params = event.payload;

    // Step 1: Report start (non-durable)
    await this.reportProgress({
      step: "start",
      status: "running",
      percent: 0.1,
      message: "Starting processing"
    });

    // Step 2: If waiting for approval, pause and wait for event
    if (params.waitForApproval) {
      await this.reportProgress({
        step: "approval",
        status: "pending",
        percent: 0.3,
        message: "Waiting for approval"
      });

      const approval = await step.waitForEvent<{
        approved: boolean;
        reason?: string;
      }>("wait-for-approval", { type: "approval", timeout: "1 minute" });

      if (!approval.payload.approved) {
        await step.reportError(
          `Rejected: ${approval.payload.reason || "No reason given"}`
        );
        throw new Error("Workflow rejected");
      }
    }

    // Step 3: Process the task (non-durable progress report)
    await this.reportProgress({
      step: "process",
      status: "running",
      percent: 0.5,
      message: "Processing task"
    });

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

    // Step 5: Broadcast to clients (non-durable)
    this.broadcastToClients({
      type: "workflow-progress",
      taskId: params.taskId,
      status: "completing"
    });

    // Step 6: Report completion (durable via step)
    await this.reportProgress({
      step: "complete",
      status: "running",
      percent: 0.9,
      message: "Almost done"
    });
    await step.reportComplete(result);

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
    event: AgentWorkflowEvent<{ value: string }>,
    step: AgentWorkflowStep
  ) {
    const params = event.payload;

    const result = await step.do("echo", async () => {
      return { echoed: params.value };
    });

    await step.reportComplete(result);
    return result;
  }
}

/**
 * Test workflow that throws directly in run() (outside any step.do).
 * Used to verify that unhandled errors trigger onWorkflowError on the Agent.
 */
export class ThrowInRunWorkflow extends AgentWorkflow<
  TestWorkflowAgent,
  { message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ message: string }>,
    _step: AgentWorkflowStep
  ) {
    throw new Error(event.payload.message);
  }
}

/**
 * Test workflow that calls step.reportError() and then throws.
 * Used to verify that onWorkflowError is NOT called twice (no double notification).
 */
export class ReportErrorThenThrowWorkflow extends AgentWorkflow<
  TestWorkflowAgent,
  { message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ message: string }>,
    step: AgentWorkflowStep
  ) {
    await step.reportError(event.payload.message);
    throw new Error(event.payload.message);
  }
}

/**
 * Test workflow that calls step.reportError() without throwing.
 * Used to verify backward compatibility: reportError alone still works
 * and workflow continues executing.
 */
export class ReportErrorOnlyWorkflow extends AgentWorkflow<
  TestWorkflowAgent,
  { message: string }
> {
  async run(
    event: AgentWorkflowEvent<{ message: string }>,
    step: AgentWorkflowStep
  ) {
    await step.reportError(event.payload.message);

    const result = await step.do("continue-work", async () => {
      return { continued: true };
    });

    await step.reportComplete(result);
    return result;
  }
}

/**
 * Test workflow that throws a non-Error value (string).
 * Used to verify that String(err) path works in _autoReportError.
 */
export class ThrowNonErrorWorkflow extends AgentWorkflow<
  TestWorkflowAgent,
  { value: string }
> {
  async run(
    event: AgentWorkflowEvent<{ value: string }>,
    _step: AgentWorkflowStep
  ) {
    // oxlint-disable-next-line no-throw-literal
    throw event.payload.value;
  }
}
