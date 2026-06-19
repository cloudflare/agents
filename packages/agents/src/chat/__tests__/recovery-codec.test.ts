import { describe, it, expect } from "vitest";
import { AISDKRecoveryCodec, aiSdkRecoveryCodec } from "../recovery-codec";

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

  // Deltas/ends and lifecycle frames are NOT progress: they either replay
  // existing content or carry no produced content, so crediting them would let
  // a stalled turn look alive (false non-terminalization) — or, for think's
  // per-token `text-delta`, regress to per-token writes if ever reused.
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
