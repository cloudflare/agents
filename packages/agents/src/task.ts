/**
 * Unified Task System for Agents SDK
 *
 * A single abstraction for all background work - whether quick operations
 * or long-running durable workflows. Same API, same mental model.
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent<Env> {
 *   // Quick task - runs in Durable Object
 *   @task()
 *   async quickProcess(input: Input, ctx: TaskContext) {
 *     ctx.emit("working");
 *     ctx.setProgress(50);
 *     return await doWork(input);
 *   }
 *
 *   // Durable task - backed by Cloudflare Workflow
 *   @task({ durable: true })
 *   async longProcess(input: Input, ctx: TaskContext) {
 *     const data = await ctx.step("fetch", () => fetchData(input));
 *     await ctx.sleep("throttle", "5 minutes");
 *     return await ctx.step("process", () => process(data));
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
  | "aborted"
  | "waiting"; // For durable tasks waiting on sleep/event

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
  /** Workflow instance ID (for durable tasks) */
  workflowInstanceId?: string;
  /** Whether this is a durable task */
  durable?: boolean;
  /** Current step name (for durable tasks) */
  currentStep?: string;
}

/**
 * Options for the @task() decorator
 */
export interface TaskDecoratorOptions {
  /** Timeout duration (e.g., "5m", "1h", or milliseconds) */
  timeout?: string | number;
  /**
   * Run as a durable task backed by Cloudflare Workflows.
   * Enables ctx.step(), ctx.sleep(), ctx.waitForEvent()
   */
  durable?: boolean;
  /**
   * Retry configuration (only for durable tasks)
   */
  retry?: {
    /** Maximum retry attempts */
    limit?: number;
    /** Delay between retries (e.g., "10s", "1m") */
    delay?: string | number;
    /** Backoff strategy */
    backoff?: "constant" | "linear" | "exponential";
  };
}

/**
 * Options for creating a task programmatically
 */
export interface TaskOptions extends TaskDecoratorOptions {
  /** Custom task ID (defaults to auto-generated) */
  id?: string;
  /** @deprecated Use retry.limit instead */
  retries?: number;
}

/**
 * Metadata stored for @task() decorated methods
 */
export interface TaskMethodMetadata extends TaskDecoratorOptions {
  /** Method name (set during decoration) */
  methodName?: string;
}

/** Storage for task method metadata */
export const taskMethodMetadata = new Map<Function, TaskMethodMetadata>();

/** Storage for original task method implementations by class+method name */
export const taskMethodOriginals = new Map<string, Function>();

/** Storage for durable task methods that need workflow generation */
export const durableTaskMethods = new Map<string, TaskMethodMetadata>();

/** Helper to create a unique key for a task method */
export function getTaskMethodKey(
  className: string,
  methodName: string
): string {
  return `${className}::${methodName}`;
}

// ============================================================================
// Unified TaskContext
// ============================================================================

/**
 * Options for waiting on an external event
 */
export interface WaitForEventOptions {
  /** Event type to wait for */
  type: string;
  /** Timeout duration (e.g., "1h", "24h", "7d") */
  timeout?: string;
}

/**
 * Unified context provided to all task methods.
 *
 * For simple tasks (@task()), step/sleep/waitForEvent are pass-through or no-ops.
 * For durable tasks (@task({ durable: true })), they use Cloudflare Workflows.
 */
export interface TaskContext {
  /** Task ID */
  taskId: string;

  /** Abort signal - check this to handle cancellation */
  signal: AbortSignal;

  /**
   * Emit a custom event (syncs to clients in real-time)
   */
  emit(type: string, data?: unknown): void;

  /**
   * Set progress percentage (0-100)
   */
  setProgress(progress: number): void;

  /**
   * Execute a durable step with automatic retry.
   *
   * - In simple tasks: executes immediately (no durability)
   * - In durable tasks: creates a checkpoint, survives restarts
   *
   * @param name - Step name for observability
   * @param fn - Async function to execute
   * @returns The result of the function
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Sleep for a duration.
   *
   * - In simple tasks: uses setTimeout (non-durable)
   * - In durable tasks: durable sleep that survives restarts
   *
   * @param name - Step name for observability
   * @param duration - Duration string (e.g., "5m", "1h", "7d")
   */
  sleep(name: string, duration: string): Promise<void>;

  /**
   * Wait for an external event.
   *
   * - In simple tasks: throws an error (not supported)
   * - In durable tasks: pauses until event is received or timeout
   *
   * @param name - Step name for observability
   * @param options - Event type and timeout
   * @returns The event payload when received
   */
  waitForEvent<T = unknown>(
    name: string,
    options: WaitForEventOptions
  ): Promise<T>;
}

