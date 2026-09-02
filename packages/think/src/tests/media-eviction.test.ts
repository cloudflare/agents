import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import type { MediaEvictionConfig } from "../think";

/**
 * Media eviction as a CONTEXT-WINDOW technique (#1710).
 *
 * Aged media leaves the conversation so the model stops re-reading a large
 * image every turn; the bytes land in the Workspace, raw and correctly typed,
 * and the marker tells the agent where to read them back. This is not the
 * Sessions attachment store, which is an invisible, lossless storage detail.
 */

type MediaEvictionStub = {
  setMediaEvictionForTest(config: MediaEvictionConfig | boolean): Promise<void>;
  seedMediaHistoryForTest(prefix?: string): Promise<void>;
  runEvictionForTest(): Promise<{
    messages: number;
    parts: number;
    bytes: number;
    backlogRemains: boolean;
  } | null>;
  runSessionMaintenanceForTest(): Promise<{ messages: number } | null>;
  getStoredMessageForTest(id: string): Promise<UIMessage | null>;
  getInlinedMessageForTest(id: string): Promise<UIMessage | null>;
  getAttachmentReferenceCountForTest(): Promise<number>;
  getAttachmentBlobCountForTest(): Promise<number>;
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
    const inlined = await agent.getInlinedMessageForTest("m0");
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

  it("reaps the Sessions blob so the bytes live in exactly one place", async () => {
    const agent = await evictionAgent(uniqueName("evict-reap"));
    // Seeding UNDER the policy sends the payloads through the Sessions write
    // path, so the stored rows carry `attachment:sha256:` pointers.
    await agent.setMediaEvictionForTest(AGED_POLICY);
    await agent.seedMediaHistoryForTest();

    const seeded = await agent.getStoredMessageForTest("m0");
    expect(JSON.stringify(seeded)).toContain("attachment:sha256:");
    expect(await agent.getAttachmentBlobCountForTest()).toBeGreaterThan(0);
    expect(await agent.getAttachmentReferenceCountForTest()).toBeGreaterThan(0);

    expect(await agent.runEvictionForTest()).toMatchObject({
      messages: 2,
      parts: 2,
      bytes: PAYLOAD_BYTES * 2
    });

    const m0 = await agent.getStoredMessageForTest("m0");
    expect(m0?.parts[1]).toEqual({
      type: "text",
      text: `[evicted image/png, ${PAYLOAD_BYTES} bytes; preserved at /attachments/evicted/m0-0.png]`
    });
    // The last reference is gone, so the blob is reaped: the only copy of
    // these bytes is now the Workspace file.
    expect(await agent.getAttachmentReferenceCountForTest()).toBe(0);
    expect(await agent.getAttachmentBlobCountForTest()).toBe(0);
    expect(
      (await agent.readEvictedFileForTest("/attachments/evicted/m0-0.png"))
        ?.byteLength
    ).toBe(PAYLOAD_BYTES);
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
    const inlined = await agent.getInlinedMessageForTest("m0");
    expect((inlined?.parts[1] as { url: string } | undefined)?.url).toBe(
      `data:image/png;base64,${"A".repeat(16_000)}`
    );
    expect(
      await agent.readEvictedFileForTest("/attachments/evicted/m0-0.png")
    ).toBeNull();
  });

  it("owns the aged-row pass, so Sessions' own maintenance stands down", async () => {
    const agent = await evictionAgent(uniqueName("evict-maintenance"));
    await agent.seedMediaHistoryForTest();

    // Disabled: Sessions keeps its default maintenance, which is free to move
    // the same bytes into attachment storage.
    expect(await agent.runSessionMaintenanceForTest()).not.toBeNull();

    // Enabled: Think owns aged rows, so Sessions' pass is off and cannot
    // shuttle bytes into attachment storage a moment before Think evicts them.
    await agent.setMediaEvictionForTest(AGED_POLICY);
    expect(await agent.runSessionMaintenanceForTest()).toBeNull();
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
