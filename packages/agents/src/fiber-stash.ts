/**
 * The stash sink of the fiber or chat turn running in the current async
 * context, which `stash()` writes to. Kept apart from `fiber-runs.ts` so
 * chat code that sets it does not load the Lifecycle.
 *
 * @internal
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { FiberStashContext } from "./fiber-types";

const fiberStash = new AsyncLocalStorage<FiberStashContext>();

/**
 * Run `fn` with `context` as the current fiber for `stashCurrentFiber()`.
 *
 * @internal
 */
export function withFiberStash<T>(context: FiberStashContext, fn: () => T): T {
  return fiberStash.run(context, fn);
}

/**
 * Checkpoint data for the fiber running in the current async context.
 * Throws outside a fiber.
 *
 * @internal
 */
export function stashCurrentFiber(data: unknown): void {
  const context = fiberStash.getStore();
  if (!context) {
    throw new Error("stash() called outside a fiber");
  }
  context.stash(data);
}
