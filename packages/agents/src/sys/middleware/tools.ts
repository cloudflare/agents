/**
 * Tool definition utilities matching AI SDK's `tool()` interface.
 * Adds `ToolContext` (agent, env, callId) to execute functions.
 */
import { type ZodType, type infer as ZodInfer } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolContext, ToolMeta, ToolJsonSchema } from "../types";
export type { ToolContext } from "../types";

// ============================================================
// Types
// ============================================================

/** Tool result - string, object, or null (for async tools like subagents) */
export type ToolResult = string | object | null;

/** Check if a value is a Zod schema */
function isZodSchema(value: unknown): value is ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "_def" in value &&
    "parse" in value
  );
}

/**
 * Internal representation with metadata attached.
 */
export type ToolFn<TInput = unknown> = ((
  input: TInput,
  ctx: ToolContext
) => Promise<ToolResult>) & {
  __tool?: ToolMeta;
};

// ============================================================
// Tool Factory
// ============================================================

/**
 * Define a tool with Zod or JSON Schema input and typed execute function.
 * Matches AI SDK's `tool()` interface but with required `execute` and `ToolContext`.
 *
 * @example
 * ```ts
 * import { tool, z } from 'agents/sys';
 *
 * const read_file = tool({
 *   name: 'read_file',
 *   description: 'Read a file from the filesystem',
 *   inputSchema: z.object({
 *     path: z.string().describe('File path to read'),
 *     offset: z.number().int().min(0).optional(),
 *     limit: z.number().int().min(1).optional(),
 *   }),
 *   execute: async ({ path, offset, limit }, ctx) => {
 *     // ctx.agent, ctx.env, ctx.callId available
 *     const content = await ctx.agent.fs.readFile(path);
 *     return content ?? `Error: File '${path}' not found`;
 *   },
 * });
 * ```
 */
export function tool<TSchema extends ZodType | ToolJsonSchema>(config: {
  name: string;
  description?: string;
  inputSchema: TSchema;
  execute: (
    input: TSchema extends ZodType<infer T> ? T : unknown,
    ctx: ToolContext
  ) => Promise<ToolResult>;
}): ToolFn<TSchema extends ZodType<infer T> ? T : unknown> {
  // Convert Zod schema to JSON Schema if needed
  let jsonSchema: ToolJsonSchema;
  if (isZodSchema(config.inputSchema)) {
    jsonSchema = zodToJsonSchema(config.inputSchema, {
      $refStrategy: "none",
      target: "openApi3"
    }) as ToolJsonSchema;
    delete jsonSchema.$schema;
  } else {
    jsonSchema = config.inputSchema;
  }

  type Inferred = TSchema extends ZodType<infer T> ? T : unknown;
  const fn = config.execute as ToolFn<Inferred>;
  fn.__tool = {
    name: config.name,
    description: config.description,
    parameters: jsonSchema
  };

  return fn;
}

// ============================================================
// Utilities
// ============================================================

/** Extract tool metadata from a tool function. */
export function getToolMeta(
  fn: ToolFn | { __tool?: ToolMeta },
  fallbackName?: string
): ToolMeta | null {
  const m = fn.__tool;
  return m ? m : fallbackName ? { name: fallbackName } : null;
}

/** Check if a function is a tool. */
export function isTool(fn: unknown): fn is ToolFn {
  return (
    typeof fn === "function" &&
    "__tool" in fn &&
    typeof (fn as ToolFn).__tool === "object"
  );
}

// Re-export Zod for convenience
export { z } from "zod";
