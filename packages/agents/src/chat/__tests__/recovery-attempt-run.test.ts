import { describe, expect, it } from "vitest";
import type { TaskStep } from "../../tasks";
import { currentRunAttempt, runChatRecoveryAttempt } from "../recovery-task";

describe("runChatRecoveryAttempt", () => {
  it("runs the attempt a timed-out attempt planned in the same run, after its wait", async () => {
    const steps: string[] = [];
    const step = {
      sleep: async (name: string, ms: number) =>
        void steps.push(`${name}:${ms}`),
      do: async (
        name: string,
        _config: unknown,
        fn: () => Promise<unknown>
      ) => {
        steps.push(name);
        return fn();
      }
    } as unknown as TaskStep;
    const calls: unknown[] = [];
    await runChatRecoveryAttempt(
      step,
      {
        _chatRecoveryContinue: async (data) => {
          calls.push(data);
          // The first attempt times out waiting for a stable chat and plans
          // the next one (`rescheduleAfterStableTimeout`).
          if (calls.length === 1) {
            expect(
              currentRunAttempt()?.({
                callback: "_chatRecoveryContinue",
                data: { n: 2 },
                delaySeconds: 5
              })
            ).toBe(true);
            // A second plan in one attempt is declined.
            expect(
              currentRunAttempt()?.({
                callback: "_chatRecoveryContinue",
                data: { n: 3 },
                delaySeconds: 5
              })
            ).toBe(false);
          }
        },
        _chatRecoveryRetry: async () => {}
      },
      { callback: "_chatRecoveryContinue", data: { n: 1 }, delaySeconds: 0 }
    );
    expect(steps).toEqual(["continuation", "backoff-2:5000", "continuation-2"]);
    expect(calls).toEqual([{ n: 1 }, { n: 2 }]);
    // Outside an attempt there is nowhere to plan.
    expect(currentRunAttempt()).toBeUndefined();
  });
});
