import type { Executor, ResolvedProvider } from "./executor";
import { normalizeCode } from "./normalize";

export type CodeGlobals = Record<
  string,
  Record<string, (...args: unknown[]) => Promise<unknown> | unknown>
>;

export type ExecuteCodeOptions = {
  code: string;
  executor: Executor;
  globals?: CodeGlobals;
};

export type ExecuteCodeOutput = {
  code: string;
  result: unknown;
  logs?: string[];
};

export async function executeCode({
  code,
  executor,
  globals
}: ExecuteCodeOptions): Promise<ExecuteCodeOutput> {
  const executeResult = await executor.execute(
    normalizeCode(code),
    globals ? globalsToProviders(globals) : []
  );

  if (executeResult.error) {
    const logCtx = executeResult.logs?.length
      ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
      : "";
    throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
  }

  const output: ExecuteCodeOutput = { code, result: executeResult.result };
  if (executeResult.logs) output.logs = executeResult.logs;
  return output;
}

function globalsToProviders(globals: CodeGlobals): ResolvedProvider[] {
  return Object.entries(globals).map(([name, fns]) => ({
    name,
    fns: Object.fromEntries(
      Object.entries(fns).map(([fnName, fn]) => [
        fnName,
        async (...args: unknown[]) => fn(...args)
      ])
    )
  }));
}

export type { Executor };
