/**
 * schema-to-ts
 *
 * Converts JSON Schema and Zod schemas to TypeScript types.
 * Works with both real Zod schemas (with _zod property) and
 * AI SDK jsonSchema() wrappers.
 */

export type {
  JSONSchema,
  JSONSchemaType,
  SchemaToTsOptions,
  SchemaToTsResult,
  ZodSchemaLike,
  JsonSchemaWrapper
} from "./types.js";

export {
  isZodSchema,
  isJsonSchemaWrapper,
  extractJsonSchema
} from "./detect.js";
export { jsonSchemaToTs } from "./convert.js";
export { schemaToTs } from "./schema-to-ts.js";
