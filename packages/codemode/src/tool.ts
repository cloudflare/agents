import { tool, type Tool, asSchema } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import * as acorn from "acorn";
import { generateTypes, sanitizeToolName, type ToolDescriptors } from "./types";
import type { Executor } from "./executor";

const DEFAULT_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

export interface CreateCodeToolOptions {
  tools: ToolDescriptors | ToolSet;
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

function normalizeCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "async () => {}";

  try {
    const ast = acorn.parse(trimmed, {
      ecmaVersion: "latest",
      sourceType: "module"
    });

    // Already an arrow function — pass through
    if (ast.body.length === 1 && ast.body[0].type === "ExpressionStatement") {
      const expr = (ast.body[0] as acorn.ExpressionStatement).expression;
      if (expr.type === "ArrowFunctionExpression") return trimmed;
    }

    // Last statement is expression → splice in return
    const last = ast.body[ast.body.length - 1];
    if (last?.type === "ExpressionStatement") {
      const exprStmt = last as acorn.ExpressionStatement;
      const before = trimmed.slice(0, last.start);
      const exprText = trimmed.slice(
        exprStmt.expression.start,
        exprStmt.expression.end
      );
      return `async () => {\n${before}return (${exprText})\n}`;
    }

    return `async () => {\n${trimmed}\n}`;
  } catch {
    return `async () => {\n${trimmed}\n}`;
  }
}

/**
 * Create a codemode tool that allows LLMs to write and execute code
 * with access to your tools in a sandboxed environment.
 *
 * Returns an AI SDK compatible tool.
 */
function hasNeedsApproval(t: Record<string, unknown>): boolean {
  return "needsApproval" in t && t.needsApproval != null;
}

export function createCodeTool(
  options: CreateCodeToolOptions
): Tool<CodeInput, CodeOutput> {
  const tools: ToolDescriptors | ToolSet = {};
  for (const [name, t] of Object.entries(options.tools)) {
    if (!hasNeedsApproval(t as Record<string, unknown>)) {
      (tools as Record<string, unknown>)[name] = t;
    }
  }

  const types = generateTypes(tools);
  const executor = options.executor;

  const description = (options.description ?? DEFAULT_DESCRIPTION).replace(
    "{{types}}",
    types
  );

  return tool({
    description,
    inputSchema: codeSchema,
    execute: async ({ code }) => {
      // Extract execute functions from tools, keyed by name.
      // Wrap each with its schema so arguments from the sandbox
      // are validated before reaching the tool function.
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

          // Use AI SDK's asSchema() to normalize any schema type
          // (Zod v3/v4, Standard Schema, JSON Schema) into a unified
          // Schema with an optional .validate() method.
          const schema = rawSchema != null ? asSchema(rawSchema) : undefined;

          fns[sanitizeToolName(name)] = schema?.validate
            ? async (args: unknown) => {
                const result = await schema.validate!(args);
                if (!result.success) throw result.error;
                return execute(result.value);
              }
            : execute;
        }
      }

      const normalizedCode = normalizeCode(code);

      const executeResult = await executor.execute(normalizedCode, fns);

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
