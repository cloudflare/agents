/**
 * Workflow integration types for Agents
 *
 * These types provide seamless integration between Cloudflare Agents
 * and Cloudflare Workflows for durable, multi-step background processing.
 */

import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowSleepDuration
} from "cloudflare:workers";

/**
 * Type alias for WorkflowEvent in AgentWorkflow context.
 * Identical to WorkflowEvent - provided for naming consistency with AgentWorkflowStep.
 */
export type AgentWorkflowEvent<Params = unknown> = WorkflowEvent<Params>;

/**
 * Extended WorkflowStep with durable Agent communication methods.
 * All added methods on this interface are durable - they're idempotent and won't
 * repeat on workflow retry.
 */
export interface AgentWorkflowStep extends WorkflowStep {
  /**
   * Report successful completion to the Agent (durable).
   * Triggers onWorkflowComplete() on the Agent.
   * @param result - Optional result data
   */
  reportComplete<T = unknown>(result?: T): Promise<void>;

  /**
   * Report an error to the Agent (durable).
   * Triggers onWorkflowError() on the Agent.
   * @param error - Error or error message
   */
  reportError(error: Error | string): Promise<void>;

  /**
   * Send a custom event to the Agent (durable).
   * Triggers onWorkflowEvent() on the Agent.
   * @param event - Custom event payload
   */
  sendEvent<T = unknown>(event: T): Promise<void>;

  /**
   * Update the Agent's state entirely (durable).
   * This will replace the Agent's state and broadcast to all connected clients.
   * @param state - New state to set
   */
  updateAgentState(state: unknown): Promise<void>;

  /**
   * Merge partial state into the Agent's existing state (durable).
   * Performs a shallow merge and broadcasts to all connected clients.
   * @param partialState - Partial state to merge
   */
  mergeAgentState(partialState: Record<string, unknown>): Promise<void>;

  /**
   * Reset the Agent's state to its initialState (durable).
   * Broadcasts the reset state to all connected clients.
   */
  resetAgentState(): Promise<void>;
}

/**
 * Internal parameters injected by runWorkflow() to identify the originating Agent
 */
export type AgentWorkflowInternalParams = {
  /** Name/ID of the Agent that started this workflow */
  __agentName: string;
  /** Environment binding name for the Agent's namespace */
  __agentBinding: string;
  /** Workflow binding name (for callbacks) */
  __workflowName: string;
};

/**
 * Combined workflow params: user params + internal agent params
 */
export type AgentWorkflowParams<T = unknown> = T & AgentWorkflowInternalParams;

/**
 * Workflow callback types for Agent-Workflow communication
 */
export type WorkflowCallbackType = "progress" | "complete" | "error" | "event";

/**
 * Base callback structure sent from Workflow to Agent
 */
export type WorkflowCallbackBase = {
  /** Workflow binding name */
  workflowName: string;
  /** ID of the workflow instance */
  workflowId: string;
  /** Type of callback */
  type: WorkflowCallbackType;
  /** Timestamp when callback was sent */
  timestamp: number;
};

/**
 * Default progress type - covers common use cases.
 * Developers can define their own progress type for domain-specific needs.
 */
export type DefaultProgress = {
  /** Current step name */
  step?: string;
  /** Step/overall status */
  status?: "pending" | "running" | "complete" | "error";
  /** Human-readable message */
  message?: string;
  /** Progress percentage (0-1) */
  percent?: number;
  /** Allow additional custom fields */
  [key: string]: unknown;
};

/**
 * Progress callback - reports workflow progress with typed payload
 */
export type WorkflowProgressCallback<P = DefaultProgress> =
  WorkflowCallbackBase & {
    type: "progress";
    /** Typed progress data */
    progress: P;
  };

/**
 * Complete callback - workflow finished successfully
 */
export type WorkflowCompleteCallback = WorkflowCallbackBase & {
  type: "complete";
  /** Result of the workflow */
  result?: unknown;
};

/**
 * Error callback - workflow encountered an error
 */
export type WorkflowErrorCallback = WorkflowCallbackBase & {
  type: "error";
  /** Error message */
  error: string;
};

