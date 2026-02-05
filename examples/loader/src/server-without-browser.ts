import { Agent, type Connection, routeAgentRequest } from "agents";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { YjsStorage, type SqlFunction } from "./yjs-storage";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import {
  createTools,
  SYSTEM_PROMPT,
  type ToolContext,
  type TaskContext,
  type SubagentContext,
  type SubagentResult
} from "./agent-tools";
import { SubagentManager, type SubagentEnv } from "./subagent";
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
// Note: BrowserLoopback type is defined in agent-tools.ts as BrowserLoopbackInterface
// to avoid importing @cloudflare/playwright which fails in test environments

// Re-export loopback classes so they're available via ctx.exports
// Note: BrowserLoopback is NOT exported here - it's added in server-with-browser.ts
// to avoid bundling @cloudflare/playwright in tests (requires node:child_process)
export { BashLoopback } from "./loopbacks/bash";
export { BraveSearchLoopback } from "./loopbacks/brave-search";
export { EchoLoopback } from "./loopbacks/echo";
export { FetchLoopback } from "./loopbacks/fetch";
export { FSLoopback } from "./loopbacks/fs";

// Re-export Subagent for facet-based parallel execution
export { Subagent } from "./subagent";

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
export interface CoderState {
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
 * The main Coder Agent - orchestrates dynamic code execution
 *
 * Architecture:
 * - This Agent (Durable Object) is the persistent "brain"
 * - Dynamic workers loaded via LOADER are the ephemeral "hands"
 * - Yjs document stores the code with full version history
 * - Loopback bindings provide tools to dynamic workers
 */
export class Coder extends Agent<Env, CoderState> {
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

