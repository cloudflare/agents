/**
 * Task System for Agents SDK
 *
 * Tasks provide lifecycle tracking on top of the existing primitives:
 * - Queue handles execution (when/how to run)
 * - SQL handles persistence (queries, history)
 * - State handles real-time sync (automatic broadcast to clients)
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent<Env> {
 *   async createTask(input: string) {
 *     const task = await this.task("processData", { input });
 *     return { taskId: task.id };
 *   }
 *
 *   async processData(input: { input: string }, ctx: TaskContext) {
 *     ctx.emit("starting");
 *     // ... do work ...
 *     return { result: "done" };
 *   }
 * }
 * ```
 */

import { nanoid } from "nanoid";
import { callableMetadata } from "./callable";

// ============================================================================
// Types
// ============================================================================

/**
 * Task status values
 */
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

/**
 * A task event emitted during execution
 */
export interface TaskEvent {
  /** Unique event ID */
  id: string;
  /** Event type/name */
  type: string;
  /** Event payload */
  data?: unknown;
  /** When the event occurred */
  timestamp: number;
}

/**
 * A tracked task with lifecycle and result
 */
export interface Task<TResult = unknown> {
  /** Unique task identifier */
  id: string;
  /** Method name being executed */
  method: string;
  /** Input payload passed to the task */
  input: unknown;
  /** Current task status */
  status: TaskStatus;
  /** Task result (when completed) */
  result?: TResult;
  /** Error message (when failed) */
  error?: string;
  /** Events emitted during execution */
  events: TaskEvent[];
  /** When the task was created */
  createdAt: number;
  /** When execution started */
  startedAt?: number;
  /** When execution completed/failed/aborted */
  completedAt?: number;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Queue item ID (links to queue system) */
  queueId?: string;
  /** Workflow instance ID (for workflow tasks) */
  workflowInstanceId?: string;
  /** Workflow binding name (for workflow tasks) */
  workflowBinding?: string;
}

/**
 * Options for creating a task
 */
export interface TaskOptions {
  /** Timeout duration (e.g., "5m", "300s", or milliseconds) */
  timeout?: string | number;
  /** Number of retry attempts on failure */
  retries?: number;
  /** Custom task ID (defaults to auto-generated) */
  id?: string;
}

/**
 * Metadata stored for @task() decorated methods
 */
export interface TaskMethodMetadata {
  timeout?: string | number;
  retries?: number;
}

/** Storage for task method metadata */
export const taskMethodMetadata = new Map<Function, TaskMethodMetadata>();

/** Storage for original task method implementations by class+method name */
export const taskMethodOriginals = new Map<string, Function>();

/** Helper to create a unique key for a task method */
export function getTaskMethodKey(
  className: string,
  methodName: string
): string {
  return `${className}::${methodName}`;
}

/**
 * Decorator that marks a method as a task
 *
 * When called, the method will be executed as a tracked task with:
 * - Automatic progress/event broadcasting
 * - Persistence in SQLite
 * - Cancellation support
 * - Optional timeout and retries (non-durable, in-memory)
 *
 * Note: For durable retries that survive restarts, use `this.workflow()` with
 * Cloudflare Workflows which has built-in retry support via `step.do({ retries: {...} })`.
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent<Env> {
 *   @task({ timeout: "5m" })
 *   async analyzeRepo(input: { repoUrl: string }, ctx: TaskContext) {
 *     ctx.emit("phase", { name: "fetching" });
 *     ctx.setProgress(50);
 *     // ... do work ...
 *     return { result: "done" };
 *   }
 * }
 *
 * // Call it - returns TaskHandle immediately
 * const handle = await agent.analyzeRepo({ repoUrl: "..." });
 * console.log(handle.id, handle.status); // task_xxx, "pending"
 * ```
 */