/**
 * Extended context for durable tasks with access to workflow primitives
 * @internal
 */
export interface DurableTaskContext extends TaskContext {
  /** @internal Workflow step reference */
  _workflowStep?: unknown;
  /** @internal Whether this is running in durable mode */
  _isDurable: boolean;
}

// ============================================================================
// Task Handle
// ============================================================================

/**
 * Handle returned when a task is started.
 * Use this to track progress, get results, or cancel.
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
  /** Whether this is a durable task */
  durable?: boolean;
}

// ============================================================================
// @task() Decorator
// ============================================================================

/**
 * Decorator that marks a method as a task.
 *
 * Tasks are tracked operations with:
 * - Automatic progress/event broadcasting to clients
 * - Persistence in SQLite
 * - Cancellation support
 * - Optional durability via Cloudflare Workflows
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent<Env> {
 *   // Simple task - runs in Durable Object
 *   @task({ timeout: "5m" })
 *   async quickWork(input: Input, ctx: TaskContext) {
 *     ctx.emit("starting");
 *     ctx.setProgress(50);
 *     return await doWork(input);
 *   }
 *
 *   // Durable task - backed by Workflow
 *   @task({ durable: true, timeout: "1h" })
 *   async longWork(input: Input, ctx: TaskContext) {
 *     const data = await ctx.step("fetch", () => fetch(input.url));
 *     await ctx.sleep("rate-limit", "1m");
 *     return await ctx.step("process", () => process(data));
 *   }
 * }
 * ```
 */
export function task(options: TaskDecoratorOptions = {}) {
  return function taskDecorator<
    This extends {
      _runTask: (
        method: string,
        input: unknown,
        opts: TaskOptions
      ) => Promise<TaskHandle>;
      _runDurableTask: (
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
    const metadata: TaskMethodMetadata = { ...options, methodName };
    taskMethodMetadata.set(target, metadata);

    // Return a wrapper that calls the appropriate task runner
    async function wrapper(
      this: This,
      input: Args[0]
    ): Promise<TaskHandle<Return>> {
      const taskOptions: TaskOptions = {
        timeout: options.timeout,
        durable: options.durable,
        retry: options.retry
      };

      // Route to appropriate runner based on durable flag
      if (options.durable) {
        return this._runDurableTask(methodName, input, taskOptions) as Promise<
          TaskHandle<Return>
        >;
      }
      return this._runTask(methodName, input, taskOptions) as Promise<
        TaskHandle<Return>
      >;
    }

    // Store the original method for later execution
    context.addInitializer(function () {
      const instance = this as This;
      const className = instance.constructor.name;
      const key = getTaskMethodKey(className, methodName);

      if (!taskMethodOriginals.has(key)) {
        taskMethodOriginals.set(key, target);
      }

      // Track durable methods for workflow generation
      if (options.durable) {
        durableTaskMethods.set(key, metadata);
      }
    });

    // Register as callable so RPC works
    callableMetadata.set(wrapper, {});

    return wrapper as unknown as typeof target;
  };
}

// ============================================================================
// Filter and Query Types
// ============================================================================

/**
 * Filter options for listing tasks
 */
export interface TaskFilter {
  /** Filter by status */
  status?: TaskStatus | TaskStatus[];
  /** Filter by method name */
  method?: string;
  /** Filter by durable flag */
  durable?: boolean;
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
  durable?: boolean;
  retry?: TaskDecoratorOptions["retry"];
  /** @deprecated Use retry.limit instead */
  retries?: number;
}

/**
 * Callback to sync task to agent state (for real-time updates)
 */
export type StateSyncCallback = (taskId: string, task: Task | null) => void;

// ============================================================================
// Duration Parsing
// ============================================================================

/**
 * Parse duration string to milliseconds.
 * Supports formats like "5s", "10m", "1h", "2d", "500ms",
 * as well as verbose forms like "5 seconds", "10 minutes".
 *
 * @param duration - Duration string (e.g., "5m", "1h", "30s", "500ms")
 * @returns Duration in milliseconds
 * @throws Error if duration format is invalid
 */
export function parseDuration(duration: string): number {
  const match = duration.match(
    /^(\d+)\s*(ms|s|m|h|d|seconds?|minutes?|hours?|days?)?$/i
  );
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] || "ms").toLowerCase();

  switch (unit) {
    case "ms":
      return value;
    case "s":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      return value;
  }
}

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
  durable: number | null;
  current_step: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * Callback for observability events
 */
