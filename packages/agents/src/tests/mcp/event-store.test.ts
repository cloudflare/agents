import { describe, expect, it, beforeEach, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { DurableObjectEventStore } from "../../mcp/event-store";

/**
 * Minimal in-memory mock of the subset of {@link DurableObjectStorage} that
 * {@link DurableObjectEventStore} uses. Mirrors the documented semantics of
 * `put`, `list` ({ prefix, start, limit, reverse }), and `delete`.
 */
class MockStorage {
  private readonly data = new Map<string, unknown>();
  putCalls = 0;
  deleteCalls: string[][] = [];

  async put<T>(
    keyOrEntries: string | Record<string, T>,
    value?: T
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.data.set(keyOrEntries, value as T);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.data.set(k, v as T);
      }
    }
    this.putCalls++;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async list<T>(
    options: {
      prefix?: string;
      start?: string;
      limit?: number;
      reverse?: boolean;
    } = {}
  ): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((k) => {
      if (options.prefix && !k.startsWith(options.prefix)) return false;
      if (options.start && k < options.start) return false;
      return true;
    });
    keys.sort();
    if (options.reverse) keys.reverse();
    const limited =
      typeof options.limit === "number" ? keys.slice(0, options.limit) : keys;
    return new Map(limited.map((k) => [k, this.data.get(k) as T]));
  }

  async delete(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    this.deleteCalls.push([...keys]);
    let n = 0;
    for (const k of keys) {
      if (this.data.delete(k)) n++;
    }
    return n;
  }

  /** Test helper: number of keys with a given prefix. */
  countWithPrefix(prefix: string): number {
    let n = 0;
    for (const k of this.data.keys()) if (k.startsWith(prefix)) n++;
    return n;
  }
}

const msg = (id: number): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "test/notify",
  params: { n: id }
});

