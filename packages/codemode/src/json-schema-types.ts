import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  sanitizeToolName,
  toPascalCase,
  escapeJsDoc,
  escapeStringLiteral,
  quoteProp
} from "./utils";

export interface ConversionContext {
  root: JSONSchema7;
  depth: number;
  seen: Set<unknown>;
  maxDepth: number;
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
 * Report whether a generated type has a `|` outside brackets, strings and
 * comments. Such a type needs parentheses inside an intersection.
 */
function hasTopLevelUnion(type: string): boolean {
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    const ch = type[i];
    if (ch === '"') {
      for (i++; i < type.length && type[i] !== '"'; i++) {
        if (type[i] === "\\") i++;
      }
    } else if (ch === "/" && type[i + 1] === "*") {
      const end = type.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 1;
    } else if (ch === "{" || ch === "[" || ch === "(" || ch === "<") {
      depth++;
    } else if (ch === "}" || ch === "]" || ch === ")" || ch === ">") {
      depth--;
    } else if (ch === "|" && depth === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Convert the array keywords of a schema. Does not apply `nullable`.
 */
function arrayTypeString(
  schema: JSONSchema7,
  indent: string,
  ctx: ConversionContext
): string {
  // Tuple support: prefixItems (JSON Schema 2020-12)
  const prefixItems = (schema as Record<string, unknown>)
    .prefixItems as JSONSchema7Definition[];
  if (Array.isArray(prefixItems)) {
    const types = prefixItems.map((s) =>
      jsonSchemaToTypeString(s, indent, ctx)
    );
    return `[${types.join(", ")}]`;
  }

  // Tuple support: items as array (draft-07)
  if (Array.isArray(schema.items)) {
    const types = schema.items.map((s) =>
      jsonSchemaToTypeString(s, indent, ctx)
    );
    return `[${types.join(", ")}]`;
  }

  if (schema.items) {
    // Array<T>, not T[]: `[]` binds tighter than `|` and `&`, so a union or
    // intersection item type would otherwise leak out of the array.
    return `Array<${jsonSchemaToTypeString(schema.items, indent, ctx)}>`;
  }
  return "unknown[]";
}

/**
 * Convert the object keywords of a schema. Does not apply `nullable`.
 */
function objectTypeString(
  schema: JSONSchema7,
  indent: string,
  nextCtx: ConversionContext
): string {
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
    if (schema.additionalProperties === false) {
      return "{}";
    }
    return "Record<string, unknown>";
  }

  return `{\n${lines.join("\n")}\n${indent}}`;
}

/**
 * Convert a schema as if its `type` were the single type `type`.
 * Does not apply `nullable`.
 */
function singleTypeString(
  type: string | undefined,
  schema: JSONSchema7,
  indent: string,
  ctx: ConversionContext
): string {
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return arrayTypeString(schema, indent, ctx);
  if (type === "object" || schema.properties) {
    return objectTypeString(schema, indent, ctx);
  }
  return "unknown";
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 * This is a direct conversion without going through Zod.
 */
export function jsonSchemaToTypeString(
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

  ctx.seen.add(schema);
  const nextCtx: ConversionContext = {
    ...ctx,
    depth: ctx.depth + 1
  };

  try {
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
      if (types.length === 0) return "never";
      return applyNullable(types.join(" | "), schema);
    }
    if (schema.oneOf) {
      const types = schema.oneOf.map((s) =>
        jsonSchemaToTypeString(s, indent, nextCtx)
      );
      if (types.length === 0) return "never";
      return applyNullable(types.join(" | "), schema);
    }

    // Handle allOf (intersection types)
    if (schema.allOf) {
      // `&` binds tighter than `|`, so a union member needs parentheses.
      const types = schema.allOf.map((s) => {
        const member = jsonSchemaToTypeString(s, indent, nextCtx);
        return hasTopLevelUnion(member) ? `(${member})` : member;
      });
      if (types.length === 0) return "unknown";
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

    // Array of types (e.g., ["string", "null"]). Each member reads the
    // schema's own keywords, so ["array", "null"] keeps `items` and
    // ["object", "null"] keeps `properties`.
    if (Array.isArray(type)) {
      const types = new Set(
        type.map((t) => singleTypeString(t, schema, indent, nextCtx))
      );
      if (types.size === 0 || types.has("unknown")) return "unknown";
      return applyNullable([...types].join(" | "), schema);
    }

    if (type === "null") return "null";
    return applyNullable(
      singleTypeString(type, schema, indent, nextCtx),
      schema
    );
  } finally {
    ctx.seen.delete(schema);
  }
}

/**
 * Convert a JSON Schema to a TypeScript type declaration.
 */
export function jsonSchemaToType(
  schema: JSONSchema7,
  typeName: string
): string {
  const ctx: ConversionContext = {
    root: schema,
    depth: 0,
    seen: new Set(),
    maxDepth: 20
  };
  const typeBody = jsonSchemaToTypeString(schema, "", ctx);
  return `type ${typeName} = ${typeBody}`;
}

/**
 * Extract field descriptions from a JSON Schema's properties.
 */
function extractJsonSchemaDescriptions(
  schema: JSONSchema7
): Record<string, string> {
  const descriptions: Record<string, string> = {};
  if (schema.properties) {
    for (const [fieldName, propSchema] of Object.entries(schema.properties)) {
      if (
        propSchema &&
        typeof propSchema === "object" &&
        propSchema.description
      ) {
        descriptions[fieldName] = propSchema.description;
      }
    }
  }
  return descriptions;
}

/**
 * A tool descriptor using plain JSON Schema (no Zod or AI SDK dependency).
 */
export interface JsonSchemaToolDescriptor {
  description?: string;
  inputSchema: JSONSchema7;
  outputSchema?: JSONSchema7;
}

export type JsonSchemaToolDescriptors = Record<
  string,
  JsonSchemaToolDescriptor
>;

/**
 * Generate TypeScript type definitions from tool descriptors with JSON Schema.
 * This function has NO dependency on the AI SDK or Zod — it works purely with
 * JSON Schema objects.
 *
 * Use this when you have raw JSON Schema (e.g. from OpenAPI specs, MCP tool
 * definitions, etc.) and don't need the AI SDK.
 */
export function generateTypesFromJsonSchema(
  tools: JsonSchemaToolDescriptors
): string {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    const safeName = sanitizeToolName(toolName);
    const typeName = toPascalCase(safeName);

    try {
      const inputType = jsonSchemaToType(tool.inputSchema, `${typeName}Input`);

      const outputType = tool.outputSchema
        ? jsonSchemaToType(tool.outputSchema, `${typeName}Output`)
        : `type ${typeName}Output = unknown`;

      availableTypes += `\n${inputType.trim()}`;
      availableTypes += `\n${outputType.trim()}`;

      const paramLines = (() => {
        try {
          const paramDescs = extractJsonSchemaDescriptions(tool.inputSchema);
          return Object.entries(paramDescs).map(
            ([fieldName, desc]) => `@param input.${fieldName} - ${desc}`
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
        jsdocLines.push(escapeJsDoc(toolName));
      }
      for (const pd of paramLines) {
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

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
  `.trim();
}
