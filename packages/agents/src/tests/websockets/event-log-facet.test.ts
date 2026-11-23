/**
 * The event log inside a facet: its stream lives in the facet's own
 * SQLite (never the root's), and followers connect through the root's
 * `/sub/` route. Their sockets are the root's, bridged in; a subscription
 * rides the bridged connection's state, so it survives the facet
 * reloading its connections from the root.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../../index";
import {
  EVENT_LOG_EVENTS,
  EVENT_LOG_RESYNC,
  EVENT_LOG_SUBSCRIBE,
  EVENT_LOG_SYNCED
} from "../../websockets/event-log-protocol";

type Frame = {
  type: string;
  log?: string;
  events?: { seq: number; data: unknown }[];
};

const unique = () => crypto.randomUUID().slice(0, 8);

async function connect(path: string) {
  const res = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const frames: Frame[] = [];
  ws.addEventListener("message", (event) => {
    try {
      frames.push(JSON.parse(event.data as string) as Frame);
    } catch {
      // not JSON
    }
  });
  return {
    ws,
    /** The log's frames, once `count` of `type` have arrived. */
    async until(type: string, count = 1): Promise<Frame[]> {
      const start = Date.now();
      for (;;) {
        const log = frames.filter((frame) => frame.log === "feed");
        if (log.filter((frame) => frame.type === type).length >= count) {
          return log;
        }
        if (Date.now() - start > 5000) {
          throw new Error(`no ${type} in ${JSON.stringify(frames)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    subscribe(cursor?: { epoch: string; seq: number }) {
      ws.send(
        JSON.stringify({ type: EVENT_LOG_SUBSCRIBE, log: "feed", cursor })
      );
    }
  };
}

const follow = (parent: string, child: string) =>
  connect(
    `/agents/test-sub-agent-parent/${parent}/sub/event-log-sub-agent/${child}`
  );

const seqs = (frames: Frame[]) =>
  frames
    .filter((frame) => frame.type === EVENT_LOG_EVENTS)
    .flatMap((frame) => frame.events ?? [])
    .map((event) => event.seq);

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

  it("replays to a follower by cursor and sends it live publishes, from a parent RPC and from its own socket", async () => {
    const parentName = unique();
    const child = unique();
    const parent = await getAgentByName(env.TestSubAgentParent, parentName);
    await parent.eventLogFacetPublish(child, "one");
    await parent.eventLogFacetPublish(child, "two");
    const { epoch } = await parent.eventLogFacetHead(child);

    const tab = await follow(parentName, child);
    tab.subscribe({ epoch, seq: 1 });
    expect(seqs(await tab.until(EVENT_LOG_SYNCED))).toEqual([2]);

    expect(await parent.eventLogFacetPublish(child, "three")).toBe(3);
    tab.ws.send("publish:four");
    expect(seqs(await tab.until(EVENT_LOG_EVENTS, 3))).toEqual([2, 3, 4]);
    tab.ws.close();
  });

  it("keeps a follower's subscription when the facet reloads its connections from the root", async () => {
    const parentName = unique();
    const child = unique();
    const parent = await getAgentByName(env.TestSubAgentParent, parentName);
    const tab = await follow(parentName, child);
    tab.subscribe();
    await tab.until(EVENT_LOG_RESYNC);

    await parent.eventLogFacetRehydrate(child);
    expect(await parent.eventLogFacetPublish(child, "after")).toBe(1);
    expect(seqs(await tab.until(EVENT_LOG_EVENTS))).toEqual([1]);
    tab.ws.close();
  });

  it("buffers a batch in the facet, replays its tail and resyncs a trimmed cursor", async () => {
    const parentName = unique();
    const child = unique();
    const parent = await getAgentByName(env.TestSubAgentParent, parentName);
    const { epoch } = await parent.eventLogFacetHead(child);
    const writer = await follow(parentName, child);
    writer.subscribe();
    await writer.until(EVENT_LOG_RESYNC);
    writer.ws.send("append:a");
    writer.ws.send("append:b");
    await writer.until(EVENT_LOG_EVENTS, 2);
    // Both are buffered (a batch writes at 3).
    expect(await parent.eventLogFacetRows(child)).toEqual([]);

    const late = await follow(parentName, child);
    late.subscribe({ epoch, seq: 1 });
    expect(seqs(await late.until(EVENT_LOG_SYNCED))).toEqual([2]);

    // Retention 5: after 5 more, event 1 is gone and cursor 0 resyncs.
    for (let i = 0; i < 5; i++) await parent.eventLogFacetPublish(child, "x");
    const old = await follow(parentName, child);
    old.subscribe({ epoch, seq: 0 });
    await old.until(EVENT_LOG_RESYNC);
    for (const tab of [writer, late, old]) tab.ws.close();
  });

  it("sends a facet socket's log frames to the facet's log, not a root log of the same name", async () => {
    const parentName = unique();
    const child = unique();
    const root = await getAgentByName(env.EventLogFacetParent, parentName);
    expect(await root.publishRoot("root")).toBe(1);
    expect(await root.publishRoot("root")).toBe(2);
    expect(await root.publishChild(child, "facet")).toBe(1);

    const tab = await connect(
      `/agents/event-log-facet-parent/${parentName}/sub/event-log-sub-agent/${child}`
    );
    tab.subscribe();
    const frames = await tab.until(EVENT_LOG_RESYNC);
    // The facet's head (1), not the root's (2).
    expect(frames.find((f) => f.type === EVENT_LOG_RESYNC)).toMatchObject({
      seq: 1
    });
    // A root publish does not reach the facet's follower; a facet one does.
    await root.publishRoot("root");
    await root.publishChild(child, "facet");
    expect(seqs(await tab.until(EVENT_LOG_EVENTS))).toEqual([2]);

    // And a root socket follows the root's log.
    const rootTab = await connect(
      `/agents/event-log-facet-parent/${parentName}`
    );
    rootTab.subscribe();
    const rootFrames = await rootTab.until(EVENT_LOG_RESYNC);
    expect(rootFrames.find((f) => f.type === EVENT_LOG_RESYNC)).toMatchObject({
      seq: 3
    });
    tab.ws.close();
    rootTab.ws.close();
  });
});
