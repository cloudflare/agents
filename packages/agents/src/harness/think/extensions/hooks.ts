/**
 * How the handlers of ThinkHarness's hooks combine, in order. The same
 * rule applies to the handlers one extension registered and to the
 * extensions in load order.
 *
 * - `beforeToolCall`: a `run` with a new input passes that input on; the
 *   first `block` or `substitute` ends the chain.
 * - `classifyError`: the first class given wins.
 * - `onRecovery`: the first `abandon` or options object wins.
 * - The others observe: every handler runs.
 *
 * A handler that throws ends the dispatch with its error.
 *
 * @internal Not exported from any entry point.
 */
import type { ExtensionHooks, HookRules } from "./types";

/**
 * Every handler runs, in order; the hook returns nothing.
 *
 * @internal
 */
export async function observe<C>(
  context: C,
  handlers: readonly ((context: C) => Promise<unknown>)[]
): Promise<undefined> {
  for (const handler of handlers) await handler(context);
  return undefined;
}

/** @internal */
export const harnessHookRules: HookRules<ExtensionHooks> = {
  async beforeToolCall(context, handlers) {
    let current = context;
    let input: { value: unknown } | undefined;
    for (const handler of handlers) {
      const decision = await handler(current);
      if (!decision || decision.action === "run") {
        if (decision?.input !== undefined) {
          input = { value: decision.input };
          current = { ...current, input: decision.input };
        }
        continue;
      }
      return decision;
    }
    return input ? { action: "run", input: input.value } : undefined;
  },
  async classifyError(context, handlers) {
    for (const handler of handlers) {
      const kind = await handler(context);
      if (kind !== undefined) return kind;
    }
    return undefined;
  },
  async onRecovery(context, handlers) {
    for (const handler of handlers) {
      const decision = await handler(context);
      if (decision === "abandon" || typeof decision === "object") {
        return decision;
      }
    }
    return undefined;
  },
  afterToolCall: observe,
  onStepFinish: observe,
  onTurnEnd: observe,
  onError: observe
};
