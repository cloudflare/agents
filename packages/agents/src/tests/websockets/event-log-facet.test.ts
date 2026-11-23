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
    const parent = await getAgentByName(env.TestSubAgentParent, unique());
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

    // A second facet of the same class has its own log.
    const other = unique();
    expect(await parent.eventLogFacetPublish(other, "first")).toBe(1);
    expect((await parent.eventLogFacetHead(other)).epoch).not.toBe(epoch);
  });
});
