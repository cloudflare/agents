import type { Executor } from "./executor";
import { normalizeCode } from "./normalize";
import { normalizeProviders, type CreateCodeToolOptions } from "./shared";
import { resolveProvider } from "./tool";

export type ExecuteCodeOptions = Pick<
  CreateCodeToolOptions,
  "tools" | "executor"
> & {
  code: string;
};

export type ExecuteCodeOutput = {
  code: string;
  result: unknown;
  logs?: string[];
};

export async function executeCode({
  code,
  executor,
  tools
}: ExecuteCodeOptions): Promise<ExecuteCodeOutput> {
  const executeResult = await executor.execute(
    normalizeCode(code),
    normalizeProviders(tools).map(resolveProvider)
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

export type { Executor };
