import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routeAgentRequest } from "../..";
import { followEventLog } from "../../client";
import type { EventLogCursor } from "../../websockets";

/**
 * The event log contract, driven over real hibernating WebSockets on a
 * plain Durable Object (`EventLogObject`): sequencing, replay after a
 * cursor, resync, retention, batches, the crash gap, and the size cap.
 */
type Frame = Record<string, unknown> & { type: string };

class Client {
  readonly frames: Frame[] = [];
  readonly #waiters: Array<() => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as Frame;
      if (!frame.type.startsWith("cf_agent_log_")) return;
      this.frames.push(frame);
      for (const wake of this.#waiters.splice(0)) wake();
    });
  }

  subscribe(log: string, cursor?: EventLogCursor): void {
    this.socket.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log, cursor })
    );
  }

  /** Wait until a frame matches, then return and consume frames up to it. */
  async until(match: (frame: Frame) => boolean): Promise<Frame[]> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = this.frames.findIndex(match);
      if (index >= 0) return this.frames.splice(0, index + 1);
      if (Date.now() > deadline) {
        throw new Error(
          `no matching frame; have ${JSON.stringify(this.frames)}`
        );
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

const isType = (type: string) => (frame: Frame) =>
  frame.type === `cf_agent_log_${type}`;

/** Every event seq and data in a list of frames, in order. */
function events(frames: Frame[]): Array<{ seq: number; data: unknown }> {
  return frames
    .filter(isType("events"))
    .flatMap((frame) => frame.events as Array<{ seq: number; data: unknown }>);
}

async function connect(name: string, query = ""): Promise<Client> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/event-log-object/${name}${query}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return new Client(socket);
}

function stub(name: string) {
  return env.EventLogObject.get(env.EventLogObject.idFromName(name));
}

/** Subscribe fresh and return the cursor the resync handed over. */
async function follow(client: Client, log = "feed"): Promise<EventLogCursor> {
  client.subscribe(log);
  const [resync] = (await client.until(isType("resync"))).slice(-1);
  return { epoch: resync.epoch as string, seq: resync.seq as number };
}

