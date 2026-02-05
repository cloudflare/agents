/**
 * Subagent Module
 *
 * Implements parallel task execution using Durable Object Facets.
 * Each subagent runs as a facet of the parent Think DO.
 *
 * ARCHITECTURE:
 * Facets run in separate isolates and have ISOLATED storage.
 * However, facets CAN call back to their parent via:
 * - ctx.exports.Think - get the DO namespace
 * - namespace.get(doId) - get a stub to the parent
 * - stub.fetch() - make HTTP requests to parent's endpoints
 *
 * Communication flow:
 * - Props: Task data passed when facet is created (includes parentDOId)
 * - RPC: ParentRPC client makes HTTP calls to parent's endpoints
 * - Return values: SubagentResult returned to parent
 *
 * Key features:
 * - Parallel execution of subtasks
 * - Full tool access via ParentRPC (bash, fetch, file operations)
 * - Context isolation (each subagent has focused system prompt)
 */

import { DurableObject } from "cloudflare:workers";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createTools, type ToolContext } from "./agent-tools";
import { ParentRPC } from "./loopbacks/parent-rpc";
import type { YjsStorage } from "./yjs-storage";
import type { BashLoopback } from "./loopbacks/bash";
import type { FetchLoopback } from "./loopbacks/fetch";
import type { BraveSearchLoopback } from "./loopbacks/brave-search";
import type { Task } from "./tasks";

// ============================================================================
// Types
// ============================================================================

export interface SubagentEnv {
  OPENAI_API_KEY: string;
  BRAVE_API_KEY?: string;
  // biome-ignore lint/suspicious/noExplicitAny: LOADER type is complex and varies
  LOADER: any;
}

/**
 * Props passed to Subagent facet at creation time.
 * These define the task the subagent will execute.
 *
 * Note: Facets have isolated storage and run in separate isolates.
 * All needed data must be passed via props. The subagent uses ParentRPC
 * to call back to the parent for tool access (bash, fetch, file ops).
 */
export interface SubagentProps {
  taskId: string;
  title: string;
  description: string;
  context?: string;
  parentSessionId: string;
  /** The parent DO's ID string - needed for RPC calls back to parent */
  parentDOId: string;
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
    // Note: exports is already declared in server-without-browser.ts
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
  // The class must be a DurableObject class from ctx.exports, not a regular ES6 class
  // biome-ignore lint/suspicious/noExplicitAny: Facets API accepts DO bindings
  class: any;
}

type Fetcher = {
  fetch(request: Request): Promise<Response>;
};

// ============================================================================
// Subagent Class
// ============================================================================

/**
 * Subagent runs as a facet, executing a single focused task.
 *
 * ARCHITECTURE NOTE: Facets have ISOLATED storage from the parent.
 * - Task data is passed via props (not read from parent's SQLite)
 * - Tools access parent via RPC (ParentLoopback)
 * - Results are returned to parent, which updates the task graph
 *
 * Uses the props pattern for facets - task details are passed via ctx.props
 * when the facet is created with ctx.exports.Subagent({ props: {...} })
 */
export class Subagent extends DurableObject<SubagentEnv, SubagentProps> {
  private status: SubagentStatus | null = null;

  // Props are accessed via this.ctx.props, not constructor params
  private get taskId(): string {
    return this.ctx.props.taskId;
  }

  /**
   * Execute a task with a focused agent loop.
   * Task details come from this.ctx.props (set when facet was created).
   *
   * Note: Task graph updates are handled by the PARENT when it receives
   * the SubagentResult. Facets have isolated storage and cannot access
   * the parent's task graph directly.
   */
  async execute(): Promise<SubagentResult> {
    const startTime = Date.now();
    const { taskId, title, description, context, parentSessionId } =
      this.ctx.props;

    this.status = {
      taskId,
      status: "running",
      startedAt: startTime
    };

    try {
      // Build focused system prompt
      const systemPrompt = this.buildFocusedPrompt({
        title,
        description,
        context
      });

      // Get tool context (tools access parent via RPC loopbacks)
      const toolContext = this.getToolContext(parentSessionId);
      const tools = createTools(toolContext);

      // Run focused agent loop
      const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
      const messages: ModelMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: description }
      ];

