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
 *     // Report progress to Agent
 *     await this.reportProgress(0.5, 'Halfway done');
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
import type { AgentWorkflowParams, WorkflowCallback } from "./workflow-types";

/**
 * Base class for Workflows that need access to their originating Agent.
 *
 * @template AgentType - The Agent class type (for typed RPC access)
 * @template Params - User-defined params passed to the workflow (optional)
 * @template Env - Environment type (defaults to Cloudflare.Env)
 */
export class AgentWorkflow<
  AgentType extends Agent = Agent,
  Params = unknown,
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
    const { __agentName, __agentBinding } = event.payload;

    if (!__agentName || !__agentBinding) {
      throw new Error(
        "AgentWorkflow requires __agentName and __agentBinding in params. " +
          "Use agent.runWorkflow() to start workflows with proper agent context."
      );
    }

    this._workflowId = event.instanceId;

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
   * Send a notification to the Agent.
   * Calls the Agent's /_workflow/callback endpoint.
   *
   * @param callback - Callback payload to send
   */
  protected async notifyAgent(callback: WorkflowCallback): Promise<void> {
    const response = await this.fetchAgent("/_workflow/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(callback)
    });

    if (!response.ok) {
      console.error(
        `Failed to notify agent: ${response.status} ${response.statusText}`
      );
    }
  }

  /**
   * Report progress to the Agent.
   * Triggers onWorkflowProgress() on the Agent.
   *
   * @param progress - Progress value (0-1)
   * @param message - Optional progress message
   */
  protected async reportProgress(
    progress: number,
    message?: string
  ): Promise<void> {
    await this.notifyAgent({
      workflowId: this._workflowId,
      type: "progress",
      progress,
      message,
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
      workflowId: this._workflowId,
      type: "event",
      event,
      timestamp: Date.now()
    });
  }

  /**
   * Broadcast a message to all connected WebSocket clients via the Agent.
   * Calls the Agent's broadcast() method.
   *
   * @param message - Message to broadcast (will be JSON-stringified)
   */
  protected async broadcastToClients(message: unknown): Promise<void> {
    const response = await this.fetchAgent("/_workflow/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      console.error(
        `Failed to broadcast to clients: ${response.status} ${response.statusText}`
      );
    }
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
    const { __agentName, __agentBinding, ...userParams } = event.payload;
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
  WorkflowEventCallback
} from "./workflow-types";
