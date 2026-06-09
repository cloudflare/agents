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
  type ProxyToolOutput
} from "./proxy-tool";
import type { ExecutionState, PendingAction } from "./runtime";
import type { SaveSnippetOptions, Snippet } from "./snippet";

export type CreateCodemodeRuntimeOptions = {
  ctx: DurableObjectState;
  connectors: CodemodeConnector[];
  executor: Executor;
};

export type CodemodeRuntimeToolOptions = {
  description?: string;
};

export type CodemodeApproveOptions = {
  executionId?: string;
};

export type CodemodeRejectOptions = {
  seq: number;
};

export interface CodemodeRuntimeHandle {
  tool(
    options?: CodemodeRuntimeToolOptions
  ): Tool<ProxyToolInput, ProxyToolOutput>;
  approve(options?: CodemodeApproveOptions): Promise<ProxyToolOutput>;
  reject(options: CodemodeRejectOptions): Promise<void>;
  rollback(): Promise<void>;
  pending(): Promise<PendingAction[]>;
  /** All executions, newest first — the audit trail. */
  executions(): Promise<ExecutionState[]>;
  /** Promote an execution's script to a named, reusable snippet. */
  saveSnippet(name: string, options?: SaveSnippetOptions): Promise<Snippet>;
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
      description: options?.description
    });
  }

  approve(options?: CodemodeApproveOptions): Promise<ProxyToolOutput> {
    return resumeCodemode({
      ctx: this.#options.ctx,
      executor: this.#options.executor,
      connectors: this.#options.connectors,
      executionId: options?.executionId
    });
  }

  reject(options: CodemodeRejectOptions): Promise<void> {
    return rejectCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors,
      seq: options.seq
    });
  }

  rollback(): Promise<void> {
    return rollbackCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors
    });
  }

  pending(): Promise<PendingAction[]> {
    return pendingCodemode({
      ctx: this.#options.ctx,
      connectors: this.#options.connectors
    });
  }

  executions(): Promise<ExecutionState[]> {
    return this.#runtime().listExecutions();
  }

  saveSnippet(name: string, options?: SaveSnippetOptions): Promise<Snippet> {
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
