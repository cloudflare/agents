import { AsyncLocalStorage } from "node:async_hooks";
import type { HostFunctionContext } from "./run-types";

interface RunHostFunctionContextScope {
  active: boolean;
  readonly context: HostFunctionContext;
}

const runHostFunctionContextStorage =
  new AsyncLocalStorage<RunHostFunctionContextScope>();

/** Read the invocation context inside an active trusted host function. */
export function getHostFunctionContext(): HostFunctionContext {
  const scope = runHostFunctionContextStorage.getStore();
  if (scope === undefined || !scope.active) {
    throw new Error(
      "Run host function context is available only inside an active host function."
    );
  }
  return scope.context;
}

/** Invoke trusted host code with isolated context that expires on settlement. */
export async function runWithHostFunctionContext(
  signal: AbortSignal,
  operation: () => unknown
): Promise<unknown> {
  const scope: RunHostFunctionContextScope = {
    active: true,
    context: Object.freeze({ signal })
  };
  return runHostFunctionContextStorage.run(scope, async () => {
    try {
      return await operation();
    } finally {
      scope.active = false;
    }
  });
}
