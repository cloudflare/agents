import {
  zodToTs,
  printNode as printNodeZodToTs,
  createTypeAlias,
  createAuxiliaryTypeStore
} from "zod-to-ts";
import type { ZodType } from "zod";
import type { ToolSet } from "ai";
import { fromJSONSchema } from "zod/v4";
import type { JSONSchema7 } from "json-schema";

const JS_RESERVED = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield"
]);

/**
 * Sanitize a tool name into a valid JavaScript identifier.
 * Replaces hyphens, dots, and spaces with `_`, strips other invalid chars,
 * prefixes digit-leading names with `_`, and appends `_` to JS reserved words.
 */
export function sanitizeToolName(name: string): string {
  if (!name) return "_";

  // Replace common separators with underscores
  let sanitized = name.replace(/[-.\s]/g, "_");

  // Strip any remaining non-identifier characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");

  if (!sanitized) return "_";

  // Prefix with _ if starts with a digit
  if (/^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }

  // Append _ to reserved words
  if (JS_RESERVED.has(sanitized)) {
    sanitized = sanitized + "_";
  }

  return sanitized;
}

function toCamelCase(str: string) {
  return str
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

/**
 * Extract field descriptions from a schema and format as @param lines.
 * Returns an array of `@param input.fieldName - description` lines.
 */
function extractParamDescriptions(schema: unknown): string[] {
  const descriptions = extractDescriptions(schema);
  return Object.entries(descriptions).map(
    ([fieldName, desc]) => `@param input.${fieldName} - ${desc}`
  );
}

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
 * Check if a value is an AI SDK jsonSchema wrapper.
 * The jsonSchema wrapper has a [Symbol] with jsonSchema property.
 */
function isJsonSchemaWrapper(
  value: unknown
): value is { jsonSchema: JSONSchema7 } {
  if (value === null || typeof value !== "object") return false;

  // AI SDK jsonSchema wrapper stores data in a symbol property
  // but also exposes jsonSchema directly in some versions
  if ("jsonSchema" in value) {
    return true;
  }

  // Check for symbol-based storage (AI SDK internal)
  const symbols = Object.getOwnPropertySymbols(value);
  for (const sym of symbols) {
    const symValue = (value as Record<symbol, unknown>)[sym];
    if (
      symValue &&
      typeof symValue === "object" &&
      "jsonSchema" in symValue
    ) {
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

  // Direct property access
  if ("jsonSchema" in wrapper) {
    return (wrapper as { jsonSchema: JSONSchema7 }).jsonSchema;
  }

  // Symbol-based storage
  const symbols = Object.getOwnPropertySymbols(wrapper);
  for (const sym of symbols) {
    const symValue = (wrapper as Record<symbol, unknown>)[sym];
    if (
      symValue &&
      typeof symValue === "object" &&
      "jsonSchema" in symValue
    ) {
      return (symValue as { jsonSchema: JSONSchema7 }).jsonSchema;
    }
  }

  return null;
}

/**
 * Check if a value looks like a raw JSON Schema object.
 */
function isRawJsonSchema(value: unknown): value is JSONSchema7 {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // JSON Schema typically has "type" or "$schema" or "properties"
  return (
    "type" in obj ||
    "$schema" in obj ||
    "properties" in obj ||
    "items" in obj ||
    "anyOf" in obj ||
    "oneOf" in obj ||
    "allOf" in obj
  );
}

/**
 * Normalize a schema to a Zod schema.
 * Handles: Zod schemas, AI SDK jsonSchema wrappers, and raw JSON schemas.
 */
function normalizeToZodSchema(schema: unknown): ZodType | null {
  // Already a Zod schema
  if (isZodSchema(schema)) {
    return schema;
  }

  // AI SDK jsonSchema wrapper
  if (isJsonSchemaWrapper(schema)) {
    const jsonSchema = extractJsonSchema(schema);
    if (jsonSchema) {
      try {
        return fromJSONSchema(
          jsonSchema as Parameters<typeof fromJSONSchema>[0]
        ) as unknown as ZodType;
      } catch {
        return null;
      }
    }
  }

  // Raw JSON Schema
  if (isRawJsonSchema(schema)) {
    try {
      return fromJSONSchema(
        schema as Parameters<typeof fromJSONSchema>[0]
      ) as unknown as ZodType;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Extract field descriptions from a schema.
 * Works with Zod schemas (via .shape) and JSON schemas (via .properties).
 */
function extractDescriptions(schema: unknown): Record<string, string> {
  const descriptions: Record<string, string> = {};

  // Try Zod schema shape
  const shape = (schema as { shape?: Record<string, ZodType> }).shape;
  if (shape && typeof shape === "object") {
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const desc = (fieldSchema as { description?: string }).description;
      if (desc) {
        descriptions[fieldName] = desc;
      }
    }
    return descriptions;
  }

  // Try JSON Schema properties (for jsonSchema wrapper or raw JSON schema)
  let jsonSchema: JSONSchema7 | null = null;
  if (isJsonSchemaWrapper(schema)) {
    jsonSchema = extractJsonSchema(schema);
  } else if (isRawJsonSchema(schema)) {
    jsonSchema = schema;
  }

  if (jsonSchema?.properties) {
    for (const [fieldName, propSchema] of Object.entries(jsonSchema.properties)) {
      if (typeof propSchema === "object" && propSchema.description) {
        descriptions[fieldName] = propSchema.description;
      }
    }
  }

  return descriptions;
}

/**
 * Safely convert a schema to TypeScript type string.
 * Handles Zod schemas, AI SDK jsonSchema wrappers, and raw JSON schemas.
 * Returns "unknown" if the schema cannot be represented in TypeScript.
 */
function safeSchemaToTs(
  schema: unknown,
  typeName: string,
  auxiliaryTypeStore: ReturnType<typeof createAuxiliaryTypeStore>
): string {
  try {
    const zodSchema = normalizeToZodSchema(schema);
    if (!zodSchema) {
      return `type ${typeName} = unknown`;
    }
    const result = zodToTs(zodSchema, { auxiliaryTypeStore });
    return printNodeZodToTs(createTypeAlias(result.node, typeName));
  } catch {
    // If the schema cannot be represented (e.g., transform), fall back to unknown
    return `type ${typeName} = unknown`;
  }
}

/**
 * Generate TypeScript type definitions from tool descriptors or an AI SDK ToolSet.
 * These types can be included in tool descriptions to help LLMs write correct code.
 */
export function generateTypes(tools: ToolDescriptors | ToolSet): string {
  let availableTools = "";
  let availableTypes = "";

  const auxiliaryTypeStore = createAuxiliaryTypeStore();

  for (const [toolName, tool] of Object.entries(tools)) {
    // Handle both our ToolDescriptor and AI SDK Tool types
    const inputSchema =
      "inputSchema" in tool ? tool.inputSchema : tool.parameters;
    const outputSchema = "outputSchema" in tool ? tool.outputSchema : undefined;
    const description = tool.description;

    const safeName = sanitizeToolName(toolName);

    const inputType = safeSchemaToTs(
      inputSchema,
      `${toCamelCase(safeName)}Input`,
      auxiliaryTypeStore
    );

    const outputType = outputSchema
      ? safeSchemaToTs(
          outputSchema,
          `${toCamelCase(safeName)}Output`,
          auxiliaryTypeStore
        )
      : `type ${toCamelCase(safeName)}Output = unknown`;

    availableTypes += `\n${inputType.trim()}`;
    availableTypes += `\n${outputType.trim()}`;

    // Build JSDoc comment with description and param descriptions
    const paramDescs = extractParamDescriptions(inputSchema);
    const jsdocLines: string[] = [];
    if (description?.trim()) {
      jsdocLines.push(description.trim());
    } else {
      jsdocLines.push(toolName);
    }
    for (const pd of paramDescs) {
      jsdocLines.push(pd);
    }

    const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
    availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
    availableTools += `\n\t${safeName}: (input: ${toCamelCase(safeName)}Input) => Promise<${toCamelCase(safeName)}Output>;`;
    availableTools += "\n";
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
