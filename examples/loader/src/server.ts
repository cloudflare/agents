import { Agent, type Connection, routeAgentRequest } from "agents";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { YjsStorage, type SqlFunction } from "./yjs-storage";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import {
  createTools,
  SYSTEM_PROMPT,
  type ToolContext,
  type TaskContext,
  type SubagentContext,
  type SubagentResult
} from "./agent-tools";
import {
  SubagentManager,
  type SubagentEnv,
  type SubagentCheckPayload,
  SUBAGENT_CONFIG,
  registerStaticTestValue,
  getStaticTestValue,
  STATIC_TEST_MAP
} from "./subagent";
import type { BashLoopback } from "./loopbacks/bash";
import type { FetchLoopback } from "./loopbacks/fetch";
import type { BraveSearchLoopback } from "./loopbacks/brave-search";
import {
  type Task,
  type TaskGraph,
  type TaskValidationError,
  createTaskGraph,
  createTask,
  addTask,
  startTask,
  completeTask,
  getReadyTasks,
  getProgress,
  getSubtreeProgress,
  getTaskTree,
  deserializeGraph,
  taskToRow,
  rowToTask
} from "./tasks";

// Re-export loopback classes so they're available via ctx.exports
export { BashLoopback } from "./loopbacks/bash";
export { BraveSearchLoopback } from "./loopbacks/brave-search";
export { BrowserLoopback } from "./loopbacks/browser";
export { EchoLoopback } from "./loopbacks/echo";
export { FetchLoopback } from "./loopbacks/fetch";
export { FSLoopback } from "./loopbacks/fs";

// Re-export Subagent and test facets for facet-based parallel execution
export {
  Subagent,
  StorageTestFacet,
  StaticTestFacet,
  RpcTestFacet,
  registerStaticTestValue,
  getStaticTestValue,
  STATIC_TEST_MAP
} from "./subagent";

// inline this until enable_ctx_exports is supported by default
declare global {
  interface ExecutionContext<Props = unknown> {
    readonly exports: Cloudflare.Exports;
    readonly props: Props;
  }

  interface DurableObjectState<Props = unknown> {
    readonly exports: Cloudflare.Exports;
    readonly props: Props;
  }
}

/**
 * State synced to connected clients via WebSocket
 */
export interface ThinkState {
  sessionId: string;
  status: "idle" | "thinking" | "executing" | "waiting";
  activeFile?: string;
  codeVersion: number;
}

/**
 * Chat message stored in history
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  }[];
  timestamp: number;
}

/**
 * Think WebSocket message types
 * Wrapped with __think__: 1 to allow multiplexing with other message types
 */
export type ThinkPayload =
  | { type: "text_delta"; delta: string }
  | { type: "text_done" }
  | { type: "reasoning_delta"; delta: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; output: unknown }
  | { type: "chat"; message: { role: "assistant"; content: string } }
  | { type: "error"; error: string };

export interface ThinkMessage {
  __think__: 1;
  payload: ThinkPayload;
}

/**
 * Wrap a payload in the Think message envelope
 */
function thinkMsg(payload: ThinkPayload): string {
  return JSON.stringify({ __think__: 1, payload } satisfies ThinkMessage);
}

/**
 * Debug event types for internal observability
 */
export type ThinkDebugEvent =
  | { event: "subagent:spawn"; id: string; task: string }
  | {
      event: "subagent:complete";
      id: string;
      success: boolean;
      summary?: string;
    }
  | { event: "subagent:error"; id: string; error: string }
  | { event: "task:created"; id: string; type: string; title: string }
  | { event: "task:started"; id: string }
  | { event: "task:completed"; id: string; result?: string }
  | { event: "tool:start"; name: string; callId: string }
  | {
      event: "tool:end";
      name: string;
      callId: string;
      durationMs: number;
      success: boolean;
    }
  | { event: "state:change"; status: string }
  | { event: "connected"; sessionId: string }
  | { event: "message:received"; content: string };

export interface ThinkDebugMessage {
  __think_debug__: 1;
  timestamp: number;
  payload: ThinkDebugEvent;
}

/**
 * Wrap a debug event
 */
function debugMsg(payload: ThinkDebugEvent): string {
  return JSON.stringify({
    __think_debug__: 1,
    timestamp: Date.now(),
    payload
  } satisfies ThinkDebugMessage);
}

/**
 * Action log entry for audit trail
 */
export interface ActionLogEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  tool: string;
  action: string;
  input?: string;
  outputSummary?: string;
  durationMs?: number;
  success: boolean;
  error?: string;
  messageId?: string;
}

/**
 * Maximum number of tool call rounds to prevent infinite loops
 */
const MAX_TOOL_ROUNDS = 20;

/**
 * Maximum messages to keep in context (to manage token limits)
 */
const MAX_CONTEXT_MESSAGES = 50;

/**
 * Feature flag for experimental subagent endpoints.
 * Pass --var ENABLE_SUBAGENT_API=true to wrangler dev to enable.
 *
 * These endpoints use Durable Object Facets which are experimental
 * and may not work in all environments (e.g., vitest-pool-workers).
 */
function isSubagentApiEnabled(env: Env): boolean {
  // Check for string "true" since wrangler --var passes strings
  return (
    (env as unknown as { ENABLE_SUBAGENT_API?: string }).ENABLE_SUBAGENT_API ===
    "true"
  );
}

/**
 * Interface for the dynamic worker entrypoint
 */
interface CodeExecutionEntrypoint extends WorkerEntrypoint {
  verify(): void;
  run(): Promise<{ output: unknown; logs: string[] }>;
}

/**
 * Result from executing code in a dynamic worker
 */
export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  errorType?: "syntax" | "runtime" | "timeout" | "unknown";
  logs: string[];
  duration: number;
}

/**
 * Default execution timeout in milliseconds
 */
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Custom error class for timeouts
 */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * The main Think Agent - orchestrates dynamic code execution
 *
 * Architecture:
 * - This Agent (Durable Object) is the persistent "brain"
 * - Dynamic workers loaded via LOADER are the ephemeral "hands"
 * - Yjs document stores the code with full version history
 * - Loopback bindings provide tools to dynamic workers
 */
export class Think extends Agent<Env, ThinkState> {
  // Yjs storage for code with versioning
  private yjsStorage: YjsStorage | null = null;

  // Chat history for this session (in-memory, backed by SQLite)
  private chatHistory: ModelMessage[] = [];
  private chatHistoryLoaded = false;

  // Task management for complex multi-step work
  private taskGraph: TaskGraph = createTaskGraph();
  private currentTaskId: string | null = null;
  private taskGraphLoaded = false;

  // Subagent manager for parallel task execution
  private subagentManager: SubagentManager | null = null;

  // AbortController for cancelling ongoing operations
  private currentAbortController: AbortController | null = null;

  /**
   * Emit a debug event to all subscribed connections.
   * Uses connection state to track debug subscriptions (survives hibernation).
   */
  private emitDebug(event: ThinkDebugEvent): void {
    const connections = this.getConnections();
    const msg = debugMsg(event);
    let sentCount = 0;

    for (const conn of connections) {
      // Check if this connection has debug enabled via its state
      const connState = conn.state as { debug?: boolean } | undefined;
      if (connState?.debug) {
        try {
          conn.send(msg);
          sentCount++;
        } catch {
          // Connection might be closed, ignore
        }
      }
    }

    if (sentCount > 0) {
      console.log(
        "[DEBUG SERVER] Sent",
        event.event,
        "to",
        sentCount,
        "debug connections"
      );
    }
  }

  /**
   * Initial state for the Agent - provides defaults before any state is set
   */
  initialState: ThinkState = {
    sessionId: crypto.randomUUID(),
    status: "idle",
    codeVersion: 0
  };

  /**
   * Get or initialize the YjsStorage
   */
  private getStorage(): YjsStorage {
    if (!this.yjsStorage) {
      // Bind the sql function to this Agent instance
      // Cast is needed because Agent's sql type doesn't include Uint8Array, but it works at runtime
      const boundSql = this.sql.bind(this) as SqlFunction;
      this.yjsStorage = new YjsStorage(boundSql);
      // Initialize with default files if empty
      const version = this.yjsStorage.initializeDocument({
        "main.ts": "// Your code here\nconsole.log('Hello, world!');",
        "README.md": "# Project\n\nEdit these files to build your application."
      });
      // Update state with current version
      if (version > 0 && this.state.codeVersion !== version) {
        this.setState({ ...this.state, codeVersion: version });
      }
    }
    return this.yjsStorage;
  }

