import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import type { ConnectorTool } from "@cloudflare/codemode";

function formatToolValidationError(
  connector: string,
  tool: string,
  errors: OutputUnit[]
): string {
  // A failing property emits both a generic parent `properties` error and a
  // specific child error. Prefer the latter so the model sees what to fix.
  const specific = errors.filter((error) => error.keyword !== "properties");
  const relevant = specific.length > 0 ? specific : errors;
  const details = relevant.map((error) => {
    const location = error.instanceLocation
      .replace(/^#\/?/, "")
      .replaceAll("~1", "/")
      .replaceAll("~0", "~")
      .replaceAll("/", ".");
    return `${location ? ` at ${location}` : ""}: ${error.error}`;
  });
  return `Invalid arguments for ${connector}.${tool}${details.join(";")}`;
}

const validators = new WeakMap<object, Validator>();

function validatorFor(schema: unknown): Validator {
  const key = schema as object;
  let validator = validators.get(key);
  if (!validator) {
    // Both types describe draft-7 schemas, but @cfworker's `Schema` type is
    // narrower than JSONSchema7 around boolean subschemas.
    validator = new Validator(schema as Schema, "7", false);
    validators.set(key, validator);
  }
  return validator;
}

/**
 * Check `args` against a draft-7 input schema and throw an error naming
 * what to fix. An omitted argument counts as `{}`: argumentless calls are
 * documented as `cdp.spec()`. Returns the arguments to use.
 */
export function validateArgs(
  connector: string,
  name: string,
  schema: unknown,
  args: unknown
): unknown {
  const input = args === undefined ? {} : args;
  const result = validatorFor(schema).validate(input);
  if (!result.valid) {
    throw new Error(formatToolValidationError(connector, name, result.errors));
  }
  return input;
}

/**
 * Validate a connector tool's arguments against its input schema before it
 * runs, so the model gets a precise error instead of a failure deep inside
 * browser work. An omitted argument counts as `{}`: argumentless tools are
 * documented as `cdp.spec()`.
 */
export function validateConnectorArgs(
  connector: string,
  name: string,
  tool: ConnectorTool
): ConnectorTool {
  if (!tool.inputSchema) return tool;
  const schema = tool.inputSchema;
  return {
    ...tool,
    execute: async (args, ctx) =>
      await tool.execute(validateArgs(connector, name, schema, args), ctx)
  };
}