export type TaskObservabilityCallback = (event: TaskObservabilityEvent) => void;

/**
 * Task lifecycle observability event
 */
export interface TaskObservabilityEvent {
  type:
    | "task:created"
    | "task:started"
    | "task:progress"
    | "task:completed"
    | "task:failed"
    | "task:aborted"
    | "task:event"
    | "task:step"
    | "task:sleep"
    | "task:waiting";
  taskId: string;
  method?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Tracks task lifecycle and state.
 * - SQL for persistence and queries
 * - State sync callback for real-time updates to clients
 * - Supports both simple and durable tasks
 */
export class TaskTracker {
  private sql: SqlExecutor;
  private syncToState: StateSyncCallback;
  private abortControllers = new Map<string, AbortController>();
  private observabilityCallback?: TaskObservabilityCallback;
  private deadlineCache = new Map<string, number | null>();

  /**
   * Serialize a value to JSON for SQL storage.
   *
   * This method exists to make the serialization pattern explicit and safe.
   * The returned string is passed to Cloudflare's SQL template literal API,
   * which binds it as a parameterized value (not string interpolation).
   *
   * Example: `this.sql\`UPDATE t SET data = ${this.toJSON(obj)}\``
   * Becomes: `UPDATE t SET data = ?` with obj serialized as a bound parameter
   *
   * @param value - Any JSON-serializable value
   * @returns JSON string safe for use as a SQL parameter
   */
  private toJSON(value: unknown): string {
    return JSON.stringify(value);
  }

  constructor(sql: SqlExecutor, syncToState: StateSyncCallback) {
    this.sql = sql;
    this.syncToState = syncToState;

    // Create tasks table
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
        durable INTEGER DEFAULT 0,
        current_step TEXT,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        started_at INTEGER,
        completed_at INTEGER
      )
    `;

    // Migrate: add columns for existing tables (SQLite doesn't have ADD COLUMN IF NOT EXISTS)
    const columns = this.sql<{ name: string }>`
      PRAGMA table_info(cf_agents_tasks)
    `;
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has("durable")) {
      this
        .sql`ALTER TABLE cf_agents_tasks ADD COLUMN durable INTEGER DEFAULT 0`;
    }
    if (!columnNames.has("current_step")) {
      this.sql`ALTER TABLE cf_agents_tasks ADD COLUMN current_step TEXT`;
    }
    if (!columnNames.has("workflow_binding")) {
      this.sql`ALTER TABLE cf_agents_tasks ADD COLUMN workflow_binding TEXT`;
    }

    // Create indexes
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON cf_agents_tasks(status)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_tasks_durable ON cf_agents_tasks(durable)
    `;

    // Clean up stale simple tasks from previous runs
    this.sql`
      UPDATE cf_agents_tasks 
      SET status = 'failed', error = 'Agent restarted', completed_at = ${Date.now()}
      WHERE status IN ('pending', 'running')
      AND durable = 0
    `;
  }

  /**
   * Set callback for observability events
   */
  setObservabilityCallback(callback: TaskObservabilityCallback): void {
    this.observabilityCallback = callback;
  }