  /**
   * Initial state for the Agent - provides defaults before any state is set
   */
  initialState: CoderState = {
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
        timestamp INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_chat_session 
      ON chat_messages(session_id, timestamp)
    `;

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
        ? messageContent.slice(0, 47) + "..."
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
    const self = this;

    return {
      currentTaskId,

      getTaskGraph: () => self.taskGraph,

      createSubtask: (input) => {
        const task = createTask({
          type: input.type,
          title: input.title,
          description: input.description,
          dependencies: input.dependencies,
          parentId: currentTaskId
        });

        const result = addTask(self.taskGraph, task);
        if ("type" in result && typeof result.type === "string") {
          return { error: (result as TaskValidationError).message };
        }

        self.taskGraph = result as TaskGraph;
        self.saveTask(task);

        return task;
      },

      completeTask: (taskId: string, result?: string) => {
        const updated = completeTask(self.taskGraph, taskId, result);
        if (!updated) return false;

        self.taskGraph = updated;

        // Save the updated task
        const task = updated.tasks.get(taskId);
        if (task) self.saveTask(task);

        // Also save any tasks that became unblocked
        for (const t of updated.tasks.values()) {
          if (t.id !== taskId) {
            const original = self.taskGraph.tasks.get(t.id);
            if (original && original.status !== t.status) {
              self.saveTask(t);
            }
          }
        }

        return true;
      },

      getReadyTasks: () => getReadyTasks(self.taskGraph),

      getProgress: () => {
        if (currentTaskId) {
          return getSubtreeProgress(self.taskGraph, currentTaskId);
        }
        return getProgress(self.taskGraph);
      },

      getTaskTree: () => getTaskTree(self.taskGraph)
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
      SELECT role, content, tool_calls 
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
   * Save a message to chat history
   */
  private saveChatMessage(
    role: "user" | "assistant" | "system",
    content: string,
    toolCalls?: unknown
  ): void {
    const toolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null;
    this.sql`
      INSERT INTO chat_messages (session_id, role, content, tool_calls, timestamp)
      VALUES (${this.state.sessionId}, ${role}, ${content}, ${toolCallsJson}, ${Date.now()})
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
        return `success: ${out.length > 100 ? out.slice(0, 100) + "..." : out}`;
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
  async onConnect(connection: Connection): Promise<void> {
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
    this.setState({ ...this.state, status: "thinking" });

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

      // Run the agent with GPT-5.2 reasoning model (faster + smarter than gpt-5)
      const result = await generateText({
        model: openai("gpt-5.2"),
        messages,
        tools,
        stopWhen: stepCountIs(MAX_TOOL_ROUNDS),
        providerOptions: {
          openai: {
            // Enable reasoning with medium effort (options: minimal, low, medium, high)
            reasoningEffort: "medium",
            // Get reasoning summaries to see the model's thought process
            reasoningSummary: "auto"
          }
        },
        onStepFinish: async (step) => {
          // Report each step's tool calls and results to the client
          if (step.toolCalls && step.toolCalls.length > 0) {
            this.setState({ ...this.state, status: "executing" });

            // Send tool calls
            connection.send(
              JSON.stringify({
                type: "tool_calls",
                calls: step.toolCalls.map((tc) => ({
                  id: tc.toolCallId,
                  name: tc.toolName,
                  input: tc.input
                }))
              })
            );

            // Send tool results and log actions
            if (step.toolResults) {
              for (const tr of step.toolResults) {
                // Log the action to the action_log
                const isError =
                  typeof tr.output === "object" &&
                  tr.output !== null &&
                  "error" in tr.output;
                const inputStr = JSON.stringify(tr.input || {});
                const truncatedInput =
                  inputStr.length > 1000
                    ? `${inputStr.slice(0, 1000)}...`
                    : inputStr;

                this.logAction({
                  sessionId: this.state.sessionId,
                  tool: tr.toolName,
                  action: tr.toolName, // For now, tool name is the action
                  input: truncatedInput,
                  outputSummary: this.summarizeOutput(
                    tr.toolName,
                    tr.toolName,
                    tr.output
                  ),
                  success: !isError,
                  error: isError
                    ? String(
                        (tr.output as { error?: unknown }).error || "unknown"
                      )
                    : undefined
                });

                connection.send(
                  JSON.stringify({
                    type: "tool_result",
                    callId: tr.toolCallId,
                    name: tr.toolName,
                    output: tr.output
                  })
                );
              }
            }

            this.setState({ ...this.state, status: "thinking" });
          }
        }
      });

      // Get final response text and reasoning
      const finalResponse = result.text || "";
      const reasoning = result.reasoning;

      // Send reasoning summary if available (GPT-5 reasoning models)
      if (reasoning) {
        connection.send(
          JSON.stringify({
            type: "reasoning",
            content: reasoning
          })
        );
      }

      // Save assistant response to history
      if (finalResponse) {
        const assistantMessage: ModelMessage = {
          role: "assistant",
          content: finalResponse
        };
        this.chatHistory.push(assistantMessage);
        this.saveChatMessage("assistant", finalResponse);

        // Send final response to client
        connection.send(
          JSON.stringify({
            type: "chat",
            message: {
              role: "assistant",
              content: finalResponse
            }
          })
        );
      }

      // Log usage stats including reasoning tokens
      if (result.usage) {
        const reasoningTokens =
          (result.providerMetadata as { openai?: { reasoningTokens?: number } })
            ?.openai?.reasoningTokens ?? 0;
        console.log(
          `Agent completed: ${result.steps.length} steps, ` +
            `${result.usage.inputTokens ?? 0} input tokens, ` +
            `${result.usage.outputTokens ?? 0} output tokens` +
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
      console.error("Agent loop error:", e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      connection.send(
        JSON.stringify({
          type: "error",
          error: `Agent error: ${errorMessage}`
        })
      );
    } finally {
      this.setState({ ...this.state, status: "idle" });
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
   * The pathname is the full path, e.g., /agents/coder/room/state
   * We extract the sub-path after the room identifier
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract the sub-path after /agents/{agent}/{room}
    // pathname: /agents/coder/test/state → subPath: /state
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

    // Chat endpoint for HTTP-based chat (useful for testing)
    if (subPath === "/chat" && request.method === "POST") {
      const { message } = (await request.json()) as { message: string };

      // Create a simple response collector
      const responses: unknown[] = [];
      const mockConnection = {
        id: "http-" + crypto.randomUUID(),
        send: (data: string) => {
          responses.push(JSON.parse(data));
        }
      } as Connection;

      await this.handleChatMessage(mockConnection, message);

      return new Response(JSON.stringify({ responses }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get chat history
    if (subPath === "/chat/history" && request.method === "GET") {
      this.loadChatHistory();
      return new Response(
        JSON.stringify({
          messages: this.chatHistory,
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
    return new Response("Cloud-Native Coding Agent Runtime", {
      headers: { "Content-Type": "text/plain" }
    });
  }
};
