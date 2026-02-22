import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { ApprovalAgent } from "./approval-agent";

export type ApprovalParams = {
  title: string;
  description: string;
  requestedBy?: string;
};

export type ApprovalResult = {
  title: string;
  approved: boolean;
  resolvedAt: string;
  approvedBy?: string;
};

/**
 * An approval workflow that demonstrates:
 * - waitForApproval() for human-in-the-loop patterns
 * - Progress reporting while waiting
 * - Handling both approval and rejection
 */
export class ApprovalWorkflow extends AgentWorkflow<
  ApprovalAgent,
  ApprovalParams,
  { status: "pending" | "approved" | "rejected"; message: string }
> {
  async run(
    event: AgentWorkflowEvent<ApprovalParams>,
    step: AgentWorkflowStep
  ): Promise<ApprovalResult> {
    const { title, description: _description } = event.payload;

    // Report that we're waiting for approval
    await this.reportProgress({
      status: "pending",
      message: `Waiting for approval: ${title}`
    });

    // Wait for approval - this pauses the workflow until approved/rejected
    // The agent calls approveWorkflow() or rejectWorkflow() to resume
    try {
      const approvalData = await this.waitForApproval<{
        approvedBy?: string;
      }>(step, {
        timeout: "7 days"
      });

      // Approved!
      const result: ApprovalResult = {
        title,
        approved: true,
        resolvedAt: new Date().toISOString(),
        approvedBy: approvalData?.approvedBy
      };

      await this.reportProgress({
        status: "approved",
        message: `Approved: ${title}`
      });

      await step.reportComplete(result);
      return result;
    } catch (_error) {
      // Rejected - WorkflowRejectedError was thrown
      const result: ApprovalResult = {
        title,
        approved: false,
        resolvedAt: new Date().toISOString()
      };

      await this.reportProgress({
        status: "rejected",
        message: `Rejected: ${title}`
      });

      // Note: reportError was already called by waitForApproval
      return result;
    }
  }
}
