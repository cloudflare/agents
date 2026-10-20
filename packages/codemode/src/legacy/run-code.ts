import type { CodeOutput } from "./shared";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { normalizeCode } from "./normalize";

/**
 * @deprecated Legacy Code Mode API, feature-frozen and no longer maintained.
 * Use `exec` from `@cloudflare/computer`, with tools imported from `ws:tools`.
 * See https://github.com/cloudflare/agents/blob/main/docs/codemode/legacy.md
 */
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

  if (executeResult.error) {
    const logCtx = executeResult.logs?.length
      ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
      : "";
    throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
  }

  return executeResult.logs?.length
    ? { result: executeResult.result, logs: executeResult.logs }
    : { result: executeResult.result };
}