export function task(options: TaskMethodMetadata = {}) {
  return function taskDecorator<
    This extends {
      task: (
        method: string,
        input: unknown,
        opts: TaskOptions
      ) => Promise<TaskHandle>;
      constructor: { name: string };
    },
    Args extends [unknown, TaskContext?],
    Return
  >(
    target: (this: This, ...args: Args) => Promise<Return>,
    context: ClassMethodDecoratorContext
  ) {
    const methodName = String(context.name);

    // Store metadata for the original method
    taskMethodMetadata.set(target, options);

    // Return a wrapper that calls this.task() instead of the method directly
    async function wrapper(
      this: This,
      input: Args[0]
    ): Promise<TaskHandle<Return>> {
      return this.task(methodName, input, {
        timeout: options.timeout,
        retries: options.retries
      }) as Promise<TaskHandle<Return>>;
    }

    // Store the original method once we know the class name
    context.addInitializer(function () {
      const instance = this as This;
      const className = instance.constructor.name;
      const key = getTaskMethodKey(className, methodName);
      if (!taskMethodOriginals.has(key)) {
        taskMethodOriginals.set(key, target);
      }
    });

    // Register as callable so RPC works
    callableMetadata.set(wrapper, {});

    return wrapper as unknown as typeof target;
  };
}

/**
 * Context provided to task methods during execution
 */
export interface TaskContext {
  /** Emit a progress event */
  emit(type: string, data?: unknown): void;
  /** Set progress percentage (0-100) */
  setProgress(progress: number): void;
  /** Abort signal - check this to handle cancellation */
  signal: AbortSignal;
  /** Task ID */
  taskId: string;
}

/**
 * Handle returned when a task is started
 */
export interface TaskHandle<TResult = unknown> {
  /** Task ID */
  id: string;
  /** Current status */
  status: TaskStatus;
  /** Result (if completed) */
  result?: TResult;
  /** Error (if failed) */
  error?: string;
  /** Progress percentage */
  progress?: number;
  /** When created */
  createdAt: number;
}

/**
 * Filter options for listing tasks
 */
export interface TaskFilter {
  /** Filter by status */
  status?: TaskStatus | TaskStatus[];
  /** Filter by method name */
  method?: string;
  /** Only tasks created after this timestamp */
  createdAfter?: number;
  /** Only tasks created before this timestamp */
  createdBefore?: number;
  /** Limit number of results */
  limit?: number;
}

/**
 * Internal payload passed to queue for task execution
 */
export interface TaskExecutionPayload {
  taskId: string;
  methodName: string;
  input: unknown;
  timeoutMs?: number;
  retries?: number;
}

/**
 * Callback to sync task to agent state (for real-time updates)
 */
export type StateSyncCallback = (taskId: string, task: Task | null) => void;

// ============================================================================
// Task Tracker
// ============================================================================

/**
 * SQL interface type (matches the Agent's sql template literal)
 */
type SqlExecutor = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/**
 * Internal task row from SQLite
 */
interface TaskRow {
  id: string;
  method: string;
  input: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  events: string;
  progress: number | null;
  timeout_ms: number | null;
  deadline_at: number | null;
  queue_id: string | null;
  workflow_instance_id: string | null;
  workflow_binding: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * Tracks task lifecycle and state.
 * - SQL for persistence and queries
 * - State sync callback for real-time updates to clients
 * - Execution handled by queue system
 * - Timeouts use deadline-based checking (no setTimeout accumulation)
 */
export class TaskTracker {
  private sql: SqlExecutor;
  private syncToState: StateSyncCallback;
  private abortControllers = new Map<string, AbortController>();

  constructor(sql: SqlExecutor, syncToState: StateSyncCallback) {
    this.sql = sql;
    this.syncToState = syncToState;

    // Create tasks table if not exists
    // deadline_at: when the task should timeout (calculated from timeout_ms + started_at)
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        method TEXT NOT NULL,
        input TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        error TEXT,
        events TEXT DEFAULT '[]',
        progress REAL,
        timeout_ms INTEGER,
        deadline_at INTEGER,
        queue_id TEXT,
        workflow_instance_id TEXT,
        workflow_binding TEXT,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        started_at INTEGER,
        completed_at INTEGER
      )
    `;

    // Create index on status for efficient queries
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON cf_agents_tasks(status)
    `;

    // Clean up stale tasks from previous runs (pending/running tasks that didn't complete)
    this.sql`
      UPDATE cf_agents_tasks 
      SET status = 'failed', error = 'Agent restarted', completed_at = ${Date.now()}
      WHERE status IN ('pending', 'running')
    `;
  }

