/**
 * Internal runtime abstraction.
 *
 * Thin wrapper today — exists as a seam so a future facet-backed runtime
 * can implement the same interface for stateful pause/resume, session
 * caching, and approval queues without changing the proxy tool.
 */
import type { CodeOutput } from "./shared";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { runCode } from "./run-code";

export type CodemodeRuntime = {
  execute(input: {
    code: string;
    providers: ResolvedProvider[];
    connectors?: ConnectorBinding[];
  }): Promise<CodeOutput>;
};

export function createRuntime(executor: Executor): CodemodeRuntime {
  return {
    execute: (input) =>
      runCode({
        code: input.code,
        executor,
        providers: input.providers,
        connectors: input.connectors
      })
  };
}
