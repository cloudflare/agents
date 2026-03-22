/**
 * TanStack AI integration for codemode.
 *
 * Provides the same capabilities as `@cloudflare/codemode/ai` but returns
 * TanStack AI-compatible tools for use with `chat()` from `@tanstack/ai`.
 *
 * @example
 * ```ts
 * import { createCodeTool, tanstackTools } from "@cloudflare/codemode/tanstack-ai";
 * import { chat } from "@tanstack/ai";
 *
 * const codeTool = createCodeTool({
 *   tools: [tanstackTools(myServerTools)],
 *   executor,
 * });
 *
 * const stream = chat({
 *   adapter: openaiText("gpt-4o"),
 *   tools: [codeTool],
 *   messages,
 * });
 * ```
 */

import { toolDefinition, convertSchemaToJsonSchema } from "@tanstack/ai";
import type {
  Tool as TanStackTool,
  ServerTool,
  JSONSchema as TanStackJSONSchema
} from "@tanstack/ai";
import { z } from "zod";
import type { JSONSchema7 } from "json-schema";
import type {
  ToolProvider,
  ToolProviderTools,
  ResolvedProvider,
  SimpleToolRecord
} from "./executor";
import { normalizeCode } from "./normalize";
import { filterTools, extractFns } from "./resolve";
import {
  DEFAULT_DESCRIPTION,
  type CreateCodeToolOptions,
  type CodeOutput,
  normalizeProviders
} from "./shared";
import { jsonSchemaToType } from "./json-schema-types";
import { sanitizeToolName, toPascalCase, escapeJsDoc } from "./utils";

export type { CreateCodeToolOptions, CodeInput, CodeOutput } from "./shared";
export { DEFAULT_DESCRIPTION, normalizeProviders } from "./shared";
export { resolveProvider } from "./resolve";

const codeSchema = z.object({
  code: z
    .string()
    .meta({ description: "JavaScript async arrow function to execute" })
});

/**
 * Convert a TanStack AI schema (StandardJSONSchema or plain JSONSchema) to
 * a JSON Schema 7 object usable by the core type generator.
 */
function toJsonSchema7(schema: unknown): JSONSchema7 | null {
  const converted = convertSchemaToJsonSchema(schema as TanStackJSONSchema);
  if (!converted) return null;
  return converted as unknown as JSONSchema7;
}

/**
 * Generate TypeScript type definitions from an array of TanStack AI tools.
 *
 * Uses the tools' schemas (Zod, ArkType, JSON Schema, etc.) to produce type
 * declarations that the LLM sees in the code-tool description.
 */
