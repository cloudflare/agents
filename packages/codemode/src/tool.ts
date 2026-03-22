import { tool, type Tool, asSchema } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import { generateTypes, type ToolDescriptors } from "./tool-types";
import type {
  ToolProvider,
  ToolProviderTools,
  ResolvedProvider
} from "./executor";
import { normalizeCode } from "./normalize";
import { filterTools } from "./resolve";
import {
  DEFAULT_DESCRIPTION,
  type CreateCodeToolOptions,
  type CodeInput,
  type CodeOutput,
  normalizeProviders
} from "./shared";
export type { CreateCodeToolOptions, CodeInput, CodeOutput } from "./shared";
export { DEFAULT_DESCRIPTION, normalizeProviders } from "./shared";

const codeSchema = z.object({
  code: z.string().describe("JavaScript async arrow function to execute")
});

/**
 * Extract execute functions from tools, keyed by name.
 * Wraps each with schema validation via AI SDK's `asSchema` when available.
 */
function extractFns(
  tools: ToolProviderTools
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  for (const [name, t] of Object.entries(tools)) {
    const execute =
      "execute" in t
        ? (t.execute as (args: unknown) => Promise<unknown>)
        : undefined;
    if (execute) {
      const rawSchema =
        "inputSchema" in t
          ? t.inputSchema
          : "parameters" in t
            ? (t as Record<string, unknown>).parameters
            : undefined;

      const schema = rawSchema != null ? asSchema(rawSchema) : undefined;

      fns[name] = schema?.validate
        ? async (args: unknown) => {
            const result = await schema.validate!(args);
            if (!result.success) throw result.error;
            return execute(result.value);
          }
        : execute;
    }
  }

  return fns;
}

/**
 * Wrap raw AI SDK tools into a ToolProvider under the default "codemode" namespace.
 *
 * @example
 * ```ts
 * createCodeTool({
 *   tools: [stateTools(workspace), aiTools(myTools)],
 *   executor,
 * });
 * ```
 */
export function aiTools(tools: ToolDescriptors | ToolSet): ToolProvider {
  return { tools };
}

/**
 * Resolve a ToolProvider into a ResolvedProvider ready for execution.
 * Filters out tools with `needsApproval` and validates inputs via AI SDK's `asSchema`.
 */
export function resolveProvider(provider: ToolProvider): ResolvedProvider {
  const name = provider.name ?? "codemode";
  const filtered = filterTools(provider.tools);
  const resolved: ResolvedProvider = { name, fns: extractFns(filtered) };
  if (provider.positionalArgs) resolved.positionalArgs = true;
  return resolved;
}

export function createCodeTool(
  options: CreateCodeToolOptions
): Tool<CodeInput, CodeOutput> {
  const providers = normalizeProviders(options.tools);

  // Build type block and resolved providers for each provider.
  const typeBlocks: string[] = [];
  const resolvedProviders: ResolvedProvider[] = [];

  for (const provider of providers) {
    const name = provider.name ?? "codemode";
    const filtered = filterTools(provider.tools);
    const types =
      provider.types ?? generateTypes(filtered as ToolDescriptors, name);
    typeBlocks.push(types);
    resolvedProviders.push({ name, fns: extractFns(filtered) });
  }

  const typeBlock = typeBlocks.filter(Boolean).join("\n\n");

  const executor = options.executor;

  const description = (options.description ?? DEFAULT_DESCRIPTION).replace(
    "{{types}}",
    typeBlock
  );

  return tool({
    description,
    inputSchema: codeSchema,
    execute: async ({ code }) => {
      const normalizedCode = normalizeCode(code);

      const executeResult = await executor.execute(
        normalizedCode,
        resolvedProviders
      );

      if (executeResult.error) {
        const logCtx = executeResult.logs?.length
          ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
          : "";
        throw new Error(
          `Code execution failed: ${executeResult.error}${logCtx}`
        );
      }

      const output: CodeOutput = { code, result: executeResult.result };
      if (executeResult.logs) output.logs = executeResult.logs;
      return output;
    }
  });
}
