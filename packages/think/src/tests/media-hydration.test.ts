import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { TAIL_MEDIA_CHARS, TAIL_MEDIA_MESSAGES } from "./agents/think-session";

/**
 * `mediaHydration`: media is held with its bytes only for the newest
 * messages. Older rows keep their Sessions pointers in the live cache, reach
 * the model as a marker, and write back without losing the attachment.
 */

type MediaHydrationStub = {
  getCachedBytesForTest(): Promise<number>;
  getCachedFileUrlsForTest(): Promise<string[]>;
  getModelMessagesForTest(): Promise<string>;
  touchCachedMessageForTest(
    id: string
  ): Promise<{ cachedUrl: string; storedUrl: string }>;
};

function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const POINTER = /^attachment:sha256:[0-9a-f]{64}$/;
const dataUrlOf = (i: number) =>
  `data:image/png;base64,${String.fromCharCode(65 + i).repeat(TAIL_MEDIA_CHARS)}`;

describe("mediaHydration — media bytes only for the recent tail", () => {
  it("holds pointers for messages older than the window and bytes for the rest", async () => {
    const agent = (await getAgentByName(
      env.ThinkTailMediaHydrationAgent,
      uniqueName("tail-media")
    )) as unknown as MediaHydrationStub;

    const urls = await agent.getCachedFileUrlsForTest();
    expect(urls).toHaveLength(TAIL_MEDIA_MESSAGES);
    for (let i = 0; i < TAIL_MEDIA_MESSAGES - 4; i++) {
      expect(urls[i]).toMatch(POINTER);
    }
    for (let i = TAIL_MEDIA_MESSAGES - 4; i < TAIL_MEDIA_MESSAGES; i++) {
      expect(urls[i]).toBe(dataUrlOf(i));
    }
  });

  it("shrinks the resident cache by the media share of the older rows", async () => {
    const tail = (await getAgentByName(
      env.ThinkTailMediaHydrationAgent,
      uniqueName("tail-media-bytes")
    )) as unknown as MediaHydrationStub;
    const full = (await getAgentByName(
      env.ThinkFullMediaHydrationAgent,
      uniqueName("full-media-bytes")
    )) as unknown as MediaHydrationStub;

    const tailBytes = await tail.getCachedBytesForTest();
    const fullBytes = await full.getCachedBytesForTest();
    // Eight images of 160k chars fully hydrated is ~1.28 MB; four is ~640 KB.
    expect(fullBytes).toBeGreaterThan(TAIL_MEDIA_MESSAGES * TAIL_MEDIA_CHARS);
    expect(tailBytes).toBeLessThan(4 * TAIL_MEDIA_CHARS + 8 * 1_000);
    // Every one of the full cache's URLs is bytes.
    for (const url of await full.getCachedFileUrlsForTest()) {
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("sends the model a marker for withheld media, never a pointer", async () => {
    const agent = (await getAgentByName(
      env.ThinkTailMediaHydrationAgent,
      uniqueName("tail-media-model")
    )) as unknown as MediaHydrationStub;

    const serialized = await agent.getModelMessagesForTest();
    expect(serialized).not.toMatch(/attachment:sha256:/);
    expect(serialized).toContain(
      "[image/png omitted: older than the recent window]"
    );
    // The newest messages still carry their bytes.
    expect(serialized).toContain(dataUrlOf(TAIL_MEDIA_MESSAGES - 1));
  });

  it("writes a pointer-form message back without losing its attachment", async () => {
    const agent = (await getAgentByName(
      env.ThinkTailMediaHydrationAgent,
      uniqueName("tail-media-roundtrip")
    )) as unknown as MediaHydrationStub;

    const { cachedUrl, storedUrl } =
      await agent.touchCachedMessageForTest("tail-0");
    // The cache still holds the pointer; the row still resolves to the bytes.
    expect(cachedUrl).toMatch(POINTER);
    expect(storedUrl).toBe(dataUrlOf(0));
  });
});
