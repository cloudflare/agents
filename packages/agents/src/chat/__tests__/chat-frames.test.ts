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