  /**
   * Sync task state to callback.
   * Rate limiting is handled by the Agent's _syncTaskToState, so we always call immediately.
   * This ensures consistent ordering - no debouncing means no out-of-order updates.
   */
  private sync(taskId: string): void {
    const task = this.get(taskId);
    this.syncToState(taskId, task || null);
  }

  /**
   * Create a task record (called before queueing)
   */
  create<TInput>(
    method: string,
    input: TInput,
    options: TaskOptions = {}
  ): Task {
    const id = options.id || `task_${nanoid(12)}`;
    const now = Date.now();
    const timeoutMs = this.parseTimeout(options.timeout);

    const task: Task = {
      id,
      method,
      input,
      status: "pending",
      events: [],
      createdAt: now,
      timeoutMs
    };

    // Persist to SQL
    this.sql`
      INSERT INTO cf_agents_tasks (id, method, input, status, events, timeout_ms, created_at)
      VALUES (
        ${id},
        ${method},
        ${JSON.stringify(input)},
        'pending',
        '[]',
        ${timeoutMs ?? null},
        ${now}
      )
    `;

    // Sync to state for real-time updates
    this.sync(id);

    return task;
  }

  /**
   * Link task to its queue item
   */
  linkToQueue(taskId: string, queueId: string): void {
    this.sql`
      UPDATE cf_agents_tasks SET queue_id = ${queueId} WHERE id = ${taskId}
    `;
  }

  /**
   * Link task to a workflow instance for cancellation support
   */
  linkToWorkflow(taskId: string, instanceId: string, binding: string): void {
    this.sql`
      UPDATE cf_agents_tasks 
      SET workflow_instance_id = ${instanceId}, workflow_binding = ${binding}
      WHERE id = ${taskId}
    `;
  }

  /**
   * Get workflow info for a task (for cancellation)
   */
  getWorkflowInfo(
    taskId: string
  ): { instanceId: string; binding: string } | null {
    const rows = this.sql<{
      workflow_instance_id: string | null;
      workflow_binding: string | null;
    }>`
      SELECT workflow_instance_id, workflow_binding 
      FROM cf_agents_tasks WHERE id = ${taskId}
    `;
    if (!rows?.[0]?.workflow_instance_id || !rows?.[0]?.workflow_binding) {
      return null;
    }
    return {
      instanceId: rows[0].workflow_instance_id,
      binding: rows[0].workflow_binding
    };
  }

  /**
   * Mark task as running (called when queue executes it)
   * Sets deadline based on timeout_ms for deadline-based timeout checking
   */
  markRunning(taskId: string): AbortController {
    const now = Date.now();
    const task = this.get(taskId);
    const deadline = task?.timeoutMs ? now + task.timeoutMs : null;

    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'running', started_at = ${now}, deadline_at = ${deadline}
      WHERE id = ${taskId}
    `;

    // Create abort controller for this task
    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    // Sync to state - immediate for status change
    this.sync(taskId);

    return controller;
  }

  /**
   * Check if a task has exceeded its deadline
   * Called by Agent during execution to enforce timeouts
   */
  checkTimeout(taskId: string): boolean {
    const task = this.get(taskId);
    if (!task || task.status !== "running") return false;

    // Check deadline from database (persisted, survives restarts)
    const rows = this.sql<{ deadline_at: number | null }>`
      SELECT deadline_at FROM cf_agents_tasks WHERE id = ${taskId}
    `;
    const deadline = rows?.[0]?.deadline_at;

    if (deadline && Date.now() > deadline) {
      this.abort(taskId, "Task timed out");
      return true;
    }
    return false;
  }

  /**
   * Mark task as completed with result
   */
  complete(taskId: string, result: unknown): void {
    const now = Date.now();
    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'completed', result = ${JSON.stringify(result)}, completed_at = ${now}, progress = 100
      WHERE id = ${taskId}
    `;

    this.cleanupController(taskId);
    this.addEventInternal(taskId, "completed", { result });

    // Immediate sync for completion
    this.sync(taskId);
  }

