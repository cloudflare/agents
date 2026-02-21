/**
 * Main entry point for schema-to-ts
 *
 * Handles both Zod schemas and JSON Schema wrappers,
 * routing to the appropriate converter.
 */

import type {
  JSONSchema,
  SchemaToTsOptions,
  SchemaToTsResult
} from "./types.js";
import {
  isZodSchema,
  isJsonSchemaWrapper,
  extractJsonSchema
} from "./detect.js";
import { jsonSchemaToTs } from "./convert.js";

/**
 * Convert any supported schema to TypeScript types
 *
 * Supports:
 * - Real Zod schemas (with _zod property)
 * - AI SDK jsonSchema() wrappers
 * - Raw JSON Schema objects
 *
 * @param schema - The schema to convert
 * @param options - Conversion options
 * @returns TypeScript type string
 *
 * @example
 * ```ts
 * import { schemaToTs } from '@anthropic/schema-to-ts';
 * import { jsonSchema } from 'ai';
 * import { z } from 'zod';
 *
 * // Works with AI SDK jsonSchema()
 * const aiSchema = jsonSchema({ type: 'object', properties: { name: { type: 'string' } } });
 * const ts1 = schemaToTs(aiSchema, { name: 'User' });
 *
 * // Works with Zod schemas
 * const zodSchema = z.object({ name: z.string() });
 * const ts2 = schemaToTs(zodSchema, { name: 'User' });
 *
 * // Works with raw JSON Schema
 * const rawSchema = { type: 'object', properties: { name: { type: 'string' } } };
 * const ts3 = schemaToTs(rawSchema, { name: 'User' });
 * ```
 */
export function schemaToTs(
  schema: unknown,
  options: SchemaToTsOptions = {}
): string {
  // Extract JSON Schema from whatever type we have
  const jsonSchema = extractJsonSchema(schema);

  // Convert to TypeScript
  return jsonSchemaToTs(jsonSchema, options);
}

/**
 * Convert schema to TypeScript with full result including auxiliary types
 */
export function schemaToTsFull(
  schema: unknown,
  options: SchemaToTsOptions = {}
): SchemaToTsResult {
  const jsonSchema = extractJsonSchema(schema);
  const type = jsonSchemaToTs(jsonSchema, { ...options, name: undefined });

  // Parse out auxiliary types (this is a simplified version)
  const auxiliaryTypes = new Map<string, string>();

  // Generate full output
  const output = jsonSchemaToTs(jsonSchema, options);

  return {
    type,
    auxiliaryTypes,
    output
  };
}

/**
 * Batch convert multiple schemas
 */
export function schemasToTs(
  schemas: Record<string, unknown>,
  options: Omit<SchemaToTsOptions, "name"> = {}
): string {
  const parts: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    parts.push(schemaToTs(schema, { ...options, name }));
  }

  return parts.join("\n\n");
}
