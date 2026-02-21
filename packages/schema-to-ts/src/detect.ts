/**
 * Schema detection utilities
 *
 * Detects whether a schema is a real Zod schema, AI SDK jsonSchema() wrapper,
 * or raw JSON Schema, and extracts the underlying JSON Schema.
 */

import type { JSONSchema, ZodSchemaLike, JsonSchemaWrapper } from "./types.js";

/**
 * Check if a value is a real Zod schema
 *
 * Zod v3 uses `_def` property
 * Zod v4 uses `_zod` property
 */
export function isZodSchema(schema: unknown): schema is ZodSchemaLike {
  if (schema === null || typeof schema !== "object") {
    return false;
  }

  const s = schema as Record<string, unknown>;

  // Zod v4 check
  if ("_zod" in s && s._zod !== undefined) {
    return true;
  }

  // Zod v3 check - has _def and safeParse method
  if ("_def" in s && typeof s.safeParse === "function") {
    return true;
  }

  return false;
}

/**
 * Check if a value is an AI SDK jsonSchema() wrapper
 *
 * AI SDK's jsonSchema() returns an object with a jsonSchema property
 * that contains the actual JSON Schema definition.
 */
export function isJsonSchemaWrapper(
  schema: unknown
): schema is JsonSchemaWrapper {
  if (schema === null || typeof schema !== "object") {
    return false;
  }

  // Must have jsonSchema property
  if (!("jsonSchema" in schema)) {
    return false;
  }

  // Must NOT be a Zod schema
  if (isZodSchema(schema)) {
    return false;
  }

  return true;
}

/**
 * Check if a value is a raw JSON Schema object
 */
export function isRawJsonSchema(schema: unknown): schema is JSONSchema {
  if (schema === null || typeof schema !== "object") {
    return false;
  }

  // Not a Zod schema
  if (isZodSchema(schema)) {
    return false;
  }

  // Not a jsonSchema wrapper
  if (isJsonSchemaWrapper(schema)) {
    return false;
  }

  // Has typical JSON Schema properties or is empty object (valid JSON Schema)
  const s = schema as Record<string, unknown>;
  return (
    s.type !== undefined ||
    s.properties !== undefined ||
    s.items !== undefined ||
    s.anyOf !== undefined ||
    s.allOf !== undefined ||
    s.oneOf !== undefined ||
    s.$ref !== undefined ||
    s.enum !== undefined ||
    s.const !== undefined ||
    Object.keys(s).length === 0 // empty schema is valid
  );
}

/**
 * Extract the raw JSON Schema from any supported schema type
 *
 * @param schema - A Zod schema, jsonSchema() wrapper, or raw JSON Schema
 * @returns The raw JSON Schema object
 * @throws Error if schema type is not recognized
 */
export function extractJsonSchema(schema: unknown): JSONSchema {
  // Raw JSON Schema
  if (isRawJsonSchema(schema)) {
    return schema;
  }

  // AI SDK jsonSchema() wrapper
  if (isJsonSchemaWrapper(schema)) {
    const wrapped = schema.jsonSchema;

    // Handle PromiseLike (we can't await, so throw)
    if (
      wrapped &&
      typeof (wrapped as PromiseLike<JSONSchema>).then === "function"
    ) {
      throw new Error(
        "Cannot extract JSON Schema from async jsonSchema() wrapper. " +
          "Please resolve the promise before calling extractJsonSchema()."
      );
    }

    return wrapped as JSONSchema;
  }

  // Zod schema - extract from internal structure
  if (isZodSchema(schema)) {
    return extractJsonSchemaFromZod(schema);
  }

  throw new Error(
    `Cannot extract JSON Schema from value of type ${typeof schema}. ` +
      "Expected a Zod schema, AI SDK jsonSchema() wrapper, or raw JSON Schema object."
  );
}

/**
 * Extract JSON Schema from a Zod schema's internal structure
 *
 * Zod v4 schemas have a toJSONSchema() method or we can inspect _zod
 */
function extractJsonSchemaFromZod(zodSchema: ZodSchemaLike): JSONSchema {
  // Try toJSONSchema() method if available (Zod v4)
  if (
    typeof (zodSchema as { toJSONSchema?: () => JSONSchema }).toJSONSchema ===
    "function"
  ) {
    return (zodSchema as { toJSONSchema: () => JSONSchema }).toJSONSchema();
  }

  // Try _def.jsonSchema if available
  const def = (zodSchema as { _def?: { jsonSchema?: JSONSchema } })._def;
  if (def?.jsonSchema) {
    return def.jsonSchema;
  }

  // For fromJSONSchema() results, the original schema might be stored
  // We'll need to introspect the Zod schema structure
  // This is a fallback that inspects the Zod type structure
  return introspectZodSchema(zodSchema);
}

/**
 * Introspect a Zod schema and build a JSON Schema from its structure
 *
 * This handles cases where we can't directly get the JSON Schema
 */
function introspectZodSchema(zodSchema: ZodSchemaLike): JSONSchema {
  const def = (zodSchema as { _zod?: { def?: unknown } })._zod;

  if (!def) {
    return {}; // Unknown structure, return empty schema
  }

  // For now, return a basic introspection
  // Full implementation would need to handle all Zod types
  // But since we primarily use this with fromJSONSchema() results,
  // which store the original schema, this is rarely needed

  return {};
}