export function generateTypes(
  tools: TanStackTool[],
  namespace = "codemode"
): string {
  let availableTools = "";
  let availableTypes = "";

  for (const tool of tools) {
    const safeName = sanitizeToolName(tool.name);
    const typeName = toPascalCase(safeName);

    try {
      const inputJsonSchema = tool.inputSchema
        ? toJsonSchema7(tool.inputSchema)
        : null;
      const outputJsonSchema = tool.outputSchema
        ? toJsonSchema7(tool.outputSchema)
        : null;

      const inputType = inputJsonSchema
        ? jsonSchemaToType(inputJsonSchema, `${typeName}Input`)
        : `type ${typeName}Input = unknown`;

      const outputType = outputJsonSchema
        ? jsonSchemaToType(outputJsonSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramDescs = (() => {
        try {
          if (!inputJsonSchema?.properties) return [];
          return Object.entries(inputJsonSchema.properties)
            .filter(
              ([, propSchema]) =>
                propSchema &&
                typeof propSchema === "object" &&
                (propSchema as JSONSchema7).description
            )
            .map(
              ([fieldName, propSchema]) =>
                `@param input.${fieldName} - ${(propSchema as JSONSchema7).description}`
            );
        } catch {
          return [];
        }
      })();

      const jsdocLines: string[] = [];
      if (tool.description?.trim()) {
        jsdocLines.push(
          escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " "))
        );
      } else {
        jsdocLines.push(escapeJsDoc(tool.name));
      }
      for (const pd of paramDescs) {
        jsdocLines.push(escapeJsDoc(pd.replace(/\r?\n/g, " ")));
      }

      const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
      availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    } catch {
      availableTypes += `\ntype ${typeName}Input = unknown`;
      availableTypes += `\ntype ${typeName}Output = unknown`;

      availableTools += `\n\t/**\n\t * ${escapeJsDoc(tool.name)}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
      availableTools += "\n";
    }
  }

  availableTools = `\ndeclare const ${namespace}: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}

/**
 * Wrap TanStack AI tools into a ToolProvider for use with `createCodeTool`.
 *
 * Converts the array-based TanStack tool format into the record-based
 * ToolProvider that the codemode executor expects.
 *
 * @example
 * ```ts
 * import { createCodeTool, tanstackTools } from "@cloudflare/codemode/tanstack-ai";
 *
 * const codeTool = createCodeTool({
 *   tools: [
 *     tanstackTools(myServerTools),
 *     tanstackTools(otherTools, "other"),
 *   ],
 *   executor,
 * });
 * ```
 */
export function tanstackTools(
  tools: TanStackTool[],
  name?: string
): ToolProvider {
  const filtered = tools.filter(
    (t) => !("needsApproval" in t && t.needsApproval != null)
  );

  const toolRecord: SimpleToolRecord = {};
  for (const tool of filtered) {
    if (tool.execute) {
      toolRecord[tool.name] = {
        description: tool.description,
        execute: async (args: unknown) => tool.execute!(args)
      };
    }
  }

  const ns = name ?? "codemode";
  const types = generateTypes(filtered, ns);

  return { name: ns === "codemode" ? undefined : ns, tools: toolRecord, types };
}

/**
 * Create a codemode tool that allows LLMs to write and execute code
 * with access to your tools in a sandboxed environment.
 *
 * Returns a TanStack AI `ServerTool` compatible with `chat()` from `@tanstack/ai`.
 *
 * @example Basic usage
 * ```ts
 * const codeTool = createCodeTool({
 *   tools: [tanstackTools(myTools)],
 *   executor,
 * });
 *
 * const stream = chat({
 *   adapter: openaiText("gpt-4o"),
 *   tools: [codeTool],
 *   messages,
 * });
 * ```
 *
 * @example Multiple namespaces
 * ```ts
 * createCodeTool({
 *   tools: [
 *     tanstackTools(githubTools, "github"),
 *     tanstackTools(dbTools, "db"),
 *   ],
 *   executor,
 * });
 * ```
 */
export function createCodeTool(options: CreateCodeToolOptions): ServerTool {
  const providers = normalizeProviders(options.tools);

  const typeBlocks: string[] = [];
  const resolvedProviders: ResolvedProvider[] = [];

  for (const provider of providers) {
    const providerName = provider.name ?? "codemode";
    const filtered = filterTools(provider.tools);

    const types =
      provider.types ?? generateTypesFromRecord(filtered, providerName);
    typeBlocks.push(types);

    resolvedProviders.push({ name: providerName, fns: extractFns(filtered) });
  }

  const typeBlock = typeBlocks.filter(Boolean).join("\n\n");
  const executor = options.executor;

  const description = (options.description ?? DEFAULT_DESCRIPTION).replace(
    "{{types}}",
    typeBlock
  );

  const def = toolDefinition({
    name: "codemode_execute" as const,
    description,
    inputSchema: codeSchema
  });

  return def.server(async ({ code }) => {
    const normalizedCode = normalizeCode(code);

    const executeResult = await executor.execute(
      normalizedCode,
      resolvedProviders
    );

    if (executeResult.error) {
      const logCtx = executeResult.logs?.length
        ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
        : "";
      throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
    }

    const output: CodeOutput = { code, result: executeResult.result };
    if (executeResult.logs) output.logs = executeResult.logs;
    return output;
  });
}

/**
 * Generate types from a ToolProviderTools record.
 * Falls back to the JSON Schema generator for SimpleToolRecord.
 */
function generateTypesFromRecord(
  tools: ToolProviderTools,
  namespace: string
): string {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safeName = sanitizeToolName(toolName);
    const typeName = toPascalCase(safeName);
    const description =
      "description" in tool
        ? (tool as Record<string, unknown>).description
        : undefined;

    availableTypes += `\ntype ${typeName}Input = unknown`;
    availableTypes += `\ntype ${typeName}Output = unknown`;

    const descStr =
      typeof description === "string" && description.trim()
        ? escapeJsDoc(description.trim().replace(/\r?\n/g, " "))
        : escapeJsDoc(toolName);

    availableTools += `\n\t/**\n\t * ${descStr}\n\t */`;
    availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
    availableTools += "\n";
  }

  availableTools = `\ndeclare const ${namespace}: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
