/**
 * Zero-dependency browser counterpart to `createCodeTool` from `./ai`.
 *
 * Returns a plain JSON Schema tool descriptor instead of an AI SDK `Tool`.
 * No `ai`, no `zod` — just JSON Schema and browser APIs. JSON Schema is used
 * for generated types only; this helper does not perform runtime validation.
 */

import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptor,
  type JsonSchemaToolDescriptors
} from "./json-schema-types";
import { normalizeCode } from "./normalize";
import { sanitizeToolName } from "./utils";
import type { Executor, ResolvedProvider } from "./executor-types";
import { IframeSandboxExecutor } from "./iframe-executor";

// -- Types --

/**
 * A JSON Schema tool descriptor with an execute function attached.
 */
export interface JsonSchemaExecutableToolDescriptor extends JsonSchemaToolDescriptor {
  name?: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export type JsonSchemaExecutableToolDescriptors = Record<
  string,
  JsonSchemaExecutableToolDescriptor
>;

interface ApprovalAwareJsonSchemaExecutableToolDescriptor extends JsonSchemaExecutableToolDescriptor {
  needsApproval?: boolean | ((...args: unknown[]) => unknown);
}

type ApprovalAwareJsonSchemaExecutableToolDescriptors = Record<
  string,
  ApprovalAwareJsonSchemaExecutableToolDescriptor
>;

export interface BrowserCodeToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: {
      code: { type: "string"; description: string };
    };
    required: ["code"];
  };
  outputSchema: {
    type: "object";
    properties: {
      code: { type: "string"; description: string };
      result: { description: string };
      logs: {
        type: "array";
        items: { type: "string" };
        description: string;
      };
    };
    required: ["code", "result"];
  };
  execute: (args: {
    code: string;
  }) => Promise<{ code: string; result: unknown; logs?: string[] }>;
}

export interface CreateBrowserCodeToolOptions {
  /**
   * Tools available inside the sandbox via `codemode.*`.
   *
   * Accepts either an array (like `listTools()` returns) with `name` on each item,
   * or an object keyed by tool name (like `createCodeTool` expects).
   */
  tools:
    | ApprovalAwareJsonSchemaExecutableToolDescriptor[]
    | ApprovalAwareJsonSchemaExecutableToolDescriptors;
  /**
   * Executor to use. Defaults to a new `IframeSandboxExecutor`.
   */
  executor?: Executor;
  /**
   * Custom tool description. Use `{{types}}` as a placeholder for generated type definitions.
   */
  description?: string;
}

// -- Implementation --

const DEFAULT_DESCRIPTION = `Execute code to achieve a goal.

Available:
{{types}}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax — no type annotations, interfaces, or generics.
Do NOT define named functions then call them — just write the arrow function body directly.

Example: async () => { const r = await codemode.searchWeb({ query: "test" }); return r; }`;

function toRecord(
  tools:
    | ApprovalAwareJsonSchemaExecutableToolDescriptor[]
    | ApprovalAwareJsonSchemaExecutableToolDescriptors
): ApprovalAwareJsonSchemaExecutableToolDescriptors {
  if (!Array.isArray(tools)) return tools;

  const record: ApprovalAwareJsonSchemaExecutableToolDescriptors = {};
  for (const tool of tools) {
    if (!tool.name) {
      throw new Error(
        "Tool descriptors in array form must have a `name` property"
      );
    }
    record[tool.name] = tool;
  }
  return record;
}

function hasNeedsApproval(tool: Record<string, unknown>): boolean {
  return "needsApproval" in tool && tool.needsApproval != null;
}

/**
 * Create a codemode tool descriptor using only JSON Schema and browser APIs.
 *
 * This is the browser counterpart to `createCodeTool` from
 * `@cloudflare/codemode/ai`.
 * It returns a plain object with `{ name, description, inputSchema, outputSchema, execute }`
 * that can be passed to any framework — including
 * `navigator.modelContext.registerTool()`.
 *
 * Tools with `needsApproval` are excluded, matching the current codemode
 * behavior for approval-gated tools. JSON Schema is used for prompt/type
 * generation only and is not enforced at runtime.
 */
export function createBrowserCodeTool(
  options: CreateBrowserCodeToolOptions
): BrowserCodeToolDescriptor {
  const allTools = toRecord(options.tools);
  const toolMap: JsonSchemaExecutableToolDescriptors = {};
  for (const [name, tool] of Object.entries(allTools)) {
    if (!hasNeedsApproval(tool as unknown as Record<string, unknown>)) {
      toolMap[name] = tool;
    }
  }
  const executor = options.executor ?? new IframeSandboxExecutor();

  // Generate TypeScript type descriptions for the LLM prompt
  const schemaOnly: JsonSchemaToolDescriptors = {};
  for (const [name, tool] of Object.entries(toolMap)) {
    schemaOnly[name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema
    };
  }
  const types = generateTypesFromJsonSchema(schemaOnly);

  const description = (options.description ?? DEFAULT_DESCRIPTION).replace(
    "{{types}}",
    types
  );

  // Extract execute functions, keyed by sanitized name
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, tool] of Object.entries(toolMap)) {
    if (tool.execute) {
      fns[sanitizeToolName(name)] = tool.execute as (
        args: unknown
      ) => Promise<unknown>;
    }
  }
  const resolvedProviders: ResolvedProvider[] = [{ name: "codemode", fns }];

  return {
    name: "codemode",
    description,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript async arrow function to execute"
        }
      },
      required: ["code"]
    },
    outputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The original code that was executed"
        },
        result: {
          description: "The return value of the executed code"
        },
        logs: {
          type: "array",
          items: { type: "string" },
          description: "Console output captured during execution"
        }
      },
      required: ["code", "result"]
    },
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

      const output: { code: string; result: unknown; logs?: string[] } = {
        code,
        result: executeResult.result
      };
      if (executeResult.logs) output.logs = executeResult.logs;
      return output;
    }
  };
}
