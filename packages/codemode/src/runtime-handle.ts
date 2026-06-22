import type { CodemodeConnector } from "./connectors";
import type { Executor } from "./executor";
import {
  createProxyTool,
  disposeConnectors,
  expireCodemode,
  getCodemodeRuntime,
  pendingCodemode,
  rejectCodemode,
  resumeCodemode,
  rollbackCodemode,
  validateConnectorNames,
  type CodemodeTool,
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
   * Runtime name — the durable identity of this runtime's facet (its
   * executions and snippets). Defaults to `"default"`. Use distinct names for
   * runtimes that should keep separate histories. Adding or removing
   * connectors does NOT change the identity: each execution/snippet records
   * the connector names it needs, and resuming/re-running verifies they are
   * still configured.
   */
  name?: string;
  /**
   * How many terminal (completed/error) executions to retain per runtime.
   * Older ones are pruned automatically when a new run begins. Running and
   * paused executions are never pruned (see `expirePaused`). Defaults to 50.
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
  /**
   * One-line hints rendered next to each connector in the default tool
   * description (keyed by connector name). Ignored when a custom
   * `description` is given.
   */
  connectorHints?: Record<string, string>;
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

export type CodemodeExpireOptions = {
  /**
   * Expire non-terminal runs whose last state change is older than this.
   * Defaults to 24 hours.
   */
  maxAgeMs?: number;
};

export interface CodemodeRuntimeHandle {
  tool(options?: CodemodeRuntimeToolOptions): CodemodeTool;
  approve(options: CodemodeApproveOptions): Promise<ProxyToolOutput>;
  /**
   * Reject a pending action, ending the run. Returns whether the reject
   * actually terminated it — `false` when the action was no longer pending
   * (approved or rejected from elsewhere, or expired), in which case the run
   * was NOT rejected and the action may have executed.
   */
  reject(options: CodemodeRejectOptions): Promise<boolean>;
  rollback(options: CodemodeRollbackOptions): Promise<void>;
  pending(executionId?: string): Promise<PendingAction[]>;
  /**
   * Expire stale non-terminal runs (neither is ever auto-pruned), disposing
   * per-execution connector resources: paused runs nobody approved are marked
   * rejected; running runs whose host died mid-pass are marked error. Call
   * from a recurring alarm/scheduled task. Returns the expired ids.
   */
  expirePaused(options?: CodemodeExpireOptions): Promise<string[]>;
  /** All executions, newest first — the audit trail. Optionally capped. */
  executions(limit?: number): Promise<ExecutionState[]>;
  /**
   * Delete a single execution from the audit trail. Deleting a non-terminal
   * execution also disposes its per-execution connector resources.
   */
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
    validateConnectorNames(options.connectors);
    this.#options = options;
  }

  tool(options?: CodemodeRuntimeToolOptions): CodemodeTool {
    return createProxyTool({
      ctx: this.#options.ctx,
      executor: this.#options.executor,
      connectors: this.#options.connectors,
      name: this.#options.name,
      description: options?.description,
      connectorHints: options?.connectorHints,
      maxExecutions: this.#options.maxExecutions,
      transformResult: this.#options.transformResult
    });
  }

  approve(options: CodemodeApproveOptions): Promise<ProxyToolOutput> {
    return resumeCodemode({
      ctx: this.#options.ctx,
      executor: this.#options.executor,
      connectors: this.#options.connectors,
      name: this.#options.name,
      executionId: options.executionId,
      maxExecutions: this.#options.maxExecutions,
      transformResult: this.#options.transformResult
    });
  }

  reject(options: CodemodeRejectOptions): Promise<boolean> {
    return rejectCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      name: this.#options.name,
      seq: options.seq,
      executionId: options.executionId
    });
  }

  rollback(options: CodemodeRollbackOptions): Promise<void> {
    return rollbackCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      name: this.#options.name,
      executionId: options.executionId
    });
  }

  pending(executionId?: string): Promise<PendingAction[]> {
    return pendingCodemode({
      ctx: this.#options.ctx,
      name: this.#options.name,
      executionId
    });
  }

  expirePaused(options?: CodemodeExpireOptions): Promise<string[]> {
    return expireCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      name: this.#options.name,
      maxAgeMs: options?.maxAgeMs
    });
  }

  executions(limit?: number): Promise<ExecutionState[]> {
    return this.#runtime().listExecutions(limit);
  }

  async deleteExecution(id: string): Promise<boolean> {
    const runtime = this.#runtime();
    // A non-terminal execution still owns per-execution connector resources
    // (e.g. a browser session) that `disposeExecution` would normally release
    // on its terminal transition — deleting the record must not leak them.
    const state = await runtime.getExecution(id);
    const deleted = await runtime.deleteExecution(id);
    if (
      deleted &&
      (state?.status === "paused" || state?.status === "running")
    ) {
      await disposeConnectors(this.#options.connectors, id, "rejected");
    }
    return deleted;
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
    return getCodemodeRuntime(this.#options.ctx, this.#options.name);
  }
}
