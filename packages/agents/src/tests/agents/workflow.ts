import { Agent } from "../../index.ts";
import type { WorkflowStatus, WorkflowInfo } from "../../workflows.ts";

type WorkflowEnv = {
  TEST_WORKFLOW: Workflow;
  SIMPLE_WORKFLOW: Workflow;
  THROW_IN_RUN_WORKFLOW: Workflow;
  REPORT_ERROR_THEN_THROW_WORKFLOW: Workflow;
  REPORT_ERROR_ONLY_WORKFLOW: Workflow;
  THROW_NON_ERROR_WORKFLOW: Workflow;
};

// Test Agent for Workflow integration
export class TestWorkflowAgent extends Agent<WorkflowEnv> {
  observability = undefined;

  // Track callbacks received for testing
  private _callbacksReceived: Array<{
    type: string;
    workflowName: string;
    workflowId: string;
    data: unknown;
  }> = [];

  getCallbacksReceived(): Array<{
    type: string;
    workflowName: string;
    workflowId: string;
    data: unknown;
  }> {
    return this._callbacksReceived;
  }

  clearCallbacks(): void {
    this._callbacksReceived = [];
  }

  // Helper to insert workflow tracking directly (for testing duplicate ID handling)
  insertWorkflowTracking(workflowId: string, workflowName: string): void {
    const id = `test-${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      this.sql`
        INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status)
        VALUES (${id}, ${workflowId}, ${workflowName}, 'queued')
      `;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(
          `Workflow with ID "${workflowId}" is already being tracked`
        );
      }
      throw e;
    }
  }

  // Override lifecycle callbacks to track them
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "progress",
      workflowName,
      workflowId,
      data: { progress }
    });
  }

  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "complete",
      workflowName,
      workflowId,
      data: { result }
    });
  }

  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "error",
      workflowName,
      workflowId,
      data: { error }
    });
  }

  async onWorkflowEvent(
    workflowName: string,
    workflowId: string,
    event: unknown
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "event",
      workflowName,
      workflowId,
      data: { event }
    });
  }

  // Test helper to insert a workflow tracking record directly
  async insertTestWorkflow(
    workflowId: string,
    workflowName: string,
    status: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const id = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status, metadata)
      VALUES (${id}, ${workflowId}, ${workflowName}, ${status}, ${metadata ? JSON.stringify(metadata) : null})
    `;
    return id;
  }

  // Expose getWorkflow for testing
  async getWorkflowById(workflowId: string): Promise<WorkflowInfo | null> {
    return this.getWorkflow(workflowId) ?? null;
  }

  // Expose getWorkflows for testing (returns just workflows array for backward compat)
  async getWorkflowsForTest(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    limit?: number;
    orderBy?: "asc" | "desc";
    cursor?: string;
  }): Promise<WorkflowInfo[]> {
    return this.getWorkflows(criteria).workflows;
  }

  // Expose getWorkflows with full pagination info for testing
  getWorkflowsPageForTest(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    limit?: number;
    orderBy?: "asc" | "desc";
    cursor?: string;
  }): { workflows: WorkflowInfo[]; total: number; nextCursor: string | null } {
    return this.getWorkflows(criteria);
  }

  // Expose deleteWorkflow for testing
  async deleteWorkflowById(workflowId: string): Promise<boolean> {
    return this.deleteWorkflow(workflowId);
  }

  // Expose deleteWorkflows for testing
  async deleteWorkflowsByCriteria(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    olderThan?: Date;
  }): Promise<number> {
    return this.deleteWorkflows(criteria);
  }

  // Expose migrateWorkflowBinding for testing
  migrateWorkflowBindingTest(oldName: string, newName: string): number {
    return this.migrateWorkflowBinding(oldName, newName);
  }

  // Test helper to update workflow status directly
  async updateWorkflowStatus(
    workflowId: string,
    status: string
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.sql`
      UPDATE cf_agents_workflows
      SET status = ${status}, updated_at = ${now}
      WHERE workflow_id = ${workflowId}
    `;
  }

  // Track workflow results for testing RPC calls from workflows
  private _workflowResults: Array<{ taskId: string; result: unknown }> = [];

  getWorkflowResults(): Array<{ taskId: string; result: unknown }> {
    return this._workflowResults;
  }

  clearWorkflowResults(): void {
    this._workflowResults = [];
  }

  // Called by workflows via RPC to record results
  async recordWorkflowResult(taskId: string, result: unknown): Promise<void> {
    this._workflowResults.push({ taskId, result });
  }

  // Test helper: call a method that's expected to throw, returning the error message.
  // This avoids unhandled rejections in workerd when testing error paths via RPC.
  async expectThrow(
    method: string,
    ...args: unknown[]
  ): Promise<{ threw: boolean; message: string }> {
    try {
      const self = this as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      await self[method](...args);
      return { threw: false, message: "" };
    } catch (e) {
      return {
        threw: true,
        message: e instanceof Error ? e.message : String(e)
      };
    }
  }

  // Start a workflow using the Agent's runWorkflow method
  async runWorkflowTest(
    workflowId: string,
    params: { taskId: string; shouldFail?: boolean; waitForApproval?: boolean }
  ): Promise<string> {
    return this.runWorkflow("TEST_WORKFLOW", params, { id: workflowId });
  }

  // Start a simple workflow
  async runSimpleWorkflowTest(
    workflowId: string,
    params: { value: string }
  ): Promise<string> {
    return this.runWorkflow("SIMPLE_WORKFLOW", params, {
      id: workflowId
    });
  }

  // Send an event to a workflow
  async sendApprovalEvent(
    workflowId: string,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    await this.sendWorkflowEvent("TEST_WORKFLOW", workflowId, {
      type: "approval",
      payload: { approved, reason }
    });
  }

  // Restart workflow with options (for testing resetTracking)
  async restartWorkflowWithOptions(
    workflowId: string,
    options?: { resetTracking?: boolean }
  ): Promise<void> {
    return this.restartWorkflow(workflowId, options);
  }

  // Get workflow status from Cloudflare
  async getCloudflareWorkflowStatus(workflowId: string) {
    return this.getWorkflowStatus("TEST_WORKFLOW", workflowId);
  }

  // Start a throw-in-run workflow
  async runThrowInRunWorkflowTest(
    workflowId: string,
    params: { message: string }
  ): Promise<string> {
    return this.runWorkflow("THROW_IN_RUN_WORKFLOW", params, {
      id: workflowId
    });
  }

  // Start a report-error-then-throw workflow
  async runReportErrorThenThrowWorkflowTest(
    workflowId: string,
    params: { message: string }
  ): Promise<string> {
    return this.runWorkflow("REPORT_ERROR_THEN_THROW_WORKFLOW", params, {
      id: workflowId
    });
  }

  // Start a report-error-only workflow
  async runReportErrorOnlyWorkflowTest(
    workflowId: string,
    params: { message: string }
  ): Promise<string> {
    return this.runWorkflow("REPORT_ERROR_ONLY_WORKFLOW", params, {
      id: workflowId
    });
  }

  // Start a throw-non-error workflow
  async runThrowNonErrorWorkflowTest(
    workflowId: string,
    params: { value: string }
  ): Promise<string> {
    return this.runWorkflow("THROW_NON_ERROR_WORKFLOW", params, {
      id: workflowId
    });
  }
}
