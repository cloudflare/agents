/**
 * Input validation for the `browser.*` functions. Internal — not an entry
 * point. Used by `session.ts` and `browser-functions.ts`.
 */
import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";

const validators = new WeakMap<object, Validator>();

/**
 * Check a method's input against its schema before it touches the browser,
 * so the model gets a precise error. An omitted input counts as `{}`.
 */
export function validate(
  name: string,
  schema: object,
  input: unknown
): unknown {
  let validator = validators.get(schema);
  if (!validator) {
    // SAFETY: The callers' schemas are draft-7 objects; @cfworker's `Schema`
    // type is only narrower around boolean subschemas, which they don't use.
    validator = new Validator(schema as Schema, "7", false);
    validators.set(schema, validator);
  }
  const value = input ?? {};
  const result = validator.validate(value);
  if (!result.valid) {
    throw new Error(formatValidationError(name, result.errors));
  }
  return value;
}

function formatValidationError(name: string, errors: OutputUnit[]): string {
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
  return `Invalid arguments for ${name}${details.join(";")}`;
}
