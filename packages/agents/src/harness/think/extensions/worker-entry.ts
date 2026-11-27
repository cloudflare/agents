/**
 * The extension runtime as a dynamic Worker's main module. The loader puts
 * two modules beside it: `extension.js`, whose default export is the
 * extension function, and `manifest.js`, whose default export is
 * `{ name }`. Each method is the extension handle's, over Workers RPC.
 *
 * Bundled into a string at build (`scripts/build-extension-runtime.ts`).
 *
 * @internal
 */
import { WorkerEntrypoint } from "cloudflare:workers";
// @ts-expect-error The loader provides this module beside the runtime.
import extension from "./extension.js";
// @ts-expect-error The loader provides this module beside the runtime.
import manifest from "./manifest.js";
import { harnessHookRules } from "./hooks";
import { ExtensionRuntime } from "./runtime";
import type {
  BuildContext,
  Drafts,
  HookHandler,
  HookRules,
  SchemaOf,
  ThinkExtension,
  ToolCall,
  ToolInvoke
} from "./types";

/** In a Worker a tool's schema is JSON Schema already. */
const jsonSchemaOnly: SchemaOf = (schema) => ({
  // SAFETY: an extension loaded from source gives its input schema as JSON
  // Schema; nothing here can convert another kind.
  jsonSchema: schema as never
});

/**
 * ThinkHarness's rules, and for any other hook (an older host's) the
 * handlers run in order and the last answer wins.
 */
const rules = new Proxy(harnessHookRules, {
  get: (known, name) =>
    Reflect.get(known, name) ??
    (async (
      context: unknown,
      handlers: readonly HookHandler<unknown, unknown>[]
    ) => {
      let result: unknown;
      for (const handler of handlers) {
        const answer = await handler(context);
        if (answer !== undefined) result = answer;
      }
      return result;
    })
}) as HookRules<Record<string, readonly [unknown, unknown]>>;

let loaded:
  | Promise<ExtensionRuntime<Record<string, readonly [unknown, unknown]>>>
  | undefined;

function runtime() {
  loaded ??= (async () => {
    const { name } = manifest as { name: string };
    const runtime = new ExtensionRuntime(name, rules, jsonSchemaOnly);
    // SAFETY: the loader puts an extension function in extension.js.
    await runtime.install(
      extension as ThinkExtension<Record<string, readonly [unknown, unknown]>>
    );
    return runtime;
  })();
  return loaded;
}

export default class ExtensionWorker extends WorkerEntrypoint {
  async describe() {
    return (await runtime()).describe();
  }

  async build(drafts: Drafts, build: BuildContext) {
    return (await runtime()).build(drafts, build);
  }

  async execute(
    tool: string,
    input: unknown,
    call: ToolCall,
    onOutput: (output: unknown) => void | Promise<void>,
    invoke?: ToolInvoke
  ) {
    return (await runtime()).execute(tool, input, call, onOutput, invoke);
  }

  async cancel(call: Pick<ToolCall, "id" | "session">, reason?: unknown) {
    (await runtime()).cancel(call, reason);
  }

  async validate(tool: string, input: unknown, build: BuildContext) {
    return (await runtime()).validate(tool, input, build);
  }

  async modelOutput(
    tool: string,
    output: { toolCallId: string; input: unknown; output: unknown },
    build: BuildContext
  ) {
    return (await runtime()).modelOutput(tool, output, build);
  }

  async needsApproval(tool: string, input: unknown, call: ToolCall) {
    return (await runtime()).needsApproval(tool, input, call);
  }

  async hook(name: string, context: unknown) {
    return (await runtime()).hook(name, context);
  }
}
