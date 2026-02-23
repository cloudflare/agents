import {
  zodToTs,
  printNode as printNodeZodToTs,
  createTypeAlias,
  createAuxiliaryTypeStore
} from "zod-to-ts";
import type { ZodType } from "zod";
import type { ToolSet } from "ai";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

interface ConversionContext {
  root: JSONSchema7;
  depth: number;
  seen: Set<unknown>;
  maxDepth: number;
}

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

  // Direct property access
  if ("jsonSchema" in wrapper) {
    return (wrapper as { jsonSchema: JSONSchema7 }).jsonSchema;
  }

  // Symbol-based storage
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
 * Check if a property name needs quoting in TypeScript.
 */
function needsQuotes(name: string): boolean {
  // Valid JS identifier: starts with letter, $, or _, followed by letters, digits, $, _
  return !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/**
 * Escape a character as a unicode escape sequence if it is a control character.
 */
function escapeControlChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code <= 0x1f || code === 0x7f) {
    return "\\u" + code.toString(16).padStart(4, "0");
  }
  return ch;
}

/**
 * Quote a property name if needed.
 * Escapes backslashes, quotes, and control characters.
 */
function quoteProp(name: string): string {
  if (needsQuotes(name)) {
    let escaped = "";
    for (const ch of name) {
      if (ch === "\\") escaped += "\\\\";
      else if (ch === '"') escaped += '\\"';
      else if (ch === "\n") escaped += "\\n";
      else if (ch === "\r") escaped += "\\r";
      else if (ch === "\t") escaped += "\\t";
      else if (ch === "\u2028") escaped += "\\u2028";
      else if (ch === "\u2029") escaped += "\\u2029";
      else escaped += escapeControlChar(ch);
    }
    return `"${escaped}"`;
  }
  return name;
}

/**
 * Escape a string for use inside a double-quoted TypeScript string literal.
 * Handles backslashes, quotes, newlines, control characters, and line/paragraph separators.
 */
function escapeStringLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\u2028") out += "\\u2028";
    else if (ch === "\u2029") out += "\\u2029";
    else out += escapeControlChar(ch);
  }
  return out;
}

/**
 * Escape a string for use inside a JSDoc comment.
 * Prevents premature comment closure from star-slash sequences.
 */
function escapeJsDoc(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

/**
 * Resolve an internal JSON Pointer $ref (e.g. #/definitions/Foo) against the root schema.
 * Returns null for external URLs or unresolvable paths.
 */
function resolveRef(
  ref: string,
  root: JSONSchema7
): JSONSchema7Definition | null {
  // "#" is a valid self-reference to the root schema
  if (ref === "#") return root;

  if (!ref.startsWith("#/")) return null;

  const segments = ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) return null;
  }

  // Allow both object schemas and boolean schemas (true = any, false = never)
  if (typeof current === "boolean") return current;
  if (current === null || typeof current !== "object") return null;
  return current as JSONSchema7;
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 * This is a direct conversion without going through Zod.
 */
