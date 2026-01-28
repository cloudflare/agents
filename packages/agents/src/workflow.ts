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
 *   async run(event: AgentWorkflowEvent<TaskParams>, step: WorkflowStep) {
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
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getAgentByName, type Agent } from "./index";
import type {
  AgentWorkflowParams,
  AgentWorkflowStep,
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

    // Store original run method - cast to accept clean event type and wrapped step
    // (user's implementation expects WorkflowEvent<Params> and AgentWorkflowStep)
    const originalRun = this.run.bind(this) as (
      event: WorkflowEvent<Params>,
      step: AgentWorkflowStep
    ) => Promise<unknown>;

    // Override run to initialize agent before user code executes
    this.run = async (
      event: WorkflowEvent<AgentWorkflowParams<Params>>,
      step: WorkflowStep
    ) => {
      // Extract internal params
      const { __agentName, __agentBinding, __workflowName, ...userParams } =
        event.payload;

      // Initialize agent connection
      await this._initAgent(
        __agentName,
        __agentBinding,
        __workflowName,
        event.instanceId
      );

      // Pass cleaned event and wrapped step to user's implementation
      const cleanedEvent = {
        ...event,
        payload: userParams as Params
      } as WorkflowEvent<Params>;

      const wrappedStep = this._wrapStep(step);

      return originalRun(cleanedEvent, wrappedStep);
    };
  }

  /**
   * Initialize the Agent stub from workflow params.
   * Called automatically before run() executes.
   */
  private async _initAgent(
    agentName: string | undefined,
    agentBinding: string | undefined,
    workflowName: string | undefined,
    instanceId: string
  ): Promise<void> {
    if (!agentName || !agentBinding || !workflowName) {
      throw new Error(
        "AgentWorkflow requires __agentName, __agentBinding, and __workflowName in params. " +
          "Use agent.runWorkflow() to start workflows with proper agent context."
      );
    }

    this._workflowId = instanceId;
    this._workflowName = workflowName;

    // Get the Agent namespace from env
    const namespace = (this.env as Record<string, unknown>)[
      agentBinding
    ] as DurableObjectNamespace<AgentType>;

    if (!namespace) {
      throw new Error(
        `Agent binding '${agentBinding}' not found in environment`
      );
    }

    // Get the Agent stub by name
    this._agent = await getAgentByName<Cloudflare.Env, AgentType>(
      namespace,
      agentName
    );
  }

  /**
   * Wrap WorkflowStep with durable Agent communication methods.
   * Methods added to the wrapped step are idempotent and won't repeat on retry.
   *
   * Note: We add methods directly to the step object to preserve instanceof checks
   * that Cloudflare's runtime may perform on the WorkflowStep class.
   */
  private _wrapStep(step: WorkflowStep): AgentWorkflowStep {
    let stepCounter = 0;

    // Cast step to our extended type and add methods directly
    // This preserves the original object identity and instanceof relationship
    const wrappedStep = step as AgentWorkflowStep;

    // Add durable Agent methods directly to the step object
    wrappedStep.reportComplete = async <T>(result?: T): Promise<void> => {
      await step.do(`__agent_reportComplete_${stepCounter++}`, async () => {
        await this.notifyAgent({
          workflowName: this._workflowName,
          workflowId: this._workflowId,
          type: "complete",
          result,
          timestamp: Date.now()
        });
      });
    };

    wrappedStep.reportError = async (error: Error | string): Promise<void> => {
      const errorMessage = error instanceof Error ? error.message : error;
      await step.do(`__agent_reportError_${stepCounter++}`, async () => {
        await this.notifyAgent({
          workflowName: this._workflowName,
          workflowId: this._workflowId,
          type: "error",
          error: errorMessage,
          timestamp: Date.now()
        });
      });
    };

    wrappedStep.sendEvent = async <T>(event: T): Promise<void> => {
      await step.do(`__agent_sendEvent_${stepCounter++}`, async () => {
        await this.notifyAgent({
          workflowName: this._workflowName,
          workflowId: this._workflowId,
          type: "event",
          event,
          timestamp: Date.now()
        });
      });
    };

    wrappedStep.updateAgentState = async (state: unknown): Promise<void> => {
      await step.do(`__agent_updateState_${stepCounter++}`, async () => {
        this.agent._workflow_updateState("set", state);
      });
    };

    wrappedStep.mergeAgentState = async (
      partialState: Record<string, unknown>
    ): Promise<void> => {
      await step.do(`__agent_mergeState_${stepCounter++}`, async () => {
        this.agent._workflow_updateState("merge", partialState);
      });
    };

    wrappedStep.resetAgentState = async (): Promise<void> => {
      await step.do(`__agent_resetState_${stepCounter++}`, async () => {
        this.agent._workflow_updateState("reset");
      });
    };

    return wrappedStep;
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
   * Broadcast a message to all connected WebSocket clients via the Agent.
   * This is non-durable and may repeat on workflow retry.
   *
   * @param message - Message to broadcast (will be JSON-stringified)
   */
  protected broadcastToClients(message: unknown): void {
    this.agent._workflow_broadcast(message);
  }

  /**
   * Wait for approval from the Agent.
   * Handles rejection by reporting error (durably) and throwing WorkflowRejectedError.
   *
   * @param step - AgentWorkflowStep object
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
    step: AgentWorkflowStep,
    options?: WaitForApprovalOptions
  ): Promise<T> {
    const stepName = options?.stepName ?? "wait-for-approval";
    const eventType = options?.eventType ?? "approval";
    const timeout = options?.timeout;

    // Wait for the approval event
    // Note: Call reportProgress() before this method if you want to update progress
    const event = await step.waitForEvent(stepName, {
      type: eventType,
      timeout
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
      await step.reportError(reason ?? "Workflow rejected");
      throw new WorkflowRejectedError(reason, this._workflowId);
    }

    // Return the approval metadata as the result
    return payload.metadata as T;
  }
}

// Re-export types for convenience
export type {
  AgentWorkflowEvent,
  AgentWorkflowStep,
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
