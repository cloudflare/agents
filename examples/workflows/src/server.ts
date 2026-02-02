/**
 * Workflow Demo - Task Processing with Approval
 *
 * This example demonstrates:
 * - Multiple concurrent workflows with progress tracking
 * - Human-in-the-loop approval gate per workflow
 * - Real-time state sync to connected clients
 * - Workflow list with status tracking
 * - Approve/reject specific workflows from the Agent
 */

import { Agent, callable, routeAgentRequest } from "agents";
import { AgentWorkflow } from "agents/workflows";
import type {
  AgentWorkflowEvent,
  AgentWorkflowStep,
  DefaultProgress,
  WorkflowInfo
} from "agents/workflows";

// Workflow parameters
type TaskParams = {
  taskId: string;
  taskName: string;
};

// Persisted UI state stored in workflow metadata
// This survives page refreshes unlike real-time progress updates
type PersistedUIState = {
  waitingForApproval?: boolean;
  lastProgress?: DefaultProgress;
};

// Workflow metadata structure
type WorkflowMetadata = {
  taskName: string;
  uiState?: PersistedUIState;
};

// UI status (subset of WorkflowInfo status with "waiting" for approval UI)
type UIStatus =
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "errored"
  | "paused";

// Per-workflow UI state extends WorkflowInfo with transient UI fields
export type WorkflowItem = Omit<WorkflowInfo, "status"> & {
  /** UI-friendly status */
  status: UIStatus;
  /** Display name for the task */
  taskName: string;
  /** Real-time progress (not persisted in tracking table) */
  progress: DefaultProgress | null;
  /** Whether workflow is waiting for user approval */
  waitingForApproval: boolean;
  /** Workflow result (not persisted in tracking table) */
  result?: unknown;
};

// Shared agent state (minimal - real-time updates only)
// Pagination is client-side, not shared
export type AgentState = Record<string, never>; // Empty state

// Page result returned by listWorkflows
export type WorkflowPage = {
  workflows: WorkflowItem[];
  total: number;
  nextCursor: string | null;
};

// Broadcast message types for real-time updates
export type WorkflowUpdate =
  | { type: "workflow:added"; workflow: WorkflowItem }
  | {
      type: "workflow:updated";
      workflowId: string;
      updates: Partial<WorkflowItem>;
    }
  | { type: "workflow:removed"; workflowId: string };

/**
 * TaskAgent - manages multiple task workflows and syncs state to clients
 */
export class TaskAgent extends Agent<Env, AgentState> {
  // Empty state - pagination is client-side
  initialState: AgentState = {};

  /**
   * Convert WorkflowInfo to WorkflowItem for UI
   * Reads persisted UI state from metadata.uiState
   */
  private toWorkflowItem(
    info: WorkflowInfo,
    overrides: Partial<WorkflowItem> = {}
  ): WorkflowItem {
    const metadata = info.metadata as WorkflowMetadata | null;
    const uiState = metadata?.uiState;

    // Use overrides first, then persisted uiState, then defaults
    const waitingForApproval =
      overrides.waitingForApproval ?? uiState?.waitingForApproval ?? false;
    const progress = overrides.progress ?? uiState?.lastProgress ?? null;

    return {
      ...info,
      status: this.mapStatus(info.status, waitingForApproval),
      taskName: metadata?.taskName || "Unknown Task",
      progress,
      waitingForApproval,
      result: overrides.result
    };
  }

  /**
   * Update persisted UI state in metadata
   */
  private updateUIState(workflowId: string, uiState: PersistedUIState): void {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) return;

    const metadata = (workflow.metadata as WorkflowMetadata) || {};
    const updatedMetadata: WorkflowMetadata = {
      ...metadata,
      uiState: { ...metadata.uiState, ...uiState }
    };

