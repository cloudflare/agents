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

  // Both types describe draft-7 schemas, but @cfworker's `Schema` type is
  // narrower than JSONSchema7 around boolean subschemas.
  const schema = tool.inputSchema as unknown as Schema;
  const validator = new Validator(schema, "7", false);
  return {
    ...tool,
    execute: async (args, ctx) => {
      const input = args === undefined ? {} : args;
      const result = validator.validate(input);
      if (!result.valid) {
        throw new Error(
          formatToolValidationError(connector, name, result.errors)
        );
      }
      return await tool.execute(input, ctx);
    }
  };
}
