import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { subscribe } from "agents/observability";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import type {
  OnStartDegradationForTest,
  TestChatResult
} from "./agents/think-session";
import type { MediaEvictionConfig } from "../think";

/**
 * Steps 2 and 3 of #1710.
 *
 * Step 2 — `hydrationByteBudget`: an oversized stored transcript hydrates
 * as a bounded recent window instead of materializing fully in memory on
 * every wake.
 *
 * Step 3 — `mediaEviction`: oversized inline media (data-URL file parts,
 * large strings in tool outputs) is evicted from AGED stored messages and
 * preserved as workspace files, so the persisted footprint stops growing
 * with session age.
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
  setMediaEvictionForTest(config: MediaEvictionConfig | boolean): Promise<void>;
  seedMediaHistoryForTest(prefix?: string): Promise<void>;
  runEvictionForTest(): Promise<{
    messages: number;
    parts: number;
    bytes: number;
    backlogRemains: boolean;
  } | null>;
  getStoredMessageForTest(id: string): Promise<UIMessage | null>;
  getInlinedMessageForTest(id: string): Promise<UIMessage | null>;
  getAttachmentForTest(pointer: string): Promise<{
    hash: string;
    path: string;
    mediaType: string;
    bytes: number;
  } | null>;
  readAttachmentForTest(pointer: string): Promise<Uint8Array>;
  getAttachmentReferenceCountForTest(): Promise<number>;
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
});

describe("mediaEviction — aged media leaves the stored transcript (#1710)", () => {
  it("stores aged file parts and tool strings as lossless attachment pointers", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000
    });

    const totals = await agent.runEvictionForTest();
    expect(totals).toMatchObject({
      messages: 2,
      parts: 2,
      backlogRemains: false
    });
    expect(totals?.bytes).toBeGreaterThan(20_000);

    const m0 = await agent.getStoredMessageForTest("m0");
    expect(m0?.parts[0]).toEqual({
      type: "text",
      text: "look at this screenshot"
    });
    const filePart = m0?.parts[1] as { type: string; url: string };
    expect(filePart.type).toBe("file");
    expect(filePart.url).toMatch(/^attachment:sha256:[0-9a-f]{64}$/);
    expect(await agent.getAttachmentForTest(filePart.url)).toMatchObject({
      mediaType: "image/png",
      bytes: 12_000
    });
    expect(await agent.readAttachmentForTest(filePart.url)).toHaveLength(
      12_000
    );

    const inlined = await agent.getInlinedMessageForTest("m0");
    expect(inlined).not.toBeNull();
    expect((inlined?.parts[1] as { url: string } | undefined)?.url).toBe(
      `data:image/png;base64,${"A".repeat(16_000)}`
    );

    const m1 = await agent.getStoredMessageForTest("m1");
    const toolPart = m1?.parts[0] as {
      type: string;
      state: string;
      output: { mediaType: string; data: string; note: string };
    };
    expect(toolPart.type).toBe("tool-screenshot");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output.mediaType).toBe("image/png");
    expect(toolPart.output.note).toBe("small structured field");
    const toolPointer = toolPart.output.data.match(
      /attachment:sha256:[0-9a-f]{64}/
    )?.[0];
    expect(toolPointer).toBeDefined();
    const toolBytes = await agent.readAttachmentForTest(toolPointer ?? "");
    expect(new TextDecoder().decode(toolBytes)).toBe("B".repeat(16_000));

    const m3 = await agent.getStoredMessageForTest("m3");
    expect(m3?.parts[0]).toEqual({ type: "text", text: "recent answer" });
  });

  it("keeps the chat:media:evicted observability event", async () => {
    const name = uniqueName("evict-observability");
    const events: Array<{ messages?: number; parts?: number; bytes?: number }> =
      [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.type === "chat:media:evicted" && event.name?.startsWith(name)) {
        events.push(event.payload);
      }
    });

    try {
      const agent = (await getAgentByName(
        env.ThinkMediaEvictionAgent,
        name
      )) as unknown as MediaEvictionStub;
      await agent.seedMediaHistoryForTest();
      await agent.setMediaEvictionForTest({
        keepRecentMessages: 2,
        minPartBytes: 10_000
      });
      await agent.runEvictionForTest();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ messages: 2, parts: 2 });
    } finally {
      unsubscribe();
    }
  });

  it("clamps keepRecentMessages to the model full-fidelity window", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-clamp")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 0,
      minPartBytes: 10_000
    });

    expect(await agent.runEvictionForTest()).toMatchObject({ messages: 2 });
    for (const id of ["m2", "m3", "m4", "m5"]) {
      const message = await agent.getStoredMessageForTest(id);
      expect(JSON.stringify(message)).not.toContain("attachment:sha256:");
    }
  });

  it("chains bounded passes until the backlog drains", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-chain")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000,
      maxRowsPerPass: 1
    });

    expect(await agent.runEvictionForTest()).toMatchObject({
      messages: 1,
      backlogRemains: true
    });
    await vi.waitFor(
      async () => {
        const m1 = await agent.getStoredMessageForTest("m1");
        expect(JSON.stringify(m1)).toContain("attachment:sha256:");
      },
      { timeout: 10_000, interval: 250 }
    );
  });

  it("a second pass is a cheap no-op", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-idempotent")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000
    });

    expect(await agent.runEvictionForTest()).toMatchObject({ messages: 2 });
    expect(await agent.runEvictionForTest()).toEqual({
      messages: 0,
      parts: 0,
      bytes: 0,
      backlogRemains: false
    });
  });

  it("keeps the explicit lossy mode without writing attachment blobs", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-drop")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest("d");
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000,
      externalizeToWorkspace: false
    });

    expect(await agent.runEvictionForTest()).toMatchObject({
      messages: 2,
      parts: 2
    });
    const d0 = await agent.getStoredMessageForTest("d0");
    const marker = d0?.parts[1] as { type: string; text: string };
    expect(marker.type).toBe("text");
    expect(marker.text).toContain("[evicted image/png");
    expect(marker.text).not.toContain("preserved at");
    expect(await agent.getAttachmentReferenceCountForTest()).toBe(0);
  });

  it("disabled eviction leaves inline media untouched", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-disabled")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    expect(await agent.runEvictionForTest()).toBeNull();
    const m0 = await agent.getStoredMessageForTest("m0");
    expect(m0).not.toBeNull();
    expect((m0?.parts[1] as { url: string } | undefined)?.url).toContain(
      "data:image/png;base64,"
    );
  });

  it("conversation growth schedules aged tool-output eviction", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAutoAgent,
      uniqueName("evict-auto")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest("a");
    await vi.waitFor(
      async () => {
        const a1 = await agent.getStoredMessageForTest("a1");
        expect(JSON.stringify(a1)).toContain("attachment:sha256:");
      },
      { timeout: 10_000, interval: 250 }
    );
  });
});
