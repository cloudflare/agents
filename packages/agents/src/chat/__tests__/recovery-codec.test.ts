import { describe, it, expect } from "vitest";
import {
  AISDKRecoveryCodec,
  aiSdkRecoveryCodec,
  shouldCreditStreamProgress
} from "../recovery-codec";
import {
  StreamProgressCreditThrottle,
  CHAT_STREAM_PROGRESS_CREDIT_THROTTLE_MS
} from "../recovery-incident";

describe("AISDKRecoveryCodec.isProgressChunk", () => {
  const codec = new AISDKRecoveryCodec();

  // The load-bearing list (#1637): started text/reasoning segments and settled
  // tool input/output are the only chunk types that credit forward progress.
  // This is the exact set ai-chat's `_maybeBumpRecoveryProgress` bumped on
  // before the predicate moved onto the codec (T2-4) — a regression here would
  // silently shift the recovery no-progress window.
  const PROGRESS_TYPES = [
    "text-start",
    "reasoning-start",
    "tool-input-available",
    "tool-output-available",
    "tool-output-error",
    "tool-output-denied"
  ];

  for (const type of PROGRESS_TYPES) {
    it(`credits "${type}" as progress`, () => {
      expect(codec.isProgressChunk(type)).toBe(true);
    });
  }

  // Deltas/ends and lifecycle frames are NOT milestones. Deltas (`text-delta`,
  // `reasoning-delta`) DO credit progress, but through the time throttle (see
  // `isStreamingContentChunk` / `shouldCreditStreamProgress`) so a milestone
  // bump is never per-token; ends and lifecycle frames carry no produced
  // content and never credit.
  const NON_PROGRESS_TYPES = [
    "text-delta",
    "reasoning-delta",
    "text-end",
    "reasoning-end",
    "tool-input-start",
    "start",
    "finish",
    "unknown-type"
  ];

  for (const type of NON_PROGRESS_TYPES) {
    it(`does not credit "${type}"`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }

  it("treats an undefined (non-JSON / typeless) body as non-progress", () => {
    expect(codec.isProgressChunk(undefined)).toBe(false);
  });

  it("exposes a shared stateless singleton", () => {
    expect(aiSdkRecoveryCodec).toBeInstanceOf(AISDKRecoveryCodec);
    expect(aiSdkRecoveryCodec.isProgressChunk("text-start")).toBe(true);
  });
});

describe("AISDKRecoveryCodec.isStreamingContentChunk", () => {
  const codec = new AISDKRecoveryCodec();

  // Mid-segment deltas: too granular to credit per token, but a long single
  // segment that produces only these must still register progress across
  // crashes (throttled). Disjoint from the milestone set above.
  const STREAMING_CONTENT_TYPES = [
    "text-delta",
    "reasoning-delta",
    "tool-input-delta"
  ];

  for (const type of STREAMING_CONTENT_TYPES) {
    it(`classifies "${type}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(true);
    });
    it(`does not also classify "${type}" as a milestone`, () => {
      expect(codec.isProgressChunk(type)).toBe(false);
    });
  }

  // Milestones and lifecycle frames are not streaming content (milestones credit
  // unconditionally; lifecycle frames never credit).
  const NON_STREAMING_TYPES = [
    "text-start",
    "reasoning-start",
    "tool-input-available",
    "tool-output-available",
    "text-end",
    "start",
    "finish",
    "unknown-type"
  ];

  for (const type of NON_STREAMING_TYPES) {
    it(`does not classify "${type}" as streaming content`, () => {
      expect(codec.isStreamingContentChunk(type)).toBe(false);
    });
  }

  it("treats an undefined body as non-streaming-content", () => {
    expect(codec.isStreamingContentChunk(undefined)).toBe(false);
  });
});

describe("shouldCreditStreamProgress", () => {
  // A throttle that always allows, to isolate the codec-classification arm.
  const openThrottle = { shouldCredit: () => true };
  // A throttle that never allows, to prove deltas are gated by it.
  const closedThrottle = { shouldCredit: () => false };

  it("credits a milestone unconditionally — even when the throttle is closed", () => {
    expect(
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type: "text-start",
        throttle: closedThrottle,
        now: 0
      })
    ).toBe(true);
  });

  it("credits a settled-tool milestone unconditionally", () => {
    expect(
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type: "tool-output-available",
        throttle: closedThrottle,
        now: 0
      })
    ).toBe(true);
  });

  it("gates streaming content on the throttle", () => {
    expect(
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type: "text-delta",
        throttle: openThrottle,
        now: 0
      })
    ).toBe(true);
    expect(
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type: "text-delta",
        throttle: closedThrottle,
        now: 0
      })
    ).toBe(false);
  });

  it("never credits a lifecycle/typeless chunk, regardless of throttle", () => {
    for (const type of ["text-end", "start", "finish", undefined]) {
      expect(
        shouldCreditStreamProgress({
          codec: aiSdkRecoveryCodec,
          type,
          throttle: openThrottle,
          now: 0
        })
      ).toBe(false);
    }
  });

  // The integration that closes the convergence gap: a long single text segment
  // that emits only deltas (no new milestone) still credits progress over time,
  // so the no-progress window can't false-fire while content streams. ai-chat
  // previously credited such a segment exactly once (at `text-start`); now both
  // hosts credit it again every throttle window.
  it("credits a delta-only segment once per throttle window (long-segment gap)", () => {
    const throttle = new StreamProgressCreditThrottle();
    const credit = (now: number) =>
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type: "text-delta",
        throttle,
        now
      });
    // Epoch-scale clock: the in-memory `_lastBumpAt` starts at 0, so the first
    // delta after a fresh isolate is always past the window and credits.
    const t0 = 1_700_000_000_000;
    expect(credit(t0)).toBe(true);
    // Rapid follow-up deltas within the window do not (no per-token writes).
    expect(credit(t0 + 1)).toBe(false);
    expect(credit(t0 + CHAT_STREAM_PROGRESS_CREDIT_THROTTLE_MS - 1)).toBe(
      false
    );
    // Once the window elapses, the still-streaming segment credits again.
    expect(credit(t0 + CHAT_STREAM_PROGRESS_CREDIT_THROTTLE_MS)).toBe(true);
  });
});
