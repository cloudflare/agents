import type { Connection } from "agents";
import { describe, expect, it } from "vitest";
import { sendReplayBodies, sendReplayControl } from "../replay-frames";

function connection(): { conn: Connection; frames: () => unknown[] } {
  const sent: string[] = [];
  const conn = {
    id: "c1",
    readyState: 1,
    send: (message: string) => void sent.push(message)
  } as unknown as Connection;
  return { conn, frames: () => sent.map((frame) => JSON.parse(frame)) };
}

describe("sendReplayBodies", () => {
  it("names the message a replayed continuation is stored in, as its live frames do", () => {
    const { conn, frames } = connection();
    expect(
      sendReplayBodies(conn, "req-1", ["a", "b"], true, 3, "assistant-2")
    ).toBe(true);

    expect(frames()).toEqual([
      {
        body: "a",
        done: false,
        id: "req-1",
        type: "cf_agent_use_chat_response",
        replay: true,
        seq: 3,
        continuation: true,
        messageId: "assistant-2"
      },
      expect.objectContaining({
        body: "b",
        seq: 4,
        continuation: true,
        messageId: "assistant-2"
      })
    ]);
  });

  it("names no message for a reply that is not a continuation", () => {
    const { conn, frames } = connection();
    sendReplayBodies(conn, "req-1", ["a"], false, 0, "assistant-2");

    expect(frames()[0]).not.toHaveProperty("messageId");
    expect(frames()[0]).not.toHaveProperty("continuation");
  });

  it("names no message for a continuation an older version stored", () => {
    const { conn, frames } = connection();
    sendReplayBodies(conn, "req-1", ["a"], true);

    expect(frames()[0]).toMatchObject({ continuation: true, seq: 0 });
    expect(frames()[0]).not.toHaveProperty("messageId");
  });
});

describe("sendReplayControl", () => {
  it("ends a replayed continuation with its flag", () => {
    const { conn, frames } = connection();
    sendReplayControl(conn, "req-1", { done: true, continuation: true });

    expect(frames()[0]).toMatchObject({
      done: true,
      replay: true,
      continuation: true
    });
  });
});