  /**
   * Mark task as failed with error
   */
  fail(taskId: string, error: string): void {
    const now = Date.now();
    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'failed', error = ${error}, completed_at = ${now}
      WHERE id = ${taskId}
    `;

    this.cleanupController(taskId);
    this.addEventInternal(taskId, "failed", { error });

    // Immediate sync for failure
    this.sync(taskId);
  }

  /**
   * Abort a running task
   */
  abort(taskId: string, reason?: string): boolean {
    const task = this.get(taskId);
    if (!task) return false;

    if (task.status !== "pending" && task.status !== "running") {
      return false;
    }

    // Signal abort to the running task
    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort(reason);
    }

    // Update status
    const now = Date.now();
    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'aborted', completed_at = ${now}, error = ${reason || "Aborted"}
      WHERE id = ${taskId}
    `;

    this.cleanupController(taskId);
    this.addEventInternal(taskId, "aborted", { reason });

    // Immediate sync for abort
    this.sync(taskId);

    return true;
  }

  /**
   * Get abort signal for a task (used during execution)
   */
  getAbortSignal(taskId: string): AbortSignal | undefined {
    return this.abortControllers.get(taskId)?.signal;
  }

  /**
   * Add an event to a task
   */
  addEvent(taskId: string, type: string, data?: unknown): void {
    this.addEventInternal(taskId, type, data);

    // Debounced sync for events
    this.sync(taskId);
  }

  /**
   * Add event without syncing (internal use)
   */
  private addEventInternal(taskId: string, type: string, data?: unknown): void {
    const event: TaskEvent = {
      id: nanoid(8),
      type,
      data,
      timestamp: Date.now()
    };

    const task = this.get(taskId);
    if (!task) return;

    const events = [...task.events, event];
    this.sql`
      UPDATE cf_agents_tasks
      SET events = ${JSON.stringify(events)}
      WHERE id = ${taskId}
    `;
  }

  /**
   * Set progress for a task
   */
  setProgress(taskId: string, progress: number): void {
    const clampedProgress = Math.max(0, Math.min(100, progress));
    this.sql`
      UPDATE cf_agents_tasks
      SET progress = ${clampedProgress}
      WHERE id = ${taskId}
    `;

    // Debounced sync for progress updates
    this.sync(taskId);
  }

  /**
   * Get a task by ID
   */
  get(taskId: string): Task | undefined {
    const rows = this.sql<TaskRow>`
      SELECT * FROM cf_agents_tasks WHERE id = ${taskId}
    `;

    if (!rows || rows.length === 0) {
      return undefined;
    }

    return this.rowToTask(rows[0]);
  }

  /**
   * Get a task handle (simplified view)
   */
  getHandle<TResult>(taskId: string): TaskHandle<TResult> | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;

    return {
      id: task.id,
      status: task.status,
      result: task.result as TResult,
      error: task.error,
      progress: task.progress,
      createdAt: task.createdAt
    };
  }

  /**
   * List tasks with optional filtering
   */
  list(filter: TaskFilter = {}): Task[] {
    const rows = this.sql<TaskRow>`
      SELECT * FROM cf_agents_tasks
      ORDER BY created_at DESC
    `;

    return (rows || [])
      .map((row) => this.rowToTask(row))
      .filter((task) => {
        if (filter.status) {
          const statuses = Array.isArray(filter.status)
            ? filter.status
            : [filter.status];
          if (!statuses.includes(task.status)) return false;
        }
        if (filter.method && task.method !== filter.method) return false;
        if (filter.createdAfter && task.createdAt <= filter.createdAfter)
          return false;
        if (filter.createdBefore && task.createdAt >= filter.createdBefore)
          return false;
        return true;
      })
      .slice(0, filter.limit);
  }

  /**
   * Cancel is an alias for abort
   */
  cancel(taskId: string, reason?: string): boolean {
    return this.abort(taskId, reason);
  }

  /**
   * Delete a task (only completed/failed/aborted tasks)
   */
  delete(taskId: string): boolean {
    const task = this.get(taskId);
    if (!task) return false;

    if (task.status === "pending" || task.status === "running") {
      throw new Error(`Cannot delete ${task.status} task. Abort it first.`);
    }

    this.sql`DELETE FROM cf_agents_tasks WHERE id = ${taskId}`;

    // Remove from state
    this.syncToState(taskId, null);

    return true;
  }

  /**
   * Clean up old completed/failed/aborted tasks
   */
  cleanupOldTasks(olderThanMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    const before = this.list({ status: ["completed", "failed", "aborted"] });

    this.sql`
      DELETE FROM cf_agents_tasks
      WHERE status IN ('completed', 'failed', 'aborted')
      AND completed_at < ${cutoff}
    `;

    const after = this.list({ status: ["completed", "failed", "aborted"] });
    return before.length - after.length;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private cleanupController(taskId: string): void {
    this.abortControllers.delete(taskId);
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      method: row.method,
      input: row.input ? JSON.parse(row.input) : undefined,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error || undefined,
      events: row.events ? JSON.parse(row.events) : [],
      progress: row.progress ?? undefined,
      timeoutMs: row.timeout_ms ?? undefined,
      queueId: row.queue_id ?? undefined,
      workflowInstanceId: row.workflow_instance_id ?? undefined,
      workflowBinding: row.workflow_binding ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }

  private parseTimeout(timeout?: string | number): number | undefined {
    if (!timeout) return undefined;
    if (typeof timeout === "number") return timeout;

    const match = timeout.match(/^(\d+)(ms|s|m|h)?$/);
    if (!match) return undefined;

    const value = Number.parseInt(match[1], 10);
    const unit = match[2] || "ms";

    switch (unit) {
      case "ms":
        return value;
      case "s":
        return value * 1000;
      case "m":
        return value * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      default:
        return value;
    }
  }
}

