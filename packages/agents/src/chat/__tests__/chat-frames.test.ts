import { describe, expect, it } from "vitest";
import { ChatFrames, type ChatFramesOptions } from "../chat-frames";
import { recentChatTerminal } from "../recent-terminals";

const RESPONSE = "cf_agent_use_chat_response";
const MESSAGES = "cf_agent_chat_messages";

function setup(overrides: Partial<ChatFramesOptions> = {}) {
  const sent: Array<{ frame: Record<string, unknown>; without: string[] }> = [];
  const store = new Map<string, unknown>();
  const resuming = new Set<string>();
  const frames = new ChatFrames({
    broadcast: (message, without) =>
      sent.push({ frame: JSON.parse(message), without }),
    kv: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      put: (key, value) => {
        store.set(key, value);
      }
    },
    resuming,
    storedOriginIds: () => undefined,
    recoveryOriginIds: () => undefined,
    clientView: (messages) => ({ messages: [...messages] }),
    ...overrides
  });
  const kv = {
    get: <T>(key: string) => store.get(key) as T | undefined,
    put: (key: string, value: unknown) => {
      store.set(key, value);
    }
  };
  return { frames, sent, resuming, kv };
}

describe("ChatFrames", () => {
  it("names the origin messages on a terminal frame only", () => {
    const { frames, sent } = setup();
    frames.requestOrigins.set("r1", ["u1"]);
    frames.broadcast({ type: RESPONSE, id: "r1", body: "x", done: false });
    frames.broadcast({ type: RESPONSE, id: "r1", body: "", done: true });
    expect(sent[0].frame.messageIds).toBeUndefined();
    expect(sent[1].frame.messageIds).toEqual(["u1"]);
  });

  it("falls back to the stream's origin ids, then the recovery chain's", () => {
    const { frames, sent } = setup({
      storedOriginIds: (id) => (id === "stored" ? ["s1"] : undefined),
      recoveryOriginIds: () => ["c1"]
    });
    frames.broadcast({ type: RESPONSE, id: "stored", done: true });
    frames.broadcast({ type: RESPONSE, id: "other", error: true });
    expect(sent[0].frame.messageIds).toEqual(["s1"]);
    expect(sent[1].frame.messageIds).toEqual(["c1"]);
  });

  it("leaves out excluded and resuming connections", () => {
    const { frames, sent, resuming } = setup();
    resuming.add("waiting");
    frames.broadcast({ type: RESPONSE, id: "r1", done: false }, ["self"]);
    expect(sent[0].without).toEqual(["self", "waiting"]);
  });

  it("adds the queued messages to a message list", () => {
    const { frames, sent } = setup({
      clientView: <T extends { id: string }>(messages: ReadonlyArray<T>) => ({
        messages: [...messages, { id: "q1" } as unknown as T],
        queuedMessageIds: ["q1"]
      })
    });
    frames.broadcast({ type: MESSAGES, messages: [{ id: "m1" }] });
    expect(sent[0].frame).toEqual({
      type: MESSAGES,
      messages: [{ id: "m1" }, { id: "q1" }],
      queuedMessageIds: ["q1"]
    });
  });

  it("records a terminal frame after sending it", () => {
    const recordedAtSend: unknown[] = [];
    const { frames, kv } = setup({
      broadcast: () => recordedAtSend.push(recentChatTerminal(kv, ["r1"]))
    });
    frames.requestOrigins.set("r1", ["u1"]);
    frames.broadcast({ type: RESPONSE, id: "r1", body: "", done: true });
    expect(recordedAtSend).toEqual([null]);
    expect(recentChatTerminal(kv, ["r1"])).toMatchObject({
      requestId: "r1",
      messageIds: ["u1"]
    });
  });

  it("ends an unstarted request on its own connection", () => {
    const { frames, sent, kv } = setup();
    const direct: string[] = [];
    frames.endUnstarted(
      { id: "c1", send: (message) => direct.push(message) },
      "r1",
      "skipped"
    );
    expect(sent).toHaveLength(0);
    expect(JSON.parse(direct[0])).toEqual({
      type: RESPONSE,
      id: "r1",
      body: "",
      done: true,
      outcome: "skipped"
    });
    expect(recentChatTerminal(kv, ["r1"])?.outcome).toBe("skipped");
  });

  it("ends an unstarted request on every connection when it has none", () => {
    const { frames, sent } = setup();
    frames.endUnstarted(null, "r1", "aborted");
    expect(sent[0].frame).toMatchObject({ id: "r1", outcome: "aborted" });
  });

  it("ignores a closed socket", () => {
    const { frames } = setup();
    expect(() =>
      frames.send(
        {
          id: "c1",
          send: () => {
            throw new Error("closed");
          }
        },
        { type: MESSAGES, messages: [] }
      )
    ).not.toThrow();
  });
});