/**
 * Event callback - custom event from workflow
 */
export type WorkflowEventCallback = WorkflowCallbackBase & {
  type: "event";
  /** Custom event payload */
  event: unknown;
};

/**
 * Union of all callback types
 */
export type WorkflowCallback<P = DefaultProgress> =
  | WorkflowProgressCallback<P>
  | WorkflowCompleteCallback
  | WorkflowErrorCallback
  | WorkflowEventCallback;

/**
 * Workflow status values - derived from Cloudflare's InstanceStatus
 */
export type WorkflowStatus = InstanceStatus["status"];

/**
 * Row structure for cf_agents_workflows tracking table
 */
export type WorkflowTrackingRow = {
  /** Internal row ID (UUID) */
  id: string;
  /** Cloudflare Workflow instance ID */
  workflow_id: string;
  /** Workflow binding name */
  workflow_name: string;
  /** Current workflow status */
  status: WorkflowStatus;
  /** JSON-serialized metadata for querying */
  metadata: string | null;
  /** Error name if workflow failed */
  error_name: string | null;
  /** Error message if workflow failed */
  error_message: string | null;
  /** Unix timestamp when workflow was created */
  created_at: number;
  /** Unix timestamp when workflow was last updated */
  updated_at: number;
  /** Unix timestamp when workflow completed (null if not complete) */
  completed_at: number | null;
};

/**
 * Options for runWorkflow()
 */
export type RunWorkflowOptions = {
  /** Custom workflow instance ID (auto-generated if not provided) */
  id?: string;
  /** Optional metadata for querying (stored as JSON) */
  metadata?: Record<string, unknown>;
  /** Agent binding name (auto-detected from class name if not provided) */
  agentBinding?: string;
};

/**
 * Event payload for sendWorkflowEvent()
 */
export type WorkflowEventPayload = {
  /** Event type name */
  type: string;
  /** Event payload data */
  payload: unknown;
};

/**
 * Parsed workflow tracking info returned by getWorkflow()
 */
export type WorkflowInfo = {
  /** Internal row ID */
  id: string;
  /** Cloudflare Workflow instance ID */
  workflowId: string;
  /** Workflow binding name */
  workflowName: string;
  /** Current workflow status */
  status: WorkflowStatus;
  /** Metadata (parsed from JSON) */
  metadata: Record<string, unknown> | null;
  /** Error info if workflow failed */
  error: { name: string; message: string } | null;
  /** When workflow was created */
  createdAt: Date;
  /** When workflow was last updated */
  updatedAt: Date;
  /** When workflow completed (null if not complete) */
  completedAt: Date | null;
};

/**
 * Criteria for querying tracked workflows
 */
export type WorkflowQueryCriteria = {
  /** Filter by status */
  status?: WorkflowStatus | WorkflowStatus[];
  /** Filter by workflow binding name */
  workflowName?: string;
  /** Filter by metadata key-value pairs (exact match) */
  metadata?: Record<string, string | number | boolean>;
  /** Limit number of results */
  limit?: number;
  /** Order by created_at */
  orderBy?: "asc" | "desc";
};

/**
 * Standard approval event payload used by approveWorkflow/rejectWorkflow
 */
export type ApprovalEventPayload = {
  /** Whether the workflow was approved */
  approved: boolean;
  /** Optional reason for approval/rejection */
  reason?: string;
  /** Optional additional metadata */
  metadata?: Record<string, unknown>;
};

/**
 * Options for waitForApproval()
 */
export type WaitForApprovalOptions = {
  /** Step name for waitForEvent (default: "wait-for-approval") */
  stepName?: string;
  /** Timeout duration (e.g., "7 days") */
  timeout?: WorkflowSleepDuration;
  /** Event type to wait for (default: "approval") */
  eventType?: string;
};

/**
 * Error thrown when a workflow is rejected via rejectWorkflow()
 */
export class WorkflowRejectedError extends Error {
  constructor(
    public readonly reason?: string,
    public readonly workflowId?: string
  ) {
    super(reason ? `Workflow rejected: ${reason}` : "Workflow rejected");
    this.name = "WorkflowRejectedError";
  }
}
