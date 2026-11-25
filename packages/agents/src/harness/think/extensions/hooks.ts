/**
 * How the handlers of one hook combine, in order. The same rule applies to
 * the handlers one extension registered and to the extensions in the
 * harness's order.
 *
 * - `beforeToolCall`: a `run` with a new input passes that input on; the
 *   first `block` or `substitute` ends the chain.
 * - `classifyError`: the first class given wins.
 * - `onRecovery`: the first `abandon` wins.
 * - The others observe: every handler runs.
 *
 * A handler that throws ends the dispatch with its error.
 *
 * @internal Not exported from any entry point.
 */
import type { ThinkToolCallDecision } from "../types";
import type { ExtensionHookName, ExtensionHooks } from "./types";

/** One handler, or one extension's handlers, of a hook. @internal */
export type HookRunner = (context: unknown) => unknown;

/** @internal */
export async function dispatchHook<H extends ExtensionHookName>(
  name: H,
  context: ExtensionHooks[H][0],
  runners: readonly HookRunner[]
): Promise<ExtensionHooks[H][1]> {
  // SAFETY: each branch returns what hook `name` returns; the runners of
  // hook `name` return its result type.
  type Result = ExtensionHooks[H][1];
  switch (name) {
    case "beforeToolCall": {
      let current = context as ExtensionHooks["beforeToolCall"][0];
      let input: { value: unknown } | undefined;
      for (const run of runners) {
        const decision = (await run(current)) as
          | ThinkToolCallDecision
          | undefined;
        if (!decision || decision.action === "run") {
          if (decision?.input !== undefined) {
            input = { value: decision.input };
            current = { ...current, input: decision.input };
          }
          continue;
        }
        return decision as Result;
      }
      return (
        input ? { action: "run", input: input.value } : undefined
      ) as Result;
    }
    case "classifyError":
      for (const run of runners) {
        const kind = await run(context);
        if (kind !== undefined) return kind as Result;
      }
      return undefined as Result;
    case "onRecovery":
      for (const run of runners) {
        if ((await run(context)) === "abandon") return "abandon" as Result;
      }
      return undefined as Result;
    default:
      for (const run of runners) await run(context);
      return undefined as Result;
  }
}
