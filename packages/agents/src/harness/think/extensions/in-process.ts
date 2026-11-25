/**
 * The in-process loader: run an extension in this isolate, with the AI
 * SDK's schema conversion, so a tool may use a zod schema or an AI SDK
 * `tool()`.
 *
 * @internal Not exported from any entry point.
 */
import { asSchema, jsonSchema, type JSONSchema7 } from "ai";
import { harnessHookRules } from "./hooks";
import { ExtensionRuntime } from "./runtime";
import type { ExtensionHandle, SchemaOf, ThinkExtension } from "./types";

/** A plain JSON Schema object, as opposed to an AI SDK, zod or standard schema. */
function isPlainJsonSchema(schema: unknown): schema is JSONSchema7 {
  return (
    typeof schema === "object" &&
    schema !== null &&
    !(Symbol.for("vercel.ai.schema") in schema) &&
    !("~standard" in schema) &&
    !("_def" in schema)
  );
}

/**
 * An AI SDK, zod or standard schema as the AI SDK reads it, and a plain
 * JSON Schema object as it is, as in a Worker.
 */
const aiSdkSchema: SchemaOf = (schema) =>
  // SAFETY: anything else an extension gives is a schema asSchema takes.
  asSchema(isPlainJsonSchema(schema) ? jsonSchema(schema) : (schema as never));

/**
 * Load `extension` in this isolate: run it once, and return its handle.
 *
 * @internal
 */
export async function loadInProcess(
  name: string,
  extension: ThinkExtension
): Promise<ExtensionHandle> {
  const runtime = new ExtensionRuntime(name, harnessHookRules, aiSdkSchema);
  await runtime.install(extension);
  return runtime;
}
