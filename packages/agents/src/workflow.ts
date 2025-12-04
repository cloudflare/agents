/**
 * Workflow Integration for Agents SDK
 *
 * Provides a base class for Cloudflare Workflows that integrates with the
 * Agent task system. Workflows get a familiar ctx.emit()/ctx.setProgress() API
 * that syncs updates back to the Agent for real-time client notifications.
 *
 * @example
 * ```typescript
 * // Define a workflow
 * export class AnalysisWorkflow extends AgentWorkflow<Env, { repoUrl: string }> {
 *   async run(ctx) {
 *     const files = await ctx.step("fetch", async () => {
 *       ctx.emit("phase", { name: "fetching" });
 *       return await fetchFiles(ctx.params.repoUrl);
 *     });
 *
 *     await ctx.sleep("rate-limit", "1h");
 *
 *     return await ctx.step("analyze", async () => {
 *       ctx.setProgress(50);
 *       return await analyze(files);
 *     });
 *   }
 * }
 *
 * // Dispatch from Agent
 * class MyAgent extends Agent<Env> {
 *   @callable()
 *   async startAnalysis(input: { repoUrl: string }) {
 *     return this.workflow("ANALYSIS_WORKFLOW", input);
 *   }
 * }
 * ```
 */

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// ============================================================================
// Types
// ============================================================================

/**
 * Internal payload added by Agent when dispatching workflow
 */
export interface WorkflowTaskPayload {
  _taskId: string;
  _agentBinding: string;
  _agentName: string;
}

/**
 * Context provided to workflow run() method
 * Combines Workflow step API with Task-like helpers
 */
export interface WorkflowTaskContext<TParams = unknown> {
  /** Workflow params (excluding internal fields) */
  params: TParams;

  /** Task ID for tracking */
  taskId: string;

  /**
   * Execute a durable step
   * Automatically retried on failure, state persisted
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Sleep for a duration (durable - survives restarts)
   * @param name Step name for observability
   * @param duration Duration string like "1h", "30m", "7d"
   */
  sleep(name: string, duration: string): Promise<void>;

  /**
   * Emit a progress event (syncs to Agent → clients)
   */
  emit(type: string, data?: unknown): void;

  /**
   * Set progress percentage (syncs to Agent → clients)
   */
  setProgress(progress: number): void;
}

/**
 * Update sent from Workflow to Agent
 */
export interface WorkflowUpdate {
  taskId: string;
  event?: { type: string; data?: unknown };
  progress?: number;
  status?: "completed" | "failed";
  result?: unknown;
  error?: string;
}

// ============================================================================
// AgentWorkflow Base Class
// ============================================================================

/**
 * Base class for Workflows that integrate with the Agent task system.
 *
 * Extend this instead of WorkflowEntrypoint to get:
 * - Automatic task state sync to Agent
 * - Familiar ctx.emit() and ctx.setProgress() API
 * - Error handling that updates task state
 *
 * @template Env - Environment bindings type
 * @template TParams - Workflow input parameters type
 */
export abstract class AgentWorkflow<
  Env extends Record<string, unknown>,
  TParams extends Record<string, unknown> = Record<string, unknown>
> {
  protected env: Env;
  protected ctx: ExecutionContext;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  /**
   * Implement this method with your workflow logic
   */
  abstract run(ctx: WorkflowTaskContext<TParams>): Promise<unknown>;

  /**
   * Entry point called by Workflows runtime
   * Wraps run() with Agent sync
   */
  async execute(
    event: WorkflowEvent<TParams & WorkflowTaskPayload>,
    step: WorkflowStep
  ): Promise<unknown> {
    const { _taskId, _agentBinding, _agentName, ...params } = event.payload;

    // Batch updates - only flushed at step boundaries (no extra durable steps)
    let pendingUpdate: WorkflowUpdate | null = null;

    // Flush pending update by merging into next step (no separate durable step)
    const flushUpdates = async () => {
      if (!pendingUpdate) return;
      const update = pendingUpdate;
      pendingUpdate = null;
      await this.notifyAgent(_agentBinding, _agentName, update);
    };

    // Create context with Task-like API
    const ctx: WorkflowTaskContext<TParams> = {
      params: params as unknown as TParams,
      taskId: _taskId,

      step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        // Flush pending update, then execute step
        await flushUpdates();
        // step.do returns Serializable<T>, cast back to T for convenience
        // biome-ignore lint/suspicious/noExplicitAny: Workflow type coercion
        return step.do(name, fn as any) as unknown as Promise<T>;
      },

      sleep: async (name: string, duration: string): Promise<void> => {
        await flushUpdates();
        // Cast duration string to the required WorkflowSleepDuration type
        return step.sleep(name, duration as Parameters<typeof step.sleep>[1]);
      },

      // Queue event - will be sent at next step boundary
      emit: (type: string, data?: unknown) => {
        pendingUpdate = {
          taskId: _taskId,
          ...pendingUpdate,
          event: { type, data }
        };
      },

      // Queue progress - will be sent at next step boundary
      setProgress: (progress: number) => {
        pendingUpdate = {
          taskId: _taskId,
          ...pendingUpdate,
          progress
        };
      }
    };

    try {
      // Run the workflow
      const result = await this.run(ctx);

      // Notify Agent of completion (always a separate step for durability)
      await step.do("_complete", async () => {
        await this.notifyAgent(_agentBinding, _agentName, {
          taskId: _taskId,
          status: "completed",
          progress: 100,
          result
        });
      });

      return result;
    } catch (error) {
      // Notify Agent of failure (always a separate step for durability)
      await step.do("_fail", async () => {
        await this.notifyAgent(_agentBinding, _agentName, {
          taskId: _taskId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      });
      throw error;
    }
  }

  /**
   * Send update to Agent via fetch with retry logic
   * @param binding - Agent binding name
   * @param agentName - Agent instance name
   * @param update - Update payload to send
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   */
  private async notifyAgent(
    binding: string,
    agentName: string,
    update: WorkflowUpdate,
    maxRetries = 3
  ): Promise<void> {
    // Get the Agent's Durable Object
    const agentNS = this.env[binding] as DurableObjectNamespace;
    if (!agentNS) {
      console.error(`[AgentWorkflow] Binding ${binding} not found`);
      return;
    }

    const agentId = agentNS.idFromName(agentName);
    const agent = agentNS.get(agentId);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await agent.fetch(
          new Request("http://internal/_workflow-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update)
          })
        );

        // Check for successful response
        if (response.ok) {
          return; // Success!
        }

        // Non-retryable client errors (4xx except 429)
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          console.error(
            `[AgentWorkflow] Non-retryable error notifying agent: ${response.status}`
          );
          return;
        }

        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If not the last attempt, wait before retrying with exponential backoff
      if (attempt < maxRetries - 1) {
        const backoffMs = Math.min(100 * 2 ** attempt, 2000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        console.warn(
          `[AgentWorkflow] Retry ${attempt + 1}/${maxRetries} notifying agent...`
        );
      }
    }

    // All retries exhausted
    console.error(
      `[AgentWorkflow] Failed to notify agent after ${maxRetries} attempts:`,
      lastError
    );
  }
}

