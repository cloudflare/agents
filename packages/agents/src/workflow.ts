/**
 * Workflow Integration for Agents SDK
 *
 * This module provides:
 * 1. DurableTaskWorkflow - The built-in workflow for @task({ durable: true })
 * 2. AgentWorkflow - Base class for custom workflows that integrate with agents
 * 3. Utilities for workflow-agent communication
 *
 * @example
 * ```typescript
 * // Using @task({ durable: true }) - the recommended approach
 * class MyAgent extends Agent<Env> {
 *   @task({ durable: true })
 *   async processOrder(input: OrderInput, ctx: TaskContext) {
 *     const order = await ctx.step("validate", () => validate(input));
 *     await ctx.sleep("rate-limit", "1m");
 *     return await ctx.step("process", () => process(order));
 *   }
 * }
 *
 * // Or using a custom workflow for advanced use cases
 * export class CustomWorkflow extends AgentWorkflow<Env, Params> {
 *   async run(ctx) {
 *     // Custom workflow logic
 *   }
 * }
 * ```
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";

// ============================================================================
// Types
// ============================================================================

/**
 * Internal payload for durable task workflow
 */
export interface DurableTaskWorkflowPayload {
  _taskId: string;
  _agentBinding: string;
  _agentName: string;
  _methodName: string;
  _input: unknown;
  _timeout?: string | number;
  _retry?: {
    limit?: number;
    delay?: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
}

/**
 * Internal payload added by Agent when dispatching workflow (legacy)
 */
export interface WorkflowTaskPayload {
  _taskId: string;
  _agentBinding: string;
  _agentName: string;
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

/**
 * Context provided to custom workflow run() method
 */
export interface WorkflowTaskContext<TParams = unknown> {
  /** Workflow params (excluding internal fields) */
  params: TParams;
  /** Task ID for tracking */
  taskId: string;
  /** Execute a durable step */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Sleep for a duration (durable) */
  sleep(name: string, duration: string): Promise<void>;
  /** Emit a progress event */
  emit(type: string, data?: unknown): void;
  /** Set progress percentage */
  setProgress(progress: number): void;
}

// ============================================================================
// DurableTaskWorkflow - Built-in workflow for @task({ durable: true })
// ============================================================================

/**
 * The built-in workflow that executes @task({ durable: true }) methods.
 *
 * This workflow is automatically used when you decorate a method with
 * @task({ durable: true }). It calls back into the agent to execute
 * the actual task method with durable step/sleep/waitForEvent support.
 *
 * To use durable tasks, add this to your wrangler.jsonc:
 * ```jsonc
 * {
 *   "workflows": [{
 *     "name": "durable-tasks",
 *     "binding": "DURABLE_TASKS_WORKFLOW",
 *     "class_name": "DurableTaskWorkflow"
 *   }]
 * }
 * ```
 *
 * And export it from your worker:
 * ```typescript
 * export { DurableTaskWorkflow } from "agents/workflow";
 * ```
 */
export class DurableTaskWorkflow extends WorkflowEntrypoint<
  Record<string, unknown>,
  DurableTaskWorkflowPayload
> {
  async run(
    event: WorkflowEvent<DurableTaskWorkflowPayload>,
    step: WorkflowStep
  ): Promise<unknown> {
    const { _taskId, _agentBinding, _agentName, _methodName, _input, _retry } =
      event.payload;

    /**
     * Notify agent of task updates with proper error handling.
     * @param update - The update to send
     * @param critical - If true, log error on failure (for completion/failure states)
     */
    const notifyAgent = async (
      update: Partial<WorkflowUpdate>,
      critical = false
    ): Promise<boolean> => {
      const success = await this.sendUpdateToAgent(_agentBinding, _agentName, {
        taskId: _taskId,
        ...update
      });
      if (!success && critical) {
        console.error(
          `[DurableTaskWorkflow] Critical notification failed for task ${_taskId}:`,
          update.status || update.event?.type
        );
      }
      return success;
    };

    // Notify that we're starting (non-critical - workflow will proceed regardless)
    await step.do("_start", async () => {
      await notifyAgent({
        event: { type: "workflow-executing", data: { methodName: _methodName } }
      });
    });

    try {
      // Build retry config if provided
      // Note: Cloudflare Workflows expects delay as a WorkflowSleepDuration.
      // We normalize user input and cast to the expected type.
      const normalizeDelay = (
        delay: string | number | undefined
      ): import("cloudflare:workers").WorkflowSleepDuration => {
        if (!delay) return "10 seconds";
        if (typeof delay === "number") return `${delay} seconds`;
        // User-provided strings like "10s", "1m" need to be in CF format
        // CF expects "10 seconds", "1 minute", etc.
        return delay as import("cloudflare:workers").WorkflowSleepDuration;
      };

      const retryConfig = _retry
        ? {
            limit: _retry.limit ?? 3,
            delay: normalizeDelay(_retry.delay),
            backoff: _retry.backoff ?? ("exponential" as const)
          }
        : undefined;

      // Execute the task method on the agent
      const result = await step.do(
        `execute-${_methodName}`,
        retryConfig ? { retries: retryConfig } : {},
        async () => {
          return (await this.executeTaskOnAgent(
            _agentBinding,
            _agentName,
            _taskId,
            _methodName,
            _input
            // biome-ignore lint/suspicious/noExplicitAny: Workflow type coercion
          )) as any;
        }
      );

      // Notify completion (critical - agent needs to know task completed)
      await step.do("_complete", async () => {
        await notifyAgent(
          {
            status: "completed",
            progress: 100,
            result
          },
          true
        );
      });

      return result;
    } catch (error) {
      // Notify failure (critical - agent needs to know task failed)
      await step.do("_fail", async () => {
        await notifyAgent(
          {
            status: "failed",
            error: error instanceof Error ? error.message : String(error)
          },
          true
        );
      });
      throw error;
    }
  }

  /**
   * Execute the task method on the agent via RPC
   */
  private async executeTaskOnAgent(
    agentBinding: string,
    agentName: string,
    taskId: string,
    methodName: string,
    input: unknown
  ): Promise<unknown> {
    const agentNS = this.env[agentBinding] as DurableObjectNamespace;
    if (!agentNS) {
      throw new Error(`Agent binding ${agentBinding} not found`);
    }

    const agentId = agentNS.idFromName(agentName);
    const agent = agentNS.get(agentId);

    // Call the agent's internal task execution endpoint
    const response = await agent.fetch(
      new Request("http://internal/_execute-durable-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          methodName,
          input
        })
      })
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Task execution failed: ${errorText}`);
    }

    return response.json();
  }

  /**
   * Send update to Agent
   * @returns true if notification succeeded, false otherwise
   */
  private async sendUpdateToAgent(
    binding: string,
    agentName: string,
    update: WorkflowUpdate,
    maxRetries = 3
  ): Promise<boolean> {
    const agentNS = this.env[binding] as DurableObjectNamespace;
    if (!agentNS) {
      console.error(`[DurableTaskWorkflow] Binding ${binding} not found`);
      return false;
    }

    const agentId = agentNS.idFromName(agentName);
    const agent = agentNS.get(agentId);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await agent.fetch(
          new Request("http://internal/_workflow-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update)
          })
        );

        if (response.ok) return true;

        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          console.error(
            `[DurableTaskWorkflow] Non-retryable error: ${response.status}`
          );
          return false;
        }
      } catch (error) {
        if (attempt === maxRetries - 1) {
          console.error("[DurableTaskWorkflow] Failed to notify agent:", error);
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise((r) =>
          setTimeout(r, Math.min(100 * 2 ** attempt, 2000))
        );
      }
    }
    return false;
  }
}

// ============================================================================
// AgentWorkflow - Base class for custom workflows
// ============================================================================

/**
 * Base class for custom Workflows that integrate with the Agent task system.
 *
 * Use this when you need more control than @task({ durable: true }) provides.
 * Extend this class to get:
 * - Automatic task state sync to Agent
 * - Familiar ctx.emit() and ctx.setProgress() API
 * - Error handling that updates task state
 *
 * @example
 * ```typescript
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
 * ```
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
   */
  async execute(
    event: WorkflowEvent<TParams & WorkflowTaskPayload>,
    step: WorkflowStep
  ): Promise<unknown> {
    const { _taskId, _agentBinding, _agentName, ...params } = event.payload;

    let pendingUpdate: WorkflowUpdate | null = null;

    const flushUpdates = async (): Promise<void> => {
      if (!pendingUpdate) return;
      const update = pendingUpdate;
      pendingUpdate = null;
      await this.notifyAgent(_agentBinding, _agentName, update);
    };

    const ctx: WorkflowTaskContext<TParams> = {
      params: params as unknown as TParams,
      taskId: _taskId,

      step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        await flushUpdates();
        // biome-ignore lint/suspicious/noExplicitAny: Workflow type coercion
        return step.do(name, fn as any) as unknown as Promise<T>;
      },

      sleep: async (name: string, duration: string): Promise<void> => {
        await flushUpdates();
        return step.sleep(name, duration as Parameters<typeof step.sleep>[1]);
      },

      emit: (type: string, data?: unknown): void => {
        pendingUpdate = {
          taskId: _taskId,
          ...pendingUpdate,
          event: { type, data }
        };
      },

      setProgress: (progress: number): void => {
        pendingUpdate = {
          taskId: _taskId,
          ...pendingUpdate,
          progress
        };
      }
    };

    try {
      const result = await this.run(ctx);

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
   * Send update to Agent
   * @returns true if notification succeeded, false otherwise
   */
  private async notifyAgent(
    binding: string,
    agentName: string,
    update: WorkflowUpdate,
    maxRetries = 3
  ): Promise<boolean> {
    const agentNS = this.env[binding] as DurableObjectNamespace;
    if (!agentNS) {
      console.error(`[AgentWorkflow] Binding ${binding} not found`);
      return false;
    }

    const agentId = agentNS.idFromName(agentName);
    const agent = agentNS.get(agentId);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await agent.fetch(
          new Request("http://internal/_workflow-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update)
          })
        );

        if (response.ok) return true;

        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          console.error(
            `[AgentWorkflow] Non-retryable error: ${response.status}`
          );
          return false;
        }
      } catch (error) {
        if (attempt === maxRetries - 1) {
          console.error("[AgentWorkflow] Failed to notify agent:", error);
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise((r) =>
          setTimeout(r, Math.min(100 * 2 ** attempt, 2000))
        );
      }
    }
    return false;
  }
}

// ============================================================================
// Workflow Adapter (for testing/mocking and custom implementations)
// ============================================================================

/**
 * Workflow adapter interface for flexible workflow implementations.
 *
 * This interface allows you to:
 * - Mock workflow behavior in tests
 * - Implement custom workflow backends
 * - Add instrumentation/logging around workflow operations
 *
 * @example
 * ```typescript
 * // Mock adapter for testing
 * class MockWorkflowAdapter implements WorkflowAdapter {
 *   async dispatch() { return { instanceId: "mock-123" }; }
 *   async getStatus() { return { status: "complete", output: { result: "test" } }; }
 *   async terminate() { return { success: true }; }
 * }
 * ```
 */
export interface WorkflowAdapter {
  dispatch(
    binding: string,
    input: unknown,
    taskId: string,
    agentBinding: string,
    agentName: string
  ): Promise<{ instanceId: string }>;

  getStatus(
    binding: string,
    instanceId: string
  ): Promise<{ status: string; output?: unknown; error?: string }>;

  terminate(
    binding: string,
    instanceId: string
  ): Promise<{ success: boolean; reason?: string }>;
}

/**
 * Default Cloudflare Workflows adapter.
 *
 * Provides the standard implementation for interacting with Cloudflare Workflows.
 * Used internally by the task system, but can also be used directly for
 * custom workflow management.
 *
 * @example
 * ```typescript
 * const adapter = new CloudflareWorkflowAdapter(env);
 * const { instanceId } = await adapter.dispatch(
 *   "MY_WORKFLOW",
 *   { data: "input" },
 *   "task-123",
 *   "MY_AGENT",
 *   "agent-name"
 * );
 * const status = await adapter.getStatus("MY_WORKFLOW", instanceId);
 * ```
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
