import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import { describe, expect, it } from "vitest";
import type {
  OnStartDegradationForTest,
  TestChatResult
} from "./agents/think-session";

/**
 * Steps 2 and 3 of #1710.
 *
 * Step 2 — `hydrationByteBudget`: an oversized stored transcript hydrates
 * as a bounded recent window instead of materializing fully in memory on
 * every wake.
 *
 * Media eviction itself lives in `media-eviction.test.ts`.
 */

type WindowedHydrationStub = {
  getHydrationInfoForTest(): Promise<{
    truncated: boolean;
    totalContentBytes: number;
    hydratedMessages: number;
  } | null>;
  getCachedMessageIdsForTest(): Promise<string[]>;
  getFullHistoryIdsForTest(): Promise<string[]>;
  getOnStartDegradationsForTest(): Promise<OnStartDegradationForTest[]>;
  getPublicDegradationsForTest(): Promise<OnStartDegradationForTest[]>;
  resyncForTest(): Promise<number>;
  testChat(message: string): Promise<TestChatResult>;
};

type MediaEvictionStub = {
  getHydrationBudgetForTest(): Promise<number>;
};

type PointerHydrationStub = {
  getHydrationInfoForTest(): Promise<{
    truncated: boolean;
    totalContentBytes: number;
    hydratedMessages: number;
  } | null>;
  getCachedMessageIdsForTest(): Promise<string[]>;
  getFullHistoryIdsForTest(): Promise<string[]>;
  getStoredPathBytesForTest(): Promise<number>;
  getAttachmentPathBytesForTest(): Promise<number>;
  getCachedFileUrlsForTest(): Promise<string[]>;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("hydrationByteBudget — windowed hydration (#1710)", () => {
  it("boots an oversized transcript as a bounded recent window", async () => {
    const agent = (await getAgentByName(
      env.ThinkWindowedHydrationAgent,
      uniqueName("seeded-windowed")
    )) as unknown as WindowedHydrationStub;

    // No degradation: windowing is the SUCCESS path for oversized sessions.
    expect(await agent.getOnStartDegradationsForTest()).toEqual([]);

    const info = await agent.getHydrationInfoForTest();
    expect(info).not.toBeNull();
    expect(info!.truncated).toBe(true);
    // ~300KB stored vs 64KB budget.
    expect(info!.totalContentBytes).toBeGreaterThan(250_000);
    // The window floor: never fewer than the read-time truncation span the
    // model sees at full fidelity (4 messages), even though 4 × 30KB
    // overshoots the 64KB budget — windowing must not starve the model.
    expect(info!.hydratedMessages).toBeGreaterThanOrEqual(4);
    expect(info!.hydratedMessages).toBeLessThan(10);

    // The in-memory view is the SUFFIX of the seeded chain, ending at the
    // leaf — and durable storage still holds the full transcript.
    const cached = await agent.getCachedMessageIdsForTest();
    expect(cached).toHaveLength(info!.hydratedMessages);
    expect(cached.at(-1)).toBe("seed-9");
    expect(cached).toEqual(
      Array.from(
        { length: cached.length },
        (_, i) => `seed-${10 - cached.length + i}`
      )
    );
    const full = await agent.getFullHistoryIdsForTest();
    expect(full).toEqual(Array.from({ length: 10 }, (_, i) => `seed-${i}`));
  });

  it("emits chat:hydration:windowed on change, not on every sync", async () => {
    const events: Array<{
      type: string;
      payload: { hydratedMessages?: number; budgetBytes?: number };
    }> = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:hydration:windowed") {
        events.push(
          event as unknown as {
            type: string;
            payload: { hydratedMessages?: number; budgetBytes?: number };
          }
        );
      }
    });

    try {
      const agent = (await getAgentByName(
        env.ThinkWindowedHydrationAgent,
        uniqueName("seeded-windowed-events")
      )) as unknown as WindowedHydrationStub;

      // Boot hydration windowed the transcript → exactly one event.
      const info = await agent.getHydrationInfoForTest();
      expect(info!.truncated).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        budgetBytes: 64 * 1024,
        hydratedMessages: info!.hydratedMessages
      });

      // Re-syncing an unchanged oversized transcript must NOT re-emit —
      // a chronically oversized session syncs many times per turn and
      // would otherwise spam identical events.
      await agent.resyncForTest();
      await agent.resyncForTest();
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("exposes degraded onStart steps via the public accessor", async () => {
    const agent = (await getAgentByName(
      env.ThinkWindowedHydrationAgent,
      uniqueName("seeded-windowed-accessor")
    )) as unknown as WindowedHydrationStub;

    // Windowed hydration is the success path — no degradations — and the
    // public accessor agrees with the protected field.
    expect(await agent.getPublicDegradationsForTest()).toEqual([]);
  });

  it("a small transcript hydrates fully (not truncated)", async () => {
    const agent = (await getAgentByName(
      env.ThinkWindowedHydrationAgent,
      uniqueName("empty-boot")
    )) as unknown as WindowedHydrationStub;

    const info = await agent.getHydrationInfoForTest();
    expect(info).not.toBeNull();
    expect(info!.truncated).toBe(false);
    expect(await agent.getCachedMessageIdsForTest()).toEqual([]);
  });

  it("chat works on a windowed-boot agent and persists past the window", async () => {
    const agent = (await getAgentByName(
      env.ThinkWindowedHydrationAgent,
      uniqueName("seeded-windowed-chat")
    )) as unknown as WindowedHydrationStub;

    const result = await agent.testChat("hello there");
    expect(result.done).toBe(true);
    expect(result.error).toBeUndefined();

    // The new turn is persisted on top of the full stored history.
    const full = await agent.getFullHistoryIdsForTest();
    expect(full.length).toBeGreaterThanOrEqual(12);
    expect(full.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => `seed-${i}`)
    );
  });

  it("defaults the budget to 32 MiB", async () => {
    // Read off an agent that does not override the field.
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("default-budget")
    )) as unknown as MediaEvictionStub;

    expect(await agent.getHydrationBudgetForTest()).toBe(32 * 1024 * 1024);
  });

  it("charges a pointer row the bytes it re-inflates, not its stored size", async () => {
    const agent = (await getAgentByName(
      env.ThinkPointerHydrationAgent,
      uniqueName("pointer-hydration")
    )) as unknown as PointerHydrationStub;

    // Ten rows, each offloaded on the write path: the stored transcript is
    // ~a couple of KB, comfortably UNDER the 64KB budget. A budget that
    // counted stored bytes alone would happily hydrate all ten — and then
    // inflate ~420KB of attachments into the isolate.
    const storedBytes = await agent.getStoredPathBytesForTest();
    expect(storedBytes).toBeLessThan(64 * 1024);
    const attachmentBytes = await agent.getAttachmentPathBytesForTest();
    expect(attachmentBytes).toBeGreaterThan(400_000);

    const info = await agent.getHydrationInfoForTest();
    expect(info).not.toBeNull();
    // The budget counts the reconstruction, so this DOES window.
    expect(info!.truncated).toBe(true);
    // `totalContentBytes` still reports the on-disk footprint, which is why
    // it alone cannot be the thing the budget is compared against.
    expect(info!.totalContentBytes).toBe(storedBytes);
    expect(info!.totalContentBytes).toBeLessThan(64 * 1024);
    // Four rows × ~42KB already overshoots 64KB, so the window is the
    // full-fidelity floor and nothing more.
    expect(info!.hydratedMessages).toBe(4);

    const cached = await agent.getCachedMessageIdsForTest();
    expect(cached).toEqual(["ptr-6", "ptr-7", "ptr-8", "ptr-9"]);
    // Durable storage still holds every row.
    expect(await agent.getFullHistoryIdsForTest()).toEqual(
      Array.from({ length: 10 }, (_, i) => `ptr-${i}`)
    );

    // The window is reconstructed byte-for-byte, not left as pointers.
    const urls = await agent.getCachedFileUrlsForTest();
    expect(urls).toEqual(
      [6, 7, 8, 9].map(
        (i) =>
          `data:image/png;base64,${String.fromCharCode(65 + i).repeat(56_000)}`
      )
    );
  });
});
