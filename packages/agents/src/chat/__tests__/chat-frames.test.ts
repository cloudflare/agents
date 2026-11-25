import { describe, expect, it } from "vitest";
import { ChatFrames, type ChatFramesOptions } from "../chat-frames";
import { recentChatTerminal } from "../recent-terminals";
import { WEBSOCKET_MESSAGE_BYTES } from "../../internal/platform-limits";

const RESPONSE = "cf_agent_use_chat_response";
const MESSAGES = "cf_agent_chat_messages";

function setup(overrides: Partial<ChatFramesOptions> = {}) {
  const sent: Array<{ frame: Record<string, unknown>; without: string[] }> = [];
  const store = new Map<string, unknown>();
  const resuming = new Set<string>();
  const connections = [{ id: "t1" }, { id: "t2" }, { id: "waiting" }];
  const frames = new ChatFrames({
    broadcast: (message, without) =>
      sent.push({ frame: JSON.parse(message), without }),
    connections: () => connections,
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
  return { frames, sent, resuming, kv, connections };
}

describe("ChatFrames", () => {
  it("does not send a message list over the WebSocket message limit, and logs it", () => {
    const { frames, sent } = setup();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const big = [{ id: "m", text: "x".repeat(WEBSOCKET_MESSAGE_BYTES) }];
      frames.broadcastMessages(big);
      const sentTo: string[] = [];
      frames.send(
        { id: "t1", send: (text: string) => sentTo.push(text) },
        frames.messagesFrame(big)
      );
      expect(sent).toEqual([]);
      expect(sentTo).toEqual([]);
      expect(errors).toHaveLength(2);
      expect(String(errors[0])).toContain(MESSAGES);
      // A list that fits still goes out.
      frames.broadcastMessages([{ id: "m", text: "small" }]);
      expect(sent).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

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

  it("tells each socket a request's end once", () => {
    const { frames, sent, resuming, connections } = setup();
    const direct: string[] = [];
    const [t1, t2, waiting] = connections;
    const tab = Object.assign(t1, { send: (m: string) => void direct.push(m) });
    // One tab was sent the end directly (a stop); another waits on its
    // resume ack.
    frames.send(tab, { type: RESPONSE, id: "r1", done: true });
    frames.send(tab, { type: RESPONSE, id: "r1", done: true });
    expect(direct).toHaveLength(1);
    resuming.add("waiting");
    frames.broadcast({ type: RESPONSE, id: "r1", done: true });
    // The broadcast leaves out the tab told already, and the waiting one.
    expect(sent[0].without).toEqual(["waiting", "t1"]);
    expect(frames.ended.has(t2, "r1")).toBe(true);
    expect(frames.ended.has(waiting, "r1")).toBe(false);
    // A tab that reconnects keeps its id on a new socket: told nothing.
    expect(frames.ended.has({ id: "t2" }, "r1")).toBe(false);
    // A second broadcast reaches only the sockets not told yet.
    resuming.clear();
    frames.broadcast({ type: RESPONSE, id: "r1", done: true });
    expect(sent[1].without).toEqual(["t1", "t2"]);
    // "recovering" is not an end.
    frames.broadcast({
      type: RESPONSE,
      id: "r2",
      done: true,
      outcome: "recovering"
    });
    expect(frames.ended.has(t2, "r2")).toBe(false);
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

  it("sends the message list with the waiting messages, to resuming tabs only when the host says so", () => {
    const view = {
      clientView: <T extends { id: string }>(messages: ReadonlyArray<T>) => ({
        messages: [...messages],
        queuedMessageIds: ["q"]
      })
    };
    const withheld = setup(view);
    withheld.resuming.add("waiting");
    withheld.frames.broadcastMessages([{ id: "m" }], ["self"]);
    expect(withheld.sent[0].frame).toEqual({
      type: MESSAGES,
      messages: [{ id: "m" }],
      queuedMessageIds: ["q"]
    });
    expect(withheld.sent[0].without).toEqual(["self", "waiting"]);

    const sent = setup({ ...view, listsReachResumingTabs: true });
    sent.resuming.add("waiting");
    sent.frames.broadcastMessages([{ id: "m" }], ["self"]);
    expect(sent.sent[0].without).toEqual(["self"]);
    sent.frames.broadcastMessages([{ id: "m" }]);
    expect(sent.sent[1].without).toEqual([]);
    withheld.frames.broadcastMessages([{ id: "m" }]);
    expect(withheld.sent[1].without).toEqual(["waiting"]);
    expect(
      sent.frames.messagesFrame([{ id: "m" }], { connect: true })
    ).toMatchObject({
      type: MESSAGES,
      connect: true
    });
  });
});
