/**
 * AgentWorkflow - Base class for Workflows that integrate with Agents
 *
 * Extends Cloudflare's WorkflowEntrypoint to provide seamless access to
 * the Agent that started the workflow, enabling bidirectional communication.
 *
 * @example
 * ```typescript
 * import { AgentWorkflow } from 'agents';
 * import type { MyAgent } from './agent';
 *
 * type TaskParams = { taskId: string; data: string };
 *
 * export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
 *   async run(event: WorkflowEvent<AgentWorkflowParams<TaskParams>>, step: WorkflowStep) {
 *     // Access the originating Agent via typed RPC
 *     await this.agent.updateTaskStatus(event.payload.taskId, 'processing');
 *
 *     const result = await step.do('process', async () => {
 *       // ... processing logic
 *       return { processed: true };
 *     });
 *
 *     // Report progress to Agent (typed)
 *     await this.reportProgress({ step: 'process', status: 'complete', percent: 0.5 });
 *
 *     // Broadcast to connected clients
 *     await this.broadcastToClients({ type: 'progress', data: result });
 *
 *     return result;
 *   }
 * }
 * ```
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowSleepDuration
} from "cloudflare:workers";
import { getAgentByName, type Agent } from "./index";
import type {
  AgentWorkflowParams,
  WorkflowCallback,
  DefaultProgress,
  WaitForApprovalOptions
} from "./workflow-types";
import { WorkflowRejectedError } from "./workflow-types";

/**
 * Base class for Workflows that need access to their originating Agent.
 *
 * @template AgentType - The Agent class type (for typed RPC access)
 * @template Params - User-defined params passed to the workflow (optional)
 * @template ProgressType - Type for progress reporting (defaults to DefaultProgress)
 * @template Env - Environment type (defaults to Cloudflare.Env)
 */
export class AgentWorkflow<
  AgentType extends Agent = Agent,
  Params = unknown,
  ProgressType = DefaultProgress,
  Env extends Cloudflare.Env = Cloudflare.Env
