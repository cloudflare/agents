import { asSchema } from "ai";
import type { ZodType } from "zod";
import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import { sanitizeToolName, toPascalCase, escapeJsDoc } from "./utils";
import {
  jsonSchemaToTypeString,
  type ConversionContext
} from "./json-schema-types";

export interface ToolDescriptor {
  description?: string;
  inputSchema: ZodType;
  outputSchema?: ZodType;
  execute?: (args: unknown) => Promise<unknown>;
}

export type ToolDescriptors = Record<string, ToolDescriptor>;

/**
 * Check if a value is a Zod schema (has _zod property).
 */
function isZodSchema(value: unknown): value is ZodType {
  return (
    value !== null &&
    typeof value === "object" &&
    "_zod" in value &&
    (value as { _zod?: unknown })._zod !== undefined
  );
}

/**
 * Check if a value conforms to the Standard Schema protocol (~standard).
 * This catches Zod v3 schemas (which expose ~standard but not _zod).
 */
function isStandardSchema(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "~standard" in value &&
    (value as Record<string, unknown>)["~standard"] !== undefined
  );
}

/**
 * Check if a value is an AI SDK jsonSchema wrapper.
 * The jsonSchema wrapper has a [Symbol] with jsonSchema property.
 */
function isJsonSchemaWrapper(
  value: unknown
): value is { jsonSchema: JSONSchema7 } {
  if (value === null || typeof value !== "object") return false;

  if ("jsonSchema" in value) {
    return true;
  }

  const symbols = Object.getOwnPropertySymbols(value);
  for (const sym of symbols) {
    const symValue = (value as Record<symbol, unknown>)[sym];
    if (symValue && typeof symValue === "object" && "jsonSchema" in symValue) {
      return true;
    }
  }

  return false;
}

/**
 * Extract JSON schema from an AI SDK jsonSchema wrapper.
 */
function extractJsonSchema(wrapper: unknown): JSONSchema7 | null {
  if (wrapper === null || typeof wrapper !== "object") return null;

  if ("jsonSchema" in wrapper) {
    return (wrapper as { jsonSchema: JSONSchema7 }).jsonSchema;
  }

  const symbols = Object.getOwnPropertySymbols(wrapper);
  for (const sym of symbols) {
    const symValue = (wrapper as Record<symbol, unknown>)[sym];
    if (symValue && typeof symValue === "object" && "jsonSchema" in symValue) {
      return (symValue as { jsonSchema: JSONSchema7 }).jsonSchema;
    }
  }

  return null;
}

/**
 * Extract field descriptions from a schema.
 * Works with Zod schemas (via .shape) and jsonSchema wrappers (via .properties).
 */
function extractDescriptions(schema: unknown): Record<string, string> {
  const descriptions: Record<string, string> = {};

  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  if (shape && typeof shape === "object") {
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      let s = fieldSchema as { description?: string; unwrap?: () => unknown };
      while (!s.description && typeof s.unwrap === "function") {
        s = s.unwrap() as typeof s;
      }
      if (s.description) {
        descriptions[fieldName] = s.description;
      }
    }
    return descriptions;
  }

  if (isJsonSchemaWrapper(schema)) {
    const jsonSchema = extractJsonSchema(schema);
    if (jsonSchema?.properties) {
      for (const [fieldName, propSchema] of Object.entries(
        jsonSchema.properties
      )) {
        if (
          propSchema &&
          typeof propSchema === "object" &&
          propSchema.description
        ) {
          descriptions[fieldName] = propSchema.description;
        }
      }
    }
  }

  return descriptions;
}

/**
 * Extract field descriptions from a schema and format as @param lines.
 */
function extractParamDescriptions(schema: unknown): string[] {
  const descriptions = extractDescriptions(schema);
  return Object.entries(descriptions).map(
    ([fieldName, desc]) => `@param input.${fieldName} - ${desc}`
  );
}

