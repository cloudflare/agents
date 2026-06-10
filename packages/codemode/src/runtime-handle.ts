import type { Tool } from "ai";
import type { CodemodeConnector } from "./connectors";
import type { Executor } from "./executor";
import {
  createProxyTool,
  getCodemodeRuntime,
  pendingCodemode,
  rejectCodemode,
  resumeCodemode,
  rollbackCodemode,
  type ProxyToolInput,
  type ProxyToolOutput,
  type TransformResult
} from "./proxy-tool";
import type { ExecutionState, PendingAction } from "./runtime";
import type { SaveSnippetOptions, Snippet } from "./snippet";

export type CreateCodemodeRuntimeOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
  /**
   * How many terminal (completed/error) executions to retain per runtime.
   * Older ones are pruned automatically when a new run begins. Running and
   * paused executions are never pruned. Defaults to 50.
   */
  maxExecutions?: number;
  /**
   * Optionally reshape the model-facing result of a completed run before it is
   * returned — e.g. `(r) => truncateResult(r)` to cap response size. The raw
   * result is still recorded on the execution, so the audit trail is intact.
   * Applies to both the initial run and a resume after approval.
   */
  transformResult?: TransformResult;
};

export type CodemodeRuntimeToolOptions = {
  description?: string;
};

export type CodemodeApproveOptions = {
  /** Execution to approve and resume. Get it from `pending()` or the tool output. */
  executionId: string;
};

export type CodemodeRejectOptions = {
  seq: number;
  /** Execution to reject within. Get it from `pending()`. */
  executionId: string;
};

export type CodemodeRollbackOptions = {
  /** Execution to roll back. Get it from `executions()` or the tool output. */
  executionId: string;
};

export interface CodemodeRuntimeHandle {
  tool(
    options?: CodemodeRuntimeToolOptions
  ): Tool<ProxyToolInput, ProxyToolOutput>;
  approve(options: CodemodeApproveOptions): Promise<ProxyToolOutput>;
  reject(options: CodemodeRejectOptions): Promise<void>;
  rollback(options: CodemodeRollbackOptions): Promise<void>;
  pending(executionId?: string): Promise<PendingAction[]>;
  /** All executions, newest first — the audit trail. Optionally capped. */
  executions(limit?: number): Promise<ExecutionState[]>;
  /** Delete a single execution from the audit trail. */
  deleteExecution(id: string): Promise<boolean>;
  /** Prune terminal executions, keeping the newest `keep`. */
  pruneExecutions(keep?: number): Promise<number>;
  /** Promote an execution's script to a named, reusable snippet. */
  saveSnippet(name: string, options: SaveSnippetOptions): Promise<Snippet>;
  snippets(): Promise<Snippet[]>;
  deleteSnippet(name: string): Promise<boolean>;
}

export function createCodemodeRuntime(
  options: CreateCodemodeRuntimeOptions
): CodemodeRuntimeHandle {
  return new DefaultCodemodeRuntimeHandle(options);
}

class DefaultCodemodeRuntimeHandle implements CodemodeRuntimeHandle {
  #options: CreateCodemodeRuntimeOptions;

  constructor(options: CreateCodemodeRuntimeOptions) {
    this.#options = options;
  }

  tool(
    options?: CodemodeRuntimeToolOptions
  ): Tool<ProxyToolInput, ProxyToolOutput> {
    return createProxyTool({
      ctx: this.#options.ctx,
      executor: this.#options.executor,
      connectors: this.#options.connectors,
      description: options?.description,
      maxExecutions: this.#options.maxExecutions,
      transformResult: this.#options.transformResult
    });
  }

  approve(options: CodemodeApproveOptions): Promise<ProxyToolOutput> {
    return resumeCodemode({
      ctx: this.#options.ctx,
      executor: this.#options.executor,
      connectors: this.#options.connectors,
      executionId: options.executionId,
      maxExecutions: this.#options.maxExecutions,
      transformResult: this.#options.transformResult
    });
  }

  reject(options: CodemodeRejectOptions): Promise<void> {
    return rejectCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      seq: options.seq,
      executionId: options.executionId
    });
  }

  rollback(options: CodemodeRollbackOptions): Promise<void> {
    return rollbackCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      executionId: options.executionId
    });
  }

  pending(executionId?: string): Promise<PendingAction[]> {
    return pendingCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      executionId
    });
  }

  executions(limit?: number): Promise<ExecutionState[]> {
    return this.#runtime().listExecutions(limit);
  }

  deleteExecution(id: string): Promise<boolean> {
    return this.#runtime().deleteExecution(id);
  }

  pruneExecutions(keep?: number): Promise<number> {
    return this.#runtime().pruneExecutions(keep);
  }

  saveSnippet(name: string, options: SaveSnippetOptions): Promise<Snippet> {
    return this.#runtime().saveSnippet(name, options);
  }

  snippets(): Promise<Snippet[]> {
    return this.#runtime().listSnippets();
  }

  deleteSnippet(name: string): Promise<boolean> {
    return this.#runtime().deleteSnippet(name);
  }

  #runtime() {
    return getCodemodeRuntime(this.#options.ctx, this.#options.connectors);
  }
}
