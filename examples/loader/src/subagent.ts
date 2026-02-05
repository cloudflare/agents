/**
 * Subagent Module
 *
 * Implements parallel task execution using Durable Object Facets.
 * Each subagent runs as a facet of the parent Coder DO, sharing SQLite
 * storage but with independent execution.
 *
 * Key features:
 * - Parallel execution of subtasks
 * - Shared task graph and Yjs document
 * - Context isolation (each subagent has focused system prompt)
 * - Automatic completion reporting
 */

import { DurableObject } from "cloudflare:workers";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createTools, type ToolContext } from "./agent-tools";
import { YjsStorage, type SqlFunction } from "./yjs-storage";
import type { BashLoopback } from "./loopbacks/bash";
import type { FetchLoopback } from "./loopbacks/fetch";
import type { BraveSearchLoopback } from "./loopbacks/brave-search";
import {
  type Task,
  type TaskGraph,
  startTask,
  completeTask,
  failTask,
  deserializeGraph,
  rowToTask,
  taskToRow
} from "./tasks";

// ============================================================================
// Types
// ============================================================================

export interface SubagentEnv {
  OPENAI_API_KEY: string;
  BRAVE_API_KEY?: string;
  // biome-ignore lint/suspicious/noExplicitAny: LOADER type is complex and varies
  LOADER: any;
}

export interface SubagentResult {
  taskId: string;
  success: boolean;
  result?: string;
  error?: string;
  duration: number;
}

export interface SubagentStatus {
  taskId: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

// ============================================================================
// Facets Type Declaration
// ============================================================================

declare global {
  interface DurableObjectState {
    facets: DurableObjectFacets;
  }
}

interface DurableObjectFacets {
  // biome-ignore lint/suspicious/noExplicitAny: Facets API allows various DO types
  get<T = any>(
    name: string,
    getStartupOptions: () => FacetStartupOptions | Promise<FacetStartupOptions>
  ): Fetcher & T;
  abort(name: string, reason: unknown): void;
  delete(name: string): void;
}

interface FacetStartupOptions {
  id?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Facets API accepts various class types
  class: new (state: DurableObjectState, env: any) => any;
}

type Fetcher = {
  fetch(request: Request): Promise<Response>;
};

// ============================================================================
// Subagent Class
// ============================================================================

/**
 * Subagent runs as a facet, executing a single focused task.
 * Shares SQLite with parent but has isolated LLM context.
 */
export class Subagent extends DurableObject<SubagentEnv> {
  private taskId: string | null = null;
  private status: SubagentStatus | null = null;

  constructor(
    private state: DurableObjectState,
    env: SubagentEnv
  ) {
    super(state, env);
  }

  /**
   * Execute a task with a focused agent loop
   */
  async execute(params: {
    taskId: string;
    title: string;
    description: string;
    context?: string;
    parentSessionId: string;
  }): Promise<SubagentResult> {
    const startTime = Date.now();
    this.taskId = params.taskId;

    this.status = {
      taskId: params.taskId,
      status: "running",
      startedAt: startTime
    };

    try {
      // Load task graph from shared SQLite
      const taskGraph = this.loadTaskGraph();

      // Mark task as in progress
      const started = startTask(
        taskGraph,
        params.taskId,
        `subagent-${params.taskId}`
      );
      if (started) {
        this.saveTaskGraph(started);
      }

      // Build focused system prompt
      const systemPrompt = this.buildFocusedPrompt(params);

      // Get tool context (shared storage, loopbacks)
      const toolContext = this.getToolContext(params.parentSessionId);
      const tools = createTools(toolContext);

      // Run focused agent loop
      const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
      const messages: ModelMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.description }
      ];

      const result = await generateText({
        model: openai("gpt-4o"),
        messages,
        tools,
        stopWhen: stepCountIs(15), // Limit steps for focused work
        providerOptions: {
          openai: {
            reasoningEffort: "low" // Fast for focused tasks
          }
        }
      });

      const finalResult = result.text || "Task completed";

      // Mark task complete
      const completed = completeTask(
        this.loadTaskGraph(),
        params.taskId,
        finalResult.slice(0, 500)
      );
      if (completed) {
        this.saveTaskGraph(completed);
      }

      this.status = {
        taskId: params.taskId,
        status: "complete",
        startedAt: startTime,
        completedAt: Date.now(),
        result: finalResult
      };