function jsonSchemaToTypeDecl(jsonSchema: JSONSchema7, typeName: string) {
  const ctx: ConversionContext = {
    root: jsonSchema,
    depth: 0,
    seen: new Set(),
    maxDepth: 20
  };
  return `type ${typeName} = ${jsonSchemaToTypeString(jsonSchema, "", ctx)}`;
}

/**
 * Safely convert a schema to TypeScript type string.
 * Handles Zod schemas (v3/v4) and AI SDK jsonSchema wrappers.
 */
function safeSchemaToTs(schema: unknown, typeName: string): string {
  try {
    if (isZodSchema(schema) || isStandardSchema(schema)) {
      const wrapped = asSchema(schema as ZodType);
      const jsonSchema = wrapped.jsonSchema as JSONSchema7;
      if (jsonSchema) return jsonSchemaToTypeDecl(jsonSchema, typeName);
    }

    if (isJsonSchemaWrapper(schema)) {
      const jsonSchema = extractJsonSchema(schema);
      if (jsonSchema) return jsonSchemaToTypeDecl(jsonSchema, typeName);
    }

    return `type ${typeName} = unknown`;
  } catch {
    return `type ${typeName} = unknown`;
  }
}

interface StandardJsonSchemaConverter {
  output?: (options: { target: "draft-07" }) => unknown;
}

/**
 * JSON Schema for the value a schema *produces*, from its Standard JSON
 * Schema converter (Zod 4, Valibot, ArkType, ...). AI SDK's `asSchema`
 * always converts the input side, which is wrong for a tool's output:
 * `.default()` fields come out optional and `.pipe()` keeps the pre-pipe
 * type.
 *
 * Returns `undefined` when the schema has no such converter (Zod 3,
 * `jsonSchema()` wrappers, whose input and output are the same). Throws when
 * the output can't be represented in JSON Schema (e.g. `.transform()`);
 * callers treat that as `unknown` rather than falling back to the input type.
 */
export function standardOutputJsonSchema(
  schema: unknown
): JSONSchema7 | undefined {
  if (!isStandardSchema(schema)) return undefined;
  const converter = (
    schema as { "~standard": { jsonSchema?: StandardJsonSchemaConverter } }
  )["~standard"].jsonSchema;
  if (typeof converter?.output !== "function") return undefined;
  return converter.output({ target: "draft-07" }) as JSONSchema7;
}

/** Like `safeSchemaToTs`, but types the value the schema produces. */
function safeOutputSchemaToTs(schema: unknown, typeName: string): string {
  let jsonSchema: JSONSchema7 | undefined;
  try {
    jsonSchema = standardOutputJsonSchema(schema);
  } catch {
    return `type ${typeName} = unknown`;
  }
  return jsonSchema
    ? jsonSchemaToTypeDecl(jsonSchema, typeName)
    : safeSchemaToTs(schema, typeName);
}

/**
 * Generate TypeScript type definitions from tool descriptors or an AI SDK ToolSet.
 * These types can be included in tool descriptions to help LLMs write correct code.
 *
 * Requires the `ai` peer dependency. For a version that works with plain JSON Schema
 * objects (no AI SDK), use `generateTypesFromJsonSchema` from the main entry point.
 */
export function generateTypes(
  tools: ToolDescriptors | ToolSet,
  namespace = "codemode"
): string {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safeName = sanitizeToolName(toolName);
    const typeName = toPascalCase(safeName);

    try {
      const inputSchema =
        "inputSchema" in tool ? tool.inputSchema : tool.parameters;
      const outputSchema =
        "outputSchema" in tool ? tool.outputSchema : undefined;
      const description = tool.description;

      const inputType = safeSchemaToTs(inputSchema, `${typeName}Input`);

      const outputType = outputSchema
        ? safeOutputSchemaToTs(outputSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramDescs = (() => {
        try {
          return inputSchema ? extractParamDescriptions(inputSchema) : [];
        } catch {
          return [];
        }
      })();
      const jsdocLines: string[] = [];
      if (description?.trim()) {
        jsdocLines.push(escapeJsDoc(description.trim().replace(/\r?\n/g, " ")));
      } else {
        jsdocLines.push(escapeJsDoc(toolName));
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

      availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
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