describe("event log", () => {
  it("resyncs a first subscriber with a snapshot taken at the head, then sends live events", async () => {
    const name = crypto.randomUUID();
    await stub(name).publishMany("feed", 2);
    const client = await connect(name);
    client.subscribe("feed");
    const [resync] = await client.until(isType("resync"));
    expect(resync).toMatchObject({ log: "feed", seq: 2, snapshot: { at: 2 } });

    expect(await stub(name).publish("feed", { hello: "world" })).toBe(3);
    const frames = await client.until(isType("events"));
    expect(events(frames)).toEqual([{ seq: 3, data: { hello: "world" } }]);
    client.close();
  });

  it("replays what a reconnecting client missed, in order, then says synced", async () => {
    const name = crypto.randomUUID();
    const first = await connect(name);
    const cursor = await follow(first);
    await stub(name).publish("feed", "a");
    await first.until(isType("events"));
    first.close();

    await stub(name).publish("feed", "b");
    await stub(name).publish("feed", "c");

    const second = await connect(name);
    second.subscribe("feed", { epoch: cursor.epoch, seq: 1 });
    const frames = await second.until(isType("synced"));
    expect(events(frames)).toEqual([
      { seq: 2, data: "b" },
      { seq: 3, data: "c" }
    ]);
    expect(frames.at(-1)).toMatchObject({ epoch: cursor.epoch, seq: 3 });
    second.close();
  });

  it("resyncs a cursor that is ahead, from another epoch, or malformed", async () => {
    const name = crypto.randomUUID();
    await stub(name).publish("feed", "a");
    const { epoch } = await stub(name).head();
    const client = await connect(name);

    client.subscribe("feed", { epoch, seq: 9 });
    expect((await client.until(isType("resync"))).at(-1)).toMatchObject({
      seq: 1
    });
    client.subscribe("feed", { epoch: "other", seq: 1 });
    expect((await client.until(isType("resync"))).at(-1)).toMatchObject({
      epoch,
      seq: 1
    });
    client.socket.send(
      JSON.stringify({
        type: "cf_agent_log_subscribe",
        log: "feed",
        cursor: { epoch, seq: "1" }
      })
    );
    await client.until(isType("resync"));
    client.close();
  });

  it("trims to retention without reusing a seq, and resyncs a trimmed cursor", async () => {
    const name = crypto.randomUUID();
    const seqs = await stub(name).publishMany("feed", 8);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = await stub(name).rows();
    // Retention is 5 events: seqs 4..8 are kept.
    expect(rows.map((row) => row.seq_from)).toEqual([4, 5, 6, 7, 8]);
    const { epoch } = await stub(name).head();

    const client = await connect(name);
    client.subscribe("feed", { epoch, seq: 2 });
    await client.until(isType("resync"));

    client.subscribe("feed", { epoch, seq: 3 });
    const frames = await client.until(isType("synced"));
    expect(events(frames).map((event) => event.seq)).toEqual([4, 5, 6, 7, 8]);

    expect(await stub(name).publish("feed", "next")).toBe(9);
    client.close();
  });

  it("sends batched events at once, stores them in batches, and replays the buffered tail from memory", async () => {
    const name = crypto.randomUUID();
    const live = await connect(name);
    await follow(live);
    const { epoch } = await stub(name).head();

    await stub(name).openBatch();
    expect(await stub(name).append("t1")).toBe(1);
    expect(await stub(name).append("t2")).toBe(2);
    expect(events(await live.until(isType("events")))).toEqual([
      { seq: 1, data: "t1" }
    ]);
    expect(events(await live.until(isType("events")))).toEqual([
      { seq: 2, data: "t2" }
    ]);

    // The first append is stored at once and marks the log open; the
    // second is still buffered.
    expect(await stub(name).rows()).toEqual([
      { seq_from: 1, seq_to: 1, kind: "events", open_until: 4 }
    ]);

    const late = await connect(name);
    late.subscribe("feed", { epoch, seq: 0 });
    const frames = await late.until(isType("synced"));
    expect(events(frames).map((event) => event.seq)).toEqual([1, 2]);

    // Closing writes the buffered seqs 2..3 as one row and clears the
    // open mark.
    await stub(name).append("t3");
    await stub(name).closeBatch();
    expect(await stub(name).rows()).toEqual([
      { seq_from: 1, seq_to: 1, kind: "events", open_until: 4 },
      { seq_from: 2, seq_to: 3, kind: "events", open_until: null }
    ]);
    live.close();
    late.close();
  });

  it("turns a crashed batch's unstored tail into a gap, resyncing a cursor inside it", async () => {
    const name = crypto.randomUUID();
    const { epoch } = await stub(name).head();

    await stub(name).openBatch();
    expect(await stub(name).append("stored")).toBe(1);
    // Buffered, sent to any follower, never stored.
    expect(await stub(name).append("lost")).toBe(2);

    await stub(name)
      .crash()
      .catch(() => {});

    // The next touch finds the open batch and records seqs 2..4 as a gap.
    expect(await stub(name).head()).toEqual({ epoch, seq: 4 });
    expect(await stub(name).rows()).toEqual([
      { seq_from: 1, seq_to: 1, kind: "events", open_until: 4 },
      { seq_from: 2, seq_to: 4, kind: "gap", open_until: null }
    ]);
    expect(await stub(name).publish("feed", "after")).toBe(5);

    // A cursor inside the gap saw a lost event: resync.
    const sawLost = await connect(name);
    sawLost.subscribe("feed", { epoch, seq: 2 });
    expect((await sawLost.until(isType("resync"))).at(-1)).toMatchObject({
      seq: 5,
      snapshot: { at: 5 }
    });

    // A cursor before the gap replays across it.
    const before = await connect(name);
    before.subscribe("feed", { epoch, seq: 1 });
    const frames = await before.until(isType("synced"));
    expect(events(frames)).toEqual([{ seq: 5, data: "after" }]);
    sawLost.close();
    before.close();
  });

  it("resyncs a hibernated follower when the batch it was following did not close", async () => {
    const name = crypto.randomUUID();
    const survivor = await connect(name);
    await follow(survivor);
    const { epoch } = await stub(name).head();

    await stub(name).openBatch();
    await stub(name).append("stored");
    await survivor.until(isType("events"));

    // The batch is still open when the instance goes away.
    await evictDurableObject(stub(name));

    expect(await stub(name).head()).toEqual({ epoch, seq: 4 });
    expect((await survivor.until(isType("resync"))).at(-1)).toMatchObject({
      epoch,
      seq: 4,
      snapshot: { at: 4 }
    });
    survivor.close();
  });

  it("resyncs a hibernated follower at the seq of the first publish after the wake, without also sending that event", async () => {
    const name = crypto.randomUUID();
    const survivor = await connect(name);
    await follow(survivor);
    const { epoch } = await stub(name).head();

    await stub(name).openBatch();
    await stub(name).append("stored");
    await survivor.until(isType("events"));
    await evictDurableObject(stub(name));

    // The first touch is a publish. Its snapshot is taken after the
    // producer's state change, so the follower resyncs at seq 5 and must
    // not get event 5 on top.
    expect(await stub(name).publish("feed", "after")).toBe(5);
    expect(await stub(name).publish("feed", "next")).toBe(6);
    const frames = await survivor.until(
      (frame) => isType("events")(frame) && events([frame])[0]?.seq === 6
    );
    expect(frames.map((frame) => frame.type)).toEqual([
      "cf_agent_log_resync",
      "cf_agent_log_events"
    ]);
    expect(frames[0]).toMatchObject({ epoch, seq: 5, snapshot: { at: 5 } });
    expect(events(frames)).toEqual([{ seq: 6, data: "next" }]);
    survivor.close();
  });

  it("resyncs a hibernated follower of a log without a snapshot just before the first publish after the wake, then sends it", async () => {
    const name = crypto.randomUUID();
    const survivor = await connect(name);
    await follow(survivor, "bare");
    await stub(name).openBatch("bare");
    await stub(name).append("stored");
    await survivor.until(isType("events"));
    await evictDurableObject(stub(name));

    // Default batches hold 10 events: the gap is seqs 2..11.
    expect(await stub(name).publish("bare", "after")).toBe(12);
    const frames = await survivor.until(isType("events"));
    expect(frames.map((frame) => frame.type)).toEqual([
      "cf_agent_log_resync",
      "cf_agent_log_events"
    ]);
    expect(frames[0]).toMatchObject({ seq: 11 });
    expect(frames[0]).not.toHaveProperty("snapshot");
    expect(events(frames)).toEqual([{ seq: 12, data: "after" }]);
    survivor.close();
  });

  it("resyncs the existing followers on a socket whose new subscribe finds the crash gap", async () => {
    const name = crypto.randomUUID();
    const survivor = await connect(name);
    await follow(survivor);
    await stub(name).openBatch();
    await stub(name).append("stored");
    await survivor.until(isType("events"));
    await evictDurableObject(stub(name));

    survivor.socket.send(
      JSON.stringify({
        type: "cf_agent_log_subscribe",
        log: "feed",
        id: "late"
      })
    );
    const frames = await survivor.until(
      (frame) => isType("resync")(frame) && frame.id === "late"
    );
    expect(frames.map((frame) => [frame.type, frame.id])).toEqual([
      ["cf_agent_log_resync", undefined],
      ["cf_agent_log_resync", "late"]
    ]);
    survivor.close();
  });

  it("keeps a connection's subscriptions across hibernation", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name);
    await follow(client);
    await evictDurableObject(stub(name));
    await stub(name).publish("feed", "woke");
    expect(events(await client.until(isType("events")))).toEqual([
      { seq: 1, data: "woke" }
    ]);
    client.close();
  });

  it("stops sending events after an unsubscribe", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name);
    await follow(client, "bare");
    client.socket.send(
      JSON.stringify({ type: "cf_agent_log_unsubscribe", log: "bare" })
    );
    // Sent after the unsubscribe on the same socket, so answered after it.
    client.subscribe("feed");
    await client.until(isType("resync"));
    await stub(name).publish("bare", "unseen");
    await stub(name).publish("feed", "seen");
    const frames = await client.until(isType("events"));
    expect(frames.every((frame) => frame.log === "feed")).toBe(true);
    client.close();
  });

  it("keeps connection state that is not an object in its shape while following", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name, "?_pk=listed&listState");
    expect(await stub(name).connectionState("listed")).toEqual(["a", "b"]);
    await follow(client);
    expect(await stub(name).connectionState("listed")).toEqual(["a", "b"]);
    client.socket.send(
      JSON.stringify({ type: "cf_agent_log_unsubscribe", log: "feed" })
    );
    await follow(client, "bare");
    expect(await stub(name).connectionState("listed")).toEqual(["a", "b"]);
    client.close();
  });

  it("keeps a Map connection state a Map while following", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name, "?_pk=mapped&mapState");
    await follow(client);
    const state = await stub(name).connectionState("mapped");
    expect(state).toBeInstanceOf(Map);
    expect([...(state as Map<string, string>)]).toEqual([["k", "v"]]);
    client.close();
  });

  it("answers each follower's subscribe on a shared socket with its own id", async () => {
    const name = crypto.randomUUID();
    await stub(name).publish("feed", "a");
    const { epoch } = await stub(name).head();
    const client = await connect(name);
    client.socket.send(
      JSON.stringify({ type: "cf_agent_log_subscribe", log: "feed", id: "one" })
    );
    client.socket.send(
      JSON.stringify({
        type: "cf_agent_log_subscribe",
        log: "feed",
        id: "two",
        cursor: { epoch, seq: 0 }
      })
    );
    const frames = await client.until(isType("synced"));
    expect(frames.map((frame) => [frame.type, frame.id])).toEqual([
      ["cf_agent_log_resync", "one"],
      ["cf_agent_log_events", "two"],
      ["cf_agent_log_synced", "two"]
    ]);
    await stub(name).publish("feed", "live");
    const [live] = await client.until(isType("events"));
    expect(live).not.toHaveProperty("id");
    client.close();
  });

  it("replays from the head a resync handed out after a crash gap", async () => {
    const name = crypto.randomUUID();
    const { epoch } = await stub(name).head();
    await stub(name).openBatch();
    await stub(name).append("stored");
    await stub(name)
      .crash()
      .catch(() => {});
    expect((await stub(name).head()).seq).toBe(4);

    const client = await connect(name);
    client.subscribe("feed", { epoch, seq: 4 });
    expect((await client.until(isType("synced"))).at(-1)).toMatchObject({
      seq: 4
    });
    client.close();
  });

  it("rejects an event over the size cap before assigning it a seq", async () => {
    const name = crypto.randomUUID();
    expect(await stub(name).publishSized(700_000)).toMatch(
      /exceeds the 600000-byte limit/
    );
    expect((await stub(name).head()).seq).toBe(0);
  });

  it("splits a write into rows under the row limit and replays them all", async () => {
    const name = crypto.randomUUID();
    const { epoch } = await stub(name).head();
    await stub(name).openBatch();
    await stub(name).append("small");
    // Buffered: under the batch's byte limit.
    await stub(name).appendSized(200_000);
    // Publishing writes the buffer and this event: 600 KB, two rows.
    expect(await stub(name).publishSized(400_000)).toBe(3);
    await stub(name).closeBatch();
    expect((await stub(name).rows()).map((row) => row.seq_from)).toEqual([
      1, 2, 3
    ]);
    const client = await connect(name);
    client.subscribe("feed", { epoch, seq: 0 });
    const frames = await client.until(isType("synced"));
    expect(events(frames).map((event) => event.seq)).toEqual([1, 2, 3]);
    client.close();
  });

  it("answers an unknown log and a refused subscription with an error", async () => {
    const name = crypto.randomUUID();
    const client = await connect(name);
    client.subscribe("nope");
    expect((await client.until(isType("error"))).at(-1)).toMatchObject({
      log: "nope"
    });
    client.subscribe("guarded");
    expect((await client.until(isType("error"))).at(-1)).toMatchObject({
      log: "guarded",
      error: "Subscription refused"
    });
    client.close();

    const allowed = await connect(name, "?allow");
    allowed.subscribe("guarded");
    const [resync] = await allowed.until(isType("resync"));
    expect(resync).not.toHaveProperty("snapshot");
    allowed.close();
  });
});

