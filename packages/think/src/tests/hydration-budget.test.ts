import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
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
  testChat(message: string): Promise<TestChatResult>;
};

type MediaEvictionStub = {
  setMediaEvictionForTest(config: MediaEvictionConfig | boolean): Promise<void>;
  seedMediaHistoryForTest(prefix?: string): Promise<void>;
  runEvictionForTest(): Promise<{
    messages: number;
    parts: number;
    bytes: number;
    externalizedBytes: number;
  } | null>;
  getStoredMessageForTest(id: string): Promise<UIMessage | null>;
  readWorkspaceFileForTest(path: string): Promise<string | null>;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("hydrationByteBudget — windowed hydration (#1710)", () => {
  it("boots an oversized transcript as a bounded recent window", async () => {
    const agent = (await getServerByName(
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
    expect(info!.hydratedMessages).toBeGreaterThanOrEqual(1);
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

  it("a small transcript hydrates fully (not truncated)", async () => {
    const agent = (await getServerByName(
      env.ThinkWindowedHydrationAgent,
      uniqueName("empty-boot")
    )) as unknown as WindowedHydrationStub;

    const info = await agent.getHydrationInfoForTest();
    expect(info).not.toBeNull();
    expect(info!.truncated).toBe(false);
    expect(await agent.getCachedMessageIdsForTest()).toEqual([]);
  });

  it("chat works on a windowed-boot agent and persists past the window", async () => {
    const agent = (await getServerByName(
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
  it("evicts data-URL file parts and large tool-output strings from aged messages", async () => {
    const agent = (await getServerByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000
    });

    const totals = await agent.runEvictionForTest();
    expect(totals).not.toBeNull();
    expect(totals!.messages).toBe(2);
    expect(totals!.parts).toBe(2);
    expect(totals!.bytes).toBeGreaterThan(20_000);
    expect(totals!.externalizedBytes).toBe(totals!.bytes);

    // m0: the data-URL file part became a text marker pointing at the
    // workspace file; the small text part is untouched.
    const m0 = await agent.getStoredMessageForTest("m0");
    expect(m0!.parts[0]).toEqual({
      type: "text",
      text: "look at this screenshot"
    });
    const marker = m0!.parts[1] as { type: string; text: string };
    expect(marker.type).toBe("text");
    expect(marker.text).toContain("[evicted image/png");
    expect(marker.text).toContain("/attachments/evicted/m0-0.png");

    // m1: the tool part keeps its shape; only the oversized string was
    // replaced, small structured fields survive.
    const m1 = await agent.getStoredMessageForTest("m1");
    const toolPart = m1!.parts[0] as {
      type: string;
      state: string;
      output: { mediaType: string; data: string; note: string };
    };
    expect(toolPart.type).toBe("tool-screenshot");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output.mediaType).toBe("image/png");
    expect(toolPart.output.note).toBe("small structured field");
    expect(toolPart.output.data).toContain("[evicted");
    expect(toolPart.output.data).toContain("/attachments/evicted/m1-0.txt");

    // Recent messages (inside keepRecentMessages) are untouched.
    const m3 = await agent.getStoredMessageForTest("m3");
    expect(m3!.parts[0]).toEqual({ type: "text", text: "recent answer" });

    // The evicted bytes were preserved as workspace files BEFORE the rows
    // were rewritten.
    const filePart = await agent.readWorkspaceFileForTest(
      "/attachments/evicted/m0-0.png"
    );
    expect(filePart).toBe(`data:image/png;base64,${"A".repeat(12_000)}`);
    const toolBlob = await agent.readWorkspaceFileForTest(
      "/attachments/evicted/m1-0.txt"
    );
    expect(toolBlob).toBe("B".repeat(12_000));
  });

  it("a second pass is a cheap no-op (rewritten rows skip the size gate)", async () => {
    const agent = (await getServerByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-idempotent")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000
    });

    const first = await agent.runEvictionForTest();
    expect(first!.messages).toBe(2);

    const second = await agent.runEvictionForTest();
    expect(second).toEqual({
      messages: 0,
      parts: 0,
      bytes: 0,
      externalizedBytes: 0
    });
  });

  it("externalizeToWorkspace: false drops the bytes with a size-only marker", async () => {
    const agent = (await getServerByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-drop")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest("d");
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 2,
      minPartBytes: 10_000,
      externalizeToWorkspace: false
    });

    const totals = await agent.runEvictionForTest();
    expect(totals!.messages).toBe(2);
    expect(totals!.externalizedBytes).toBe(0);

    const d0 = await agent.getStoredMessageForTest("d0");
    const marker = d0!.parts[1] as { type: string; text: string };
    expect(marker.text).toContain("[evicted image/png");
    expect(marker.text).not.toContain("preserved at");
    expect(
      await agent.readWorkspaceFileForTest("/attachments/evicted/d0-0.png")
    ).toBeNull();
  });

  it("disabled eviction leaves everything untouched", async () => {
    const agent = (await getServerByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-disabled")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest();
    expect(await agent.runEvictionForTest()).toBeNull();

    const m0 = await agent.getStoredMessageForTest("m0");
    expect((m0!.parts[1] as { url: string }).url).toContain(
      "data:image/png;base64,"
    );
  });

  it("background pass triggered by conversation growth evicts automatically", async () => {
    const agent = (await getServerByName(
      env.ThinkMediaEvictionAutoAgent,
      uniqueName("evict-auto")
    )) as unknown as MediaEvictionStub;

    // Appends fire the message-change hook, which schedules a pass.
    await agent.seedMediaHistoryForTest("a");

    await vi.waitFor(
      async () => {
        const a0 = await agent.getStoredMessageForTest("a0");
        const part = a0!.parts[1] as { type: string; text?: string };
        expect(part.type).toBe("text");
        expect(part.text).toContain("[evicted image/png");
      },
      { timeout: 10_000, interval: 250 }
    );
  });
});
