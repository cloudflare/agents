import { Agent, callable } from "agents";
import type { WorkflowInfo } from "agents/workflows";

// No custom state needed - we use SDK's workflow tracking
// Title/description are stored in workflow metadata
export interface ApprovalAgentState {
  // Empty - all data comes from getWorkflows()
}

// Extended workflow info for the UI
export interface ApprovalRequest {
  id: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  reason?: string;
}

export class ApprovalAgent extends Agent<Env, ApprovalAgentState> {
  initialState: ApprovalAgentState = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // Workflow lifecycle callbacks
  // ─────────────────────────────────────────────────────────────────────────────

  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: { status: "pending" | "approved" | "rejected"; message: string }
  ): Promise<void> {
    this.broadcast(
      JSON.stringify({
        type: "approval_progress",
        requestId: workflowId,
        progress
      })
    );
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: { approved: boolean }
  ): Promise<void> {
    this.broadcast(
      JSON.stringify({
        type: result?.approved ? "approval_approved" : "approval_rejected",
        requestId: workflowId
      })
    );
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    this.broadcast(
      JSON.stringify({
        type: "approval_error",
        requestId: workflowId,
        error
      })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper to convert SDK WorkflowInfo to our ApprovalRequest format
  // ─────────────────────────────────────────────────────────────────────────────

  private _toApprovalRequest(w: WorkflowInfo): ApprovalRequest {
    const metadata = w.metadata as {
      title?: string;
      description?: string;
    } | null;

    // Map SDK status to our simpler status
    // "queued", "running", "waiting" are all "pending" from the user's perspective
    let status: "pending" | "approved" | "rejected" = "pending";
    if (w.status === "complete") {
      status = "approved";
    } else if (w.status === "errored" || w.status === "terminated") {
      status = "rejected";
    }

    return {
      id: w.workflowId,
      title: metadata?.title || "Untitled",
      description: metadata?.description || "",
      status,
      createdAt: w.createdAt.toISOString(),
      resolvedAt: w.completedAt?.toISOString(),
      reason: w.error?.message
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Callable methods
  // ─────────────────────────────────────────────────────────────────────────────

  @callable({ description: "Submit a new approval request" })
  async requestApproval(
    title: string,
    description: string
  ): Promise<ApprovalRequest> {
    // Start the approval workflow, storing title/description in metadata
    const workflowId = await this.runWorkflow(
      "ApprovalWorkflow",
      { title, description },
      { metadata: { title, description } }
    );

    this.broadcast(
      JSON.stringify({
        type: "approval_requested",
        requestId: workflowId,
        title
      })
    );

    // Return the request info
    return {
      id: workflowId,
      title,
      description,
      status: "pending",
      createdAt: new Date().toISOString()
    };
  }

  @callable({ description: "Get all approval requests" })
  listRequests(): ApprovalRequest[] {
    const { workflows } = this.getWorkflows({
      workflowName: "ApprovalWorkflow"
    });
    return workflows.map((w) => this._toApprovalRequest(w));
  }

  @callable({ description: "Approve a pending request" })
  async approve(requestId: string): Promise<boolean> {
    // Check if workflow exists in tracking table
    const workflow = this.getWorkflow(requestId);
    if (!workflow) {
      return false;
    }

    // Don't approve already completed workflows
    if (
      workflow.status === "complete" ||
      workflow.status === "errored" ||
      workflow.status === "terminated"
    ) {
      return false;
    }

    // Resume the workflow with approval
    // Note: we don't check "waiting" status because the local tracking table
    // doesn't auto-sync with Cloudflare - the workflow could be waiting even
    // if our local status shows "queued" or "running"
    await this.approveWorkflow(requestId, {
      reason: "Approved via playground",
      metadata: { approvedBy: "demo-user" }
    });

    return true;
  }

  @callable({ description: "Reject a pending request" })
  async reject(requestId: string, reason?: string): Promise<boolean> {
    // Check if workflow exists in tracking table
    const workflow = this.getWorkflow(requestId);
    if (!workflow) {
      return false;
    }

    // Don't reject already completed workflows
    if (
      workflow.status === "complete" ||
      workflow.status === "errored" ||
      workflow.status === "terminated"
    ) {
      return false;
    }

    // Resume the workflow with rejection
    await this.rejectWorkflow(requestId, {
      reason: reason || "Rejected via playground"
    });

    return true;
  }

  @callable({ description: "Clear resolved approval requests" })
  clearApprovals(): number {
    const count = this.deleteWorkflows({
      workflowName: "ApprovalWorkflow",
      status: ["complete", "errored", "terminated"]
    });

    this.broadcast(
      JSON.stringify({
        type: "approvals_cleared",
        count
      })
    );

    return count;
  }

  @callable({ description: "Get approval stats" })
  getStats(): { pending: number; approved: number; rejected: number } {
    const { workflows } = this.getWorkflows({
      workflowName: "ApprovalWorkflow"
    });
    return {
      pending: workflows.filter(
        (w) =>
          w.status === "queued" ||
          w.status === "running" ||
          w.status === "waiting"
      ).length,
      approved: workflows.filter((w) => w.status === "complete").length,
      rejected: workflows.filter(
        (w) => w.status === "errored" || w.status === "terminated"
      ).length
    };
  }
}
