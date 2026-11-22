import { describe, expect, it } from "vitest";
import type { Connection } from "../../lifecycle";
import { chatLogOptions, type ChatLogSource } from "../chat-log";
import { CHAT_RECOVERING_KEY } from "../recovery-incident";

const connection = {} as Connection;

function source(
  kv: Map<string, unknown> = new Map()
): ChatLogSource<{ id: string }> {
  return {
    messages: () => [{ id: "u1" }, { id: "q1" }],
    clientView: (messages: ReadonlyArray<{ id: string }>) => ({
      messages: messages.filter((m) => m.id !== "q1"),
      queuedMessageIds: ["q1"]
    }),
    activeStream: () => null,
    kv: { get: <T>(key: string) => kv.get(key) as T | undefined }
  };
}

describe("chatLogOptions", () => {
  it("writes reply frames at most a second or 64 frames late", () => {
    expect(chatLogOptions(source()).batching).toEqual({
      maxEvents: 64,
      maxDelayMs: 1000
    });
  });

  it("snapshots the transcript as tabs see it and a live recovering flag", () => {
    const kv = new Map<string, unknown>([
      [CHAT_RECOVERING_KEY, { requestId: "r1", at: Date.now() }]
    ]);
    const snapshot = chatLogOptions(source(kv)).snapshot!(connection);
    expect(snapshot).toEqual({
      messages: [{ id: "u1" }],
      queuedMessageIds: ["q1"],
      recovering: "r1"
    });
  });

  it("leaves out a recovering flag past its TTL", () => {
    const kv = new Map<string, unknown>([
      [CHAT_RECOVERING_KEY, { requestId: "r1", at: 0 }]
    ]);
    const snapshot = chatLogOptions(source(kv)).snapshot!(connection);
    expect(snapshot).not.toHaveProperty("recovering");
  });
});