    this.sql`
      UPDATE cf_agents_workflows 
      SET metadata = ${JSON.stringify(updatedMetadata)}
      WHERE workflow_id = ${workflowId}
    `;
  }

  /**
   * Clear persisted UI state from metadata
   */
  private clearUIState(workflowId: string): void {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) return;

    const metadata = (workflow.metadata as WorkflowMetadata) || {};
    const { uiState: _, ...rest } = metadata;

    this.sql`
      UPDATE cf_agents_workflows 
      SET metadata = ${JSON.stringify(rest)}
      WHERE workflow_id = ${workflowId}
    `;
  }

  /**
   * Broadcast a workflow update to all connected clients
   */
  private broadcastUpdate(update: WorkflowUpdate): void {
    this.broadcast(JSON.stringify(update));
  }

  /**
   * Map tracking table status to UI status
   */
  private mapStatus(
    status: string,
    waitingForApproval: boolean
  ): WorkflowItem["status"] {
    if (waitingForApproval) return "waiting";
    switch (status) {
      case "queued":
        return "queued";
      case "running":
        return "running";
      case "waiting":
        return "waiting";
      case "paused":
        return "paused";
      case "complete":
        return "complete";
      case "errored":
      case "terminated":
        return "errored";
      default:
        console.warn(
          `Unknown workflow status: ${status}, defaulting to running`
        );
        return "running";
    }
  }

  /**
   * Broadcast a workflow update to all clients
   */
  private updateWorkflow(
    workflowId: string,
    updates: Partial<WorkflowItem>
  ): void {
    this.broadcastUpdate({ type: "workflow:updated", workflowId, updates });
  }

  /**
   * Submit a new task for processing
   */
  @callable()
  async submitTask(taskName: string): Promise<WorkflowItem> {
    const taskId = crypto.randomUUID();

    // Start the workflow
    const workflowId = await this.runWorkflow(
      "TASK_WORKFLOW",
      { taskId, taskName },
      { metadata: { taskName } }
    );

    // Create workflow item for UI
    const now = new Date();
    const newWorkflow: WorkflowItem = {
      id: workflowId,
      workflowId,
      workflowName: "TASK_WORKFLOW",
      metadata: { taskName },
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      status: "queued",
      taskName,
      progress: { step: "starting", status: "pending", percent: 0 },
      waitingForApproval: false
    };

    // Broadcast to all clients
    this.broadcastUpdate({ type: "workflow:added", workflow: newWorkflow });

    return newWorkflow;
  }

  /**
   * Terminate a specific workflow
   */
  @callable()
  async terminate(workflowId: string): Promise<void> {
    await this.terminateWorkflow(workflowId);
    this.broadcastUpdate({ type: "workflow:removed", workflowId });
  }

  /**
   * Pause a running workflow
   */
  @callable()
  async pause(workflowId: string): Promise<void> {
    await this.pauseWorkflow(workflowId);
    this.updateWorkflow(workflowId, { status: "paused" });
  }

  /**
   * Resume a paused workflow
   */
  @callable()
  async resume(workflowId: string): Promise<void> {
    await this.resumeWorkflow(workflowId);
    this.updateWorkflow(workflowId, { status: "running" });
  }

  /**
   * Restart a completed/errored workflow
   */
  @callable()
  async restart(workflowId: string): Promise<void> {
    // Clear persisted UI state before restart
    this.clearUIState(workflowId);
    await this.restartWorkflow(workflowId);
    this.updateWorkflow(workflowId, {
      status: "queued",
      progress: { step: "restarting", status: "pending", percent: 0 },
      waitingForApproval: false,
      error: undefined,
      result: undefined
    });
  }

  /**
   * Approve a specific workflow
   */
  @callable()
  async approve(workflowId: string, reason?: string): Promise<void> {
    await this.approveWorkflow(workflowId, {
      reason: reason || "Approved by user",
      metadata: { approvedAt: Date.now() }
    });

    // Clear persisted UI state
    this.clearUIState(workflowId);

    this.updateWorkflow(workflowId, {
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
   * Reject a specific workflow
   */
  @callable()
  async reject(workflowId: string, reason?: string): Promise<void> {
    await this.rejectWorkflow(workflowId, {
      reason: reason || "Rejected by user"
    });
    // State will be updated by onWorkflowError callback
  }

  /**
   * List workflows with pagination (client-driven)
   */
  @callable()
  listWorkflows(cursor?: string, limit = 5): WorkflowPage {
    const page = this.getWorkflows({
      workflowName: "TASK_WORKFLOW",
      orderBy: "desc",
      limit,
      cursor
    });

    // toWorkflowItem reads persisted UI state from metadata.uiState
    const workflows = page.workflows.map((info) => this.toWorkflowItem(info));

    return {
      workflows,
      total: page.total,
      nextCursor: page.nextCursor
    };
  }

  /**
   * Clear completed and errored workflows
   */
  @callable()
  clearCompleted(): { clearedCount: number } {
    const count = this.deleteWorkflows({ status: ["complete", "errored"] });
    // Broadcast that clients should refresh their lists
    this.broadcast(JSON.stringify({ type: "workflows:cleared", count }));
    return { clearedCount: count };
  }

  /**
   * Remove a specific workflow
   */
  @callable()
  dismissWorkflow(workflowId: string): void {
    this.deleteWorkflow(workflowId);
    this.broadcastUpdate({ type: "workflow:removed", workflowId });
  }

  // Lifecycle callbacks from workflow - broadcast updates to all clients

  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    const p = progress as DefaultProgress & { waitingForApproval?: boolean };
    console.log(`Progress: ${workflowName}/${workflowId}`, p);

    const waitingForApproval = p.waitingForApproval ?? false;

    // Persist UI state so it survives page refresh
    this.updateUIState(workflowId, {
      waitingForApproval,
      lastProgress: p
    });

    this.updateWorkflow(workflowId, {
      progress: p,
      waitingForApproval,
      status: waitingForApproval ? "waiting" : "running"
    });
  }

  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    console.log(`Complete: ${workflowName}/${workflowId}`, result);

    // Clear persisted UI state on completion
    this.clearUIState(workflowId);

    this.updateWorkflow(workflowId, {
      progress: {
        step: "done",
        status: "complete",
        percent: 1,
        message: "Task completed!"
      },
      status: "complete",
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

    // Clear persisted UI state on error
    this.clearUIState(workflowId);

    this.updateWorkflow(workflowId, {
      progress: { step: "error", status: "error", percent: 0, message: error },
      status: "errored",
      error: { name: "WorkflowError", message: error },
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
    // Signal waiting state via progress (agent will set waitingForApproval)
    await this.reportProgress({
      step: "approval",
      status: "pending",
      percent: 0.5,
      message: "Waiting for approval...",
      waitingForApproval: true
    });

    // This will throw WorkflowRejectedError if rejected
    const approvalData = await this.waitForApproval<{ approvedAt: number }>(
      step,
      {
        timeout: "1 hour"
      }
    );

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