/**
 * A socket that can lose its connection and get a new one, as
 * `AgentClient` does: messages and `open` are re-dispatched from whichever
 * real WebSocket is attached.
 */
class ReconnectingSocket extends EventTarget {
  readyState = 0;
  #socket: WebSocket | undefined;

  attach(socket: WebSocket): void {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.dispatchEvent(new MessageEvent("message", { data: event.data }));
    });
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  drop(): void {
    this.#socket?.close();
    this.#socket = undefined;
    this.readyState = 3;
  }

  send(data: string): void {
    this.#socket?.send(data);
  }
}

async function rawSocket(name: string): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/event-log-object/${name}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("followEventLog", () => {
  it("rebuilds from the snapshot, then picks up missed events by cursor after a reconnect", async () => {
    const name = crypto.randomUUID();
    await stub(name).publish("feed", "before");
    const socket = new ReconnectingSocket();
    const log: string[] = [];
    const subscription = followEventLog<string, { at: number }>(
      socket,
      "feed",
      {
        onResync: (snapshot, seq) => log.push(`resync ${snapshot?.at} ${seq}`),
        onEvent: (data, seq) => log.push(`event ${data} ${seq}`),
        onSynced: (seq) => log.push(`synced ${seq}`)
      }
    );
    socket.attach(await rawSocket(name));
    await waitFor(() => log.length === 1);

    await stub(name).publish("feed", "live");
    await waitFor(() => log.length === 2);

    socket.drop();
    await stub(name).publish("feed", "missed-1");
    await stub(name).publish("feed", "missed-2");
    socket.attach(await rawSocket(name));
    await waitFor(() => log.length === 5);

    expect(log).toEqual([
      "resync 1 1",
      "event live 2",
      "event missed-1 3",
      "event missed-2 4",
      "synced 4"
    ]);
    expect(subscription.cursor?.seq).toBe(4);

    subscription.close();
    await stub(name).publish("feed", "after close");
    // Nothing more arrives once closed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log).toHaveLength(5);
    socket.drop();
  });

  it("keeps a second follower on the same socket going when the first closes", async () => {
    const name = crypto.randomUUID();
    await stub(name).publish("feed", "before");
    const socket = new ReconnectingSocket();
    socket.attach(await rawSocket(name));
    const first: string[] = [];
    const second: string[] = [];
    const a = followEventLog<string>(socket, "feed", {
      onResync: (_snapshot, seq) => first.push(`resync ${seq}`),
      onEvent: (data) => first.push(data)
    });
    await waitFor(() => first.length === 1);
    await stub(name).publish("feed", "one");
    await waitFor(() => first.length === 2);

    // The second follower's resync must not reset the first.
    followEventLog<string>(socket, "feed", {
      onResync: (_snapshot, seq) => second.push(`resync ${seq}`),
      onEvent: (data) => second.push(data)
    });
    await waitFor(() => second.length === 1);
    a.close();
    await stub(name).publish("feed", "two");
    await waitFor(() => second.length === 2);

    expect(first).toEqual(["resync 1", "one"]);
    expect(second).toEqual(["resync 2", "two"]);
    socket.drop();
  });

  it("resyncs after a reconnect when the events it saw were lost in a crash", async () => {
    const name = crypto.randomUUID();
    const socket = new ReconnectingSocket();
    const log: string[] = [];
    followEventLog<string>(socket, "feed", {
      onResync: (_snapshot, seq) => log.push(`resync ${seq}`),
      onEvent: (data, seq) => log.push(`event ${data} ${seq}`)
    });
    socket.attach(await rawSocket(name));
    await waitFor(() => log.length === 1);

    await stub(name).openBatch();
    await stub(name).append("stored");
    await stub(name).append("lost");
    await waitFor(() => log.length === 3);
    socket.drop();
    await stub(name)
      .crash()
      .catch(() => {});

    socket.attach(await rawSocket(name));
    await waitFor(() => log.length === 4);
    expect(log).toEqual([
      "resync 0",
      "event stored 1",
      "event lost 2",
      "resync 4"
    ]);
    socket.drop();
  });
});
