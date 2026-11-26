import { describe, expect, it } from "vitest";
import {
  dispatchChatRecoveryToHandoff,
  type ChatRecoveryHandoff
} from "../recovery-task";
import { runHoldingLane } from "../turn-task";

/** Text `isPlatformFailure` recognizes, mirroring a real memory-limit reset. */
function platformFailure(context: string): Error {
  return new Error(
    `Durable Object's isolate exceeded its memory limit and was reset (${context}).`
  );
}

/**
 * A detached model turn that hands off, then fails a beat later — long
 * enough that `track(turn)` (raced against the same rejection) reliably
 * wins first, exactly like a real model turn that runs for a while before
 * eventually failing. A turn that rejected on the very next microtask
 * would race `track` unrealistically and could win instead.
 */
function failingTurn(): ChatRecoveryHandoff["detached"] {
  return async (onTurnStarted) => {
    onTurnStarted();
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw platformFailure("model turn platform failure");
  };
}

describe("dispatchChatRecoveryToHandoff — post-handoff redefer failure", () => {
  it("retries a failed redefer and stops once it succeeds", async () => {
    let redeferAttempts = 0;
    const detachedErrors: unknown[] = [];
    const handoff: ChatRecoveryHandoff = {
      detached: failingTurn(),
      track: () => {},
      redefer: async () => {
        redeferAttempts++;
        if (redeferAttempts < 2) {
          throw platformFailure("transient enqueue failure");
        }
      },
      onDetachedError: (error) => detachedErrors.push(error)
    };

    await dispatchChatRecoveryToHandoff(handoff);
    // The detached failure and its redefer retry run after this resolves.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(redeferAttempts).toBe(2);
    expect(detachedErrors).toHaveLength(0);
  });

  it("surfaces a redefer failure via onDetachedError once retries are exhausted, instead of swallowing it", async () => {
    let redeferAttempts = 0;
    const detachedErrors: unknown[] = [];
    const handoff: ChatRecoveryHandoff = {
      detached: failingTurn(),
      track: () => {},
      redefer: async () => {
        redeferAttempts++;
        throw platformFailure("enqueue always fails");
      },
      onDetachedError: (error) => detachedErrors.push(error)
    };

    await dispatchChatRecoveryToHandoff(handoff);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(redeferAttempts).toBe(3);
    expect(detachedErrors).toHaveLength(1);
    expect((detachedErrors[0] as Error).message).toContain(
      "enqueue always fails"
    );
  });

  it("reuses one dedupe key across every retry, so a retry after a partial success (the row was inserted, then the wake push threw) joins that run instead of duplicating it", async () => {
    const dedupeKeysSeen: string[] = [];
    const handoff: ChatRecoveryHandoff = {
      detached: failingTurn(),
      track: () => {},
      redefer: async (dedupeKey) => {
        dedupeKeysSeen.push(dedupeKey);
        throw platformFailure("enqueue always fails");
      },
      onDetachedError: () => {}
    };

    await dispatchChatRecoveryToHandoff(handoff);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(dedupeKeysSeen).toHaveLength(3);
    expect(new Set(dedupeKeysSeen).size).toBe(1);
  });
});

describe("dispatchChatRecoveryToHandoff in a lane run's recovery", () => {
  it("returns at the handoff, and hands the lane the reply to wait for", async () => {
    let finishReply: () => void = () => {};
    let ended = false;
    const replyEnds = new Promise<void>((resolve) => {
      finishReply = resolve;
    });
    const handoff: ChatRecoveryHandoff = {
      detached: async (onTurnStarted) => {
        onTurnStarted();
        await replyEnds;
      },
      track: () => {},
      redefer: async () => {},
      onDetachedError: () => {}
    };
    // Returns while the reply streams: the attempt does not hold the job
    // loop the reply may need.
    const { reply } = await runHoldingLane(() =>
      dispatchChatRecoveryToHandoff(handoff)
    );
    expect(reply).toBeDefined();
    void reply?.then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ended).toBe(false);
    finishReply();
    await reply;
    expect(ended).toBe(true);
  });
});
