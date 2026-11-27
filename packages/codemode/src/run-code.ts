import type { CodeOutput } from "./shared";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { normalizeCode } from "./normalize";
import { truncateResponse, truncateResult } from "./truncate";

/** Character budget for what a code tool returns to the model (~6,000 tokens). */
const MAX_OUTPUT_CHARS = 24_000;

export async function runCode({
  code,
  executor,
  providers,
  connectors,
}: {
  code: string;
  executor: Executor;
  providers: ResolvedProvider[];
  connectors?: ConnectorBinding[];
}): Promise<CodeOutput> {
  const executeResult = await executor.execute(
    normalizeCode(code),
    providers,
    connectors?.length ? { connectors } : undefined,
  );

  if (executeResult.error) {
    const logCtx = executeResult.logs?.length
      ? `\n\nConsole output:\n${truncateResponse(
          executeResult.logs.join("\n"),
          { maxChars: MAX_OUTPUT_CHARS },
        )}`
      : "";
    throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
  }

  return executeResult.logs?.length
    ? { result: executeResult.result, logs: executeResult.logs }
    : { result: executeResult.result };
}

/**
 * `runCode` with its output bounded for the model: `result` and `logs` are
 * truncated structurally to a shared budget, with `--- TRUNCATED ---` markers
 * where content was cut. Small outputs pass through unchanged.
 */
export async function runCodeForModel(
  options: Parameters<typeof runCode>[0],
): Promise<CodeOutput> {
  const output = await runCode(options);
  return truncateResult(output, { maxChars: MAX_OUTPUT_CHARS }) as CodeOutput;
}