  /**
   * Initialize the Agent state
   */
  async onStart(): Promise<void> {
    // Initialize storage and sync version
    const storage = this.getStorage();
    const version = storage.getVersion();
    if (version > 0 && this.state.codeVersion !== version) {
      this.setState({ ...this.state, codeVersion: version });
    }
    // Initialize chat history tables
    this.initChatTables();

    // Recover any orphaned subagents from a previous instance
    // (e.g., if the DO restarted while subagents were running)
    await this.recoverOrphanedSubagents();
  }

  /**
   * Initialize SQLite tables for chat history and action logging
   */
  private initChatTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        reasoning TEXT,
        timestamp INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_session 
      ON chat_messages(session_id, timestamp)
    `;

    // Migration: add reasoning column if it doesn't exist (for existing DBs)
    try {
      this.sql`ALTER TABLE chat_messages ADD COLUMN reasoning TEXT`;
    } catch {
      // Column already exists, ignore
    }

    // Action log table for audit trail
    this.sql`
      CREATE TABLE IF NOT EXISTS action_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool TEXT NOT NULL,
        action TEXT NOT NULL,
        input TEXT,
        output_summary TEXT,
        duration_ms INTEGER,
        success INTEGER NOT NULL,
        error TEXT,
        message_id TEXT
      )
    `;

    // Tasks table for task management
    this.sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        dependencies TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        error TEXT,
        assigned_to TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        metadata TEXT
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_action_log_session 
      ON action_log(session_id, timestamp)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_action_log_tool 
      ON action_log(tool, timestamp)
    `;
  }

  // ============================================================================
  // Task Management
  // ============================================================================

  /**
   * Load task graph from SQLite
   */
  private loadTaskGraph(): void {
    if (this.taskGraphLoaded) return;

    const rows = this.sql`SELECT * FROM tasks`;

    if (rows.length > 0) {
      const tasks = rows.map((row) =>
        rowToTask(
          row as {
            id: string;
            parent_id: string | null;
            type: string;
            title: string;
            description: string | null;
            status: string;
            dependencies: string;
            result: string | null;
            error: string | null;
            assigned_to: string | null;
            created_at: number;
            started_at: number | null;
            completed_at: number | null;
            metadata: string | null;
          }
        )
      );
      this.taskGraph = deserializeGraph(tasks);
    }

    this.taskGraphLoaded = true;
  }

  /**
   * Save a task to SQLite
   */
  private saveTask(task: Task): void {
    const row = taskToRow(task);
    this.sql`
      INSERT OR REPLACE INTO tasks (
        id, parent_id, type, title, description, status, dependencies,
        result, error, assigned_to, created_at, started_at, completed_at, metadata
      ) VALUES (
        ${row.id}, ${row.parent_id}, ${row.type}, ${row.title}, ${row.description},
        ${row.status}, ${row.dependencies}, ${row.result}, ${row.error},
        ${row.assigned_to}, ${row.created_at}, ${row.started_at}, ${row.completed_at},
        ${row.metadata}
      )
    `;
  }

  /**
   * Create a root task for a user message
   */
  private createRootTask(messageContent: string): Task {
    this.loadTaskGraph();

    const title =
      messageContent.length > 50
        ? `${messageContent.slice(0, 47)}...`
        : messageContent;

    const task = createTask({
      type: "code",
      title,
      description: messageContent
    });

    const result = addTask(this.taskGraph, task);
    if ("type" in result && typeof result.type === "string") {
      // Validation error - shouldn't happen for root task, but handle gracefully
      console.error(
        "Failed to create root task:",
        (result as TaskValidationError).message
      );
      return task;
    }

    this.taskGraph = result as TaskGraph;
    this.currentTaskId = task.id;
    this.saveTask(task);

    return task;
  }

  /**
   * Get task context for tools
   */
  private getTaskContext(): TaskContext | undefined {
    if (!this.currentTaskId) return undefined;

    this.loadTaskGraph();

    const currentTaskId = this.currentTaskId;

    return {
      currentTaskId,

      getTaskGraph: () => this.taskGraph,

      createSubtask: (input) => {
        const task = createTask({
          type: input.type,
          title: input.title,
          description: input.description,
          dependencies: input.dependencies,
          parentId: currentTaskId
        });

        const result = addTask(this.taskGraph, task);
        if ("type" in result && typeof result.type === "string") {
          return { error: (result as TaskValidationError).message };
        }

        this.taskGraph = result as TaskGraph;
        this.saveTask(task);

        return task;
      },

      completeTask: (taskId: string, result?: string) => {
        const updated = completeTask(this.taskGraph, taskId, result);
        if (!updated) return false;

        this.taskGraph = updated;

        // Save the updated task
        const task = updated.tasks.get(taskId);
        if (task) this.saveTask(task);

        // Also save any tasks that became unblocked
        for (const t of updated.tasks.values()) {
          if (t.id !== taskId) {
            const original = this.taskGraph.tasks.get(t.id);
            if (original && original.status !== t.status) {
              this.saveTask(t);
            }
          }
        }

        return true;
      },

      getReadyTasks: () => getReadyTasks(this.taskGraph),

      getProgress: () => {
        if (currentTaskId) {
          return getSubtreeProgress(this.taskGraph, currentTaskId);
        }
        return getProgress(this.taskGraph);
      },

      getTaskTree: () => getTaskTree(this.taskGraph)
    };
  }

  /**
   * Get or initialize the SubagentManager
   */
  private getSubagentManager(): SubagentManager {
    if (!this.subagentManager) {
      const subagentEnv: SubagentEnv = {
        OPENAI_API_KEY: this.env.OPENAI_API_KEY,
        BRAVE_API_KEY: this.env.BRAVE_API_KEY,
        LOADER: this.env.LOADER
      };
      this.subagentManager = new SubagentManager(
        this.ctx,
        subagentEnv,
        this.state.sessionId
      );
    }
    return this.subagentManager;
  }

  /**
   * Schedule a status check for a subagent.
   * Uses the Agents SDK schedule() API for durable scheduling.
   */
  private async scheduleSubagentCheck(
    taskId: string,
    delaySeconds: number = SUBAGENT_CONFIG.initialCheckDelay
  ): Promise<void> {
    const payload: SubagentCheckPayload = {
      taskId,
      attempt: 1,
      maxAttempts: SUBAGENT_CONFIG.maxCheckAttempts
    };

    await this.schedule(delaySeconds, "checkSubagentStatus", payload);
  }

  /**
   * Callback method for scheduled subagent status checks.
   * Called by the Agents SDK scheduler when a check is due.
   */
  async checkSubagentStatus(payload: SubagentCheckPayload): Promise<void> {
    const manager = this.getSubagentManager();
    const status = await manager.getSubagentStatus(payload.taskId);

    // If status is null, the subagent was already cleaned up
    if (!status) {
      console.log(
        `Subagent ${payload.taskId}: already cleaned up, skipping check`
      );
      return;
    }

    // If complete or failed, update task graph and clean up
    if (status.status === "complete" || status.status === "failed") {
      console.log(`Subagent ${payload.taskId}: ${status.status}`);
      await this.handleSubagentComplete(payload.taskId, status);
      return;
    }

    // Still running - check for timeout
    if (manager.isTimedOut(payload.taskId)) {
      console.log(`Subagent ${payload.taskId}: timed out`);
      await this.handleSubagentTimeout(payload.taskId);
      return;
    }

    // Still running, schedule another check if we haven't hit max attempts
    if (payload.attempt < payload.maxAttempts) {
      const nextPayload: SubagentCheckPayload = {
        taskId: payload.taskId,
        attempt: payload.attempt + 1,
        maxAttempts: payload.maxAttempts
      };
      await this.schedule(
        SUBAGENT_CONFIG.checkInterval,
        "checkSubagentStatus",
        nextPayload
      );
    } else {
      // Max attempts reached without completion - mark as timed out
      console.log(
        `Subagent ${payload.taskId}: max check attempts reached, marking as timed out`
      );
      await this.handleSubagentTimeout(payload.taskId);
    }
  }

  /**
   * Handle successful or failed subagent completion
   */
  private async handleSubagentComplete(
    taskId: string,
    status: { status: string; result?: string; error?: string }
  ): Promise<void> {
    const manager = this.getSubagentManager();

    // Update task graph if available
    this.loadTaskGraph();
    const task = this.taskGraph.tasks.get(taskId);
    if (task) {
      if (status.status === "complete") {
        const updated = completeTask(
          this.taskGraph,
          taskId,
          status.result || "Completed by subagent"
        );
        if (updated) {
          this.taskGraph = updated;
          this.saveTask(task);
        }
      } else if (status.status === "failed") {
        // Task failed - mark in graph
        const failedTask = {
          ...task,
          status: "failed" as const,
          error: status.error
        };
        this.taskGraph.tasks.set(taskId, failedTask);
        this.saveTask(failedTask);
      }
    }

    // Clean up the subagent tracking
    manager.deleteSubagent(taskId);
  }

  /**
   * Handle subagent timeout
   */
  private async handleSubagentTimeout(taskId: string): Promise<void> {
    const manager = this.getSubagentManager();

    // Update task graph if available
    this.loadTaskGraph();
    const task = this.taskGraph.tasks.get(taskId);
    if (task) {
      const failedTask = {
        ...task,
        status: "failed" as const,
        error: "Subagent execution timed out"
      };
      this.taskGraph.tasks.set(taskId, failedTask);
      this.saveTask(failedTask);
    }

    // Clean up
    manager.markTimedOut(taskId);
  }

  /**
   * Recover orphaned subagents on startup.
   * Called from onStart() to detect and handle subagents that were
   * interrupted by a server restart.
   */
  private async recoverOrphanedSubagents(): Promise<void> {
    const manager = this.getSubagentManager();
    const running = manager.getRunningSubagents();

    if (running.length === 0) return;

    console.log(`Recovering ${running.length} orphaned subagent(s)...`);

    for (const subagent of running) {
      // Mark as interrupted in tracking
      manager.markInterrupted(subagent.taskId);

      // Update task graph
      this.loadTaskGraph();
      const task = this.taskGraph.tasks.get(subagent.taskId);
      if (task) {
        const failedTask = {
          ...task,
          status: "failed" as const,
          error: "Interrupted by server restart"
        };
        this.taskGraph.tasks.set(subagent.taskId, failedTask);
        this.saveTask(failedTask);
      }

      // Clean up
      manager.deleteSubagent(subagent.taskId);
    }
  }

  /**
   * Get the SubagentContext for delegating tasks to parallel subagents
   */
  private getSubagentContext(): SubagentContext | undefined {
    // Only provide subagent context when we have an active task context
    if (!this.currentTaskId) return undefined;

    const manager = this.getSubagentManager();
    const self = this;

    return {
      async delegateTask(input: {
        taskId: string;
        title: string;
        description: string;
        context?: string;
      }): Promise<{ facetName: string } | { error: string }> {
        // Verify the task exists
        const task = self.taskGraph.tasks.get(input.taskId);
        if (!task) {
          return { error: `Task ${input.taskId} not found` };
        }

        // Task must be pending or in-progress to delegate
        if (
          task.status === "complete" ||
          task.status === "failed" ||
          task.status === "cancelled"
        ) {
          return { error: `Task ${input.taskId} is already ${task.status}` };
        }

        try {
          const facetName = await manager.spawnSubagent(
            {
              ...task,
              title: input.title,
              description: input.description
            },
            input.context
          );

          // Schedule a status check to monitor the subagent
          await self.scheduleSubagentCheck(input.taskId);

          return { facetName };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error)
          };
        }
      },

      async getSubagentStatus(taskId: string) {
        const status = await manager.getSubagentStatus(taskId);
        if (!status) return null;
        return {
          status: status.status,
          result: status.result,
          error: status.error
        };
      },

      async waitForSubagents(): Promise<SubagentResult[]> {
        // Poll until all active subagents complete
        const results: SubagentResult[] = [];
        const maxWait = 5 * 60 * 1000; // 5 minute timeout
        const pollInterval = 1000; // 1 second
        const startTime = Date.now();

        while (manager.activeCount > 0 && Date.now() - startTime < maxWait) {
          const statuses = await manager.getAllStatuses();

          for (const status of statuses) {
            if (status.status === "complete" || status.status === "failed") {
              results.push({
                taskId: status.taskId,
                success: status.status === "complete",
                result: status.result,
                error: status.error,
                duration:
                  (status.completedAt || Date.now()) -
                  (status.startedAt || Date.now())
              });
            }
          }

          if (manager.activeCount > 0) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
          }
        }

        return results;
      },

      activeCount(): number {
        return manager.activeCount;
      }
    };
  }

  /**
   * Load chat history from SQLite
   */
  private loadChatHistory(): void {
    if (this.chatHistoryLoaded) return;

    const rows = this.sql`
      SELECT role, content, tool_calls, reasoning 
      FROM chat_messages 
      WHERE session_id = ${this.state.sessionId}
      ORDER BY timestamp ASC
      LIMIT ${MAX_CONTEXT_MESSAGES}
    `;

    this.chatHistory = [];
    for (const row of rows) {
      const msg: ModelMessage = {
        role: row.role as "user" | "assistant" | "system",
        content: row.content as string
      };
      this.chatHistory.push(msg);
    }
    this.chatHistoryLoaded = true;
  }

  /**
   * Get chat history with tool calls and reasoning for client display
   */
  private getChatHistoryForClient(): Array<{
    role: string;
    content: string;
    toolCalls?: unknown;
    reasoning?: string;
  }> {
    const rows = this.sql`
      SELECT role, content, tool_calls, reasoning 
      FROM chat_messages 
      WHERE session_id = ${this.state.sessionId}
      ORDER BY timestamp ASC
      LIMIT ${MAX_CONTEXT_MESSAGES}
    `;

    return Array.from(rows).map((row) => {
      const msg: {
        role: string;
        content: string;
        toolCalls?: unknown;
        reasoning?: string;
      } = {
        role: row.role as string,
        content: row.content as string
      };
      if (row.tool_calls) {
        try {
          msg.toolCalls = JSON.parse(row.tool_calls as string);
        } catch {
          // ignore parse errors
        }
      }
      if (row.reasoning) {
        msg.reasoning = row.reasoning as string;
      }
      return msg;
    });
  }

  /**
   * Save a message to chat history
   */
  private saveChatMessage(
    role: "user" | "assistant" | "system",
    content: string,
    options?: {
      toolCalls?: unknown;
      reasoning?: string;
    }
  ): void {
    const toolCallsJson = options?.toolCalls
      ? JSON.stringify(options.toolCalls)
      : null;
    // Truncate reasoning for storage (keep first 2000 chars)
    const reasoning = options?.reasoning
      ? options.reasoning.slice(0, 2000)
      : null;
    this.sql`
      INSERT INTO chat_messages (session_id, role, content, tool_calls, reasoning, timestamp)
      VALUES (${this.state.sessionId}, ${role}, ${content}, ${toolCallsJson}, ${reasoning}, ${Date.now()})
    `;
  }

  /**
   * Log an action to the action_log table for audit trail
   */
  logAction(entry: Omit<ActionLogEntry, "id" | "timestamp">): string {
    const id = crypto.randomUUID();
    const timestamp = Date.now();

    this.sql`
      INSERT INTO action_log (id, session_id, timestamp, tool, action, input, output_summary, duration_ms, success, error, message_id)
      VALUES (${id}, ${entry.sessionId}, ${timestamp}, ${entry.tool}, ${entry.action}, ${entry.input || null}, ${entry.outputSummary || null}, ${entry.durationMs || null}, ${entry.success ? 1 : 0}, ${entry.error || null}, ${entry.messageId || null})
    `;

    return id;
  }

  /**
   * Summarize output for action logging (avoid storing large data)
   */
  summarizeOutput(tool: string, _action: string, output: unknown): string {
    // Handle null/undefined
    if (output === null || output === undefined) {
      return "null";
    }

    // Handle strings
    if (typeof output === "string") {
      if (output.length > 500) {
        return `${output.slice(0, 500)}... (${output.length} chars)`;
      }
      return output;
    }

    // Handle specific tool outputs
    if (tool === "bash") {
      const result = output as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      return `exit=${result.exitCode ?? "?"}, stdout=${result.stdout?.length ?? 0} chars, stderr=${result.stderr?.length ?? 0} chars`;
    }

    if (tool === "readFile") {
      const result = output as { content?: string; lines?: number };
      if (result.content) {
        return `${result.lines ?? "?"} lines, ${result.content.length} chars`;
      }
      return JSON.stringify(output).slice(0, 200);
    }

    if (tool === "writeFile" || tool === "editFile") {
      return "success";
    }

    if (tool === "fetch") {
      const result = output as {
        status?: number;
        statusText?: string;
        body?: string;
      };
      return `${result.status ?? "?"} ${result.statusText ?? ""}, ${result.body?.length ?? 0} bytes`;
    }

    if (tool === "webSearch" || tool === "newsSearch") {
      const result = output as { results?: unknown[] };
      if (Array.isArray(result.results)) {
        return `${result.results.length} results`;
      }
      return JSON.stringify(output).slice(0, 200);
    }

    if (tool === "browseUrl") {
      const result = output as { url?: string; title?: string };
      return `${result.url ?? "?"} - "${result.title ?? "?"}"`;
    }

    if (tool === "executeCode") {
      const result = output as {
        success?: boolean;
        output?: string;
        error?: string;
      };
      if (result.success) {
        const out = result.output || "";
        return `success: ${out.length > 100 ? `${out.slice(0, 100)}...` : out}`;
      }
      return `error: ${result.error?.slice(0, 200) ?? "unknown"}`;
    }

    // Default: JSON stringify with truncation
    try {
      const json = JSON.stringify(output);
      return json.length > 500 ? `${json.slice(0, 500)}...` : json;
    } catch {
      return "[non-serializable]";
    }
  }

  /**
   * Get action log entries with optional filters
   */
  getActionLog(options?: {
    tool?: string;
    limit?: number;
    since?: number;
  }): ActionLogEntry[] {
    const limit = options?.limit ?? 100;

    let query: string;
    const params: unknown[] = [this.state.sessionId];

    if (options?.tool && options?.since) {
      query = `
        SELECT * FROM action_log 
        WHERE session_id = ? AND tool = ? AND timestamp >= ?
        ORDER BY timestamp DESC LIMIT ?
      `;
      params.push(options.tool, options.since, limit);
    } else if (options?.tool) {
      query = `
        SELECT * FROM action_log 
        WHERE session_id = ? AND tool = ?
        ORDER BY timestamp DESC LIMIT ?
      `;
      params.push(options.tool, limit);
    } else if (options?.since) {
      query = `
        SELECT * FROM action_log 
        WHERE session_id = ? AND timestamp >= ?
        ORDER BY timestamp DESC LIMIT ?
      `;
      params.push(options.since, limit);
    } else {
      query = `
        SELECT * FROM action_log 
        WHERE session_id = ?
        ORDER BY timestamp DESC LIMIT ?
      `;
      params.push(limit);
    }

    // Use raw SQL execution for dynamic queries
    const stmt = this.ctx.storage.sql.exec(query, ...params);
    const rows = [...stmt];

    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      timestamp: row.timestamp as number,
      tool: row.tool as string,
      action: row.action as string,
      input: row.input as string | undefined,
      outputSummary: row.output_summary as string | undefined,
      durationMs: row.duration_ms as number | undefined,
      success: (row.success as number) === 1,
      error: row.error as string | undefined,
      messageId: row.message_id as string | undefined
    }));
  }

  /**
   * Get OpenAI client configured with API key
   */
  private getOpenAI() {
    return createOpenAI({
      apiKey: this.env.OPENAI_API_KEY
    });
  }

  /**
   * Get tool context for the agent
   */
  private getToolContext(): ToolContext {
    const sessionId = this.state.sessionId;

    // Base context without browser
    const context: ToolContext = {
      storage: this.getStorage(),
      bash: this.ctx.exports.BashLoopback({
        props: { sessionId }
      }) as unknown as BashLoopback,
      fetch: this.ctx.exports.FetchLoopback({
        props: { sessionId }
      }) as unknown as FetchLoopback,
      braveSearch: this.ctx.exports.BraveSearchLoopback({
        props: { sessionId, apiKey: this.env.BRAVE_API_KEY }
      }) as unknown as BraveSearchLoopback,
      executeCode: (code, options) => this.executeCode(code, options || {})
    };

    // Add browser if the binding is available
    // Note: BrowserLoopback uses @cloudflare/playwright which requires the browser binding
    // Browser tools will return "not available" error when BROWSER binding doesn't exist
    if ("BROWSER" in this.env && this.env.BROWSER) {
      // Check if BrowserLoopback is available on ctx.exports
      // It may not be in test environments where @cloudflare/playwright can't load
      type ExportsWithBrowser = typeof this.ctx.exports & {
        BrowserLoopback?: (opts: {
          props: { sessionId: string };
        }) => ToolContext["browser"];
      };
      const exports = this.ctx.exports as ExportsWithBrowser;
      if (exports.BrowserLoopback) {
        context.browser = exports.BrowserLoopback({
          props: { sessionId }
        });
      }
    }

    // Add task context if we have a current task
    const taskContext = this.getTaskContext();
    if (taskContext) {
      context.tasks = taskContext;
    }

    // Add subagent context for parallel task delegation
    const subagentContext = this.getSubagentContext();
    if (subagentContext) {
      context.subagents = subagentContext;
    }

    return context;
  }

  /**
   * Handle incoming WebSocket messages from clients
   */
  async onMessage(
    connection: Connection,
    message: string | ArrayBuffer
  ): Promise<void> {
    // Handle binary Yjs updates
    if (message instanceof ArrayBuffer) {
      const update = new Uint8Array(message);
      const storage = this.getStorage();
      const newVersion = storage.updateCode(update);
      this.setState({ ...this.state, codeVersion: newVersion });

      // Broadcast to other clients (exclude sender)
      this.broadcast(message, [connection.id]);
      return;
    }

    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "chat":
          await this.handleChatMessage(connection, data.content);
          break;

        case "execute": {
          // One-off code execution
          const result = await this.executeCode(data.code, {
            modules: data.modules,
            timeoutMs: data.timeoutMs
          });
          connection.send(JSON.stringify({ type: "execution_result", result }));
          break;
        }

        case "read-file": {
          const storage = this.getStorage();
          const content = storage.readFile(data.path);
          connection.send(
            JSON.stringify({
              type: "file-content",
              path: data.path,
              content,
              requestId: data.requestId
            })
          );
          break;
        }

        case "write-file": {
          const storage = this.getStorage();
          const newVersion = storage.writeFile(data.path, data.content);
          this.setState({ ...this.state, codeVersion: newVersion });
          connection.send(
            JSON.stringify({
              type: "file-written",
              path: data.path,
              version: newVersion,
              requestId: data.requestId
            })
          );
          // Broadcast file change to other clients
          this.broadcast(
            JSON.stringify({
              type: "file-changed",
              path: data.path,
              version: newVersion
            }),
            [connection.id]
          );
          break;
        }

        case "list-files": {
          const storage = this.getStorage();
          const files = storage.listFiles();
          connection.send(
            JSON.stringify({
              type: "files-list",
              files,
              requestId: data.requestId
            })
          );
          break;
        }

        case "get-files": {
          const storage = this.getStorage();
          const files = storage.getFiles();
          connection.send(
            JSON.stringify({
              type: "files-content",
              files,
              version: this.state.codeVersion,
              requestId: data.requestId
            })
          );
          break;
        }

        case "cancel":
          // Cancel any ongoing operation
          if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
            console.log("[Think] Cancelled ongoing operation");
          }
          // Reset status to idle
          this.setState({ ...this.state, status: "idle" });
          this.emitDebug({ event: "state:change", status: "idle" });
          // Send cancellation confirmation
          connection.send(thinkMsg({ type: "text_done" }));
          break;

        default:
          console.warn("Unknown message type:", data.type);
      }
    } catch (e) {
      console.error("Failed to handle message:", e);
      connection.send(JSON.stringify({ type: "error", error: String(e) }));
    }
  }

  /**
   * Handle new WebSocket connections
   */
  async onConnect(
    connection: Connection,
    ctx: { request: Request }
  ): Promise<void> {
    // Check if client wants debug events via query param
    const url = new URL(ctx.request.url);
    const wantsDebug = url.searchParams.get("debug") === "1";

    if (wantsDebug) {
      // Store debug flag in connection state (survives hibernation)
      connection.setState({ debug: true });
      console.log("[DEBUG] Connection subscribed to debug events");
      this.emitDebug({ event: "connected", sessionId: this.state.sessionId });
    }

    // Send current state to new connection
    connection.send(
      JSON.stringify({
        type: "state",
        state: this.state
      })
    );

    // TODO: Send full Yjs document state for late-joining clients
    // Currently clients need to fetch files via get-files message
  }

  /**
   * Handle chat messages from the user - runs the LLM agent loop
   */
  private async handleChatMessage(
    connection: Connection,
    content: string
  ): Promise<void> {
    this.emitDebug({
      event: "message:received",
      content: content.slice(0, 100)
    });
    this.setState({ ...this.state, status: "thinking" });
    this.emitDebug({ event: "state:change", status: "thinking" });

    // Create AbortController for this operation
    this.currentAbortController = new AbortController();
    const abortSignal = this.currentAbortController.signal;

    // Track accumulated text/reasoning/toolcalls outside try block so we can save partial responses on cancellation
    let accumulatedText = "";
    let accumulatedReasoning = "";
    const accumulatedToolCalls: Array<{
      id: string;
      name: string;
      input: unknown;
      output?: unknown;
    }> = [];

    try {
      // Load chat history
      this.loadChatHistory();

      // Add user message to history
      const userMessage: ModelMessage = { role: "user", content };
      this.chatHistory.push(userMessage);
      this.saveChatMessage("user", content);

      // Create root task for this message (orchestration-level tracking)
      const rootTask = this.createRootTask(content);

      // Mark root task as in progress
      const startedGraph = startTask(this.taskGraph, rootTask.id);
      if (startedGraph) {
        this.taskGraph = startedGraph;
        this.saveTask(this.taskGraph.tasks.get(rootTask.id)!);
      }

      // Get OpenAI client and tools (now with task context)
      const openai = this.getOpenAI();
      const toolContext = this.getToolContext();
      const tools = createTools(toolContext);

      // Build messages array with system prompt
      const messages: ModelMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...this.chatHistory.slice(-MAX_CONTEXT_MESSAGES)
      ];

      // Run the agent with GPT-5.2 reasoning model using streaming
      const stream = streamText({
        model: openai("gpt-5.2"),
        messages,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_ROUNDS),
        abortSignal,
        providerOptions: {
          openai: {
            // Enable reasoning with medium effort (options: minimal, low, medium, high)
            reasoningEffort: "medium",
            // Get reasoning summaries to see the model's thought process
            reasoningSummary: "auto"
          }
        }
      });

      // Process the stream and send events to client in real-time
      for await (const event of stream.fullStream) {
        switch (event.type) {
          case "reasoning-delta":
            // Stream reasoning as it arrives (GPT-5 reasoning models)
            if (event.text) {
              accumulatedReasoning += event.text;
              connection.send(
                thinkMsg({ type: "reasoning_delta", delta: event.text })
              );
            }
            break;

          case "text-delta":
            // Send text chunks as they arrive for real-time display
            accumulatedText += event.text;
            connection.send(
              thinkMsg({ type: "text_delta", delta: event.text })
            );
            break;

          case "tool-call":
            // Tool call is starting - track for persistence
            accumulatedToolCalls.push({
              id: event.toolCallId,
              name: event.toolName,
              input: event.input
            });
            this.setState({ ...this.state, status: "executing" });
            this.emitDebug({ event: "state:change", status: "executing" });
            this.emitDebug({
              event: "tool:start",
              name: event.toolName,
              callId: event.toolCallId
            });
            connection.send(
              thinkMsg({
                type: "tool_call",
                id: event.toolCallId,
                name: event.toolName,
                input: event.input
              })
            );
            break;

          case "tool-result":
            // Tool has completed - log and send result
            {
              const isError =
                typeof event.output === "object" &&
                event.output !== null &&
                "error" in event.output;
              const inputStr = JSON.stringify(event.input || {});
              const truncatedInput =
                inputStr.length > 1000
                  ? `${inputStr.slice(0, 1000)}...`
                  : inputStr;

              this.logAction({
                sessionId: this.state.sessionId,
                tool: event.toolName,
                action: event.toolName,
                input: truncatedInput,
                outputSummary: this.summarizeOutput(
                  event.toolName,
                  event.toolName,
                  event.output
                ),
                success: !isError,
                error: isError
                  ? String(
                      (event.output as { error?: unknown }).error || "unknown"
                    )
                  : undefined
              });

              // Track output for persistence
              const tc = accumulatedToolCalls.find(
                (t) => t.id === event.toolCallId
              );
              if (tc) tc.output = event.output;

              connection.send(
                thinkMsg({
                  type: "tool_result",
                  callId: event.toolCallId,
                  name: event.toolName,
                  output: event.output
                })
              );

              this.emitDebug({
                event: "tool:end",
                name: event.toolName,
                callId: event.toolCallId,
                durationMs: 0, // TODO: track actual duration
                success: !isError
              });

              this.setState({ ...this.state, status: "thinking" });
              this.emitDebug({ event: "state:change", status: "thinking" });
            }
            break;
        }
      }

      // Send done signal after stream completes
      connection.send(thinkMsg({ type: "text_done" }));

      // Get final result - await the promises
      const finalResponse = accumulatedText || (await stream.text) || "";
      const reasoning = await stream.reasoning;

      // Send final reasoning if we didn't stream it (fallback for some models)
      if (!accumulatedReasoning && reasoning && reasoning.length > 0) {
        const reasoningText = reasoning
          .map((r) => (typeof r === "string" ? r : r.text || ""))
          .filter(Boolean)
          .join("\n\n");
        if (reasoningText) {
          connection.send(
            thinkMsg({ type: "reasoning", content: reasoningText })
          );
        }
      }

      // Compute final reasoning text for storage
      const finalReasoning =
        accumulatedReasoning ||
        (reasoning && reasoning.length > 0
          ? reasoning
              .map((r) => (typeof r === "string" ? r : r.text || ""))
              .filter(Boolean)
              .join("\n\n")
          : "");

      // Save assistant response to history (with tool calls and reasoning)
      if (finalResponse) {
        const assistantMessage: ModelMessage = {
          role: "assistant",
          content: finalResponse
        };
        this.chatHistory.push(assistantMessage);
        this.saveChatMessage("assistant", finalResponse, {
          toolCalls:
            accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
          reasoning: finalReasoning || undefined
        });

        // Send final response to client
        connection.send(
          thinkMsg({
            type: "chat",
            message: {
              role: "assistant",
              content: finalResponse
            }
          })
        );
      }

      // Log usage stats including reasoning tokens
      const usage = await stream.usage;
      const steps = await stream.steps;
      if (usage) {
        const providerMetadata = await stream.providerMetadata;
        const reasoningTokens =
          (providerMetadata as { openai?: { reasoningTokens?: number } })
            ?.openai?.reasoningTokens ?? 0;
        console.log(
          `Agent completed: ${steps.length} steps, ` +
            `${usage.inputTokens ?? 0} input tokens, ` +
            `${usage.outputTokens ?? 0} output tokens` +
            (reasoningTokens > 0 ? `, ${reasoningTokens} reasoning tokens` : "")
        );
      }

      // Complete the root task
      if (this.currentTaskId) {
        const completedGraph = completeTask(
          this.taskGraph,
          this.currentTaskId,
          finalResponse?.slice(0, 200)
        );
        if (completedGraph) {
          this.taskGraph = completedGraph;
          const task = completedGraph.tasks.get(this.currentTaskId);
          if (task) this.saveTask(task);
        }
        this.currentTaskId = null;
      }
    } catch (e) {
      // Check if this was a cancellation
      if (e instanceof Error && e.name === "AbortError") {
        console.log("[Think] Operation was cancelled");
        const stoppedMarker = "\n\n*[Generation stopped]*";
        connection.send(thinkMsg({ type: "text_delta", delta: stoppedMarker }));
        connection.send(thinkMsg({ type: "text_done" }));

        // Save partial response to history so context is preserved
        if (accumulatedText.trim()) {
          const partialResponse = accumulatedText + stoppedMarker;
          const assistantMessage: ModelMessage = {
            role: "assistant",
            content: partialResponse
          };
          this.chatHistory.push(assistantMessage);
          this.saveChatMessage("assistant", partialResponse, {
            toolCalls:
              accumulatedToolCalls.length > 0
                ? accumulatedToolCalls
                : undefined,
            reasoning: accumulatedReasoning || undefined
          });
          console.log(
            "[Think] Saved partial response:",
            partialResponse.slice(0, 100) + "..."
          );
        }
      } else {
        console.error("Agent loop error:", e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        connection.send(
          thinkMsg({ type: "error", error: `Agent error: ${errorMessage}` })
        );
      }
    } finally {
      // Clean up AbortController
      this.currentAbortController = null;
      this.setState({ ...this.state, status: "idle" });
      this.emitDebug({ event: "state:change", status: "idle" });
    }
  }

  /**
   * Execute arbitrary code in an isolated dynamic worker
   *
   * This is the core primitive for code execution. The code runs in a
   * sandboxed isolate with only the bindings we explicitly provide.
   *
   * Features:
   * - Timeout protection (default 30s)
   * - Error categorization (syntax, runtime, timeout)
   * - Console log capture
   *
   * @param code - JavaScript/TypeScript code to execute (must export default function)
   * @param options - Execution options (modules, timeout)
   * @returns ExecutionResult with output, logs, errors
   */
  async executeCode(
    code: string,
    options: {
      modules?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

    try {
      this.setState({ ...this.state, status: "executing" });

      // Generate unique ID for this execution
      const executionId = crypto.randomUUID();

      // Build the harness that wraps user code
      const harnessModule = this.buildHarnessModule();

      // Get the dynamic worker
      const worker = this.env.LOADER.get(executionId, () => ({
        compatibilityDate: "2025-11-01",
        compatibilityFlags: ["disallow_importable_env"],
        mainModule: "harness.js",
        modules: {
          "harness.js": harnessModule,
          "agent.js": code,
          ...(options.modules || {})
        },
        // Pass loopback bindings - tools the code can use
        env: this.getEnvForLoader(),
        // Block direct network access
        globalOutbound: null
      }));

      // Get the entrypoint
      const entrypoint = worker.getEntrypoint<CodeExecutionEntrypoint>();

      // Verify it loaded correctly (catches syntax errors early)
      try {
        await entrypoint.verify();
      } catch (verifyError) {
        return {
          success: false,
          error: this.formatError(verifyError),
          errorType: "syntax",
          logs,
          duration: Date.now() - startTime
        };
      }

      // Run with timeout protection
      const result = await this.withTimeout(
        entrypoint.run() as Promise<{ output: unknown; logs: string[] }>,
        timeoutMs,
        `Execution timed out after ${timeoutMs}ms`
      );

      return {
        success: true,
        output:
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output),
        logs: result.logs || logs,
        duration: Date.now() - startTime
      };
    } catch (e) {
      const { message, errorType } = this.categorizeError(e);
      return {
        success: false,
        error: message,
        errorType,
        logs,
        duration: Date.now() - startTime
      };
    } finally {
      this.setState({ ...this.state, status: "idle" });
      this.emitDebug({ event: "state:change", status: "idle" });
    }
  }

  /**
   * Run a promise with a timeout
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TimeoutError(timeoutMessage));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Format an error for display
   */
  private formatError(e: unknown): string {
    if (e instanceof Error) {
      let message = e.message;
      // Remove "Failed to start Worker:" prefix for cleaner display
      if (message.startsWith("Failed to start Worker:")) {
        message = message.replace("Failed to start Worker:", "").trim();
      }
      return message;
    }
    return String(e);
  }

  /**
   * Categorize an error by type for better error handling
   */
  private categorizeError(e: unknown): {
    message: string;
    errorType: "syntax" | "runtime" | "timeout" | "unknown";
  } {
    const message = this.formatError(e);

    if (e instanceof TimeoutError) {
      return { message, errorType: "timeout" };
    }

    // Syntax errors
    if (
      message.includes("SyntaxError") ||
      message.includes("Unexpected token") ||
      message.includes("Unexpected identifier")
    ) {
      return { message, errorType: "syntax" };
    }

    // Runtime errors
    if (
      message.includes("TypeError") ||
      message.includes("ReferenceError") ||
      message.includes("RangeError") ||
      message.includes("is not defined") ||
      message.includes("is not a function") ||
      message.includes("Cannot read properties of") ||
      message.includes("Cannot set properties of") ||
      message.includes("is not iterable")
    ) {
      return { message, errorType: "runtime" };
    }

    return { message, errorType: "unknown" };
  }

  /**
   * Build the harness module that wraps and executes user code
   *
   * The harness:
   * - Captures console.log calls
   * - Runs the user's code (default export function)
   * - Returns results in a structured format
   */
  private buildHarnessModule(): string {
    return `
import { WorkerEntrypoint } from "cloudflare:workers";
import agent from "agent.js";

// Capture logs
const logs = [];
const originalLog = console.log;
console.log = (...args) => {
  logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
  originalLog(...args);
};

export default class extends WorkerEntrypoint {
  verify() {
    // Called first to ensure the worker loaded correctly
    // If there are syntax errors, they'll surface here
  }

  async run() {
    try {
      let output;
      if (typeof agent === 'function') {
        output = await agent(this.env);
      } else if (agent && typeof agent.default === 'function') {
        output = await agent.default(this.env);
      } else {
        output = agent;
      }
      return { output, logs };
    } catch (e) {
      throw e;
    }
  }
}
`;
  }

  /**
   * Build environment bindings for the dynamic worker
   *
   * These are the "tools" available to code running in the isolate.
   * Each binding is a loopback to this parent Agent via ctx.exports.
   */
  private getEnvForLoader(): Record<string, unknown> {
    const sessionId = this.state.sessionId;

    return {
      // Echo loopback for testing
      ECHO: this.ctx.exports.EchoLoopback({ props: { sessionId } }),

      // Bash command execution
      BASH: this.ctx.exports.BashLoopback({ props: { sessionId } }),

      // File system operations (in-memory scratch space)
      FS: this.ctx.exports.FSLoopback({ props: { sessionId } }),

      // Controlled HTTP fetch with allowlist
      FETCH: this.ctx.exports.FetchLoopback({ props: { sessionId } })
    };
  }

  /**
   * Handle HTTP requests to the Agent
   * The pathname is the full path, e.g., /agents/think/room/state
   * We extract the sub-path after the room identifier
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract the sub-path after /agents/{agent}/{room}
    // pathname: /agents/think/test/state → subPath: /state
    const pathParts = url.pathname.split("/");
    const subPath = `/${pathParts.slice(4).join("/")}`;

    // API endpoints
    if (subPath === "/execute" && request.method === "POST") {
      const { code, modules, timeoutMs } = (await request.json()) as {
        code: string;
        modules?: Record<string, string>;
        timeoutMs?: number;
      };
      const result = await this.executeCode(code, { modules, timeoutMs });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath === "/state" || subPath === "/") {
      return new Response(JSON.stringify(this.state), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // ==========================================================================
    // Debug: Test facet storage sharing
    // This endpoint tests whether facets share SQLite storage with the parent
    // ==========================================================================
    if (subPath === "/debug/storage-test" && request.method === "POST") {
      const testId = `storage-test-${Date.now()}`;
      const testKey = `test_key_${testId}`;
      const testValue = `parent_wrote_${testId}`;

      // Step 1: Create the test table and write a value from the parent
      try {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS storage_test (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO storage_test (key, value) VALUES (?, ?)",
          testKey,
          testValue
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Failed to write from parent",
            details: error instanceof Error ? error.message : String(error)
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      // Step 2: Create a StorageTestFacet and have it read the value
      let facetReadResult: {
        found: boolean;
        value: string | null;
        error?: string;
      };
      let facetWriteResult: { success: boolean; error?: string };
      let facetTables: { tables: string[]; error?: string };
      let facetError: string | null = null;

      try {
        type ExportsWithStorageTest = typeof this.ctx.exports & {
          StorageTestFacet: (opts: { props: { testId: string } }) => {
            readTestValue: (key: string) => {
              found: boolean;
              value: string | null;
              error?: string;
            };
            writeTestValue: (
              key: string,
              value: string
            ) => { success: boolean; error?: string };
            listTables: () => { tables: string[]; error?: string };
          };
        };
        const exports = this.ctx.exports as ExportsWithStorageTest;

        const facet = this.ctx.facets.get(`storage-test-${testId}`, () => ({
          class: exports.StorageTestFacet({ props: { testId } })
        }));

        // Have the facet list tables it can see
        facetTables = facet.listTables();

        // Have the facet try to read the value the parent wrote
        facetReadResult = facet.readTestValue(testKey);

        // Have the facet write a value
        const facetWriteKey = `facet_key_${testId}`;
        const facetWriteValue = `facet_wrote_${testId}`;
        facetWriteResult = facet.writeTestValue(facetWriteKey, facetWriteValue);

        // Clean up the facet
        this.ctx.facets.delete(`storage-test-${testId}`);

        // Step 3: Try to read the facet's written value from parent
        let parentReadFacetValue: string | null = null;
        try {
          const rows = this.ctx.storage.sql
            .exec("SELECT value FROM storage_test WHERE key = ?", facetWriteKey)
            .toArray();
          if (rows.length > 0) {
            parentReadFacetValue = (rows[0] as { value: string }).value;
          }
        } catch {
          // Ignore - just for additional verification
        }

        // Determine if storage is shared
        const storageIsShared =
          facetReadResult.found &&
          facetReadResult.value === testValue &&
          facetWriteResult.success &&
          parentReadFacetValue === facetWriteValue;

        return new Response(
          JSON.stringify({
            success: true,
            storageIsShared,
            testId,
            parentWrite: { key: testKey, value: testValue },
            facetRead: facetReadResult,
            facetWrite: facetWriteResult,
            parentReadFacetValue,
            facetVisibleTables: facetTables.tables,
            conclusion: storageIsShared
              ? "CONFIRMED: Facets share SQLite storage with parent"
              : "ISOLATED: Facets have separate storage from parent"
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        facetError = error instanceof Error ? error.message : String(error);
        return new Response(
          JSON.stringify({
            success: false,
            error: "Facet operation failed",
            facetError,
            testId,
            parentWrite: { key: testKey, value: testValue }
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ==========================================================================
    // Debug: Test facet static variable sharing
    // This endpoint tests whether facets share static variables with the parent
    // ==========================================================================
    if (subPath === "/debug/static-test" && request.method === "POST") {
      const testId = `static-test-${Date.now()}`;
      const testKey = `parent_key_${testId}`;
      const testValue = `parent_value_${testId}`;

      // Step 1: Set a value in the static Map from the parent
      registerStaticTestValue(testKey, testValue);

      // Verify parent can read it back
      const parentReadBack = getStaticTestValue(testKey);

      // Step 2: Create a StaticTestFacet and have it check the value
      let facetResult: {
        keyChecked: string;
        found: boolean;
        value: string | null;
        mapSize: number;
        allKeys: string[];
      };
      let facetError: string | null = null;

      try {
        type ExportsWithStaticTest = typeof this.ctx.exports & {
          StaticTestFacet: (opts: {
            props: { testId: string; keyToCheck: string };
          }) => {
            checkStaticValue: () => {
              keyChecked: string;
              found: boolean;
              value: string | null;
              mapSize: number;
              allKeys: string[];
            };
            setStaticValue: (key: string, value: string) => void;
          };
        };
        const exports = this.ctx.exports as ExportsWithStaticTest;

        const facet = this.ctx.facets.get(`static-test-${testId}`, () => ({
          class: exports.StaticTestFacet({
            props: { testId, keyToCheck: testKey }
          })
        }));

        // Have the facet check if it can see the parent's static value
        facetResult = facet.checkStaticValue();

        // Have the facet set a value too
        const facetSetKey = `facet_key_${testId}`;
        const facetSetValue = `facet_value_${testId}`;
        facet.setStaticValue(facetSetKey, facetSetValue);

        // Check if parent can see the facet's value
        const parentReadFacetValue = getStaticTestValue(facetSetKey);

        // Clean up
        this.ctx.facets.delete(`static-test-${testId}`);
        STATIC_TEST_MAP.delete(testKey);
        STATIC_TEST_MAP.delete(facetSetKey);

        // Determine if static variables are shared
        const staticIsShared =
          facetResult.found &&
          facetResult.value === testValue &&
          parentReadFacetValue === facetSetValue;

        return new Response(
          JSON.stringify({
            success: true,
            staticIsShared,
            testId,
            parentWrite: { key: testKey, value: testValue },
            parentReadBack,
            facetResult,
            parentReadFacetValue,
            conclusion: staticIsShared
              ? "CONFIRMED: Facets share static variables with parent (same isolate)"
              : "ISOLATED: Facets have separate static variables (different isolate)"
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        facetError = error instanceof Error ? error.message : String(error);
        // Clean up on error
        STATIC_TEST_MAP.delete(testKey);
        return new Response(
          JSON.stringify({
            success: false,
            error: "Facet operation failed",
            facetError,
            testId,
            parentWrite: { key: testKey, value: testValue }
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ==========================================================================
    // Debug: Test facet RPC back to parent
    // This endpoint tests whether facets can make RPC calls back to the parent
    // ==========================================================================
    if (subPath === "/debug/rpc-test" && request.method === "POST") {
      const testId = `rpc-test-${Date.now()}`;

      // The parent's DO ID - facets need this to call back
      const parentDOId = this.ctx.id.toString();

      let exportsCheck: {
        hasExports: boolean;
        exportKeys: string[];
        hasThink: boolean;
        error?: string;
      };
      let filesCheck: {
        success: boolean;
        files?: string[];
        error?: string;
      };
      let rpcCheck: {
        success: boolean;
        result?: unknown;
        error?: string;
      };
      let facetError: string | null = null;

      try {
        type ExportsWithRpcTest = typeof this.ctx.exports & {
          RpcTestFacet: (opts: {
            props: { testId: string; parentDOId: string };
          }) => {
            checkExportsAvailable: () => {
              hasExports: boolean;
              exportKeys: string[];
              hasThink: boolean;
              error?: string;
            };
            callParentFiles: () => Promise<{
              success: boolean;
              files?: string[];
              error?: string;
            }>;
            testDirectRpc: () => Promise<{
              success: boolean;
              result?: unknown;
              error?: string;
            }>;
          };
        };
        const exports = this.ctx.exports as ExportsWithRpcTest;

        const facet = this.ctx.facets.get(`rpc-test-${testId}`, () => ({
          class: exports.RpcTestFacet({
            props: { testId, parentDOId }
          })
        }));

        // Check if exports are available in the facet
        exportsCheck = facet.checkExportsAvailable();

        // Try to call the parent's /files endpoint via RPC
        filesCheck = await facet.callParentFiles();

        // Try a direct RPC call
        rpcCheck = await facet.testDirectRpc();

        // Clean up
        this.ctx.facets.delete(`rpc-test-${testId}`);

        // Determine if RPC works
        const rpcWorks = filesCheck.success || rpcCheck.success;

        return new Response(
          JSON.stringify({
            success: true,
            rpcWorks,
            testId,
            parentDOId,
            exportsCheck,
            filesCheck,
            rpcCheck,
            conclusion: rpcWorks
              ? "CONFIRMED: Facets can make RPC calls back to parent"
              : "FAILED: Facets cannot make RPC calls to parent"
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (error) {
        facetError = error instanceof Error ? error.message : String(error);
        return new Response(
          JSON.stringify({
            success: false,
            error: "Facet operation failed",
            facetError,
            testId,
            parentDOId
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ==========================================================================
    // RPC Endpoints for Subagent Access
    // These endpoints allow subagent facets to call back to the parent for
    // bash, fetch, and search operations.
    // ==========================================================================

    if (subPath === "/rpc/bash" && request.method === "POST") {
      const { command, options } = (await request.json()) as {
        command: string;
        options?: { cwd?: string; env?: Record<string, string> };
      };

      const sessionId = this.state.sessionId;
      const bashLoopback = this.ctx.exports.BashLoopback({
        props: { sessionId }
      }) as { exec: (cmd: string, opts?: unknown) => Promise<unknown> };

      const result = await bashLoopback.exec(command, options);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath === "/rpc/fetch" && request.method === "POST") {
      const { url, method, headers, body } = (await request.json()) as {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      };

      const sessionId = this.state.sessionId;
      const fetchLoopback = this.ctx.exports.FetchLoopback({
        props: { sessionId }
      }) as { request: (url: string, opts?: unknown) => Promise<unknown> };

      const result = await fetchLoopback.request(url, {
        method,
        headers,
        body
      });
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath === "/rpc/search" && request.method === "POST") {
      const { query } = (await request.json()) as { query: string };

      const sessionId = this.state.sessionId;
      const searchLoopback = this.ctx.exports.BraveSearchLoopback({
        props: { sessionId, apiKey: this.env.BRAVE_API_KEY }
      }) as { search: (q: string) => Promise<unknown> };

      const result = await searchLoopback.search(query);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Chat endpoint for HTTP-based chat (useful for testing)
    if (subPath === "/chat" && request.method === "POST") {
      const { message } = (await request.json()) as { message: string };

      // Create a simple response collector
      const responses: unknown[] = [];
      const mockConnection = {
        id: `http-${crypto.randomUUID()}`,
        send: (data: string) => {
          responses.push(JSON.parse(data));
        }
      } as Connection;

      await this.handleChatMessage(mockConnection, message);

      return new Response(JSON.stringify({ responses }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get chat history (with tool calls and reasoning for client display)
    if (subPath === "/chat/history" && request.method === "GET") {
      const messages = this.getChatHistoryForClient();
      return new Response(
        JSON.stringify({
          messages,
          sessionId: this.state.sessionId
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Clear chat history
    if (subPath === "/chat/clear" && request.method === "POST") {
      this
        .sql`DELETE FROM chat_messages WHERE session_id = ${this.state.sessionId}`;
      this.chatHistory = [];
      return new Response(
        JSON.stringify({ success: true, sessionId: this.state.sessionId }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Truncate chat history (for editing previous messages)
    if (subPath === "/chat/truncate" && request.method === "POST") {
      const body = (await request.json()) as { keepUserMessages: number };
      const keepUserMessages = body.keepUserMessages ?? 0;

      // Load current history
      this.loadChatHistory();

      // Find the cutoff point - count user messages
      let userCount = 0;
      let cutoffIndex = 0;
      for (let i = 0; i < this.chatHistory.length; i++) {
        if (this.chatHistory[i].role === "user") {
          if (userCount >= keepUserMessages) {
            cutoffIndex = i;
            break;
          }
          userCount++;
        }
        cutoffIndex = i + 1;
      }

      // Truncate in-memory history
      const removedCount = this.chatHistory.length - cutoffIndex;
      this.chatHistory = this.chatHistory.slice(0, cutoffIndex);

      // Delete messages from database after the cutoff
      // Get message IDs to delete
      const allMessages = this.sql`
        SELECT id, created_at FROM chat_messages 
        WHERE session_id = ${this.state.sessionId} 
        ORDER BY created_at ASC
      ` as { id: number; created_at: string }[];

      if (allMessages.length > cutoffIndex) {
        const idsToDelete = allMessages.slice(cutoffIndex).map((m) => m.id);
        for (const id of idsToDelete) {
          this.sql`DELETE FROM chat_messages WHERE id = ${id}`;
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          removedCount,
          remainingMessages: this.chatHistory.length
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Get action log
    if (subPath === "/actions" && request.method === "GET") {
      const tool = url.searchParams.get("tool") || undefined;
      const limit = url.searchParams.get("limit")
        ? Number.parseInt(url.searchParams.get("limit") as string, 10)
        : undefined;
      const since = url.searchParams.get("since")
        ? Number.parseInt(url.searchParams.get("since") as string, 10)
        : undefined;

      const actions = this.getActionLog({ tool, limit, since });
      return new Response(
        JSON.stringify({
          actions,
          sessionId: this.state.sessionId,
          count: actions.length
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Clear action log
    if (subPath === "/actions/clear" && request.method === "POST") {
      this
        .sql`DELETE FROM action_log WHERE session_id = ${this.state.sessionId}`;
      return new Response(
        JSON.stringify({ success: true, sessionId: this.state.sessionId }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // File operations
    if (subPath === "/files" && request.method === "GET") {
      const storage = this.getStorage();
      const files = storage.getFiles();
      return new Response(
        JSON.stringify({ files, version: this.state.codeVersion }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (subPath.startsWith("/file/") && request.method === "GET") {
      const path = decodeURIComponent(subPath.slice(6));
      const storage = this.getStorage();
      const content = storage.readFile(path);
      if (content === null) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ path, content }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath.startsWith("/file/") && request.method === "PUT") {
      const path = decodeURIComponent(subPath.slice(6));
      const { content } = (await request.json()) as { content: string };
      const storage = this.getStorage();
      const newVersion = storage.writeFile(path, content);
      this.setState({ ...this.state, codeVersion: newVersion });
      return new Response(JSON.stringify({ path, version: newVersion }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (subPath.startsWith("/file/") && request.method === "DELETE") {
      const path = decodeURIComponent(subPath.slice(6));
      const storage = this.getStorage();
      const newVersion = storage.deleteFile(path);
      if (newVersion === null) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      this.setState({ ...this.state, codeVersion: newVersion });
      return new Response(
        JSON.stringify({ deleted: path, version: newVersion }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // ==========================================================================
    // Subagent Test Endpoints (for integration testing)
    // Guarded by ENABLE_SUBAGENT_API flag - experimental feature
    // Pass --var ENABLE_SUBAGENT_API=true to wrangler dev to enable
    // ==========================================================================

    if (isSubagentApiEnabled(this.env)) {
      // Get subagent status
      if (subPath === "/subagents" && request.method === "GET") {
        const manager = this.getSubagentManager();
        const statuses = await manager.getAllStatuses();
        return new Response(
          JSON.stringify({
            activeCount: manager.activeCount,
            statuses
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      // Spawn a test subagent (creates task + spawns facet)
      if (subPath === "/subagents/spawn" && request.method === "POST") {
        const { title, description, context } = (await request.json()) as {
          title: string;
          description: string;
          context?: string;
        };

        // Create a task for the subagent
        const task = createTask({
          type: "code",
          title,
          description
        });
        const result = addTask(this.taskGraph, task);
        if ("type" in result && typeof result.type === "string") {
          return new Response(
            JSON.stringify({ error: "Failed to create task", details: result }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        this.taskGraph = result as TaskGraph;
        this.saveTask(task);

        // Spawn the subagent
        try {
          const manager = this.getSubagentManager();
          const facetName = await manager.spawnSubagent(task, context);

          // Schedule a status check to monitor the subagent
          await this.scheduleSubagentCheck(task.id);

          return new Response(
            JSON.stringify({
              success: true,
              taskId: task.id,
              facetName,
              activeCount: manager.activeCount
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        } catch (error) {
          return new Response(
            JSON.stringify({
              error: "Failed to spawn subagent",
              details: error instanceof Error ? error.message : String(error)
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // Get status of a specific subagent
      if (subPath.startsWith("/subagents/") && request.method === "GET") {
        const taskId = subPath.slice("/subagents/".length);
        const manager = this.getSubagentManager();
        const status = await manager.getSubagentStatus(taskId);
        if (!status) {
          return new Response(JSON.stringify({ error: "Subagent not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify(status), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Get tasks (useful for debugging, not just subagents)
    if (subPath === "/tasks" && request.method === "GET") {
      this.loadTaskGraph();
      const tasks = Array.from(this.taskGraph.tasks.values());
      return new Response(
        JSON.stringify({
          tasks,
          rootTasks: Array.from(this.taskGraph.rootTasks)
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  }
}

/**
 * Main Worker entry point
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    // Route to Agent using the SDK's router
    // This handles WebSocket upgrades, connection management, etc.
    const agentResponse = await routeAgentRequest(request, env, {
      cors: true
    });

    if (agentResponse) {
      return agentResponse;
    }

    // Default: serve static files (TODO: Vite integration)
    return env.ASSETS.fetch(request);
  }
};
