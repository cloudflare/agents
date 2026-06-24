import type { CodeOutput } from "./shared";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { normalizeCode } from "./normalize";
import { CodemodeExecutionError } from "./retry";

export async function runCode({
  code,
  executor,
  providers,
  connectors
}: {
  code: string;
  executor: Executor;
  providers: ResolvedProvider[];
  connectors?: ConnectorBinding[];
}): Promise<CodeOutput> {
  const executeResult = await executor.execute(
    normalizeCode(code),
    providers,
    connectors?.length ? { connectors } : undefined
  );

  if (executeResult.error !== undefined) {
    const failure = executeResult.failure ?? {
      kind: "error" as const,
      message: executeResult.error
    };
    throw new CodemodeExecutionError(failure, executeResult.logs);
  }

  return executeResult.logs?.length
    ? { result: executeResult.result, logs: executeResult.logs }
    : { result: executeResult.result };
}
