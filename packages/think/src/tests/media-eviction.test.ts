import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import type { MediaEvictionConfig } from "../think";
import { hasEvictableMedia } from "../media-eviction";

/**
 * Media eviction as a CONTEXT-WINDOW technique (#1710).
 *
 * Aged media leaves the conversation so the model stops re-reading a large
 * image every turn; the bytes land in the Workspace, raw and correctly typed,
 * and the marker tells the agent where to read them back. This is not row
 * chunking, which is an invisible, lossless storage detail.
 */

type MediaEvictionStub = {
  setMediaEvictionForTest(config: MediaEvictionConfig | boolean): Promise<void>;
  seedMediaHistoryForTest(prefix?: string, mediaChars?: number): Promise<void>;
  runEvictionForTest(): Promise<{
    messages: number;
    parts: number;
    bytes: number;
    backlogRemains: boolean;
  } | null>;
  getStoredMessageForTest(id: string): Promise<UIMessage | null>;
  getContinuationRowCountForTest(): Promise<number>;
  readEvictedFileForTest(path: string): Promise<{
    byteLength: number;
    mimeType: string | null;
    firstBytes: number[];
    allSame: boolean;
  } | null>;
  resyncForTest(): Promise<number>;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** `keepRecentMessages` clamps up to 4, so `m0`/`m1` are the aged rows. */
const AGED_POLICY: MediaEvictionConfig = {
  keepRecentMessages: 2,
  minPartBytes: 10_000
};

/** 16_000 base64 chars decode to exactly 12_000 bytes. */
const PAYLOAD_BYTES = 12_000;

/**
 * Over the row budget, so Sessions splits the message across continuation
 * rows. The part is still an inline `data:` URL, so eviction decodes it in
 * place exactly as it does a small one.
 */
const SPLIT_MEDIA_CHARS = 1_600_000;
const SPLIT_PAYLOAD_BYTES = 1_200_000;

async function evictionAgent(name: string): Promise<MediaEvictionStub> {
  return (await getAgentByName(
    env.ThinkMediaEvictionAgent,
    name
  )) as unknown as MediaEvictionStub;
}

function textOf(part: unknown): string {
  return (part as { text?: string } | undefined)?.text ?? "";
}

describe("mediaEviction — aged media leaves the conversation (#1710)", () => {
  it("replaces an aged file part with the exact eviction marker", async () => {
    const agent = await evictionAgent(uniqueName("evict-marker"));
    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest(AGED_POLICY);

    const totals = await agent.runEvictionForTest();
    expect(totals).toMatchObject({
      messages: 2,
      parts: 2,
      bytes: PAYLOAD_BYTES * 2,
      backlogRemains: false
    });

    const m0 = await agent.getStoredMessageForTest("m0");
    // Prose is untouched: only the media part is rewritten.
    expect(m0?.parts[0]).toEqual({
      type: "text",
      text: "look at this screenshot"
    });
    expect(m0?.parts[1]).toEqual({
      type: "text",
      text: `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /attachments/evicted/m0-0.png]`
    });

    // A reconstructing read sees the marker too — the media is gone from the
    // conversation, which is the whole point.
    const inlined = await agent.getStoredMessageForTest("m0");
    expect(JSON.stringify(inlined)).not.toContain("data:image/png");
  });

  it("writes raw decoded bytes to the Workspace with the right mime type", async () => {
    const agent = await evictionAgent(uniqueName("evict-workspace"));
    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest(AGED_POLICY);
    await agent.runEvictionForTest();

    const file = await agent.readEvictedFileForTest(
      "/attachments/evicted/m0-0.png"
    );
    expect(file).not.toBeNull();
    // Raw bytes, not the `data:` URL string the old implementation stored:
    // `read` sniffs image/* off the mime type and hands the model a real
    // image when the agent deliberately reads it back.
    expect(file?.byteLength).toBe(PAYLOAD_BYTES);
    expect(file?.mimeType).toBe("image/png");
    expect(file?.allSame).toBe(true);
    expect(file?.firstBytes).toEqual([0, 0, 0, 0]);
  });

  it("evicts a data-URL string nested in a tool output", async () => {
    const agent = await evictionAgent(uniqueName("evict-tool-output"));
    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest(AGED_POLICY);
    await agent.runEvictionForTest();

    const m1 = await agent.getStoredMessageForTest("m1");
    const part = m1?.parts[0] as {
      type: string;
      state: string;
      output: { mediaType: string; data: string; note: string };
    };
    // The container shape survives so tool `toModelOutput` handlers still run.
    expect(part.type).toBe("tool-screenshot");
    expect(part.state).toBe("output-available");
    expect(part.output.mediaType).toBe("image/png");
    expect(part.output.note).toBe("small structured field");
    expect(part.output.data).toBe(
      `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /attachments/evicted/m1-0.png]`
    );

    const file = await agent.readEvictedFileForTest(
      "/attachments/evicted/m1-0.png"
    );
    expect(file?.byteLength).toBe(PAYLOAD_BYTES);
    expect(file?.mimeType).toBe("image/png");
  });

  it("evicts a payload larger than one row, leaving the bytes in one place", async () => {
    const agent = await evictionAgent(uniqueName("evict-split"));
    // Seed before enabling the policy: an append with the policy on would
    // schedule the pass itself, and this test drives the pass by hand.
    await agent.seedMediaHistoryForTest("m", SPLIT_MEDIA_CHARS);
    await agent.setMediaEvictionForTest(AGED_POLICY);

    // The message is split across continuation rows, and the part is still
    // the inline `data:` URL eviction decodes.
    expect(await agent.getContinuationRowCountForTest()).toBeGreaterThan(0);
    const seeded = await agent.getStoredMessageForTest("m0");
    expect((seeded?.parts[1] as { url?: string } | undefined)?.url).toMatch(
      /^data:image\/png;base64,/
    );

    expect(await agent.runEvictionForTest()).toMatchObject({
      messages: 2,
      parts: 2,
      bytes: SPLIT_PAYLOAD_BYTES * 2
    });

    const m0 = await agent.getStoredMessageForTest("m0");
    expect(m0?.parts[1]).toEqual({
      type: "text",
      text: `[evicted image/png, ${SPLIT_PAYLOAD_BYTES} bytes; preserved at /attachments/evicted/m0-0.png]`
    });
    // The rewritten row is small again, so its continuations are gone: the
    // only copy of these bytes is now the Workspace file.
    expect(await agent.getContinuationRowCountForTest()).toBe(0);
    expect(
      (await agent.readEvictedFileForTest("/attachments/evicted/m0-0.png"))
        ?.byteLength
    ).toBe(SPLIT_PAYLOAD_BYTES);
  });

  it("leaves recent messages alone", async () => {
    const agent = await evictionAgent(uniqueName("evict-recent"));
    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({
      keepRecentMessages: 0,
      minPartBytes: 10_000
    });

    // `keepRecentMessages` clamps to the model's full-fidelity window, so a
    // misconfigured 0 still cannot touch what the model is still reading.
    expect(await agent.runEvictionForTest()).toMatchObject({ messages: 2 });
    for (const id of ["m2", "m3", "m4", "m5"]) {
      const message = await agent.getStoredMessageForTest(id);
      expect(textOf(message?.parts[0])).toMatch(/^recent (question|answer)$/);
    }
  });

  it("a second pass is a cheap no-op", async () => {
    const agent = await evictionAgent(uniqueName("evict-idempotent"));
    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest(AGED_POLICY);

    expect(await agent.runEvictionForTest()).toMatchObject({ messages: 2 });
    expect(await agent.runEvictionForTest()).toEqual({
      messages: 0,
      parts: 0,
      bytes: 0,
      backlogRemains: false
    });
  });

  it("bounds each pass and drains the reported backlog", async () => {
    const agent = await evictionAgent(uniqueName("evict-backlog"));
    await agent.seedMediaHistoryForTest();
    await agent.setMediaEvictionForTest({ ...AGED_POLICY, maxRowsPerPass: 1 });

    expect(await agent.runEvictionForTest()).toMatchObject({
      messages: 1,
      backlogRemains: true
    });
    // A pass that made progress chains the next one itself.
    await vi.waitFor(
      async () => {
        const m1 = await agent.getStoredMessageForTest("m1");
        expect(JSON.stringify(m1)).toContain("[evicted image/png,");
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it("mediaEviction:false keeps the image visible to the model", async () => {
    const agent = await evictionAgent(uniqueName("evict-disabled"));
    await agent.seedMediaHistoryForTest();

    expect(await agent.runEvictionForTest()).toBeNull();
    const inlined = await agent.getStoredMessageForTest("m0");
    expect((inlined?.parts[1] as { url: string } | undefined)?.url).toBe(
      `data:image/png;base64,${"A".repeat(16_000)}`
    );
    expect(
      await agent.readEvictedFileForTest("/attachments/evicted/m0-0.png")
    ).toBeNull();
  });

  it("a linear append schedules the pass without a cache refresh", async () => {
    // The pass used to be armed only by a full cache refresh, which a chat
    // turn no longer performs. An append is what ages older messages, so
    // the in-memory gate runs there: once the sixth seeded message lands,
    // `p0`/`p1` are aged and still carry payloads, and the pass follows on
    // its own — no resync, no explicit run.
    const agent = await evictionAgent(uniqueName("evict-on-append"));
    await agent.setMediaEvictionForTest(AGED_POLICY);
    await agent.seedMediaHistoryForTest("p");

    await vi.waitFor(
      async () => {
        for (const id of ["p0", "p1"]) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("keeps a request that lands while a pass is running", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-mid-pass")
    )) as unknown as MediaEvictionStub & {
      appendDuringPassForTest(): Promise<{
        firstPassMessages: number;
        lateId: string;
      }>;
    };

    // The running guard used to drop the append's request outright, so
    // media aged during a pass waited for the next append or refresh.
    const { firstPassMessages, lateId } = await agent.appendDuringPassForTest();
    expect(firstPassMessages).toBe(2);
    await vi.waitFor(
      async () => {
        const message = await agent.getStoredMessageForTest(lateId);
        expect(JSON.stringify(message)).toContain("[evicted image/png,");
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("re-arms a fruitless pass on a windowed cache once appends age a protected row", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAutoAgent,
      uniqueName("evict-rearm")
    )) as unknown as MediaEvictionStub & {
      ageProtectedMediaByAppendsForTest(): Promise<string[]>;
    };
    await agent.setMediaEvictionForTest(AGED_POLICY);

    // The first pass sees the media inside the protected tail and records a
    // fruitless scan. Four appends later the media is aged; those appends
    // never refreshed the hydration snapshot, so the append count alone
    // must re-arm the pass.
    const ids = await agent.ageProtectedMediaByAppendsForTest();
    await vi.waitFor(
      async () => {
        for (const id of ids) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("counts appends that land during a fruitless pass toward re-arming it", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAutoAgent,
      uniqueName("evict-rearm-mid-pass")
    )) as unknown as MediaEvictionStub & {
      appendDuringFruitlessPassForTest(): Promise<{
        ids: string[];
        runningAtAppend: boolean;
        firstPassMessages: number;
      }>;
    };
    await agent.setMediaEvictionForTest(AGED_POLICY);

    // Four appends land while a fruitless pass is running. The pass used to
    // record zero appends since when it ended, so the request those appends
    // left pending was suppressed until four more arrived.
    const { ids, runningAtAppend, firstPassMessages } =
      await agent.appendDuringFruitlessPassForTest();
    expect(runningAtAppend).toBe(true);
    expect(firstPassMessages).toBe(0);
    await vi.waitFor(
      async () => {
        for (const id of ids) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("a windowed hydration read schedules the pass", async () => {
    const agent = (await getAgentByName(
      env.ThinkMediaEvictionAutoAgent,
      uniqueName("evict-auto")
    )) as unknown as MediaEvictionStub;

    await agent.seedMediaHistoryForTest("a");
    await agent.setMediaEvictionForTest(AGED_POLICY);
    await agent.resyncForTest();

    await vi.waitFor(
      async () => {
        for (const id of ["a0", "a1"]) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 10_000, interval: 100 }
    );
  });
});

describe("hasEvictableMedia — the in-memory gate for scheduling a pass", () => {
  const png = (bytes: number) => `data:image/png;base64,${"A".repeat(bytes)}`;

  it("sees an inline file payload at or above the threshold", () => {
    const message = {
      id: "m",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url: png(2_000) }]
    } as unknown as UIMessage;
    expect(hasEvictableMedia(message, 1_000)).toBe(true);
    expect(hasEvictableMedia(message, 10_000)).toBe(false);
  });

  it("sees a payload nested inside a tool output", () => {
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-screenshot",
          toolCallId: "tc",
          state: "output-available",
          output: { frames: [{ image: png(5_000) }] }
        }
      ]
    } as unknown as UIMessage;
    expect(hasEvictableMedia(message, 1_000)).toBe(true);
  });

  it("ignores text, markers, remote urls and small payloads", () => {
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        { type: "text", text: "x".repeat(50_000) },
        { type: "file", mediaType: "image/png", url: "https://x/y.png" },
        { type: "file", mediaType: "image/png", url: png(10) },
        {
          type: "tool-fetch",
          toolCallId: "tc",
          state: "output-available",
          output: { body: "z".repeat(50_000) }
        }
      ]
    } as unknown as UIMessage;
    expect(hasEvictableMedia(message, 1_000)).toBe(false);
  });
});
