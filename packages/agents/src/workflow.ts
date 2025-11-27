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

import type {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep
} from "cloudflare:workers";

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

    // Track pending updates to batch them
    const pendingUpdates: WorkflowUpdate[] = [];
    let lastFlush = Date.now();

    const flushUpdates = async () => {
      if (pendingUpdates.length === 0) return;
      const updates = [...pendingUpdates];
      pendingUpdates.length = 0;

      for (const update of updates) {
        await this.notifyAgent(_agentBinding, _agentName, update);
      }
      lastFlush = Date.now();
    };

    // Create context with Task-like API
    const ctx: WorkflowTaskContext<TParams> = {
      params: params as TParams,
      taskId: _taskId,

      step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        // Flush any pending updates before step
        await flushUpdates();
        return step.do(name, fn);
      },

      sleep: async (name: string, duration: string): Promise<void> => {
        await flushUpdates();
        return step.sleep(name, duration);
      },

      emit: (type: string, data?: unknown) => {
        pendingUpdates.push({
          taskId: _taskId,
          event: { type, data }
        });
        // Auto-flush if it's been a while
        if (Date.now() - lastFlush > 100) {
          step.do(`_emit_${type}_${Date.now()}`, () => flushUpdates());
        }
      },

      setProgress: (progress: number) => {
        pendingUpdates.push({
          taskId: _taskId,
          progress
        });
        if (Date.now() - lastFlush > 100) {
          step.do(`_progress_${progress}`, () => flushUpdates());
        }
      }
    };

    try {
      // Run the workflow
      const result = await this.run(ctx);

      // Notify Agent of completion
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
      // Notify Agent of failure
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
   * Send update to Agent via fetch
   */
  private async notifyAgent(
    binding: string,
    agentName: string,
    update: WorkflowUpdate
  ): Promise<void> {
    try {
      // Get the Agent's Durable Object
      const agentNS = this.env[binding] as DurableObjectNamespace;
      if (!agentNS) {
        console.error(`[AgentWorkflow] Binding ${binding} not found`);
        return;
      }

      const agentId = agentNS.idFromName(agentName);
      const agent = agentNS.get(agentId);

      // Send update
      await agent.fetch(
        new Request("http://internal/_workflow-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update)
        })
      );
    } catch (error) {
      console.error("[AgentWorkflow] Failed to notify agent:", error);
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
