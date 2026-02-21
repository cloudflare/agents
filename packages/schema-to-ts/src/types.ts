/**
 * JSON Schema types (subset of JSON Schema 2020-12 that we support)
 */

export interface JSONSchema {
  // Schema identification
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JSONSchema>;
  $comment?: string;

  // Type assertion
  type?: JSONSchemaType | JSONSchemaType[];
  enum?: unknown[];
  const?: unknown;

  // String validation
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;

  // Number validation
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // Object validation
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  patternProperties?: Record<string, JSONSchema>;
  propertyNames?: JSONSchema;
  minProperties?: number;
  maxProperties?: number;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, JSONSchema>;

  // Array validation
  items?: JSONSchema | JSONSchema[];
  prefixItems?: JSONSchema[];
  additionalItems?: boolean | JSONSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  contains?: JSONSchema;

  // Composition
  allOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  not?: JSONSchema;

  // Conditional
  if?: JSONSchema;
  then?: JSONSchema;
  else?: JSONSchema;

  // Annotations
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;

  // OpenAPI compatibility
  nullable?: boolean;

  // Allow additional properties for extensibility
  [key: string]: unknown;
}

export type JSONSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"
  | "object"
  | "array";

/**
 * Options for schema to TypeScript conversion
 */
export interface SchemaToTsOptions {
  /** Name for the generated type */
  name?: string;
  /** Whether to generate 'type' alias or 'interface' */
  format?: "type" | "interface";
  /** Whether to include JSDoc comments from descriptions */
  includeComments?: boolean;
  /** Indentation string (default: 2 spaces) */
  indent?: string;
  /** How to handle unknown schemas */
  unknownType?: "unknown" | "any";
}

/**
 * Result of schema to TypeScript conversion
 */
export interface SchemaToTsResult {
  /** The main type string */
  type: string;
  /** Any auxiliary types needed (for $defs, recursive types) */
  auxiliaryTypes: Map<string, string>;
  /** The complete output including all types */
  output: string;
}

/**
 * Context used during conversion (for handling recursion and $defs)
 */
export interface ConversionContext {
  /** Definitions from $defs */
  definitions: Map<string, JSONSchema>;
  /** Types that have been generated */
  generatedTypes: Map<string, string>;
  /** Current path in schema (for error messages) */
  path: string[];
  /** Options for conversion */
  options: Required<SchemaToTsOptions>;
  /** Schemas currently being processed (for cycle detection) */
  processing: Set<string>;
}

/**
 * Marker interface for Zod schemas
 *
 * Zod v3: has `_def` property and `safeParse` method
 * Zod v4: has `_zod` property
 */
export interface ZodSchemaLike {
  _zod?: unknown;
  _def?: unknown;
  safeParse?: (data: unknown) => unknown;
  [key: string]: unknown;
}

/**
 * AI SDK jsonSchema() wrapper structure
 */
export interface JsonSchemaWrapper {
  readonly jsonSchema: JSONSchema | PromiseLike<JSONSchema>;
  [key: string]: unknown;
}
