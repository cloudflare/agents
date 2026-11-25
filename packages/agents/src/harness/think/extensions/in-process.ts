/**
 * The in-process loader: run an extension in this isolate, with the AI
 * SDK's schema conversion, so a tool may use a zod schema or an AI SDK
 * `tool()`.
 *
 * @internal Not exported from any entry point.
 */
import { asSchema } from "ai";
import { harnessHookRules } from "./hooks";
import { ExtensionRuntime } from "./runtime";
import type { ExtensionHandle, SchemaOf, ThinkExtension } from "./types";

// SAFETY: an extension's tools carry AI SDK schemas, which asSchema takes.
const aiSdkSchema = asSchema as SchemaOf;

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
