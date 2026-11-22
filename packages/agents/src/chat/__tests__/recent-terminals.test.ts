import { describe, expect, it } from "vitest";
import {
  RECENT_TERMINAL_BODY_MAX,
  RECENT_TERMINAL_ENTRY_MAX,
  RECENT_TERMINALS_KEY,
  recentChatTerminal,
  recordRecentChatTerminal,
  type RecentTerminalsKv
} from "../recent-terminals";

function memoryKv(limit = Infinity): RecentTerminalsKv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      if (JSON.stringify(value).length > limit) {
        throw new Error("SQLITE_TOOBIG");
      }
      map.set(key, value);
    }
  };
}

describe("recordRecentChatTerminal", () => {
  it("shortens a body that escaping makes too large instead of dropping it", () => {
    const kv = memoryKv();
    // Every quote escapes to two characters, so the cut body doubles in JSON.
    recordRecentChatTerminal(kv, {
      id: "r1",
      done: true,
      error: true,
      body: '"'.repeat(RECENT_TERMINAL_BODY_MAX)
    });
    const stored = recentChatTerminal(kv, ["r1"]);
    expect(stored).toMatchObject({ requestId: "r1", error: true });
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(
      RECENT_TERMINAL_ENTRY_MAX
    );
    expect(stored?.body.length).toBeGreaterThan(0);
  });

  it("does not record an entry whose client ids are too large to keep", () => {
    const kv = memoryKv();
    recordRecentChatTerminal(kv, {
      id: "huge".padEnd(RECENT_TERMINAL_ENTRY_MAX, "x"),
      done: true,
      error: true,
      body: "rejected"
    });
    expect(kv.get(RECENT_TERMINALS_KEY)).toBeUndefined();
    // Long ids that fit are kept whole, message ids included.
    const longId = "u".padEnd(300, "y");
    recordRecentChatTerminal(kv, {
      id: "r1",
      done: true,
      body: "ok",
      messageIds: ["u1", longId]
    });
    expect(recentChatTerminal(kv, ["r1"])).toMatchObject({
      requestId: "r1",
      messageIds: ["u1", longId]
    });
  });

  it("keeps at most a capped body per entry", () => {
    const kv = memoryKv();
    recordRecentChatTerminal(kv, {
      id: "r1",
      done: true,
      error: true,
      body: "x".repeat(900_000)
    });
    expect(recentChatTerminal(kv, ["r1"])?.body.length).toBe(
      RECENT_TERMINAL_BODY_MAX
    );
  });

  it("never throws when the write fails", () => {
    const kv = memoryKv(10);
    expect(() =>
      recordRecentChatTerminal(kv, { id: "r1", done: true, body: "" })
    ).not.toThrow();
    expect(recentChatTerminal(kv, ["r1"])).toBeNull();
  });
});
