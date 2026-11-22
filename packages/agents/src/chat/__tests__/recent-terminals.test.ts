import { describe, expect, it } from "vitest";
import {
  RECENT_TERMINAL_BODY_MAX,
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
