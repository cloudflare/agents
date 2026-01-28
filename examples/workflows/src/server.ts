/**
 * Workflow Demo - Task Processing with Approval
 *
 * This example demonstrates:
 * - Multi-step workflow with progress tracking
 * - Human-in-the-loop approval gate
 * - Real-time state sync to connected clients
 * - Approve/reject workflow from the Agent
 */

import { Agent, AgentWorkflow, callable, routeAgentRequest } from "agents";
import type {
  AgentWorkflowEvent,
  AgentWorkflowStep,
  DefaultProgress
} from "agents";

// Workflow parameters
type TaskParams = {
  taskId: string;
  taskName: string;
};

// Agent state synced to clients
export type AgentState = {
  currentWorkflowId: string | null;
  currentTaskName: string | null;
  progress: DefaultProgress | null;
  waitingForApproval: boolean;
  status: "idle" | "running" | "waiting" | "completed" | "error";
  result: unknown;
  error: string | null;
};

/**
 * TaskAgent - manages task workflows and syncs state to clients
 */
export class TaskAgent extends Agent<Env, AgentState> {
  // Initialize state when agent starts
  initialState: AgentState = {
    currentWorkflowId: null,
    currentTaskName: null,
    progress: null,
    waitingForApproval: false,
    status: "idle",
    result: null,
    error: null
  };

  /**
   * Submit a new task for processing
   */
  @callable()
  async submitTask(taskName: string): Promise<string> {
    const taskId = crypto.randomUUID();

    // Start the workflow
    const workflowId = await this.runWorkflow(
      "TASK_WORKFLOW",
      { taskId, taskName },
      { metadata: { taskName } }
    );

    // Update state to show we're running
    this.setState({
      ...this.state,
      currentWorkflowId: workflowId,
      currentTaskName: taskName,
      progress: { step: "starting", status: "pending", percent: 0 },
      waitingForApproval: false,
      status: "running",
      result: null,
      error: null
    });

    return workflowId;
  }

  /**
   * Approve the current waiting workflow
   */
  @callable()
  async approve(reason?: string): Promise<void> {
    const workflowId = this.state.currentWorkflowId;
    if (!workflowId) {
      throw new Error("No workflow to approve");
    }

    await this.approveWorkflow(workflowId, {
      reason: reason || "Approved by user",
      metadata: { approvedAt: Date.now() }
    });

    this.setState({
      ...this.state,
      waitingForApproval: false,
      status: "running",
      progress: {
        step: "approved",
        status: "running",
        percent: 0.6,
        message: "Approval received, continuing..."
      }
    });
  }

  /**
   * Reject the current waiting workflow
   */
  @callable()
  async reject(reason?: string): Promise<void> {
    const workflowId = this.state.currentWorkflowId;
    if (!workflowId) {
      throw new Error("No workflow to reject");
    }

    await this.rejectWorkflow(workflowId, {
      reason: reason || "Rejected by user"
    });

    // State will be updated by onWorkflowError callback
  }

  /**
   * Reset the agent state to start fresh
   */
  @callable()
  async reset(): Promise<void> {
    this.setState(this.initialState);
  }

  // Lifecycle callbacks from workflow

  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    const p = progress as DefaultProgress;
    console.log(`Progress: ${workflowName}/${workflowId}`, p);

    this.setState({
      ...this.state,
      progress: p,
      status:
        p.status === "pending" && this.state.waitingForApproval
          ? "waiting"
          : "running"
    });
  }

  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    console.log(`Complete: ${workflowName}/${workflowId}`, result);

    this.setState({
      ...this.state,
      progress: {
        step: "done",
        status: "complete",
        percent: 1,
        message: "Task completed!"
      },
      status: "completed",
      result,
      waitingForApproval: false
    });
  }

  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    console.log(`Error: ${workflowName}/${workflowId}`, error);

    this.setState({
      ...this.state,
      progress: { step: "error", status: "error", percent: 0, message: error },
      status: "error",
      error,
      waitingForApproval: false
    });
  }
}

/**
 * TaskProcessingWorkflow - multi-step workflow with approval gate
 */
export class TaskProcessingWorkflow extends AgentWorkflow<
  TaskAgent,
  TaskParams
> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;
    console.log(`Starting workflow for task: ${params.taskName}`);

    // Step 1: Validate
    await this.reportProgress({
      step: "validate",
      status: "running",
      percent: 0.1,
      message: "Validating task..."
    });

    await step.do("validate", async () => {
      // Simulate validation work
      await sleep(1000);
      return { valid: true };
    });

    await this.reportProgress({
      step: "validate",
      status: "complete",
      percent: 0.25,
      message: "Validation complete"
    });

    // Step 2: Process
    await this.reportProgress({
      step: "process",
      status: "running",
      percent: 0.3,
      message: "Processing task..."
    });

    const processResult = await step.do("process", async () => {
      // Simulate processing work
      await sleep(1500);
      return {
        processed: true,
        taskId: params.taskId,
        data: `Processed: ${params.taskName}`
      };
    });

    await this.reportProgress({
      step: "process",
      status: "complete",
      percent: 0.5,
      message: "Processing complete - awaiting approval"
    });

    // Step 3: Wait for human approval
    await step.mergeAgentState({ waitingForApproval: true });

    await this.reportProgress({
      step: "approval",
      status: "pending",
      percent: 0.5,
      message: "Waiting for approval..."
    });

    // This will throw WorkflowRejectedError if rejected
    const approvalData = await this.waitForApproval<{ approvedAt: number }>(
      step,
      {
        timeout: "1 hour"
      }
    );

    await step.mergeAgentState({ waitingForApproval: false });

    await this.reportProgress({
      step: "approval",
      status: "complete",
      percent: 0.7,
      message: "Approved! Finalizing..."
    });

    // Step 4: Finalize
    await this.reportProgress({
      step: "finalize",
      status: "running",
      percent: 0.8,
      message: "Finalizing task..."
    });

    const finalResult = await step.do("finalize", async () => {
      // Simulate finalization work
      await sleep(1000);
      return {
        ...processResult,
        finalized: true,
        approvedAt: approvalData?.approvedAt,
        completedAt: Date.now()
      };
    });

    await this.reportProgress({
      step: "finalize",
      status: "complete",
      percent: 1,
      message: "Task completed successfully!"
    });

    await step.reportComplete(finalResult);

    return finalResult;
  }
}

// Helper to simulate work
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main request handler
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
