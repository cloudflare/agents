import { describe, expect, it } from "vitest";
import { Tasks, type TaskStep } from "../../tasks";
import { withCapabilityHarness } from "../shared/capability-harness";

/**
 * #executeRun claims a run, then awaits the wake-mirror push before it
 * registers the attempt in #active and starts the handler. A cancel() that
 * lands in that await finds no live attempt and settles the run cancelled
 * at once. The claimed attempt must then not start the handler.
 *
 * The test follows the model's path (Tasks.tla, verify-runtime): Accept,
 * AcceptReturns (warm start up to the held alarm write), CancelCall,
 * Register. Holding the claim's alarm write stands in for a storage write
 * that has not returned yet.
 */

/** Hold the Nth setAlarm call until `release()`. */
function holdSetAlarm(storage: DurableObjectStorage, nth: number) {
  const original = storage.setAlarm.bind(storage);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  storage.setAlarm = async (...args: Parameters<typeof original>) => {
    calls += 1;
    if (calls === nth) {
      resolveHeld();
      await gate;
    }
    return original(...args);
  };
  return {
    held,
    release,
    restore: () => {
      storage.setAlarm = original;
    }
  };
}

describe("Tasks cancel during the claim", () => {
  it("does not start the handler of a run cancelled while its claim is in flight", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const entries: string[] = [];
      const tasks = new Tasks({
        definitions: {
          work: async (_input: undefined, step: TaskStep) => {
            entries.push("handler");
            await step.do("only", () => {
              entries.push("step");
              return 1;
            });
            return "done";
          }
        }
      });
      const { lifecycle } = install(tasks);
      await lifecycle.start();

      // Call 1 is accept's wake push; call 2 is the claim's.
      const hold = holdSetAlarm(storage, 2);
      try {
        // Accept, AcceptReturns: the warm attempt claims the run and waits
        // on its wake push.
        const receipt = await tasks.run("work");
        await hold.held;

        // CancelCall: no attempt is registered yet, so cancel() settles the
        // parked run at once.
        const cancelled = tasks.cancel(receipt.runId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const stored = storage.sql
          .exec(
            "SELECT state FROM cf_agents_task_runs WHERE run_id = ?",
            receipt.runId
          )
          .one();
        expect(stored.state).toBe("cancelled");

        // Register: the claim's write returns.
        hold.release();
        expect(await cancelled).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(entries).toEqual([]);
        expect((await tasks.get(receipt.runId))?.state).toBe("cancelled");
      } finally {
        hold.restore();
      }
    });
  });
});