function jsonSchemaToTypeString(
  schema: JSONSchema7Definition,
  indent: string,
  ctx: ConversionContext
): string {
  // Handle boolean schemas
  if (typeof schema === "boolean") {
    return schema ? "unknown" : "never";
  }

  // Depth guard
  if (ctx.depth >= ctx.maxDepth) return "unknown";

  // Circular reference guard
  if (ctx.seen.has(schema)) return "unknown";

  const nextCtx: ConversionContext = {
    ...ctx,
    depth: ctx.depth + 1,
    seen: new Set([...ctx.seen, schema])
  };

  // Handle $ref
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, ctx.root);
    if (!resolved) return "unknown";
    return applyNullable(
      jsonSchemaToTypeString(resolved, indent, nextCtx),
      schema
    );
  }

  // Handle anyOf/oneOf (union types)
  if (schema.anyOf) {
    const types = schema.anyOf.map((s) =>
      jsonSchemaToTypeString(s, indent, nextCtx)
    );
    return applyNullable(types.join(" | "), schema);
  }
  if (schema.oneOf) {
    const types = schema.oneOf.map((s) =>
      jsonSchemaToTypeString(s, indent, nextCtx)
    );
    return applyNullable(types.join(" | "), schema);
  }

  // Handle allOf (intersection types)
  if (schema.allOf) {
    const types = schema.allOf.map((s) =>
      jsonSchemaToTypeString(s, indent, nextCtx)
    );
    return applyNullable(types.join(" & "), schema);
  }

  // Handle enum
  if (schema.enum) {
    if (schema.enum.length === 0) return "never";
    const result = schema.enum
      .map((v) => {
        if (v === null) return "null";
        if (typeof v === "string") return '"' + escapeStringLiteral(v) + '"';
        if (typeof v === "object") return JSON.stringify(v) ?? "unknown";
        return String(v);
      })
      .join(" | ");
    return applyNullable(result, schema);
  }

  // Handle const
  if (schema.const !== undefined) {
    const result =
      schema.const === null
        ? "null"
        : typeof schema.const === "string"
          ? '"' + escapeStringLiteral(schema.const) + '"'
          : typeof schema.const === "object"
            ? (JSON.stringify(schema.const) ?? "unknown")
            : String(schema.const);
    return applyNullable(result, schema);
  }

  // Handle type
  const type = schema.type;

  if (type === "string") return applyNullable("string", schema);
  if (type === "number" || type === "integer")
    return applyNullable("number", schema);
  if (type === "boolean") return applyNullable("boolean", schema);
  if (type === "null") return "null";

  if (type === "array") {
    // Tuple support: prefixItems (JSON Schema 2020-12)
    const prefixItems = (schema as Record<string, unknown>)
      .prefixItems as JSONSchema7Definition[];
    if (Array.isArray(prefixItems)) {
      const types = prefixItems.map((s) =>
        jsonSchemaToTypeString(s, indent, nextCtx)
      );
      return applyNullable(`[${types.join(", ")}]`, schema);
    }

    // Tuple support: items as array (draft-07)
    if (Array.isArray(schema.items)) {
      const types = schema.items.map((s) =>
        jsonSchemaToTypeString(s, indent, nextCtx)
      );
      return applyNullable(`[${types.join(", ")}]`, schema);
    }

    if (schema.items) {
      const itemType = jsonSchemaToTypeString(schema.items, indent, nextCtx);
      return applyNullable(`${itemType}[]`, schema);
    }
    return applyNullable("unknown[]", schema);
  }

  if (type === "object" || schema.properties) {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const lines: string[] = [];

    for (const [propName, propSchema] of Object.entries(props)) {
      if (typeof propSchema === "boolean") {
        const boolType = propSchema ? "unknown" : "never";
        const optionalMark = required.has(propName) ? "" : "?";
        lines.push(
          `${indent}    ${quoteProp(propName)}${optionalMark}: ${boolType};`
        );
        continue;
      }

      const isRequired = required.has(propName);
      const propType = jsonSchemaToTypeString(
        propSchema,
        indent + "    ",
        nextCtx
      );
      const desc = propSchema.description;
      const format = propSchema.format;

      if (desc || format) {
        const descText = desc
          ? escapeJsDoc(desc.replace(/\r?\n/g, " "))
          : undefined;
        const formatTag = format ? `@format ${escapeJsDoc(format)}` : undefined;

        if (descText && formatTag) {
          // Multi-line JSDoc when both description and format are present
          lines.push(`${indent}    /**`);
          lines.push(`${indent}     * ${descText}`);
          lines.push(`${indent}     * ${formatTag}`);
          lines.push(`${indent}     */`);
        } else {
          lines.push(`${indent}    /** ${descText ?? formatTag} */`);
        }
      }

      const quotedName = quoteProp(propName);
      const optionalMark = isRequired ? "" : "?";
      lines.push(`${indent}    ${quotedName}${optionalMark}: ${propType};`);
    }

    // Handle additionalProperties
    // NOTE: In TypeScript, an index signature [key: string]: T requires all
    // named properties to be assignable to T. If any named property has an
    // incompatible type, the generated type is invalid. We emit it anyway
    // since it's more informative for LLMs consuming these types.
    if (schema.additionalProperties) {
      const valueType =
        schema.additionalProperties === true
          ? "unknown"
          : jsonSchemaToTypeString(
              schema.additionalProperties,
              indent + "    ",
              nextCtx
            );
      lines.push(`${indent}    [key: string]: ${valueType};`);
    }

    if (lines.length === 0) {
      // additionalProperties: false means no keys allowed → empty object
      if (schema.additionalProperties === false) {
        return applyNullable("{}", schema);
      }
      return applyNullable("Record<string, unknown>", schema);
    }

    const result = `{\n${lines.join("\n")}\n${indent}}`;
    return applyNullable(result, schema);
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
    return applyNullable(types.join(" | "), schema);
  }

  return "unknown";
}

/**
 * Apply OpenAPI 3.0 `nullable: true` to a type result.
 */
function applyNullable(result: string, schema: unknown): string {
  if (
    result !== "unknown" &&
    result !== "never" &&
    (schema as Record<string, unknown>)?.nullable === true
  ) {
    return `${result} | null`;
  }
  return result;
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
        const ctx: ConversionContext = {
          root: jsonSchema,
          depth: 0,
          seen: new Set(),
          maxDepth: 20
        };
        const typeBody = jsonSchemaToTypeString(jsonSchema, "", ctx);
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
    const safeName = sanitizeToolName(toolName);
    const camelName = toCamelCase(safeName);

    try {
      // Handle both our ToolDescriptor and AI SDK Tool types
      const inputSchema =
        "inputSchema" in tool ? tool.inputSchema : tool.parameters;
      const outputSchema =
        "outputSchema" in tool ? tool.outputSchema : undefined;
      const description = tool.description;

      const inputType = safeSchemaToTs(
        inputSchema,
        `${camelName}Input`,
        auxiliaryTypeStore
      );

      const outputType = outputSchema
        ? safeSchemaToTs(outputSchema, `${camelName}Output`, auxiliaryTypeStore)
        : `type ${camelName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      // Build JSDoc comment with description and param descriptions
      const paramDescs = inputSchema
        ? extractParamDescriptions(inputSchema)
        : [];
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
      availableTools += `\n\t${safeName}: (input: ${camelName}Input) => Promise<${camelName}Output>;`;
      availableTools += "\n";
    } catch {
      // One bad tool should not break the others — emit unknown types
      availableTypes += `\ntype ${camelName}Input = unknown`;
      availableTypes += `\ntype ${camelName}Output = unknown`;

      availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
      availableTools += `\n\t${safeName}: (input: ${camelName}Input) => Promise<${camelName}Output>;`;
      availableTools += "\n";
    }
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