> extends WorkflowEntrypoint<Env, AgentWorkflowParams<Params>> {
  /**
   * The Agent stub - initialized before run() is called.
   * Use this.agent to access the Agent's RPC methods.
   */
  private _agent!: DurableObjectStub<AgentType>;

  /**
   * Workflow instance ID
   */
  private _workflowId!: string;

  /**
   * Workflow binding name (for callbacks)
   */
  private _workflowName!: string;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);

    // Store original run method
    const originalRun = this.run.bind(this);

    // Override run to initialize agent before user code executes
    this.run = async (
      event: WorkflowEvent<AgentWorkflowParams<Params>>,
      step: WorkflowStep
    ) => {
      // Initialize agent connection
      await this._initAgent(event);

      // Call user's run implementation
      return originalRun(event, step);
    };
  }

  /**
   * Initialize the Agent stub from workflow params.
   * Called automatically before run() executes.
   */
  private async _initAgent(
    event: WorkflowEvent<AgentWorkflowParams<Params>>
  ): Promise<void> {
    const { __agentName, __agentBinding, __workflowName } = event.payload;

    if (!__agentName || !__agentBinding || !__workflowName) {
      throw new Error(
        "AgentWorkflow requires __agentName, __agentBinding, and __workflowName in params. " +
          "Use agent.runWorkflow() to start workflows with proper agent context."
      );
    }

    this._workflowId = event.instanceId;
    this._workflowName = __workflowName;

    // Get the Agent namespace from env
    const namespace = (this.env as Record<string, unknown>)[
      __agentBinding
    ] as DurableObjectNamespace<AgentType>;

    if (!namespace) {
      throw new Error(
        `Agent binding '${__agentBinding}' not found in environment`
      );
    }

    // Get the Agent stub by name
    this._agent = await getAgentByName<Cloudflare.Env, AgentType>(
      namespace,
      __agentName
    );
  }

  /**
   * Get the Agent stub for RPC calls.
   * Provides typed access to the Agent's methods.
   *
   * @example
   * ```typescript
   * // Call any public method on the Agent
   * await this.agent.updateStatus('processing');
   * const data = await this.agent.getData();
   * ```
   */
  get agent(): DurableObjectStub<AgentType> {
    if (!this._agent) {
      throw new Error(
        "Agent not initialized. Ensure you're accessing this.agent inside run()."
      );
    }
    return this._agent;
  }

  /**
   * Get the workflow instance ID
   */
  get workflowId(): string {
    return this._workflowId;
  }

  /**
   * Get the workflow binding name
   */
  get workflowName(): string {
    return this._workflowName;
  }

  /**
   * Make an HTTP request to the Agent.
   * Useful for triggering HTTP endpoints on the Agent.
   *
   * @param path - Path to request (e.g., '/api/status')
   * @param init - Optional fetch init options
   * @returns Response from the Agent
   */
  protected async fetchAgent(
    path: string,
    init?: RequestInit
  ): Promise<Response> {
    const url = new URL(path, "https://agent.internal");
    return this.agent.fetch(url.toString(), init);
  }

  /**
   * Send a notification to the Agent via RPC.
   *
   * @param callback - Callback payload to send
   */
  protected async notifyAgent(callback: WorkflowCallback): Promise<void> {
    await this.agent._workflow_handleCallback(callback);
  }

  /**
   * Report progress to the Agent with typed progress data.
   * Triggers onWorkflowProgress() on the Agent.
   *
   * @param progress - Typed progress data
   *
   * @example
   * ```typescript
   * // Using default progress type
   * await this.reportProgress({ step: 'fetch', status: 'running' });
   * await this.reportProgress({ step: 'fetch', status: 'complete', percent: 0.5 });
   *
   * // With custom progress type
   * await this.reportProgress({ stage: 'extract', recordsProcessed: 100 });
   * ```
   */
  protected async reportProgress(progress: ProgressType): Promise<void> {
    await this.notifyAgent({
      workflowName: this._workflowName,
      workflowId: this._workflowId,
      type: "progress",
      progress: progress as DefaultProgress,
      timestamp: Date.now()
    });
  }

  /**
   * Report successful completion to the Agent.
   * Triggers onWorkflowComplete() on the Agent.
   *
   * @param result - Optional result data
   */
  protected async reportComplete<T = unknown>(result?: T): Promise<void> {
    await this.notifyAgent({
      workflowName: this._workflowName,
      workflowId: this._workflowId,
      type: "complete",
      result,
      timestamp: Date.now()
    });
  }

  /**
   * Report an error to the Agent.
   * Triggers onWorkflowError() on the Agent.
   *
   * @param error - Error or error message
   */
  protected async reportError(error: Error | string): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : error;
    await this.notifyAgent({
      workflowName: this._workflowName,
      workflowId: this._workflowId,
      type: "error",
      error: errorMessage,
      timestamp: Date.now()
    });
  }

  /**
   * Send a custom event to the Agent.
   * Triggers onWorkflowEvent() on the Agent.
   *
   * @param event - Custom event payload
   */
  protected async sendEvent<T = unknown>(event: T): Promise<void> {
    await this.notifyAgent({
      workflowName: this._workflowName,
      workflowId: this._workflowId,
      type: "event",
      event,
      timestamp: Date.now()
    });
  }

  /**
   * Broadcast a message to all connected WebSocket clients via the Agent.
   *
   * @param message - Message to broadcast (will be JSON-stringified)
   */
  protected broadcastToClients(message: unknown): void {
    this.agent._workflow_broadcast(message);
  }

  /**
   * Wait for approval from the Agent.
   * Automatically reports progress while waiting and handles rejection.
   *
   * @param step - Workflow step object
   * @param options - Wait options (timeout, eventType, stepName)
   * @returns Approval payload (throws WorkflowRejectedError if rejected)
   *
   * @example
   * ```typescript
   * const approval = await this.waitForApproval(step, { timeout: '7 days' });
   * // approval contains the payload from approveWorkflow()
   * ```
   */
  protected async waitForApproval<T = unknown>(
    step: WorkflowStep,
    options?: WaitForApprovalOptions
  ): Promise<T> {
    const stepName = options?.stepName ?? "wait-for-approval";
    const eventType = options?.eventType ?? "approval";
    const timeout = options?.timeout;

    // Report that we're waiting
    await this.reportProgress({
      status: "pending",
      message: "Waiting for approval"
    } as ProgressType);

    // Wait for the approval event
    const event = await step.waitForEvent(stepName, {
      type: eventType,
      timeout: timeout as WorkflowSleepDuration | undefined
    });

    // Cast the payload to our expected type
    const payload = event.payload as {
      approved: boolean;
      reason?: string;
      metadata?: T;
    };

    // Check if rejected
    if (!payload.approved) {
      const reason = payload.reason;
      await this.reportError(reason ?? "Workflow rejected");
      throw new WorkflowRejectedError(reason, this._workflowId);
    }

    // Return the approval metadata as the result
    return payload.metadata as T;
  }

  /**
   * Update the Agent's state entirely.
   * This will replace the Agent's state and broadcast to all connected clients.
   *
   * @param state - New state to set
   *
   * @example
   * ```typescript
   * this.updateAgentState({ workflowStatus: 'processing', progress: 0.5 });
   * ```
   */
  protected updateAgentState(state: unknown): void {
    this.agent._workflow_updateState("set", state);
  }

  /**
   * Merge partial state into the Agent's existing state.
   * Performs a shallow merge and broadcasts to all connected clients.
   *
   * @param partialState - Partial state to merge
   *
   * @example
   * ```typescript
   * this.mergeAgentState({
   *   currentWorkflow: { id: this.workflowId, status: 'running' }
   * });
   * ```
   */
  protected mergeAgentState(partialState: Record<string, unknown>): void {
    this.agent._workflow_updateState("merge", partialState);
  }

  /**
   * Get the user params (without internal agent params).
   *
   * @param event - Workflow event
   * @returns User params only
   */
  protected getUserParams(
    event: WorkflowEvent<AgentWorkflowParams<Params>>
  ): Params {
    const { __agentName, __agentBinding, __workflowName, ...userParams } =
      event.payload;
    return userParams as unknown as Params;
  }
}

// Re-export types for convenience
export type {
  AgentWorkflowParams,
  AgentWorkflowInternalParams,
  WorkflowCallback,
  WorkflowCallbackType,
  WorkflowProgressCallback,
  WorkflowCompleteCallback,
  WorkflowErrorCallback,
  WorkflowEventCallback,
  DefaultProgress,
  WaitForApprovalOptions,
  ApprovalEventPayload
} from "./workflow-types";

export { WorkflowRejectedError } from "./workflow-types";