/** An in-memory stand-in for the chat event log: records what it is given. */
function fakeLog(followers: string[] = [], limit = Infinity) {
  const published: Array<{ kind: string; event: unknown }> = [];
  let batches = 0;
  let open = 0;
  const check = (event: unknown) => {
    if (JSON.stringify(event).length > limit) throw new RangeError("too big");
  };
  return {
    published,
    get batches() {
      return batches;
    },
    get open() {
      return open;
    },
    log: {
      publish(event: unknown) {
        check(event);
        published.push({ kind: "publish", event });
        return published.length;
      },
      batch() {
        batches += 1;
        open += 1;
        return {
          append(event: unknown) {
            check(event);
            published.push({ kind: "append", event });
            return published.length;
          },
          close() {
            open -= 1;
          }
        };
      },
      followerIds: () => followers,
      reset() {
        published.push({ kind: "reset", event: undefined });
      }
    }
  };
}

describe("ChatFrames with the chat event log", () => {
  it("batches a request's chunks, publishes its terminal and ends the batch", () => {
    const fake = fakeLog(["tab"]);
    const { frames, sent } = setup({ log: fake.log });
    frames.broadcast({ type: RESPONSE, id: "r1", body: "a", done: false });
    frames.broadcast({ type: RESPONSE, id: "r1", body: "b", done: false });
    frames.broadcast({ type: RESPONSE, id: "r1", body: "", done: true });
    frames.broadcast({ type: MESSAGES, messages: [] }, ["sender"]);
    expect(fake.published.map((entry) => entry.kind)).toEqual([
      "append",
      "append",
      "publish",
      "publish"
    ]);
    expect(fake.batches).toBe(1);
    expect(fake.open).toBe(0);
    // The sender a frame skips travels with the event.
    expect(fake.published[3].event).toMatchObject({ without: ["sender"] });
    // Following tabs get frames from the log only.
    expect(sent.every((entry) => entry.without.includes("tab"))).toBe(true);
  });

  it("sends a frame the log refuses to following tabs the old way, and leaves a resync marker", () => {
    const fake = fakeLog(["tab"], 200);
    const { frames, sent } = setup({ log: fake.log });
    frames.broadcast({ type: MESSAGES, messages: ["x".repeat(500)] });
    expect(fake.published).toEqual([
      { kind: "publish", event: { resync: true } }
    ]);
    expect(sent[0].without).not.toContain("tab");
  });

  it("puts a reply to a following tab in the log for that tab only", () => {
    const fake = fakeLog(["tab"]);
    const { frames } = setup({ log: fake.log });
    const direct: string[] = [];
    frames.endUnstarted(
      { id: "tab", send: (message) => direct.push(message) },
      "r9",
      "skipped"
    );
    expect(direct).toEqual([]);
    expect(fake.published[0].event).toMatchObject({
      frame: { id: "r9", done: true, outcome: "skipped" },
      only: ["tab"]
    });
  });

  it("forgets the log's history when the chat is cleared", () => {
    const fake = fakeLog(["tab"]);
    const { frames } = setup({ log: fake.log });
    frames.broadcast({ type: RESPONSE, id: "r1", body: "a", done: false });
    frames.broadcast({ type: "cf_agent_chat_clear" }, ["sender"]);
    expect(fake.published.map((entry) => entry.kind)).toEqual([
      "append",
      "reset",
      "publish"
    ]);
    expect(fake.open).toBe(0);
  });
});