      const result = await generateText({
        model: openai("gpt-4o"),
        messages,
        tools,
        stopWhen: stepCountIs(15) // Limit steps for focused work
        // Note: reasoningEffort is only for reasoning models (gpt-5, o1)
      });

      const finalResult = result.text || "Task completed";

      // Update local status (parent will poll this via getStatus())
      this.status = {
        taskId,
        status: "complete",
        startedAt: startTime,
        completedAt: Date.now(),
        result: finalResult
      };

      // Return result to parent - parent handles task graph updates
      return {
        taskId,
        success: true,
        result: finalResult,
        duration: Date.now() - startTime
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error(`Subagent ${taskId} error:`, errorMessage);

      // Update local status
      this.status = {
        taskId,
        status: "failed",
        startedAt: startTime,
        completedAt: Date.now(),
        error: errorMessage
      };

      // Return error to parent - parent handles task graph updates
      return {
        taskId,
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
   * Get tool context for the subagent using ParentRPC.
   *
   * ARCHITECTURE: Facets run in separate isolates but can call back to the
   * parent via ctx.exports.Think and stub.fetch(). The ParentRPC client
   * wraps this to provide tool access.
   *
   * Note: Storage operations are async via ParentRPC (HTTP calls to parent).
   * The storage wrapper provides async methods that match YjsStorage signatures
   * but require await. Tools using storage should handle this.
   */
  private getToolContext(_sessionId: string): ToolContext {
    // Create ParentRPC client to call back to parent
    const parentRpc = new ParentRPC(this.ctx, this.ctx.props.parentDOId);

    // Create storage wrapper that uses ParentRPC
    // Note: These are async methods, while YjsStorage methods are sync
    // The tool implementations in agent-tools.ts may need adjustment
    const storageWrapper = {
      readFile: (_path: string): string | null => {
        // This is a sync interface but we need async - return placeholder
        // Real implementation would need to be async
        console.warn(
          "Subagent storage.readFile called synchronously - use parentRpc.readFile() instead"
        );
        return null;
      },
      writeFile: (_path: string, _content: string): number => {
        console.warn(
          "Subagent storage.writeFile called synchronously - use parentRpc.writeFile() instead"
        );
        return 0;
      },
      editFile: (
        _path: string,
        _search: string,
        _replace: string
      ): number | null => {
        console.warn(
          "Subagent storage.editFile called synchronously - use parentRpc for file operations"
        );
        return null;
      },
      listFiles: (): string[] => {
        console.warn(
          "Subagent storage.listFiles called synchronously - use parentRpc.listFiles() instead"
        );
        return [];
      },
      // Provide async versions that tools can use
      readFileAsync: (path: string) => parentRpc.readFile(path),
      writeFileAsync: (path: string, content: string) =>
        parentRpc.writeFile(path, content),
      listFilesAsync: () => parentRpc.listFiles()
    } as unknown as YjsStorage;

    // Create bash wrapper
    const bashWrapper = {
      exec: (
        command: string,
        options?: { cwd?: string; env?: Record<string, string> }
      ) => parentRpc.bash(command, options)
    } as unknown as BashLoopback;

    // Create fetch wrapper
    const fetchWrapper = {
      request: (
        url: string,
        options?: { method?: string; headers?: Record<string, string> }
      ) => parentRpc.fetch(url, options)
    } as unknown as FetchLoopback;

    // Create search wrapper
    const searchWrapper = {
      search: (query: string, _options?: unknown) => parentRpc.webSearch(query),
      news: async (_query: string, _options?: unknown) => ({
        results: [],
        error: "News search not available in subagent"
      })
    } as unknown as BraveSearchLoopback;

    return {
      storage: storageWrapper,
      bash: bashWrapper,
      fetch: fetchWrapper,
      braveSearch: searchWrapper,
      // No code execution in subagents
      executeCode: async () => ({
        success: false,
        error: "Code execution not available in subagent",
        errorType: "unknown" as const,
        logs: [],
        duration: 0
      })
    };
  }

  /**
   * Get the ParentRPC client for direct access to parent's tools.
   * This is the preferred way to access tools in subagent execute().
   */
  protected getParentRpc(): ParentRPC {
    return new ParentRPC(this.ctx, this.ctx.props.parentDOId);
  }
}

// ============================================================================
// Parent-side Subagent Manager
// ============================================================================

/**
 * Payload for scheduled subagent status checks
 */
export interface SubagentCheckPayload {
  taskId: string;
  attempt: number;
  maxAttempts: number;
}

/**
 * Configuration for subagent monitoring
 */
export const SUBAGENT_CONFIG = {
  /** Initial delay before first status check (seconds) */
  initialCheckDelay: 30,
  /** Delay between subsequent checks (seconds) */
  checkInterval: 60,
  /** Maximum check attempts before marking as timed out */
  maxCheckAttempts: 10,
  /** Maximum expected execution time (seconds) - after this, consider timed out */
  maxExecutionTime: 600
} as const;

/**
 * Manages subagent facets from the parent Think DO
 *
 * Uses SQLite for tracking active subagents so state persists across
 * DO hibernation and restarts.
 */
export class SubagentManager {
  private initialized = false;

  constructor(
    private ctx: DurableObjectState,
    _env: SubagentEnv, // Kept for future use but facets inherit parent's env
    private sessionId: string
  ) {}

  /**
   * Initialize the subagent tracking table
   */
  private ensureTable(): void {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_subagents (
        task_id TEXT PRIMARY KEY,
        facet_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        status TEXT DEFAULT 'running',
        props_json TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  /**
   * Track a subagent in SQLite
   */
  private trackSubagent(
    taskId: string,
    facetName: string,
    props: SubagentProps
  ): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO active_subagents (task_id, facet_name, session_id, started_at, status, props_json)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      taskId,
      facetName,
      this.sessionId,
      Date.now(),
      JSON.stringify(props)
    );
  }

  /**
   * Update subagent status in SQLite
   */
  private updateStatus(taskId: string, status: string): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      "UPDATE active_subagents SET status = ? WHERE task_id = ?",
      status,
      taskId
    );
  }

