/**
 * JSON Schema to TypeScript converter
 *
 * Converts JSON Schema objects to TypeScript type strings.
 */

import type {
  JSONSchema,
  ConversionContext,
  SchemaToTsOptions
} from "./types.js";

const DEFAULT_OPTIONS: Required<SchemaToTsOptions> = {
  name: "Schema",
  format: "type",
  includeComments: true,
  indent: "  ",
  unknownType: "unknown"
};

/**
 * Convert a JSON Schema to a TypeScript type string
 */
export function jsonSchemaToTs(
  schema: JSONSchema,
  options: SchemaToTsOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const ctx: ConversionContext = {
    definitions: new Map(),
    generatedTypes: new Map(),
    path: [],
    options: opts,
    processing: new Set()
  };

  // Extract $defs if present
  if (schema.$defs) {
    for (const [name, defSchema] of Object.entries(schema.$defs)) {
      ctx.definitions.set(name, defSchema);
    }
  }

  // Convert the main schema
  const typeString = convertSchema(schema, ctx);

  // Build output with auxiliary types
  const parts: string[] = [];

  // Add definitions first
  for (const [name, typeStr] of ctx.generatedTypes) {
    parts.push(`type ${name} = ${typeStr};`);
  }

  // Add main type
  if (opts.name) {
    const comment =
      opts.includeComments && schema.description
        ? `/** ${schema.description} */\n`
        : "";
    parts.push(`${comment}type ${opts.name} = ${typeString};`);
  } else {
    parts.push(typeString);
  }

  return parts.join("\n\n");
}

/**
 * Convert a schema node to TypeScript
 */
function convertSchema(schema: JSONSchema, ctx: ConversionContext): string {
  // Handle boolean schemas (JSON Schema allows true/false as schemas)
  if (schema === (true as unknown)) {
    return ctx.options.unknownType;
  }
  if (schema === (false as unknown)) {
    return "never";
  }

  // Handle empty object schema (matches everything)
  if (Object.keys(schema).length === 0) {
    return ctx.options.unknownType;
  }

  // Handle $ref
  if (schema.$ref) {
    return convertRef(schema.$ref, ctx);
  }

  // Handle const
  if (schema.const !== undefined) {
    return convertConst(schema.const);
  }

  // Handle enum
  if (schema.enum) {
    return convertEnum(schema.enum);
  }

  // Handle composition keywords
  if (schema.anyOf) {
    return convertAnyOf(schema.anyOf, ctx);
  }
  if (schema.oneOf) {
    return convertOneOf(schema.oneOf, ctx);
  }
  if (schema.allOf) {
    return convertAllOf(schema.allOf, ctx);
  }
  if (schema.not) {
    // 'not' is hard to represent in TS, use unknown
    return ctx.options.unknownType;
  }

  // Handle if/then/else
  if (schema.if && (schema.then || schema.else)) {
    return convertConditional(schema, ctx);
  }

  // Handle type
  if (schema.type) {
    return convertType(schema, ctx);
  }

  // No type specified - unknown
  return ctx.options.unknownType;
}

/**
 * Convert a $ref to a type reference
 */