// ============================================================================
// Workflow Adapter Pattern
// ============================================================================

/**
 * Workflow adapter interface for flexible workflow implementations.
 *
 * This pattern allows you to:
 * - Swap between different workflow backends (Cloudflare Workflows, custom, etc.)
 * - Add middleware/interceptors for workflow operations
 * - Mock workflows in tests
 *
 * @example
 * ```typescript
 * // Custom adapter for testing
 * class MockWorkflowAdapter implements WorkflowAdapter {
 *   private tasks = new Map<string, any>();
 *
 *   async dispatch(binding: string, input: unknown, taskId: string) {
 *     this.tasks.set(taskId, { status: "running", input });
 *     return { instanceId: `mock_${taskId}` };
 *   }
 *
 *   async getStatus(binding: string, instanceId: string) {
 *     return { status: "running" };
 *   }
 *
 *   async terminate(binding: string, instanceId: string) {
 *     return { success: true };
 *   }
 * }
 * ```
 */
export interface WorkflowAdapter {
  /**
   * Dispatch a workflow with the given parameters
   * @returns Object containing the workflow instance ID
   */
  dispatch(
    binding: string,
    input: unknown,
    taskId: string,
    agentBinding: string,
    agentName: string
  ): Promise<{ instanceId: string }>;

  /**
   * Get the status of a workflow instance
   */
  getStatus(
    binding: string,
    instanceId: string
  ): Promise<{ status: string; output?: unknown; error?: string }>;

  /**
   * Terminate a running workflow instance
   */
  terminate(
    binding: string,
    instanceId: string
  ): Promise<{ success: boolean; reason?: string }>;
}

/**
 * Default Cloudflare Workflows adapter implementation
 */
export class CloudflareWorkflowAdapter implements WorkflowAdapter {
  constructor(private env: Record<string, unknown>) {}

  async dispatch(
    binding: string,
    input: unknown,
    taskId: string,
    agentBinding: string,
    agentName: string
  ): Promise<{ instanceId: string }> {
    const workflowNS = this.env[binding] as {
      create: (opts: { params: unknown }) => Promise<{ id: string }>;
    } | null;

    if (!workflowNS?.create) {
      throw new Error(`Workflow binding ${binding} not found`);
    }

    // Ensure input is an object for spreading
    const inputObj =
      typeof input === "object" && input !== null ? input : { data: input };

    const instance = await workflowNS.create({
      params: {
        ...(inputObj as Record<string, unknown>),
        _taskId: taskId,
        _agentBinding: agentBinding,
        _agentName: agentName
      }
    });

    return { instanceId: instance.id };
  }

  async getStatus(
    binding: string,
    instanceId: string
  ): Promise<{ status: string; output?: unknown; error?: string }> {
    const workflowNS = this.env[binding] as {
      get: (id: string) => Promise<{
        status: () => Promise<{
          status: string;
          output?: unknown;
          error?: string;
        }>;
      }>;
    } | null;

    if (!workflowNS?.get) {
      throw new Error(`Workflow binding ${binding} not found`);
    }

    const instance = await workflowNS.get(instanceId);
    return await instance.status();
  }

  async terminate(
    binding: string,
    instanceId: string
  ): Promise<{ success: boolean; reason?: string }> {
    const workflowNS = this.env[binding] as {
      get: (id: string) => Promise<{
        terminate: () => Promise<void>;
        status: () => Promise<{ status: string }>;
      }>;
    } | null;

    if (!workflowNS?.get) {
      return { success: false, reason: "binding_not_found" };
    }

    try {
      const instance = await workflowNS.get(instanceId);

      // Check status first
      try {
        const { status } = await instance.status();
        if (["complete", "errored", "terminated"].includes(status)) {
          return { success: false, reason: `already_${status}` };
        }
      } catch {
        // Status check failed, try to terminate anyway
      }

      await instance.terminate();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, reason: message };
    }
  }
}

// ============================================================================
// Helper to create workflow class
// ============================================================================

/**
 * Helper type for workflow run function
 */
export type WorkflowRunFn<TParams> = (
  ctx: WorkflowTaskContext<TParams>
) => Promise<unknown>;
