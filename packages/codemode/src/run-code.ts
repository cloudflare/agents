import type { CodeResultTransform } from "./executor-types";
import type { CodeOutput } from "./shared";
import type { Executor, ResolvedProvider } from "./executor";
import { normalizeCode } from "./normalize";

export async function runCode({
  code,
  executor,
  providers,
  transformResult
}: {
  code: string;
  executor: Executor;
  providers: ResolvedProvider[];
  transformResult?: CodeResultTransform;
}): Promise<CodeOutput> {
  const executeResult = await executor.execute(normalizeCode(code), providers);

  if (executeResult.error) {
    const logCtx = executeResult.logs?.length
      ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
      : "";
    throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
  }

  const result = transformResult
    ? transformResult(executeResult.result)
    : executeResult.result;

  return executeResult.logs?.length
    ? { result, logs: executeResult.logs }
    : { result };
}
