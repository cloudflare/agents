import { ROW_VALUE_BYTES } from "agents/chat";
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import type { MediaEvictionConfig } from "../think";
import { hasEvictableMedia } from "../media-eviction";
import { subscribe } from "agents/observability";

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
  seedLargeTextAboveMediaForTest(largeRows: number): Promise<void>;
  lateMediaOnHiddenRowForTest(): Promise<number>;
  getContinuationRowCountForTest(): Promise<number>;
  readEvictedFileForTest(path: string): Promise<{
    byteLength: number;
    firstBytes: number[];
    allSame: boolean;
  } | null>;
  resyncForTest(): Promise<number>;
  seedLargeTextBelowMediaForTest(largeRows: number): Promise<void>;
  evictionPassQueuedForTest(): Promise<boolean>;
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
const SPLIT_MEDIA_CHARS = 4 * Math.ceil((ROW_VALUE_BYTES + 400_000) / 4);
const SPLIT_PAYLOAD_BYTES = (SPLIT_MEDIA_CHARS / 4) * 3;

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
      text: `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /workspace/attachments/evicted/m0-0.png]`
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
      "/workspace/attachments/evicted/m0-0.png"
    );
    expect(file).not.toBeNull();
    // Raw bytes, not the `data:` URL string the old implementation stored,
    // so `read` can hand the model a real image when the agent reads it back.
    expect(file?.byteLength).toBe(PAYLOAD_BYTES);
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
      `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /workspace/attachments/evicted/m1-0.png]`
    );

    const file = await agent.readEvictedFileForTest(
      "/workspace/attachments/evicted/m1-0.png"
    );
    expect(file?.byteLength).toBe(PAYLOAD_BYTES);
  });

  it("starts a pass where the last one got to, so it re-reads only new rows", async () => {
    const agent = (await evictionAgent(uniqueName("evict-cursor"))) as Awaited<
      ReturnType<typeof evictionAgent>
    > & {
      evictionPassRowsForTest(
        count: number
      ): Promise<{ first: number; second: number }>;
    };
    await agent.setMediaEvictionForTest(AGED_POLICY);
    const { first, second } = await agent.evictionPassRowsForTest(300);
    // The first pass counts the path and examines every aged row.
    expect(first).toBeGreaterThanOrEqual(300);
    // The second reads from the leaf down to the first pass's cursor.
    expect(second).toBeLessThan(40);
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
      text: `[evicted image/png, ${SPLIT_PAYLOAD_BYTES} bytes; preserved at /workspace/attachments/evicted/m0-0.png]`
    });
    // The rewritten row is small again, so its continuations are gone: the
    // only copy of these bytes is now the Workspace file.
    expect(await agent.getContinuationRowCountForTest()).toBe(0);
    expect(
      (
        await agent.readEvictedFileForTest(
          "/workspace/attachments/evicted/m0-0.png"
        )
      )?.byteLength
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

  it("reaches older media past large text rows that fill a pass", async () => {
    const agent = await evictionAgent(uniqueName("evict-large-text"));
    await agent.seedLargeTextAboveMediaForTest(3);
    await agent.setMediaEvictionForTest({ ...AGED_POLICY, maxRowsPerPass: 2 });

    await agent.runEvictionForTest();
    await agent.runEvictionForTest();
    expect(
      JSON.stringify(await agent.getStoredMessageForTest("media"))
    ).toContain("[evicted image/png,");
  });

  it("evicts media a late update puts on a row the cache does not hold", async () => {
    const agent = await evictionAgent(uniqueName("evict-late-hidden"));
    await agent.setMediaEvictionForTest(AGED_POLICY);
    expect(await agent.lateMediaOnHiddenRowForTest()).toBe(1);
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
      await agent.readEvictedFileForTest(
        "/workspace/attachments/evicted/m0-0.png"
      )
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

  it("evicts aged media on a sub-agent facet", async () => {
    const parent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-facet")
    )) as unknown as {
      seedFacetMediaForTest(...names: string[]): Promise<void>;
      getFacetStoredMessageForTest(
        name: string,
        id: string
      ): Promise<UIMessage | null>;
    };
    await parent.seedFacetMediaForTest("child");
    await vi.waitFor(
      async () => {
        const message = await parent.getFacetStoredMessageForTest(
          "child",
          "f0"
        );
        expect(JSON.stringify(message)).toContain("[evicted image/png,");
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("evicts aged media on sibling facets that queue passes together", async () => {
    const parent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-facets")
    )) as unknown as {
      seedFacetMediaForTest(...names: string[]): Promise<void>;
      getFacetStoredMessageForTest(
        name: string,
        id: string
      ): Promise<UIMessage | null>;
    };
    await parent.seedFacetMediaForTest("left", "right");
    await vi.waitFor(
      async () => {
        for (const name of ["left", "right"]) {
          const message = await parent.getFacetStoredMessageForTest(name, "f0");
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("evicts on facets of different classes with the same name", async () => {
    const parent = (await getAgentByName(
      env.ThinkMediaEvictionAgent,
      uniqueName("evict-facets-same-name")
    )) as unknown as {
      seedFacetMediaForTest(...names: string[]): Promise<void>;
      getFacetStoredMessageForTest(
        name: string,
        id: string
      ): Promise<UIMessage | null>;
    };
    await parent.seedFacetMediaForTest("a", "auto:a");
    await vi.waitFor(
      async () => {
        for (const name of ["a", "auto:a"]) {
          const message = await parent.getFacetStoredMessageForTest(name, "f0");
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
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

// Successors of the tests above that drive a pass through the class's
// `_evictAgedMediaBestEffort` seam: these let the pass run on its own, as
// it does for an app, and read what it left. They run on both configs.
describe("mediaEviction — a pass that runs on its own", () => {
  /** Seed with eviction on, then wait for the pass the appends schedule. */
  async function evictedOnItsOwn(
    name: string,
    policy: MediaEvictionConfig = AGED_POLICY
  ): Promise<MediaEvictionStub> {
    const agent = await evictionAgent(uniqueName(name));
    await agent.setMediaEvictionForTest(policy);
    await agent.seedMediaHistoryForTest();
    await vi.waitFor(
      async () => {
        for (const id of ["m0", "m1"]) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 10_000, interval: 100 }
    );
    return agent;
  }

  it("leaves the exact marker in an aged file part and keeps its prose", async () => {
    const agent = await evictedOnItsOwn("auto-marker");
    const m0 = await agent.getStoredMessageForTest("m0");
    expect(m0?.parts[0]).toEqual({
      type: "text",
      text: "look at this screenshot"
    });
    expect(m0?.parts[1]).toEqual({
      type: "text",
      text: `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /workspace/attachments/evicted/m0-0.png]`
    });
    expect(JSON.stringify(m0)).not.toContain("data:image/png");
  });

  it("writes the raw decoded bytes to the Workspace", async () => {
    const agent = await evictedOnItsOwn("auto-workspace");
    const file = await agent.readEvictedFileForTest(
      "/workspace/attachments/evicted/m0-0.png"
    );
    expect(file?.byteLength).toBe(PAYLOAD_BYTES);
    expect(file?.allSame).toBe(true);
    expect(file?.firstBytes).toEqual([0, 0, 0, 0]);
  });

  it("evicts a data URL nested in a tool output and keeps the output's shape", async () => {
    const agent = await evictedOnItsOwn("auto-tool-output");
    const m1 = await agent.getStoredMessageForTest("m1");
    const part = m1?.parts[0] as {
      type: string;
      state: string;
      output: { mediaType: string; data: string; note: string };
    };
    expect(part.type).toBe("tool-screenshot");
    expect(part.state).toBe("output-available");
    expect(part.output.mediaType).toBe("image/png");
    expect(part.output.note).toBe("small structured field");
    expect(part.output.data).toBe(
      `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /workspace/attachments/evicted/m1-0.png]`
    );
    const file = await agent.readEvictedFileForTest(
      "/workspace/attachments/evicted/m1-0.png"
    );
    expect(file?.byteLength).toBe(PAYLOAD_BYTES);
  });

  it("a backlog pass reads only what is new since the cursor, not the whole path again", async () => {
    const agent = (await evictionAgent(uniqueName("auto-cursor"))) as Awaited<
      ReturnType<typeof evictionAgent>
    > & {
      countStoredPathRowsForTest(): Promise<void>;
      storedPathRowsReadForTest(): Promise<number>;
      seedTextThenMediaForTest(count: number): Promise<void>;
    };
    // One row per pass, so evicting m0 and m1 takes two passes, the second
    // a backlog pass after the first pass's own rewrite.
    // Seeded with eviction off, so the passes counted are the ones a
    // refresh starts once it is on.
    await agent.setMediaEvictionForTest(false);
    await agent.seedTextThenMediaForTest(300);
    await agent.setMediaEvictionForTest({ ...AGED_POLICY, maxRowsPerPass: 1 });
    await agent.countStoredPathRowsForTest();
    await agent.resyncForTest();
    await vi.waitFor(
      async () => {
        for (const id of ["m0", "m1"]) {
          const message = await agent.getStoredMessageForTest(id);
          expect(JSON.stringify(message)).toContain("[evicted image/png,");
        }
      },
      { timeout: 20_000, interval: 100 }
    );
    // Both passes together read 896 rows of the 306-row path (the first
    // counts it and examines it; the backlog pass reads down to the first
    // one's cursor). A pass's own rewrite shrinks its row; if that marked the
    // cursor stale, the backlog pass would read the whole path again (1,216).
    expect(await agent.storedPathRowsReadForTest()).toBeLessThan(1000);
  }, 30_000);

  it("evicts a payload larger than one row and leaves the bytes in one place", async () => {
    const agent = await evictionAgent(uniqueName("auto-split"));
    // Seeded with eviction off, so the split is seen before any pass.
    await agent.setMediaEvictionForTest(false);
    await agent.seedMediaHistoryForTest("m", SPLIT_MEDIA_CHARS);
    expect(await agent.getContinuationRowCountForTest()).toBeGreaterThan(0);
    await agent.setMediaEvictionForTest(AGED_POLICY);
    await agent.resyncForTest();
    await vi.waitFor(
      async () => {
        const m0 = await agent.getStoredMessageForTest("m0");
        expect(m0?.parts[1]).toEqual({
          type: "text",
          text: `[evicted image/png, ${SPLIT_PAYLOAD_BYTES} bytes; preserved at /workspace/attachments/evicted/m0-0.png]`
        });
        expect(
          JSON.stringify(await agent.getStoredMessageForTest("m1"))
        ).toContain("[evicted image/png,");
      },
      { timeout: 20_000, interval: 100 }
    );
    // Both rewritten rows are small again: the Workspace file is the only
    // copy of the bytes.
    expect(await agent.getContinuationRowCountForTest()).toBe(0);
    expect(
      (
        await agent.readEvictedFileForTest(
          "/workspace/attachments/evicted/m0-0.png"
        )
      )?.byteLength
    ).toBe(SPLIT_PAYLOAD_BYTES);
  }, 30_000);

  it("drains a backlog on its own when each pass is bounded", async () => {
    // One row per pass: each pass evicts one message, and the second media
    // row is evicted only because a pass that made progress schedules the
    // next.
    const name = uniqueName("auto-backlog");
    const passes: number[] = [];
    const unsubscribe = subscribe("chat", (event) => {
      if (event.name === name && event.type === "chat:media:evicted") {
        passes.push((event.payload as { messages: number }).messages);
      }
    });
    try {
      const agent = await evictionAgent(name);
      await agent.setMediaEvictionForTest({
        ...AGED_POLICY,
        maxRowsPerPass: 1
      });
      await agent.seedMediaHistoryForTest();
      await vi.waitFor(
        async () => {
          for (const id of ["m0", "m1"]) {
            const message = await agent.getStoredMessageForTest(id);
            expect(JSON.stringify(message)).toContain("[evicted image/png,");
          }
        },
        { timeout: 10_000, interval: 100 }
      );
      expect(passes).toEqual([1, 1]);
    } finally {
      unsubscribe();
    }
  });

  it("reaches older media past large text rows that fill a pass", async () => {
    const agent = await evictionAgent(uniqueName("auto-large-text"));
    await agent.setMediaEvictionForTest({ ...AGED_POLICY, maxRowsPerPass: 2 });
    // The large text rows are older than the media, so a pass, which works
    // oldest first, fills up on them before it gets to the media.
    await agent.seedLargeTextBelowMediaForTest(3);
    // A pass that fills up on text evicts nothing and schedules no other;
    // the next refresh asks again, and the cursor has moved past the text.
    await vi.waitFor(
      async () => {
        await agent.resyncForTest();
        expect(
          JSON.stringify(await agent.getStoredMessageForTest("media"))
        ).toContain("[evicted image/png,");
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("keeps the image with mediaEviction false: no pass is scheduled", async () => {
    const agent = await evictionAgent(uniqueName("auto-disabled"));
    await agent.setMediaEvictionForTest(false);
    await agent.seedMediaHistoryForTest();
    // A pass is scheduled, if at all, by the appends just made; with
    // eviction off none is, and a refresh asks for none either.
    await agent.resyncForTest();
    expect(await agent.evictionPassQueuedForTest()).toBe(false);
    const m0 = await agent.getStoredMessageForTest("m0");
    expect((m0?.parts[1] as { url: string } | undefined)?.url).toBe(
      `data:image/png;base64,${"A".repeat(16_000)}`
    );
    expect(
      await agent.readEvictedFileForTest(
        "/workspace/attachments/evicted/m0-0.png"
      )
    ).toBeNull();
  });

  it("leaves the recent messages alone, even with keepRecentMessages 0", async () => {
    const agent = await evictedOnItsOwn("auto-recent", {
      keepRecentMessages: 0,
      minPartBytes: 10_000
    });
    for (const id of ["m2", "m3", "m4", "m5"]) {
      const message = await agent.getStoredMessageForTest(id);
      expect(textOf(message?.parts[0])).toMatch(/^recent (question|answer)$/);
    }
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
