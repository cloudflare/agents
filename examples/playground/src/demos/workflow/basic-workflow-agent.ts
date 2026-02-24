import { callable } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";
import type { ProcessingResult } from "./processing-workflow";

// Progress is transient (not persisted by SDK), so we track it in state
export interface BasicWorkflowState {
  progress: Record<string, { step: number; total: number; message: string }>;
}

// Serializable workflow info for RPC (Dates converted to ISO strings)
export interface WorkflowWithProgress {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  name: string;
  error: { name: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress?: { step: number; total: number; message: string };
}

export class BasicWorkflowAgent extends Agent<Env, BasicWorkflowState> {
  initialState: BasicWorkflowState = {
    progress: {}
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Workflow lifecycle callbacks
  // ─────────────────────────────────────────────────────────────────────────────

  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: { step: number; total: number; message: string }
  ): Promise<void> {
    // Store progress in state (transient, not tracked by SDK)
    this.setState({
      ...this.state,
      progress: {
        ...this.state.progress,
        [workflowId]: progress
      }
    });

    // Broadcast progress to connected clients
    this.broadcast(
      JSON.stringify({
        type: "workflow_progress",
        workflowId,
        workflowName,
        progress
      })
    );
  }

  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: ProcessingResult
  ): Promise<void> {
    // Clear progress from state
    const { [workflowId]: _, ...remainingProgress } = this.state.progress;
    this.setState({ ...this.state, progress: remainingProgress });

    this.broadcast(
      JSON.stringify({
        type: "workflow_complete",
        workflowId,
        workflowName,
        result
      })
    );
  }

  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    // Clear progress from state
    const { [workflowId]: _, ...remainingProgress } = this.state.progress;
    this.setState({ ...this.state, progress: remainingProgress });

    this.broadcast(
      JSON.stringify({
        type: "workflow_error",
        workflowId,
        workflowName,
        error
      })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Callable methods
  // ─────────────────────────────────────────────────────────────────────────────

  @callable({ description: "Start a new processing workflow" })
  async startWorkflow(name: string, stepCount: number): Promise<string> {
    // Start the real workflow, storing name in metadata
    const workflowId = await this.runWorkflow(
      "ProcessingWorkflow",
      { name, stepCount },
      { metadata: { name, stepCount } }
    );

    this.broadcast(
      JSON.stringify({
        type: "workflow_started",
        workflowId,
        name,
        stepCount
      })
    );

    return workflowId;
  }

  @callable({ description: "Get all workflows with progress" })
  listWorkflows(): WorkflowWithProgress[] {
    // Get workflows from SDK tracking (returns WorkflowPage with pagination)
    const { workflows } = this.getWorkflows({
      workflowName: "ProcessingWorkflow"
    });

    // Convert to serializable format and merge with progress state
    return workflows.map((w) => {
      const metadata = w.metadata as { name?: string } | null;
      return {
        id: w.id,
        workflowId: w.workflowId,
        workflowName: w.workflowName,
        status: w.status,
        name: metadata?.name || w.workflowName,
        error: w.error,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
        completedAt: w.completedAt?.toISOString() ?? null,
        progress: this.state.progress[w.workflowId]
      };
    });
  }

  @callable({ description: "Clear completed/errored workflows" })
  clearWorkflows(): number {
    const count = this.deleteWorkflows({
      status: ["complete", "errored", "terminated"]
    });

    this.broadcast(
      JSON.stringify({
        type: "workflows_cleared",
        count
      })
    );

    return count;
  }

  @callable({ description: "Get workflow stats" })
  getStats(): {
    queued: number;
    running: number;
    completed: number;
    errored: number;
  } {
    const { workflows } = this.getWorkflows({
      workflowName: "ProcessingWorkflow"
    });
    return {
      queued: workflows.filter((w) => w.status === "queued").length,
      running: workflows.filter((w) => w.status === "running").length,
      completed: workflows.filter((w) => w.status === "complete").length,
      errored: workflows.filter((w) => w.status === "errored").length
    };
  }
}