      return {
        taskId: params.taskId,
        success: true,
        result: finalResult,
        duration: Date.now() - startTime
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Mark task failed
      const failed = failTask(
        this.loadTaskGraph(),
        params.taskId,
        errorMessage
      );
      if (failed) {
        this.saveTaskGraph(failed);
      }

      this.status = {
        taskId: params.taskId,
        status: "failed",
        startedAt: startTime,
        completedAt: Date.now(),
        error: errorMessage
      };

      return {
        taskId: params.taskId,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Get current status
   */
  getStatus(): SubagentStatus | null {
    return this.status;
  }

  /**
   * Build a focused system prompt for the subtask
   */
  private buildFocusedPrompt(params: {
    title: string;
    description: string;
    context?: string;
  }): string {
    return `You are a focused coding assistant working on a specific subtask.

## Your Task
**${params.title}**

${params.description}

${params.context ? `## Context\n${params.context}` : ""}

## Guidelines
1. Focus ONLY on this specific task - don't get distracted by other work
2. Be efficient - complete the task in as few steps as possible
3. When done, summarize what you accomplished
4. If you encounter blockers, report them clearly

## Available Tools
- readFile, writeFile, editFile, listFiles - File operations
- bash - Shell commands
- fetch - HTTP requests
- webSearch - Search documentation
- executeCode - Run JavaScript for calculations

Complete this task and return a summary of what was done.`;
  }

  /**
   * Load task graph from shared SQLite
   */
  private loadTaskGraph(): TaskGraph {
    const sql = this.state.storage.sql;
    const rows = sql.exec("SELECT * FROM tasks").toArray();

    if (rows.length === 0) {
      return { tasks: new Map(), rootTasks: new Set() };
    }

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

    return deserializeGraph(tasks);
  }

  /**
   * Save updated tasks to SQLite
   */
  private saveTaskGraph(graph: TaskGraph): void {
    const sql = this.state.storage.sql;

    for (const task of graph.tasks.values()) {
      const row = taskToRow(task);
      sql.exec(
        `INSERT OR REPLACE INTO tasks (
          id, parent_id, type, title, description, status, dependencies,
          result, error, assigned_to, created_at, started_at, completed_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.parent_id,
        row.type,
        row.title,
        row.description,
        row.status,
        row.dependencies,
        row.result,
        row.error,
        row.assigned_to,
        row.created_at,
        row.started_at,
        row.completed_at,
        row.metadata
      );
    }
  }

  /**
   * Get tool context for the subagent
   */
  private getToolContext(_sessionId: string): ToolContext {
    // Note: In a facet, we share storage with parent
    // but need to create our own loopback stubs
    const sql = this.state.storage.sql as unknown as SqlFunction;
    const storage = new YjsStorage(sql);

    // For now, return a minimal context
    // Full loopback support would require passing parent ctx.exports
    return {
      storage,
      bash: null as unknown as BashLoopback,
      fetch: null as unknown as FetchLoopback,
      braveSearch: null as unknown as BraveSearchLoopback,
      executeCode: async () => ({
        success: false,
        error: "Not available in subagent",
        errorType: "unknown" as const,
        logs: [],
        duration: 0
      })
    };
  }
}

// ============================================================================
// Parent-side Subagent Manager
// ============================================================================

/**
 * Manages subagent facets from the parent Coder DO
 */
export class SubagentManager {
  private activeSubagents: Map<string, { taskId: string; startedAt: number }> =
    new Map();

  constructor(
    private ctx: DurableObjectState,
    _env: SubagentEnv, // Kept for future use but facets inherit parent's env
    private sessionId: string
  ) {}

  /**
   * Spawn a subagent facet to execute a task
   */
  async spawnSubagent(task: Task, context?: string): Promise<string> {
    const facetName = `subagent-${task.id}`;

    // Get or create the facet
    const facet = this.ctx.facets.get<Subagent>(facetName, () => ({
      class: Subagent
    }));

    // Track the subagent
    this.activeSubagents.set(task.id, {
      taskId: task.id,
      startedAt: Date.now()
    });

    // Start execution (non-blocking from parent's perspective)
    // The facet runs independently
    facet.execute({
      taskId: task.id,
      title: task.title,
      description: task.description || task.title,
      context,
      parentSessionId: this.sessionId
    });

    return facetName;
  }

  /**
   * Check status of a subagent
   */
  async getSubagentStatus(taskId: string): Promise<SubagentStatus | null> {
    const facetName = `subagent-${taskId}`;

    try {
      const facet = this.ctx.facets.get<Subagent>(facetName, () => ({
        class: Subagent
      }));
      return facet.getStatus();
    } catch {
      return null;
    }
  }

  /**
   * Get all active subagent statuses
   */
  async getAllStatuses(): Promise<SubagentStatus[]> {
    const statuses: SubagentStatus[] = [];

    for (const [taskId] of this.activeSubagents) {
      const status = await this.getSubagentStatus(taskId);
      if (status) {
        statuses.push(status);

        // Clean up completed subagents
        if (status.status === "complete" || status.status === "failed") {
          this.activeSubagents.delete(taskId);
        }
      }
    }

    return statuses;
  }

  /**
   * Abort a subagent
   */
  abortSubagent(taskId: string): void {
    const facetName = `subagent-${taskId}`;
    this.ctx.facets.abort(facetName, new Error("Aborted by parent"));
    this.activeSubagents.delete(taskId);
  }

  /**
   * Delete a subagent facet
   */
  deleteSubagent(taskId: string): void {
    const facetName = `subagent-${taskId}`;
    this.ctx.facets.delete(facetName);
    this.activeSubagents.delete(taskId);
  }

  /**
   * Get count of active subagents
   */
  get activeCount(): number {
    return this.activeSubagents.size;
  }
}
