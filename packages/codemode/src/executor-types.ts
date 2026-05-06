/**
 * Shared executor contract used by all codemode runtimes.
 */

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * Internal resolved form of a tool provider, ready for execution.
 * The tool functions are keyed by tool name and exposed under `name.*`
 * inside the sandbox.
 */
export interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  positionalArgs?: boolean;
}

/**
 * An executor runs LLM-generated code in a sandbox, making the provided
 * tool functions callable under their namespace inside the sandbox.
 *
 * Implementations should never throw — errors are returned in `ExecuteResult.error`.
 */
export interface Executor {
  execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult>;
}
