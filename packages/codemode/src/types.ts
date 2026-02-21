import {
  zodToTs,
  printNode as printNodeZodToTs,
  createTypeAlias,
  createAuxiliaryTypeStore
} from "zod-to-ts";
import type { ZodType } from "zod";
import type { ToolSet } from "ai";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

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
 * Check if a property name needs quoting in TypeScript.
 */
function needsQuotes(name: string): boolean {
  // Valid JS identifier: starts with letter, $, or _, followed by letters, digits, $, _
  return !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/**
 * Quote a property name if needed.
 */
function quoteProp(name: string): string {
  if (needsQuotes(name)) {
    return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return name;
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 * This is a direct conversion without going through Zod.
 */
function jsonSchemaToTypeString(
  schema: JSONSchema7Definition,
  indent: string = ""
): string {
  // Handle boolean schemas
  if (typeof schema === "boolean") {
    return schema ? "unknown" : "never";
  }

  // Handle anyOf/oneOf (union types)
  if (schema.anyOf) {
    const types = schema.anyOf.map((s) => jsonSchemaToTypeString(s, indent));
    return types.join(" | ");
  }
  if (schema.oneOf) {
    const types = schema.oneOf.map((s) => jsonSchemaToTypeString(s, indent));
    return types.join(" | ");
  }

  // Handle allOf (intersection types)
  if (schema.allOf) {
    const types = schema.allOf.map((s) => jsonSchemaToTypeString(s, indent));
    return types.join(" & ");
  }

  // Handle enum
  if (schema.enum) {
    return schema.enum
      .map((v) => (typeof v === "string" ? `"${v}"` : String(v)))
      .join(" | ");
  }

  // Handle const
  if (schema.const !== undefined) {
    return typeof schema.const === "string"
      ? `"${schema.const}"`
      : String(schema.const);
  }

  // Handle type
  const type = schema.type;

  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";

  if (type === "array") {
    if (schema.items) {
      const itemType = jsonSchemaToTypeString(schema.items, indent);
      return `${itemType}[]`;
    }
    return "unknown[]";
  }

  if (type === "object" || schema.properties) {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const lines: string[] = [];

    for (const [propName, propSchema] of Object.entries(props)) {
      if (typeof propSchema === "boolean") continue;

      const isRequired = required.has(propName);
      const propType = jsonSchemaToTypeString(propSchema, indent + "    ");
      const desc = propSchema.description;

      if (desc) {
        lines.push(`${indent}    /** ${desc} */`);
      }

      const quotedName = quoteProp(propName);
      const optionalMark = isRequired ? "" : "?";
      lines.push(`${indent}    ${quotedName}${optionalMark}: ${propType};`);
    }

    // Handle additionalProperties
    if (schema.additionalProperties && schema.additionalProperties !== false) {
      const valueType =
        schema.additionalProperties === true
          ? "unknown"
          : jsonSchemaToTypeString(schema.additionalProperties, indent + "    ");
      lines.push(`${indent}    [key: string]: ${valueType};`);
    }

    if (lines.length === 0) {
      return "Record<string, unknown>";
    }

    return `{\n${lines.join("\n")}\n${indent}}`;
  }

  // Handle array of types (e.g., ["string", "null"])
  if (Array.isArray(type)) {
    const types = type.map((t) => {
      if (t === "string") return "string";
      if (t === "number" || t === "integer") return "number";
      if (t === "boolean") return "boolean";
      if (t === "null") return "null";
      if (t === "array") return "unknown[]";
      if (t === "object") return "Record<string, unknown>";
      return "unknown";
    });
    return types.join(" | ");
  }

  return "unknown";
}

/**
 * Extract field descriptions from a schema.
 * Works with Zod schemas (via .shape) and jsonSchema wrappers (via .properties).
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

  // Try JSON Schema properties (for jsonSchema wrapper)
  if (isJsonSchemaWrapper(schema)) {
    const jsonSchema = extractJsonSchema(schema);
    if (jsonSchema?.properties) {
      for (const [fieldName, propSchema] of Object.entries(jsonSchema.properties)) {
        if (typeof propSchema === "object" && propSchema.description) {
          descriptions[fieldName] = propSchema.description;
        }
      }
    }
  }

  return descriptions;
}

/**
 * Safely convert a schema to TypeScript type string.
 * Handles Zod schemas and AI SDK jsonSchema wrappers.
 * Returns "unknown" if the schema cannot be represented in TypeScript.
 */
function safeSchemaToTs(
  schema: unknown,
  typeName: string,
  auxiliaryTypeStore: ReturnType<typeof createAuxiliaryTypeStore>
): string {
  try {
    // For Zod schemas, use zod-to-ts
    if (isZodSchema(schema)) {
      const result = zodToTs(schema, { auxiliaryTypeStore });
      return printNodeZodToTs(createTypeAlias(result.node, typeName));
    }

    // For JSON Schema wrapper, convert directly to TypeScript
    if (isJsonSchemaWrapper(schema)) {
      const jsonSchema = extractJsonSchema(schema);
      if (jsonSchema) {
        const typeBody = jsonSchemaToTypeString(jsonSchema);
        return `type ${typeName} = ${typeBody}`;
      }
    }

    return `type ${typeName} = unknown`;
  } catch {
    // If the schema cannot be represented, fall back to unknown
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