  /**
   * Emit an observability event
   */
  private emitObservability(
    type: TaskObservabilityEvent["type"],
    taskId: string,
    method?: string,
    data?: Record<string, unknown>
  ): void {
    this.observabilityCallback?.({
      type,
      taskId,
      method,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Sync task state to callback for real-time client updates
   */
  private sync(taskId: string): void {
    const task = this.get(taskId);
    this.syncToState(taskId, task || null);
  }

  /**
   * Create a task record
   */
  create<TInput>(
    method: string,
    input: TInput,
    options: TaskOptions = {}
  ): Task {
    const id = options.id || `task_${nanoid(12)}`;
    const now = Date.now();
    const timeoutMs = this.parseTimeout(options.timeout);
    const durable = options.durable ? 1 : 0;

    const task: Task = {
      id,
      method,
      input,
      status: "pending",
      events: [],
      createdAt: now,
      timeoutMs,
      durable: !!options.durable
    };

    this.sql`
      INSERT INTO cf_agents_tasks (id, method, input, status, events, timeout_ms, durable, created_at)
      VALUES (
        ${id},
        ${method},
        ${this.toJSON(input)},
        'pending',
        '[]',
        ${timeoutMs ?? null},
        ${durable},
        ${now}
      )
    `;

    this.emitObservability("task:created", id, method, {
      input: input as Record<string, unknown>,
      timeoutMs,
      durable: !!options.durable
    });

    this.sync(id);
    return task;
  }

  /**
   * Link task to its queue item (for simple tasks)
   */
  linkToQueue(taskId: string, queueId: string): void {
    this.sql`
      UPDATE cf_agents_tasks SET queue_id = ${queueId} WHERE id = ${taskId}
    `;
  }

  /**
   * Link task to a workflow instance (for durable tasks)
   * @param taskId - Task ID
   * @param instanceId - Workflow instance ID
   * @param binding - Optional workflow binding name (for backward compat)
   */
  linkToWorkflow(taskId: string, instanceId: string, binding?: string): void {
    if (binding) {
      this.sql`
        UPDATE cf_agents_tasks 
        SET workflow_instance_id = ${instanceId}, workflow_binding = ${binding}
        WHERE id = ${taskId}
      `;
    } else {
      this.sql`
        UPDATE cf_agents_tasks 
        SET workflow_instance_id = ${instanceId}
        WHERE id = ${taskId}
      `;
    }
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
    if (!rows?.[0]?.workflow_instance_id) {
      return null;
    }
    return {
      instanceId: rows[0].workflow_instance_id,
      binding: rows[0].workflow_binding || ""
    };
  }

  /**
   * Get workflow instance ID for a task
   */
  getWorkflowInstanceId(taskId: string): string | null {
    const rows = this.sql<{ workflow_instance_id: string | null }>`
      SELECT workflow_instance_id FROM cf_agents_tasks WHERE id = ${taskId}
    `;
    return rows?.[0]?.workflow_instance_id ?? null;
  }

  /**
   * Check if a task is durable
   */
  isDurable(taskId: string): boolean {
    const rows = this.sql<{ durable: number }>`
      SELECT durable FROM cf_agents_tasks WHERE id = ${taskId}
    `;
    return rows?.[0]?.durable === 1;
  }

  /**
   * Mark task as running and start timeout tracking.
   *
   * The deadline is computed from the current time, not task creation time.
   * This ensures timeouts are measured from when execution actually begins,
   * avoiding race conditions where a task could timeout before starting.
   */
  markRunning(taskId: string): AbortController {
    const now = Date.now();
    const task = this.get(taskId);
    // Deadline is relative to execution start, not creation time
    const deadline = task?.timeoutMs ? now + task.timeoutMs : null;

    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'running', started_at = ${now}, deadline_at = ${deadline}
      WHERE id = ${taskId}
    `;

    this.deadlineCache.set(taskId, deadline);

    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);

    this.emitObservability("task:started", taskId, task?.method, {
      deadline,
      timeoutMs: task?.timeoutMs,
      durable: task?.durable
    });

    this.sync(taskId);
    return controller;
  }

  /**
   * Update current step for durable tasks
   */
  setCurrentStep(taskId: string, stepName: string): void {
    this.sql`
      UPDATE cf_agents_tasks SET current_step = ${stepName} WHERE id = ${taskId}
    `;

    this.emitObservability("task:step", taskId, undefined, { step: stepName });
    this.sync(taskId);
  }

  /**
   * Mark task as waiting (for sleep/event)
   */
  markWaiting(taskId: string, reason: string): void {
    this.sql`
      UPDATE cf_agents_tasks SET status = 'waiting' WHERE id = ${taskId}
    `;

    this.emitObservability("task:waiting", taskId, undefined, { reason });
    this.sync(taskId);
  }

  /**
   * Resume task from waiting state
   */
  resumeFromWaiting(taskId: string): void {
    this.sql`
      UPDATE cf_agents_tasks SET status = 'running' WHERE id = ${taskId}
    `;
    this.sync(taskId);
  }

  /**
   * Check if a task has exceeded its deadline
   */
  checkTimeout(taskId: string): boolean {
    const task = this.get(taskId);
    if (!task || task.status !== "running") return false;

    let deadline = this.deadlineCache.get(taskId);

    if (deadline === undefined) {
      const rows = this.sql<{ deadline_at: number | null }>`
        SELECT deadline_at FROM cf_agents_tasks WHERE id = ${taskId}
      `;
      deadline = rows?.[0]?.deadline_at ?? null;
      this.deadlineCache.set(taskId, deadline);
    }

    if (deadline && Date.now() > deadline) {
      this.abort(taskId, "Task timed out");
      return true;
    }
    return false;
  }

  /**
   * Mark task as completed
   */
  complete(taskId: string, result: unknown): void {
    const now = Date.now();
    const task = this.get(taskId);

    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'completed', result = ${this.toJSON(result)}, completed_at = ${now}, progress = 100
      WHERE id = ${taskId}
    `;

    // cleanupController handles both abortControllers and deadlineCache
    this.cleanupController(taskId);
    this.addEventInternal(taskId, "completed", { result });

    this.emitObservability("task:completed", taskId, task?.method, {
      result: result as Record<string, unknown>,
      duration: task?.startedAt ? now - task.startedAt : undefined
    });

    this.sync(taskId);
  }

  /**
   * Mark task as failed
   */
  fail(taskId: string, error: string): void {
    const now = Date.now();
    const task = this.get(taskId);

    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'failed', error = ${error}, completed_at = ${now}
      WHERE id = ${taskId}
    `;

    // cleanupController handles both abortControllers and deadlineCache
    this.cleanupController(taskId);
    this.addEventInternal(taskId, "failed", { error });

    this.emitObservability("task:failed", taskId, task?.method, {
      error,
      duration: task?.startedAt ? now - task.startedAt : undefined
    });

    this.sync(taskId);
  }

  /**
   * Abort a task
   */
  abort(taskId: string, reason?: string): boolean {
    const task = this.get(taskId);
    if (!task) return false;

    if (!["pending", "running", "waiting"].includes(task.status)) {
      return false;
    }

    const controller = this.abortControllers.get(taskId);
    if (controller) {
      controller.abort(reason);
    }

    const now = Date.now();
    this.sql`
      UPDATE cf_agents_tasks
      SET status = 'aborted', completed_at = ${now}, error = ${reason || "Aborted"}
      WHERE id = ${taskId}
    `;

    // cleanupController handles both abortControllers and deadlineCache
    this.cleanupController(taskId);
    this.addEventInternal(taskId, "aborted", { reason });

    this.emitObservability("task:aborted", taskId, task.method, {
      reason,
      duration: task.startedAt ? now - task.startedAt : undefined
    });

    this.sync(taskId);
    return true;
  }

  /**
   * Get abort signal for a task
   */
  getAbortSignal(taskId: string): AbortSignal | undefined {
    return this.abortControllers.get(taskId)?.signal;
  }

  /**
   * Add an event to a task
   */
  addEvent(taskId: string, type: string, data?: unknown): void {
    this.addEventInternal(taskId, type, data);

    this.emitObservability("task:event", taskId, undefined, {
      eventType: type,
      eventData: data as Record<string, unknown>
    });

    this.sync(taskId);
  }

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
      SET events = ${this.toJSON(events)}
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

    this.emitObservability("task:progress", taskId, undefined, {
      progress: clampedProgress
    });

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
      createdAt: task.createdAt,
      durable: task.durable
    };
  }

  /**
   * List tasks with optional filtering
   */
  list(filter: TaskFilter = {}): Task[] {
    try {
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
          if (filter.durable !== undefined && task.durable !== filter.durable)
            return false;
          if (filter.createdAfter && task.createdAt <= filter.createdAfter)
            return false;
          if (filter.createdBefore && task.createdAt >= filter.createdBefore)
            return false;
          return true;
        })
        .slice(0, filter.limit);
    } catch {
      return [];
    }
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

    if (["pending", "running", "waiting"].includes(task.status)) {
      throw new Error(`Cannot delete ${task.status} task. Abort it first.`);
    }

    this.sql`DELETE FROM cf_agents_tasks WHERE id = ${taskId}`;
    this.syncToState(taskId, null);
    return true;
  }

  /**
   * Clean up old tasks
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

  /**
   * Clean up abort controller for a task.
   * Safe to call multiple times - idempotent operation.
   * @internal Exposed for callers to ensure cleanup in finally blocks
   */
  cleanupController(taskId: string): void {
    this.abortControllers.delete(taskId);
    this.deadlineCache.delete(taskId);
  }

  /**
   * Clean up any orphaned abort controllers.
   * Removes controllers for tasks that are no longer running/pending.
   * Call periodically to prevent memory leaks from unexpected failures.
   */
  cleanupOrphanedControllers(): number {
    let cleaned = 0;
    for (const taskId of this.abortControllers.keys()) {
      const task = this.get(taskId);
      // Clean up if task doesn't exist or is in a terminal state
      if (!task || ["completed", "failed", "aborted"].includes(task.status)) {
        this.abortControllers.delete(taskId);
        this.deadlineCache.delete(taskId);
        cleaned++;
      }
    }
    return cleaned;
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
      durable: row.durable === 1,
      currentStep: row.current_step ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }

  private parseTimeout(timeout?: string | number): number | undefined {
    if (!timeout) return undefined;
    if (typeof timeout === "number") return timeout;
    try {
      return parseDuration(timeout);
    } catch {
      return undefined;
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
 * Accessor object for task operations.
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
   * Cancel a task (also terminates workflow if durable)
   */
  async cancel(taskId: string, reason?: string): Promise<boolean> {
    // Try to cancel workflow first if this is a durable task
    if (this.workflowCancelCallback && this.tracker.isDurable(taskId)) {
      const result = await this.workflowCancelCallback(taskId);
      if (!result.success && result.reason !== "not_found") {
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
// TaskContext Factories
// ============================================================================

/**
 * Create a TaskContext for simple (non-durable) task execution
 */
export function createSimpleTaskContext(
  taskId: string,
  tracker: TaskTracker
): TaskContext {
  const signal = tracker.getAbortSignal(taskId) || new AbortController().signal;

  return {
    taskId,
    signal,

    emit(type: string, data?: unknown): void {
      tracker.addEvent(taskId, type, data);
    },

    setProgress(progress: number): void {
      tracker.setProgress(taskId, progress);
    },

    // For simple tasks, step just executes the function directly
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      tracker.setCurrentStep(taskId, name);
      return fn();
    },

    // For simple tasks, sleep uses setTimeout (non-durable)
    async sleep(name: string, duration: string): Promise<void> {
      tracker.setCurrentStep(taskId, `sleep:${name}`);
      const ms = parseDuration(duration);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },

    // For simple tasks, waitForEvent is not supported
    async waitForEvent<T>(
      _name: string,
      _options: WaitForEventOptions
    ): Promise<T> {
      throw new Error(
        "waitForEvent() is only available in durable tasks. " +
          "Use @task({ durable: true }) to enable this feature."
      );
    }
  };
}

/**
 * Subset of WorkflowStep methods used by TaskContext.
 * This interface mirrors the Cloudflare WorkflowStep API but with relaxed
 * serialization constraints for internal use. The actual WorkflowStep
 * from cloudflare:workers enforces Serializable<T> at runtime.
 *
 * @see https://developers.cloudflare.com/workflows/build/workflows-api/
 */
export interface WorkflowStepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
  waitForEvent<T>(
    name: string,
    options: { type: string; timeout?: string }
  ): Promise<T>;
}

/**
 * Create a TaskContext for durable task execution (workflow-backed)
 * This is called from within the workflow with access to WorkflowStep
 */
export function createDurableTaskContext(
  taskId: string,
  tracker: TaskTracker,
  workflowStep: WorkflowStepLike,
  notifyAgent: (update: {
    event?: { type: string; data?: unknown };
    progress?: number;
  }) => Promise<boolean>
): TaskContext {
  const signal = new AbortController().signal; // Workflows handle their own cancellation

  return {
    taskId,
    signal,

    emit(type: string, data?: unknown): void {
      // Queue notification to be sent at next step boundary
      notifyAgent({ event: { type, data } }).catch(console.error);
      tracker.addEvent(taskId, type, data);
    },

    setProgress(progress: number): void {
      notifyAgent({ progress }).catch(console.error);
      tracker.setProgress(taskId, progress);
    },

    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      tracker.setCurrentStep(taskId, name);
      // Use workflow's durable step.do()
      return workflowStep.do(name, fn);
    },

    async sleep(name: string, duration: string): Promise<void> {
      tracker.setCurrentStep(taskId, `sleep:${name}`);
      tracker.markWaiting(taskId, `Sleeping: ${duration}`);
      // Use workflow's durable sleep
      await workflowStep.sleep(name, duration);
      tracker.resumeFromWaiting(taskId);
    },

    async waitForEvent<T>(
      name: string,
      options: WaitForEventOptions
    ): Promise<T> {
      tracker.setCurrentStep(taskId, `wait:${name}`);
      tracker.markWaiting(taskId, `Waiting for event: ${options.type}`);
      // Use workflow's durable waitForEvent
      const result = await workflowStep.waitForEvent<T>(name, {
        type: options.type,
        timeout: options.timeout
      });
      tracker.resumeFromWaiting(taskId);
      return result;
    }
  };
}

/**
 * @deprecated Use createSimpleTaskContext instead
 * Backward compatibility alias
 */
export const createTaskContext = createSimpleTaskContext;
