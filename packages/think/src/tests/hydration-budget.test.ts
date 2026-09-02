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
  getHydrationBudgetForTest(): Promise<number>;
  resyncForTest(): Promise<number>;
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
    // Media nested in a tool output leaves the row at the media threshold,
    // wherever the tool put it.
    const toolPointer = toolPart.output.data.match(
      /attachment:sha256:[0-9a-f]{64}/
    )?.[0];
    expect(toolPointer).toBeDefined();
    const toolBytes = await agent.readAttachmentForTest(toolPointer ?? "");
    expect(toolBytes).toHaveLength(12_000);

    const inlinedTool = await agent.getInlinedMessageForTest("m1");
    expect(
      (inlinedTool?.parts[0] as { output: { data: string } } | undefined)
        ?.output.data
    ).toBe(`data:image/png;base64,${"B".repeat(16_000)}`);

    const m3 = await agent.getStoredMessageForTest("m3");
    expect(m3?.parts[0]).toEqual({ type: "text", text: "recent answer" });
  });

  it("emits session:maintenance:completed from the capability", async () => {
    const name = uniqueName("evict-observability");
    const events: Array<{ messages?: number; parts?: number; bytes?: number }> =
      [];
    // Think no longer re-emits `chat:media:evicted`; the Sessions capability
    // owns the telemetry and publishes it on the lifecycle channel.
    const unsubscribe = subscribe("lifecycle", (raw) => {
      const event = raw as unknown as {
        type: string;
        name?: string;
        payload: { messages?: number; parts?: number; bytes?: number };
      };
      if (
        event.type === "session:maintenance:completed" &&
        event.name?.startsWith(name)
      ) {
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

  it("bounds each pass and reports the remaining backlog", async () => {
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

    // One row per pass, and the capability chains the rest itself once the
    // first pass reports a backlog.
    expect(await agent.runEvictionForTest()).toMatchObject({
      messages: 1,
      backlogRemains: true
    });
    for (let tick = 0; tick < 50; tick++) {
      const stored = await agent.getStoredMessageForTest("m1");
      if (JSON.stringify(stored).includes("attachment:sha256:")) break;
      await scheduler.wait(1);
    }
    for (const id of ["m0", "m1"]) {
      const message = await agent.getStoredMessageForTest(id);
      expect(JSON.stringify(message)).toContain("attachment:sha256:");
    }
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

  it("externalizeToWorkspace:false is inert — payload bytes always survive", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-drop")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest("d");
    // The old lossy mode is gone. The field is still accepted (it predates
    // the Sessions capability) but no longer drops bytes: the pass is
    // lossless, so the row round-trips instead of leaving an "[evicted …]"
    // marker behind.
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
    const stored = d0?.parts[1] as { type: string; url: string };
    expect(stored.type).toBe("file");
    expect(stored.url).toMatch(/^attachment:sha256:[0-9a-f]{64}$/);
    expect(await agent.getAttachmentReferenceCountForTest()).toBeGreaterThan(0);

    const inlined = await agent.getInlinedMessageForTest("d0");
    expect((inlined?.parts[1] as { url: string } | undefined)?.url).toBe(
      `data:image/png;base64,${"A".repeat(16_000)}`
    );
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

  it("a windowed hydration read schedules the maintenance pass", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAutoAgent,
      uniqueName("evict-auto")
    )) as unknown as MediaEvictionStub;

    // Seed under a loose policy so the write path leaves the payloads
    // inline — exactly the shape a legacy transcript has.
    await agent.setMediaEvictionForTest(false);
    await agent.seedMediaHistoryForTest("a");
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000
    });

    // The agent's 1KB hydration budget makes this read window the
    // transcript, which is what schedules the background pass.
    await agent.resyncForTest();
    await vi.waitFor(
      async () => {
        for (const id of ["a0", "a1"]) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("attachment:sha256:");
        }
      },
      { timeout: 10_000, interval: 250 }
    );
  });
});
