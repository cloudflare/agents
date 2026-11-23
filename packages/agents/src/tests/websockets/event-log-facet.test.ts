/**
 * The event log's storage inside a facet: its stream lives in the facet's
 * own SQLite (never the root's), seqs, the epoch and retention work there
 * as at the root.
 *
 * Followers of a facet's log are not covered: a facet's sockets are
 * bridged from the root, and the bridge does not pass log frames to the
 * facet's WebSockets capability yet (report-ws-events.md, "Facets").
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../../index";

const unique = () => crypto.randomUUID().slice(0, 8);

describe("event log in a facet", () => {
  it("stores its events in the facet's stream, keeps the epoch and trims to retention", async () => {
    const parentName = unique();
    const parent = await getAgentByName(env.TestSubAgentParent, parentName);
    const child = unique();
    const { epoch } = await parent.eventLogFacetHead(child);
    for (let i = 1; i <= 8; i++) {
      expect(await parent.eventLogFacetPublish(child, `e${i}`)).toBe(i);
    }
    // Retention 5, a block per publish: events 4..8 are kept.
    expect(
      (await parent.eventLogFacetRows(child)).map((row) => row.seq_from)
    ).toEqual([3, 4, 5, 6, 7]);
    expect(await parent.eventLogFacetHead(child)).toEqual({ epoch, seq: 8 });
    expect(await parent.rootHasStreamBlocks()).toBe(false);

    // After a crash of the tree, the facet reads its epoch back from the
    // stream's metadata, and the next event skips past what a lost buffer
    // may have held (batch size 3, + 1).
    await parent.crashForTest().catch(() => {});
    const woken = await getAgentByName(env.TestSubAgentParent, parentName);
    expect(await woken.eventLogFacetHead(child)).toEqual({ epoch, seq: 8 });
    expect(await woken.eventLogFacetPublish(child, "woke")).toBe(13);

    // A second facet of the same class has its own log.
    const other = unique();
    expect(await woken.eventLogFacetPublish(other, "first")).toBe(1);
    expect((await woken.eventLogFacetHead(other)).epoch).not.toBe(epoch);
  });
});
