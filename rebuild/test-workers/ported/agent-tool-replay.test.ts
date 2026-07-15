/**
 * Ported from ORIGINAL Agents:
 * - packages/agents/src/tests/agent-tool-replay.test.ts
 * - last original change: 0f47d61c
 * - port date: 2026-07-15
 * Modifications:
 * - Recorded the original replay scenarios as `blocked ISSUE-035` because the
 *   rebuild delegation run model has no `interrupted` status, no persisted
 *   `reason` / `childStillRunning` fields, and no interrupted terminal frame
 *   builder to exercise honestly.
 * - Did not synthesize replay frames in a fixture.
 */
// @ts-nocheck
import { describe, it } from "vitest";

describe("agent-tool interrupted cause survives reconnect replay (#1630) (ported)", () => {
  it.skip("persists + replays reason/childStillRunning for a soft no-progress interrupt", () => {
    // blocked ISSUE-035: no soft-terminal `interrupted` rows or typed reasons.
  });

  it.skip("persists + replays a torn-down window-exceeded interrupt (childStillRunning false)", () => {
    // blocked ISSUE-035: no `childStillRunning` persistence/replay surface.
  });

  it.skip("persists + replays a reason without childStillRunning (the reconcile path)", () => {
    // blocked ISSUE-035: no interrupted reconcile result vocabulary exists.
  });

  it.skip("replays a legacy interrupted row (no persisted cause) without crashing", () => {
    // blocked ISSUE-035: no interrupted terminal event mapping exists.
  });

  it.skip("clears the persisted cause when a soft interrupt is later repaired to completed", () => {
    // blocked ISSUE-035: no soft interrupt repair path exists.
  });
});
