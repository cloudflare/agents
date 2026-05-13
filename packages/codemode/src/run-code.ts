import type { Executor, ResolvedProvider } from "./executor";
import { normalizeCode } from "./normalize";

export type RunCodeOptions = {
  code: string;
  executor: Executor;
  providers?: ResolvedProvider[];
};

export type RunCodeOutput = {
  code: string;
  result: unknown;
  logs?: string[];
};

export async function runCode(options: RunCodeOptions): Promise<RunCodeOutput> {
  const executeResult = await options.executor.execute(
    normalizeCode(options.code),
    options.providers ?? []
  );

  if (executeResult.error) {
    const logCtx = executeResult.logs?.length
      ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
      : "";
    throw new Error(`${executeResult.error}${logCtx}`);
  }

  const output: RunCodeOutput = {
    code: options.code,
    result: executeResult.result
  };
  if (executeResult.logs) output.logs = executeResult.logs;
  return output;
}
