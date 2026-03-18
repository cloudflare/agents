import { tool, type Tool, asSchema } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import { generateTypes, type ToolDescriptors } from "./tool-types";
import type {
  Executor,
  ToolProvider,
  ToolProviderTools,
  ResolvedProvider
} from "./executor";
import { normalizeCode } from "./normalize";

const DEFAULT_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

export interface CreateCodeToolOptions {
  tools: ToolProviderTools | ToolProvider[];
  executor: Executor;
  /**
   * Custom tool description. Use {{types}} as a placeholder for the generated type definitions.
   */
  description?: string;
}

const codeSchema = z.object({
  code: z.string().describe("JavaScript async arrow function to execute")
});

type CodeInput = z.infer<typeof codeSchema>;
type CodeOutput = { code: string; result: unknown; logs?: string[] };

/**
 * Create a codemode tool that allows LLMs to write and execute code
 * with access to your tools in a sandboxed environment.
 *
 * Returns an AI SDK compatible tool.
 *
 * @example Raw tools (backwards compatible)
 * ```ts
 * createCodeTool({ tools: myToolSet, executor });
 * ```
 *
 * @example ToolProvider array with namespaces
 * ```ts
 * createCodeTool({
 *   tools: [
 *     { name: "github", tools: githubTools },
 *     { name: "state", tools: stateTools },
 *     { tools: aiTools }, // default "codemode" namespace
 *   ],
 *   executor,
 * });
 * ```
 */
function hasNeedsApproval(t: Record<string, unknown>): boolean {
  return "needsApproval" in t && t.needsApproval != null;
}

/**
 * Check if the tools option is an array of ToolProviders.
 * A plain ToolSet/ToolDescriptors is a Record (not an array).
 */
function isToolProviderArray(
  tools: ToolProviderTools | ToolProvider[]
): tools is ToolProvider[] {
  return Array.isArray(tools);
}

/**
 * Normalize the tools option into a list of ToolProviders.
 * Raw ToolSet/ToolDescriptors are wrapped as a single default provider.
 */
function normalizeProviders(
  tools: ToolProviderTools | ToolProvider[]
): ToolProvider[] {
  if (isToolProviderArray(tools)) {
    return tools;
  }
  return [{ tools }];
}

/**
 * Filter out tools with needsApproval and return a clean copy.
 */
function filterTools(tools: ToolProviderTools): ToolProviderTools {
  const filtered: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!hasNeedsApproval(t as Record<string, unknown>)) {
      filtered[name] = t;
    }
  }
  return filtered as ToolProviderTools;
}

/**
 * Extract execute functions from tools, keyed by name.
 * Wraps each with schema validation when available.
 * Note: tool name sanitization happens in the executor, not here.
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
 * Resolve a ToolProvider into a ResolvedProvider ready for execution.
 * Filters out tools with `needsApproval`, validates schemas, and sanitizes names.
 */
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
