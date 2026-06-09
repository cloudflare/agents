import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import type { ThinkRecoveryTestAgent } from "./agents/think-session";

// Covers alarm-driven resumable-stream buffer cleanup (#1706): Think arms a
// scheduled cleanup alarm whenever a stream finishes so idle/one-off chat DOs
// still reclaim their buffers, instead of only sweeping lazily when a
// *subsequent* stream completes. Uses ThinkRecoveryTestAgent, which carries the
// stream/schedule test helpers.

const CLEANUP_CALLBACK = "_cleanupStreamBuffers";

async function freshAgent(name?: string) {
  return getAgentByName(
    env.ThinkRecoveryTestAgent as unknown as DurableObjectNamespace<ThinkRecoveryTestAgent>,
    name ?? crypto.randomUUID()
  );
}

describe("Think — alarm-driven stream cleanup (#1706)", () => {
  it("arms a single cleanup alarm when a stream finishes, deduping repeats", async () => {
    const agent = await freshAgent();

    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);

    await agent.insertAgedStreamForTest("s1", "req-1", "streaming", 1000);
    await agent.completeStreamForTest("s1");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);

    // Subsequent finishes collapse onto the same pending alarm (idempotent).
    await agent.insertAgedStreamForTest("s2", "req-2", "streaming", 1000);
    await agent.completeStreamForTest("s2");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("reclaims aged buffers when the alarm fires without a new stream completing", async () => {
    const agent = await freshAgent();

    // The #1706 scenario: a one-off chat whose buffers age out with no further
    // stream ever completing to drive the lazy in-line sweep.
    await agent.insertAgedStreamForTest(
      "old-errored",
      "req-errored",
      "error",
      25 * 60 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "abandoned",
      "req-abandoned",
      "streaming",
      25 * 60 * 60 * 1000
    );

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("old-errored")).toBeNull();
    expect(await agent.getStreamStatusForTest("abandoned")).toBeNull();
  });

  it("re-arms only while reclaimable buffers remain", async () => {
    const agent = await freshAgent();

    // Fully-swept DO: running cleanup with nothing left does NOT re-arm.
    await agent.runStreamCleanupForTest();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);

    // A still-recent stream survives the sweep, so an alarm stays pending.
    await agent.insertAgedStreamForTest(
      "recent",
      "req-recent",
      "streaming",
      60 * 1000
    );
    await agent.runStreamCleanupForTest();
    expect(await agent.getStreamStatusForTest("recent")).toBe("streaming");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("survives the real alarm fire and re-arms when a younger buffer remains", async () => {
    // Guards the idempotent-reschedule footgun: when the cleanup alarm fires,
    // `alarm()` deletes the fired one-shot row after the callback returns. An
    // idempotent re-arm would dedup onto that doomed row and vanish with it,
    // leaking any buffer that survived this sweep. The re-arm must be a fresh
    // row.
    const agent = await freshAgent();

    // A recent buffer that survives the 24h sweep, plus a finish to arm the
    // alarm.
    await agent.insertAgedStreamForTest(
      "young",
      "req-young",
      "streaming",
      60 * 1000
    );
    await agent.completeStreamForTest("young");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);

    // Fire the alarm for real — the fired row is deleted after the callback.
    await agent.fireDueCleanupAlarmForTest();

    // The young buffer survived the sweep, so a FRESH cleanup alarm must remain
    // pending (this is exactly 0 if the re-arm were idempotent).
    expect(await agent.getStreamStatusForTest("young")).toBe("completed");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("stops re-arming after the real alarm sweeps the last buffer", async () => {
    const agent = await freshAgent();

    // An aged buffer that the sweep will reclaim. Arm directly so we don't
    // leave a fresh surviving buffer (completing a stream would reset its age).
    await agent.insertAgedStreamForTest(
      "old",
      "req-old",
      "completed",
      25 * 60 * 60 * 1000
    );
    await agent.armStreamCleanupForTest();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);

    await agent.fireDueCleanupAlarmForTest();

    // Nothing reclaimable remains, so no re-arm: the DO stops waking itself.
    expect(await agent.getStreamStatusForTest("old")).toBeNull();
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);
  });

  it("does not sweep a long-running stream that is still emitting chunks", async () => {
    // The abandoned-streaming sweep keys off LAST chunk activity, not start
    // time: a stream that began > 24h ago but is still writing chunks must
    // survive, while one silent past the window is reclaimed.
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "long-active",
      "req-active",
      "streaming",
      25 * 60 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("long-active", 60 * 1000);

    await agent.insertAgedStreamForTest(
      "long-silent",
      "req-silent",
      "streaming",
      25 * 60 * 60 * 1000
    );
    await agent.insertStreamChunkForTest("long-silent", 25 * 60 * 60 * 1000);

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("long-active")).toBe("streaming");
    expect(await agent.getStreamStatusForTest("long-silent")).toBeNull();
  });

  it("arms cleanup when a stream starts (covers never-finished orphans)", async () => {
    const agent = await freshAgent();

    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(0);

    // Starting a stream (without ever finishing it) must arm cleanup so an
    // evicted, never-resumed mid-stream orphan still gets a future sweep.
    await agent.startStreamForTest("req-orphan");
    expect(
      await agent.getScheduledChatRecoveryCountForTest(CLEANUP_CALLBACK)
    ).toBe(1);
  });

  it("arms the cleanup alarm at the completion-grace delay (10 minutes)", async () => {
    // Locks the arming interval: a regression that lengthens it back toward
    // the old 24h window (re-introducing the #1706 leak) fails here.
    const agent = await freshAgent();

    await agent.armStreamCleanupForTest();
    expect(await agent.streamCleanupScheduleDelaySecondsForTest()).toBe(
      10 * 60
    );
  });

  it("sweeps a finished buffer past the 10-minute grace, keeps a recent one", async () => {
    // Completion retention is short: the assistant message is persisted
    // separately, so a finished buffer is only a brief replay grace.
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "done-stale",
      "req-done-stale",
      "completed",
      11 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "done-recent",
      "req-done-recent",
      "completed",
      5 * 60 * 1000
    );

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("done-stale")).toBeNull();
    expect(await agent.getStreamStatusForTest("done-recent")).toBe("completed");
  });

  it("keeps an abandoned in-flight buffer until the 1-hour stale window", async () => {
    // In-flight retention is generous so an interrupted turn has ample time to
    // be resumed or recovered before its buffer is presumed dead.
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "inflight-recent",
      "req-inflight-recent",
      "streaming",
      30 * 60 * 1000
    );
    await agent.insertAgedStreamForTest(
      "inflight-stale",
      "req-inflight-stale",
      "streaming",
      70 * 60 * 1000
    );

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("inflight-recent")).toBe(
      "streaming"
    );
    expect(await agent.getStreamStatusForTest("inflight-stale")).toBeNull();
  });

  it("keeps an in-flight buffer's chunks reconstructable past the completion grace", async () => {
    // Recovery reconstructs a partial assistant message from the stream buffer
    // (getStreamChunks), and only ever does so for an ACTIVE `streaming` row —
    // which uses the generous 1h last-activity window, NOT the 10min completion
    // grace. A buffer whose last chunk is older than the completion grace but
    // within the in-flight window must survive a sweep with its chunks intact,
    // otherwise a turn interrupted >10min could not be recovered.
    const agent = await freshAgent();

    await agent.insertAgedStreamForTest(
      "recovering",
      "req-recovering",
      "streaming",
      30 * 60 * 1000
    );
    // Last chunk 20 minutes ago: past the 10min grace, within the 1h window.
    await agent.insertStreamChunkForTest("recovering", 20 * 60 * 1000);

    await agent.runStreamCleanupForTest();

    expect(await agent.getStreamStatusForTest("recovering")).toBe("streaming");
    const snapshot = await agent.getLatestStreamSnapshot();
    expect(snapshot?.requestId).toBe("req-recovering");
    expect(snapshot?.chunkCount).toBeGreaterThan(0);
  });
});
