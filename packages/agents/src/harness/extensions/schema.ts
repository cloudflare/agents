/**
 * Tool input schemas. A portable tool's `input` is any schema that speaks
 * both Standard Schema (to parse what the model sent) and Standard JSON
 * Schema (to tell the model what to send). Zod 4, Valibot and ArkType do;
 * `jsonSchema()` wraps a raw JSON Schema for tools whose schema is only
 * known at runtime, such as tools discovered from an MCP server.
 *
 * The two interfaces are declared structurally, so this module does not
 * depend on any schema library. See https://standardschema.dev.
 */

/**
 * A JSON value. Mutable in shape so harness JSON types (pi's, OpenCode's)
 * are assignable both ways; hooks are handed copies, so editing one in
 * place never reaches the harness's own record.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object, the shape of every tool input. */
export type JsonObject = { [key: string]: JsonValue };

/** One problem a schema found in a value. */
export type SchemaIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
};

type ParseOutcome<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<SchemaIssue> };

/**
 * The parts of Standard Schema v1 and Standard JSON Schema v1 a tool needs.
 *
 * @template T - What a successful parse produces.
 */
export type ToolInputSchema<T> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): ParseOutcome<T> | Promise<ParseOutcome<T>>;
    readonly jsonSchema: {
      input(options: {
        readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0";
      }): Record<string, unknown>;
    };
    /** Type carrier only. */
    readonly types?: { readonly input: unknown; readonly output: T };
  };
};

/** What a tool's schema parses its input into. */
export type InferInput<S> = S extends ToolInputSchema<infer T> ? T : never;

/**
 * A raw JSON Schema as a tool input schema. Values are only checked to be
 * JSON objects; the schema itself is what the model sees. Use it when the
 * schema comes from elsewhere at runtime, such as an MCP server's tool list.
 *
 * @param schema - A JSON Schema whose `type` is `"object"`.
 * @returns A schema that accepts any JSON object.
 */
export function jsonSchema(
  schema: Record<string, unknown>
): ToolInputSchema<JsonObject> {
  return {
    "~standard": {
      version: 1,
      vendor: "agents/harness/extensions",
      validate(value) {
        return isJsonObject(value)
          ? { value }
          : { issues: [{ message: "Expected a JSON object" }] };
      },
      jsonSchema: { input: () => schema }
    }
  };
}

/** Whether a value is a plain JSON object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render schema issues as one line for the model. */
export function formatIssues(issues: ReadonlyArray<SchemaIssue>): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((part) =>
          typeof part === "object" ? String(part.key) : String(part)
        )
        .join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}
