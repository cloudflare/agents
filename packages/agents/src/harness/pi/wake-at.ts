import type { TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "./context";
import type { PiTask } from "./harness";

/**
 * When a task next runs, read from a numeric `wakeAt` in its checkpoint,
 * the field `sleepUntil` commits. Compose it into `wakeAt`:
 *
 * ```ts
 * new PiHarness({ harness, wakeAt: (task) => mine(task) ?? checkpointWakeAt(task) });
 * ```
 */
export function checkpointWakeAt(task: PiTask): Date | undefined {
  const { checkpoint } = task;
  if (typeof checkpoint !== "object" || checkpoint === null) return undefined;
  const { wakeAt } = checkpoint as { wakeAt?: unknown };
  return typeof wakeAt === "number" && Number.isFinite(wakeAt)
    ? new Date(wakeAt)
    : undefined;
}

/**
 * Sleep until `at`, with the deadline in the task's checkpoint so the
 * harness can read it through `checkpointWakeAt`. Commits `wakeAt` into
 * the current checkpoint, then calls `runtime.sleep()`.
 *
 * Commit the phase's next checkpoint after it returns. The `wakeAt` commit
 * counts as progress, so a phase that returned without moving on would run
 * again. A rerun after a restart commits the same `wakeAt` and sleeps for
 * whatever is left.
 */
export async function sleepUntil<
  I,
  S extends { readonly phase: string; readonly wakeAt?: number },
  R,
  H extends object
>(
  runtime: TaskRuntime<I, S, R, H>,
  at: Date | number,
  context: Context
): Promise<void> {
  const wakeAt = typeof at === "number" ? at : at.getTime();
  await runtime.commit(
    (_tx, current) => ({
      status: "running",
      checkpoint: { ...current.state.checkpoint, wakeAt }
    }),
    context
  );
  await runtime.sleep(wakeAt, context);
}