// ============================================================================
// Tasks Accessor
// ============================================================================

/**
 * Result of workflow cancellation attempt
 */
export interface WorkflowCancelResult {
  success: boolean;
  reason?: string;
}

/**
 * Callback for canceling workflow tasks
 */
export type WorkflowCancelCallback = (
  taskId: string
) => Promise<WorkflowCancelResult>;

/**
 * Accessor object for task operations
 * Provides a clean API: this.tasks.get(id), this.tasks.cancel(id), etc.
 */
export class TasksAccessor {
  private workflowCancelCallback?: WorkflowCancelCallback;

  constructor(private tracker: TaskTracker) {}

  /**
   * Set callback for canceling workflow tasks
   * @internal
   */
  setWorkflowCancelCallback(callback: WorkflowCancelCallback): void {
    this.workflowCancelCallback = callback;
  }

  /**
   * Get a task by ID
   */
  get<TResult = unknown>(taskId: string): Task<TResult> | undefined {
    return this.tracker.get(taskId) as Task<TResult> | undefined;
  }

  /**
   * Get a simplified task handle
   */
  getHandle<TResult = unknown>(
    taskId: string
  ): TaskHandle<TResult> | undefined {
    return this.tracker.getHandle(taskId);
  }

  /**
   * List tasks with optional filtering
   */
  list(filter?: TaskFilter): Task[] {
    return this.tracker.list(filter);
  }

  /**
   * Cancel/abort a task (also terminates workflow if applicable)
   * @returns true if task was cancelled, false otherwise
   */
  async cancel(taskId: string, reason?: string): Promise<boolean> {
    // Try to cancel workflow first if this is a workflow task
    if (this.workflowCancelCallback) {
      const result = await this.workflowCancelCallback(taskId);
      // Add event if workflow cancellation had issues
      if (!result.success && result.reason !== "not_a_workflow") {
        this.tracker.addEvent(taskId, "workflow-cancel-failed", {
          reason: result.reason
        });
      }
    }
    return this.tracker.cancel(taskId, reason);
  }

  /**
   * Delete a completed task
   */
  delete(taskId: string): boolean {
    return this.tracker.delete(taskId);
  }

  /**
   * Clean up old tasks
   */
  cleanup(olderThanMs?: number): number {
    return this.tracker.cleanupOldTasks(olderThanMs);
  }
}

// ============================================================================
// Helper to create TaskContext
// ============================================================================

/**
 * Create a TaskContext for use during task execution
 */
export function createTaskContext(
  taskId: string,
  tracker: TaskTracker
): TaskContext {
  const signal = tracker.getAbortSignal(taskId) || new AbortController().signal;

  return {
    taskId,
    signal,
    emit: (type: string, data?: unknown) => {
      tracker.addEvent(taskId, type, data);
    },
    setProgress: (progress: number) => {
      tracker.setProgress(taskId, progress);
    }
  };
}