  /**
   * Remove a subagent from tracking
   */
  private removeSubagent(taskId: string): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      "DELETE FROM active_subagents WHERE task_id = ?",
      taskId
    );
  }

  /**
   * Get tracking info for a subagent
   */
  private getTracking(taskId: string): {
    taskId: string;
    facetName: string;
    startedAt: number;
    props: SubagentProps;
  } | null {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT task_id, facet_name, started_at, props_json FROM active_subagents WHERE task_id = ?",
        taskId
      )
      .toArray();

    if (rows.length === 0) return null;
    const row = rows[0] as {
      task_id: string;
      facet_name: string;
      started_at: number;
      props_json: string;
    };
    return {
      taskId: row.task_id,
      facetName: row.facet_name,
      startedAt: row.started_at,
      props: JSON.parse(row.props_json) as SubagentProps
    };
  }

  /**
   * Spawn a subagent facet to execute a task
   *
   * NOTE: Facets require the `experimental` compatibility flag and may not
   * work in all environments (e.g., vitest-pool-workers). In unsupported
   * environments, this will throw an error.
   */
  async spawnSubagent(task: Task, context?: string): Promise<string> {
    const facetName = `subagent-${task.id}`;

    // Get the parent DO ID - needed for RPC calls back to parent
    const parentDOId = this.ctx.id.toString();

    // Create props for this subagent
    const props: SubagentProps = {
      taskId: task.id,
      title: task.title,
      description: task.description || task.title,
      context,
      parentSessionId: this.sessionId,
      parentDOId // Pass parent ID so facet can call back via RPC
    };

    // Get or create the facet with props
    // IMPORTANT: ctx.exports.Subagent({ props }) returns a loopback namespace
    // that the facets API recognizes as a valid class
    const facet = this.ctx.facets.get<Subagent>(facetName, () => ({
      class: this.ctx.exports.Subagent({ props })
    }));

    // Track the subagent in SQLite (persists across DO hibernation)
    this.trackSubagent(task.id, facetName, props);

    // Start execution (non-blocking from parent's perspective)
    // Props are already set - execute() reads them from ctx.props
    facet.execute().catch((error: Error) => {
      console.error(`Subagent ${facetName} execution failed:`, error.message);
      // Update tracking to mark as failed
      this.updateStatus(task.id, "failed");
    });

    return facetName;
  }

  /**
   * Check status of a subagent
   */
  async getSubagentStatus(taskId: string): Promise<SubagentStatus | null> {
    // Check SQLite tracking first
    const tracking = this.getTracking(taskId);
    if (!tracking) {
      return null;
    }

    const facetName = tracking.facetName;

    try {
      // Recreate the loopback namespace with the same props
      // This returns the same facet if it already exists
      const facet = this.ctx.facets.get<Subagent>(facetName, () => ({
        class: this.ctx.exports.Subagent({ props: tracking.props })
      }));
      const status = facet.getStatus();

      // If facet reports complete/failed, update SQLite and potentially clean up
      if (
        status &&
        (status.status === "complete" || status.status === "failed")
      ) {
        this.updateStatus(taskId, status.status);
      }

      return status;
    } catch {
      // Facets API not available - return pending status based on tracking
      return {
        taskId,
        status: "pending",
        startedAt: tracking.startedAt
      };
    }
  }

  /**
   * Get all active subagent statuses
   */
  async getAllStatuses(): Promise<SubagentStatus[]> {
    this.ensureTable();
    const statuses: SubagentStatus[] = [];

    // Get all tracked subagents from SQLite
    const rows = this.ctx.storage.sql
      .exec("SELECT task_id FROM active_subagents")
      .toArray();

    for (const row of rows) {
      const taskId = (row as { task_id: string }).task_id;
      const status = await this.getSubagentStatus(taskId);
      if (status) {
        statuses.push(status);

        // Clean up completed subagents from tracking
        if (status.status === "complete" || status.status === "failed") {
          this.removeSubagent(taskId);
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
    this.removeSubagent(taskId);
  }

  /**
   * Delete a subagent facet
   */
  deleteSubagent(taskId: string): void {
    const facetName = `subagent-${taskId}`;
    this.ctx.facets.delete(facetName);
    this.removeSubagent(taskId);
  }

  /**
   * Get count of active subagents
   */
  get activeCount(): number {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec("SELECT COUNT(*) as count FROM active_subagents")
      .toArray();
    return (rows[0] as { count: number }).count;
  }

  // ==========================================================================
  // Recovery Methods
  // ==========================================================================

  /**
   * Get all subagents that are still marked as running.
   * Used on startup to detect orphaned subagents that may have been interrupted.
   */
  getRunningSubagents(): Array<{
    taskId: string;
    facetName: string;
    startedAt: number;
    sessionId: string;
  }> {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT task_id, facet_name, started_at, session_id 
         FROM active_subagents 
         WHERE status = 'running'`
      )
      .toArray();

    return rows.map((row) => {
      const r = row as {
        task_id: string;
        facet_name: string;
        started_at: number;
        session_id: string;
      };
      return {
        taskId: r.task_id,
        facetName: r.facet_name,
        startedAt: r.started_at,
        sessionId: r.session_id
      };
    });
  }

  /**
   * Mark a subagent as interrupted (due to server restart).
   * Updates both the tracking table and optionally the task graph.
   */
  markInterrupted(taskId: string): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `UPDATE active_subagents SET status = 'interrupted' WHERE task_id = ?`,
      taskId
    );
  }

  /**
   * Check if a subagent has been running too long (potential timeout).
   * Returns true if the subagent started more than maxExecutionTime ago.
   */
  isTimedOut(taskId: string): boolean {
    const tracking = this.getTracking(taskId);
    if (!tracking) return false;

    const elapsed = Date.now() - tracking.startedAt;
    return elapsed > SUBAGENT_CONFIG.maxExecutionTime * 1000;
  }

  /**
   * Mark a subagent as timed out and remove from tracking.
   */
  markTimedOut(taskId: string): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      `UPDATE active_subagents SET status = 'timeout' WHERE task_id = ?`,
      taskId
    );
    // Clean up after marking
    this.removeSubagent(taskId);
  }
}

// ============================================================================
// Static Variable Test (for E2E testing static sharing between parent and facet)
// ============================================================================

/**
 * Static Map used to test if facets share static variables with parent.
 * If facets share the same isolate, they will see values set by the parent.
 */
export const STATIC_TEST_MAP: Map<string, string> = new Map();

/**
 * Register a value in the static test map (called by parent)
 */
export function registerStaticTestValue(key: string, value: string): void {
  STATIC_TEST_MAP.set(key, value);
}

/**
 * Read a value from the static test map
 */
export function getStaticTestValue(key: string): string | undefined {
  return STATIC_TEST_MAP.get(key);
}

/**
 * Props for StaticTestFacet
 */
export interface StaticTestProps {
  testId: string;
  keyToCheck: string;
}

/**
 * Facet for testing whether static variables are shared with parent.
 * If the parent sets a value in STATIC_TEST_MAP before spawning this facet,
 * and the facet can read it, then static variables ARE shared.
 */
export class StaticTestFacet extends DurableObject<
  SubagentEnv,
  StaticTestProps
> {
  /**
   * Check if a value exists in the static Map (set by parent)
   */
  checkStaticValue(): {
    keyChecked: string;
    found: boolean;
    value: string | null;
    mapSize: number;
    allKeys: string[];
  } {
    const key = this.ctx.props.keyToCheck;
    const value = STATIC_TEST_MAP.get(key);
    return {
      keyChecked: key,
      found: value !== undefined,
      value: value ?? null,
      mapSize: STATIC_TEST_MAP.size,
      allKeys: Array.from(STATIC_TEST_MAP.keys())
    };
  }

  /**
   * Set a value in the static Map from the facet
   */
  setStaticValue(key: string, value: string): void {
    STATIC_TEST_MAP.set(key, value);
  }
}

// ============================================================================
// Storage Test Facet (for E2E testing storage sharing)
// ============================================================================

/**
 * Props for StorageTestFacet
 */
export interface StorageTestProps {
  testId: string;
}

/**
 * Simple facet for testing whether storage is shared with parent.
 * Does NOT use LLM - just reads/writes SQLite.
 */
export class StorageTestFacet extends DurableObject<
  SubagentEnv,
  StorageTestProps
> {
  /**
   * Read a value from the storage_test table.
   * Returns the value if found, null if not found, or error info.
   */
  readTestValue(key: string): {
    found: boolean;
    value: string | null;
    error?: string;
  } {
    try {
      const rows = this.ctx.storage.sql
        .exec("SELECT value FROM storage_test WHERE key = ?", key)
        .toArray();

      if (rows.length === 0) {
        return { found: false, value: null };
      }

      return { found: true, value: (rows[0] as { value: string }).value };
    } catch (error) {
      return {
        found: false,
        value: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Write a value to the storage_test table from the facet's perspective.
   */
  writeTestValue(
    key: string,
    value: string
  ): { success: boolean; error?: string } {
    try {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO storage_test (key, value) VALUES (?, ?)",
        key,
        value
      );
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * List all tables visible to this facet.
   */
  listTables(): { tables: string[]; error?: string } {
    try {
      const rows = this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray();
      const tables = rows.map((r) => (r as { name: string }).name);
      return { tables };
    } catch (error) {
      return {
        tables: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

// ============================================================================
// RPC Test Facet (for E2E testing RPC back to parent)
// ============================================================================

/**
 * Props for RpcTestFacet
 */
export interface RpcTestProps {
  testId: string;
  parentDOId: string;
}

/**
 * Facet for testing whether we can make RPC calls back to the parent DO.
 * This tests the minions pattern of using ctx.exports to get a stub to the parent.
 */
export class RpcTestFacet extends DurableObject<SubagentEnv, RpcTestProps> {
  /**
   * Test if we can access ctx.exports
   */
  checkExportsAvailable(): {
    hasExports: boolean;
    exportKeys: string[];
    hasThink: boolean;
    error?: string;
  } {
    try {
      // Check if ctx.exports is available
      const exports = this.ctx.exports;
      const hasExports = exports !== undefined && exports !== null;

      // Get the keys of exports - be careful with null
      let exportKeys: string[] = [];
      try {
        if (hasExports && typeof exports === "object") {
          exportKeys = Object.keys(exports);
        }
      } catch {
        // Object.keys failed
      }

      // Check if Think is available
      let hasThink = false;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: checking dynamic exports
        hasThink = hasExports && typeof (exports as any).Think !== "undefined";
      } catch {
        // Access failed
      }

      return {
        hasExports,
        exportKeys,
        hasThink
      };
    } catch (error) {
      return {
        hasExports: false,
        exportKeys: [],
        hasThink: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Test if we can get a stub to the parent and call its /files endpoint
   */
  async callParentFiles(): Promise<{
    success: boolean;
    files?: string[];
    thinkAvailable?: boolean;
    stubObtained?: boolean;
    error?: string;
  }> {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic exports
      const exports = this.ctx.exports as any;

      // Check if Think namespace is available
      const thinkAvailable = exports && exports.Think !== undefined;
      if (!thinkAvailable) {
        return {
          success: false,
          thinkAvailable: false,
          stubObtained: false,
          error: "exports.Think not available"
        };
      }

      // Get the parent DO namespace
      const thinkNamespace = exports.Think;

      // Get the parent DO ID from props
      const parentId = this.ctx.props.parentDOId;

      // Get a stub to the parent
      let parentStub: { fetch: (req: Request) => Promise<Response> };
      try {
        const doId = thinkNamespace.idFromString(parentId);
        parentStub = thinkNamespace.get(doId);
      } catch (stubError) {
        return {
          success: false,
          thinkAvailable: true,
          stubObtained: false,
          error: `Failed to get stub: ${stubError instanceof Error ? stubError.message : String(stubError)}`
        };
      }

      // Make an HTTP request to the parent's /files endpoint
      const response = await parentStub.fetch(
        new Request("http://parent/files", { method: "GET" })
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          thinkAvailable: true,
          stubObtained: true,
          error: `HTTP ${response.status}: ${errorText}`
        };
      }

      const data = (await response.json()) as { files: Record<string, string> };
      return {
        success: true,
        thinkAvailable: true,
        stubObtained: true,
        files: Object.keys(data.files)
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Test if we can make an HTTP request via the stub's fetch() method
   */
  async testDirectRpc(): Promise<{
    success: boolean;
    result?: unknown;
    stubType?: string;
    hasFetch?: boolean;
    error?: string;
  }> {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: accessing dynamic exports
      const exports = this.ctx.exports as any;

      if (!exports || !exports.Think) {
        return {
          success: false,
          error: "exports.Think not available"
        };
      }

      const thinkNamespace = exports.Think;
      const parentId = this.ctx.props.parentDOId;
      const doId = thinkNamespace.idFromString(parentId);
      const parentStub = thinkNamespace.get(doId);

      // Check what type the stub is
      const stubType = typeof parentStub;
      const hasFetch = typeof parentStub.fetch === "function";

      // Try to call fetch() on the stub - this should work
      const response = await parentStub.fetch(
        new Request("http://do/files", { method: "GET" })
      );

      const status = response.status;
      const body = await response.text();

      return {
        success: true,
        stubType,
        hasFetch,
        result: {
          status,
          bodyLength: body.length,
          bodyPreview: body.slice(0, 200)
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
