import { describe, expect, it } from "vitest";
import {
  chatRecoverySchedulePolicy,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryScheduleReason
} from "../recovery-engine";

/**
 * Layer-2 shared engine seam tests (rfc-chat-recovery-foundation, Phase 2).
 *
 * The scheduling-idempotency policy is a cutover invariant that no type error
 * guards: an initial recovery schedule MUST be idempotent (so a deploy storm of
 * re-detections collapses to one enqueued continuation), and a stable-timeout
 * reschedule MUST NOT be idempotent (so it does not dedup onto the executing
 * one-shot row that `alarm()` is about to delete). Both `AIChatAgent` and
 * `Think` now source this single flag from `chatRecoverySchedulePolicy`; these
 * tests pin it both directly and through a fake scheduler exercised exactly the
 * way the packages call `schedule()`.
 */
describe("chatRecoverySchedulePolicy", () => {
  it("makes the initial recovery schedule idempotent (deploy-storm dedup)", () => {
    expect(chatRecoverySchedulePolicy("initial")).toEqual({ idempotent: true });
  });

  it("makes the stable-timeout reschedule non-idempotent (survives row deletion)", () => {
    expect(chatRecoverySchedulePolicy("stable_timeout_retry")).toEqual({
      idempotent: false
    });
  });

  it("is exhaustive over the schedule reasons", () => {
    const reasons: ChatRecoveryScheduleReason[] = [
      "initial",
      "stable_timeout_retry"
    ];
    for (const reason of reasons) {
      const policy = chatRecoverySchedulePolicy(reason);
      expect(typeof policy.idempotent).toBe("boolean");
    }
  });
});

describe("recovery scheduling seam (fake scheduler)", () => {
  type ScheduleCall = {
    delaySeconds: number;
    callback: ChatRecoveryScheduleCallback;
    options: { idempotent: boolean };
  };

  function makeFakeScheduler() {
    const calls: ScheduleCall[] = [];
    const schedule = (
      delaySeconds: number,
      callback: ChatRecoveryScheduleCallback,
      _data: Record<string, unknown>,
      options: { idempotent: boolean }
    ): Promise<void> => {
      calls.push({ delaySeconds, callback, options });
      return Promise.resolve();
    };
    return { calls, schedule };
  }

  it("passes idempotent:true when a package schedules an initial continuation", async () => {
    const scheduler = makeFakeScheduler();
    // Mirrors `AIChatAgent`/`Think` scheduling an initial continuation.
    await scheduler.schedule(
      0,
      "_chatRecoveryContinue",
      { incidentId: "abc" },
      chatRecoverySchedulePolicy("initial")
    );
    expect(scheduler.calls).toHaveLength(1);
    expect(scheduler.calls[0]?.options).toEqual({ idempotent: true });
  });

  it("passes idempotent:false when a package reschedules after a stable timeout", async () => {
    const scheduler = makeFakeScheduler();
    // Mirrors the stable-timeout reschedule issued from inside the executing row.
    await scheduler.schedule(
      5,
      "_chatRecoveryRetry",
      { incidentId: "abc" },
      chatRecoverySchedulePolicy("stable_timeout_retry")
    );
    expect(scheduler.calls).toHaveLength(1);
    expect(scheduler.calls[0]?.options).toEqual({ idempotent: false });
  });
});