function convertRef(ref: string, ctx: ConversionContext): string {
  // Handle local refs: #/$defs/Name
  const localMatch = ref.match(/^#\/\$defs\/(.+)$/);
  if (localMatch) {
    const name = localMatch[1];
    const defSchema = ctx.definitions.get(name);

    if (!defSchema) {
      return ctx.options.unknownType;
    }

    // Check for cycles
    if (ctx.processing.has(name)) {
      return name; // Return reference to avoid infinite recursion
    }

    // Generate type if not already done
    if (!ctx.generatedTypes.has(name)) {
      ctx.processing.add(name);
      const typeStr = convertSchema(defSchema, ctx);
      ctx.generatedTypes.set(name, typeStr);
      ctx.processing.delete(name);
    }

    return name;
  }

  // Handle definitions (older style): #/definitions/Name
  const defMatch = ref.match(/^#\/definitions\/(.+)$/);
  if (defMatch) {
    const name = defMatch[1];
    return name;
  }

  // External refs - can't resolve, use unknown
  return ctx.options.unknownType;
}

/**
 * Convert a const value to a literal type
 */
function convertConst(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  // Objects/arrays as const - stringify
  return JSON.stringify(value);
}

/**
 * Convert an enum to a union of literals
 */
function convertEnum(values: unknown[]): string {
  const literals = values.map(convertConst);
  return literals.join(" | ");
}

/**
 * Convert anyOf to union type
 */
function convertAnyOf(schemas: JSONSchema[], ctx: ConversionContext): string {
  const types = schemas.map((s) => convertSchema(s, ctx));
  const unique = [...new Set(types)];
  if (unique.length === 1) return unique[0];
  return unique.map((t) => wrapIfNeeded(t, "&")).join(" | ");
}

/**
 * Convert oneOf to union type (same as anyOf for type purposes)
 */
function convertOneOf(schemas: JSONSchema[], ctx: ConversionContext): string {
  return convertAnyOf(schemas, ctx);
}

/**
 * Convert allOf to intersection type
 */
function convertAllOf(schemas: JSONSchema[], ctx: ConversionContext): string {
  const types = schemas.map((s) => convertSchema(s, ctx));
  const unique = [...new Set(types)];
  if (unique.length === 1) return unique[0];
  return unique.map((t) => wrapIfNeeded(t, "|")).join(" & ");
}

/**
 * Convert if/then/else to union
 */
function convertConditional(
  schema: JSONSchema,
  ctx: ConversionContext
): string {
  const types: string[] = [];

  if (schema.then) {
    types.push(convertSchema(schema.then, ctx));
  }
  if (schema.else) {
    types.push(convertSchema(schema.else, ctx));
  }

  if (types.length === 0) return ctx.options.unknownType;
  if (types.length === 1) return types[0];
  return types.join(" | ");
}

/**
 * Convert a typed schema
 */
function convertType(schema: JSONSchema, ctx: ConversionContext): string {
  const type = schema.type;

  // Handle array of types (nullable, etc.)
  if (Array.isArray(type)) {
    const types = type.map((t) => convertSingleType(t, schema, ctx));
    return types.join(" | ");
  }

  let result = convertSingleType(type as string, schema, ctx);

  // Handle OpenAPI nullable: true
  if (schema.nullable === true) {
    result = `${result} | null`;
  }

  return result;
}

/**
 * Convert a single type
 */
function convertSingleType(
  type: string,
  schema: JSONSchema,
  ctx: ConversionContext
): string {
  switch (type) {
    case "string":
      return "string";

    case "number":
    case "integer":
      return "number";

    case "boolean":
      return "boolean";

    case "null":
      return "null";

    case "object":
      return convertObject(schema, ctx);

    case "array":
      return convertArray(schema, ctx);

    default:
      return ctx.options.unknownType;
  }
}

/**
 * Convert object type
 */
function convertObject(schema: JSONSchema, ctx: ConversionContext): string {
  const properties = schema.properties;
  const required = new Set(schema.required || []);
  const additionalProps = schema.additionalProperties;

  // Empty object with no constraints
  if (!properties && additionalProps === undefined) {
    return "Record<string, " + ctx.options.unknownType + ">";
  }

  // Only additionalProperties
  if (!properties && additionalProps !== undefined) {
    if (additionalProps === true) {
      return "Record<string, " + ctx.options.unknownType + ">";
    }
    if (additionalProps === false) {
      return "{}";
    }
    const valueType = convertSchema(additionalProps, ctx);
    return `Record<string, ${valueType}>`;
  }

  // Build object type
  const parts: string[] = [];
  const indent = ctx.options.indent;

  for (const [key, propSchema] of Object.entries(properties || {})) {
    const isRequired = required.has(key);
    const propType = convertSchema(propSchema, ctx);
    const safeName = isValidIdentifier(key) ? key : JSON.stringify(key);
    const optional = isRequired ? "" : "?";

    // Add description as comment
    let comment = "";
    if (ctx.options.includeComments && propSchema.description) {
      comment = `${indent}/** ${propSchema.description} */\n`;
    }

    parts.push(`${comment}${indent}${safeName}${optional}: ${propType}`);
  }

  // Add index signature for additionalProperties
  if (additionalProps === true) {
    parts.push(`${indent}[key: string]: ${ctx.options.unknownType}`);
  } else if (additionalProps && typeof additionalProps === "object") {
    const valueType = convertSchema(additionalProps, ctx);
    parts.push(`${indent}[key: string]: ${valueType}`);
  }

  if (parts.length === 0) {
    return "{}";
  }

  return `{\n${parts.join(";\n")};\n}`;
}

/**
 * Convert array type
 */
function convertArray(schema: JSONSchema, ctx: ConversionContext): string {
  // Tuple with prefixItems (JSON Schema 2020-12)
  if (schema.prefixItems) {
    const tupleTypes = schema.prefixItems.map((s) => convertSchema(s, ctx));

    // Check for rest items
    if (
      schema.items &&
      typeof schema.items === "object" &&
      !Array.isArray(schema.items)
    ) {
      const restType = convertSchema(schema.items, ctx);
      return `[${tupleTypes.join(", ")}, ...${restType}[]]`;
    }

    return `[${tupleTypes.join(", ")}]`;
  }

  // Tuple with items as array (older JSON Schema)
  if (Array.isArray(schema.items)) {
    const tupleTypes = schema.items.map((s) => convertSchema(s, ctx));
    return `[${tupleTypes.join(", ")}]`;
  }

  // Regular array
  if (schema.items) {
    const itemType = convertSchema(schema.items, ctx);
    return `${wrapIfNeeded(itemType, "|")}[]`;
  }

  // No items specified
  return `${ctx.options.unknownType}[]`;
}

/**
 * Check if a string is a valid JS identifier
 */
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

/**
 * Wrap type in parens if it contains the given operator
 */
function wrapIfNeeded(type: string, operator: "|" | "&"): string {
  if (type.includes(operator) && !type.startsWith("(")) {
    return `(${type})`;
  }
  return type;
}