describe("DurableObjectEventStore", () => {
  let storage: MockStorage;
  let store: DurableObjectEventStore;

  beforeEach(() => {
    storage = new MockStorage();
    store = new DurableObjectEventStore(
      storage as unknown as DurableObjectStorage
    );
  });

  it("storeEvent returns an id of the form `<streamId>:<seqHex>`", async () => {
    const id = await store.storeEvent("stream-a", msg(1));
    expect(id).toMatch(/^stream-a:[0-9a-f]{16}$/);
  });

  it("storeEvent issues monotonically ordered ids within a stream", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await store.storeEvent("s", msg(i)));
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("getStreamIdForEventId extracts the stream id without a storage hit", async () => {
    const id = await store.storeEvent("stream-xyz", msg(1));
    storage.putCalls = 0; // reset
    const streamId = await store.getStreamIdForEventId(id);
    expect(streamId).toBe("stream-xyz");
    expect(storage.putCalls).toBe(0);
  });

  it("replayEventsAfter sends every event newer than lastEventId, exclusive", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await store.storeEvent("s", msg(i)));
    }

    const sent: Array<{ eventId: string; message: JSONRPCMessage }> = [];
    const streamId = await store.replayEventsAfter(ids[1], {
      send: async (eventId, message) => {
        sent.push({ eventId, message });
      }
    });

    expect(streamId).toBe("s");
    expect(sent.map((s) => s.eventId)).toEqual([ids[2], ids[3]]);
    expect(sent.map((s) => (s.message as { id: number }).id)).toEqual([2, 3]);
  });

  it("replayEventsAfter ignores events from other streams", async () => {
    const a1 = await store.storeEvent("a", msg(1));
    await store.storeEvent("b", msg(99));
    const a2 = await store.storeEvent("a", msg(2));

    const sent: string[] = [];
    const streamId = await store.replayEventsAfter(a1, {
      send: async (id) => {
        sent.push(id);
      }
    });

    expect(streamId).toBe("a");
    expect(sent).toEqual([a2]);
  });

  it("replayEventsAfter on an unknown stream returns empty string", async () => {
    const sent: string[] = [];
    const streamId = await store.replayEventsAfter("", {
      send: async (id) => {
        sent.push(id);
      }
    });
    expect(streamId).toBe("");
    expect(sent).toEqual([]);
  });

  it("clearStream removes only that stream's events and resets the counter", async () => {
    await store.storeEvent("a", msg(1));
    await store.storeEvent("a", msg(2));
    await store.storeEvent("b", msg(1));

    await store.clearStream("a");

    expect(storage.countWithPrefix("__mcp_event__:a:")).toBe(0);
    expect(storage.countWithPrefix("__mcp_event__:b:")).toBe(1);

    // After clearing, the next storeEvent for "a" restarts at seq 1. This is
    // safe because the cleared ids can no longer be resumed from — they were
    // deleted from storage.
    const a3 = await store.storeEvent("a", msg(3));
    expect(a3).toBe(`a:${(1).toString(16).padStart(16, "0")}`);
  });

  it("rehydrates the seq counter from storage after losing in-memory state", async () => {
    const first = new DurableObjectEventStore(
      storage as unknown as DurableObjectStorage
    );
    const id1 = await first.storeEvent("s", msg(1));
    const id2 = await first.storeEvent("s", msg(2));

    // Simulate DO hibernation by constructing a fresh store over the same
    // storage. The seq counter must be recovered from the persisted log
    // rather than starting back at 1 (which would produce duplicate ids).
    const second = new DurableObjectEventStore(
      storage as unknown as DurableObjectStorage
    );
    const id3 = await second.storeEvent("s", msg(3));

    expect(
      [id1, id2, id3].every((id, i, arr) => i === 0 || id > arr[i - 1])
    ).toBe(true);
    expect(new Set([id1, id2, id3]).size).toBe(3);
  });

  it("does not register any timers", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      for (let i = 0; i < 3; i++) await store.storeEvent("s", msg(i));
      await store.replayEventsAfter(`s:${(1).toString(16).padStart(16, "0")}`, {
        send: async () => {}
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  describe("sweep", () => {
    it("deletes every event of streams quieter than cutoff and leaves the rest", async () => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        // Stream `a` writes early then goes idle; stream `b` is recent.
        await store.storeEvent("a", msg(1));
        await store.storeEvent("a", msg(2));
        now += 10 * 60_000; // jump 10 minutes
        const recentBWriteAt = now;
        const recentBId = await store.storeEvent("b", msg(99));

        // Cutoff = 5 minutes ago. `a` (10 min old) goes; `b` (just
        // now) stays.
        const cutoff = now - 5 * 60_000;
        const result = await store.sweep(cutoff);
        expect(result.expiredStreamIds).toEqual(["a"]);
        expect(result.nextWriteAt).toBe(recentBWriteAt);
        expect(storage.countWithPrefix("__mcp_event__:a:")).toBe(0);
        expect(storage.countWithPrefix("__mcp_event__:b:")).toBe(1);

        // The surviving stream's event is still replayable.
        const sent: string[] = [];
        const seedId = `b:${(0).toString(16).padStart(16, "0")}`;
        await store.replayEventsAfter(seedId, {
          send: async (id) => {
            sent.push(id);
          }
        });
        expect(sent).toEqual([recentBId]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("with no streams in the store, returns empty result", async () => {
      const result = await store.sweep(Date.now());
      expect(result.expiredStreamIds).toEqual([]);
      expect(result.nextWriteAt).toBeUndefined();
    });

    it("with no expired streams, returns the oldest active write time", async () => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await store.storeEvent("a", msg(1));
        const aWriteAt = now;
        now += 60_000;
        await store.storeEvent("b", msg(2));

        // Cutoff of 0 — nothing qualifies as expired.
        const result = await store.sweep(0);
        expect(result.expiredStreamIds).toEqual([]);
        expect(result.nextWriteAt).toBe(aWriteAt);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("after a stream is swept entirely, next storeEvent restarts seq at 1", async () => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await store.storeEvent("s", msg(1));
        await store.storeEvent("s", msg(2));
        now += 10 * 60_000;

        const result = await store.sweep(now - 60_000);
        expect(result.expiredStreamIds).toEqual(["s"]);

        const fresh = await store.storeEvent("s", msg(3));
        expect(fresh).toBe(`s:${(1).toString(16).padStart(16, "0")}`);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("fires onStoreEvent after each storeEvent (used by McpAgent to arm sweeps)", async () => {
      const onStoreEvent = vi.fn(async () => {});
      const hookedStore = new DurableObjectEventStore(
        storage as unknown as DurableObjectStorage,
        { onStoreEvent }
      );
      await hookedStore.storeEvent("s", msg(1));
      await hookedStore.storeEvent("s", msg(2));
      expect(onStoreEvent).toHaveBeenCalledTimes(2);
    });
  });
});
