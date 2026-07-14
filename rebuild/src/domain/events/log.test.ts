import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createTestClock } from "../../adapters/memory/clock.js";
import { createConversationEventLog, type ConversationEvent, type StoredEvent } from "./log.js";
import type { KeyValueStore } from "../../ports/storage.js";
import type { TestClock } from "../../adapters/memory/clock.js";

function setup(retention?: { settledTurnChunksMs?: number; abandonedTurnChunksMs?: number; maxLightEvents?: number }) {
  const store: KeyValueStore = createMemoryKeyValueStore();
  const clock: TestClock = createTestClock(0);
  const log = createConversationEventLog({ store, clock, retention });
  return { store, clock, log };
}

function chunkEvent(requestId: string, text = "hi"): ConversationEvent {
  return { type: "chunk", requestId, chunk: { type: "text-delta", delta: text } };
}

function startedEvent(requestId: string): ConversationEvent {
  return { type: "turn:started", requestId, trigger: "chat" };
}

function settledEvent(
  requestId: string,
  outcome: "completed" | "suspended" | "cancelled" | "failed" = "completed",
): ConversationEvent {
  return { type: "turn:settled", requestId, outcome };
}

describe("createConversationEventLog", () => {
  describe("publish / read ordering", () => {
    it("assigns monotonically increasing offsets starting at 0", () => {
      const { log } = setup();
      const a = log.publish(startedEvent("req_1"));
      const b = log.publish(chunkEvent("req_1"));
      const c = log.publish(settledEvent("req_1"));
      expect(a.offset).toBe(0);
      expect(b.offset).toBe(1);
      expect(c.offset).toBe(2);
    });

    it("stamps each stored event with the clock's current time", () => {
      const { log, clock } = setup();
      clock.set(1000);
      const stored = log.publish(startedEvent("req_1"));
      expect(stored.at).toBe(1000);
    });

    it("head() reports the next offset to be assigned", () => {
      const { log } = setup();
      expect(log.head()).toBe(0);
      log.publish(startedEvent("req_1"));
      expect(log.head()).toBe(1);
      log.publish(chunkEvent("req_1"));
      expect(log.head()).toBe(2);
    });

    it("read(0) returns all published events in publish order", () => {
      const { log } = setup();
      const events = [startedEvent("req_1"), chunkEvent("req_1"), settledEvent("req_1")];
      for (const e of events) log.publish(e);

      const result = log.read(0);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events.map((s) => s.event)).toEqual(events);
      expect(result.events.map((s) => s.offset)).toEqual([0, 1, 2]);
    });

    it("read(fromOffset) beyond head returns an empty events list, not a gap", () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));
      const result = log.read(5);
      expect(result).toEqual({ kind: "events", events: [] });
    });

    it("read() only returns events at or after fromOffset", () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));
      log.publish(chunkEvent("req_1"));
      log.publish(settledEvent("req_1"));
      const result = log.read(1);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events.map((s) => s.offset)).toEqual([1, 2]);
    });

    it("read() respects the limit parameter", () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));
      log.publish(chunkEvent("req_1"));
      log.publish(settledEvent("req_1"));
      const result = log.read(0, 2);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events.map((s) => s.offset)).toEqual([0, 1]);
    });
  });

  describe("subscribe()", () => {
    it("subscribe(0, fn) replays existing events with replay=true, synchronously", () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));
      log.publish(chunkEvent("req_1"));

      const received: Array<{ event: ConversationEvent; replay: boolean }> = [];
      log.subscribe(0, (stored, replay) => received.push({ event: stored.event, replay }));

      expect(received).toHaveLength(2);
      expect(received.every((r) => r.replay)).toBe(true);
    });

    it("continues delivering live events (replay=false) after catch-up", () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));

      const received: Array<{ event: ConversationEvent; replay: boolean }> = [];
      log.subscribe(0, (stored, replay) => received.push({ event: stored.event, replay }));
      expect(received).toHaveLength(1);

      log.publish(chunkEvent("req_1"));
      expect(received).toHaveLength(2);
      expect(received[1]?.replay).toBe(false);
    });

    it('subscribe("live", fn) skips catch-up and only receives future events', () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));

      const received: StoredEvent[] = [];
      log.subscribe("live", (stored) => received.push(stored));
      expect(received).toHaveLength(0);

      log.publish(chunkEvent("req_1"));
      expect(received).toHaveLength(1);
      expect(received[0]?.event.type).toBe("chunk");
    });

    it("unsubscribe stops further delivery", () => {
      const { log } = setup();
      const received: StoredEvent[] = [];
      const unsubscribe = log.subscribe("live", (stored) => received.push(stored));

      log.publish(startedEvent("req_1"));
      expect(received).toHaveLength(1);

      unsubscribe();
      log.publish(chunkEvent("req_1"));
      expect(received).toHaveLength(1);
    });

    it("a throwing subscriber does not prevent delivery to other subscribers", () => {
      const { log } = setup();
      const received: StoredEvent[] = [];
      log.subscribe("live", () => {
        throw new Error("boom");
      });
      log.subscribe("live", (stored) => received.push(stored));

      expect(() => log.publish(startedEvent("req_1"))).not.toThrow();
      expect(received).toHaveLength(1);
    });

    it("a throwing subscriber during catch-up replay does not prevent replay to other subscribers", () => {
      const { log } = setup();
      log.publish(startedEvent("req_1"));
      const received: StoredEvent[] = [];

      expect(() => {
        log.subscribe(0, () => {
          throw new Error("boom");
        });
        log.subscribe(0, (stored) => received.push(stored));
      }).not.toThrow();
      expect(received).toHaveLength(1);
    });

    it("multiple subscribers each receive independent live deliveries", () => {
      const { log } = setup();
      const a: StoredEvent[] = [];
      const b: StoredEvent[] = [];
      log.subscribe("live", (stored) => a.push(stored));
      log.subscribe("live", (stored) => b.push(stored));

      log.publish(startedEvent("req_1"));
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });

  describe("gc() retention: chunk events", () => {
    it("does not prune a settled turn's chunk events before settledTurnChunksMs elapses", () => {
      const { log, clock } = setup({ settledTurnChunksMs: 10_000 });
      log.publish(chunkEvent("req_1"));
      log.publish(settledEvent("req_1"));
      clock.advance(9_999);
      expect(log.gc()).toBe(0);
      const result = log.read(0);
      expect(result.kind).toBe("events");
    });

    it("prunes a settled turn's chunk events once settledTurnChunksMs has elapsed since settlement", () => {
      const { log, clock } = setup({ settledTurnChunksMs: 10_000 });
      log.publish(chunkEvent("req_1"));
      log.publish(settledEvent("req_1"));
      clock.advance(10_000);
      expect(log.gc()).toBe(1);
    });

    it("measures settled retention from the turn:settled event, not from the chunk event", () => {
      const { log, clock } = setup({ settledTurnChunksMs: 10_000 });
      log.publish(chunkEvent("req_1"));
      clock.advance(9_000);
      log.publish(settledEvent("req_1"));
      clock.advance(9_999);
      expect(log.gc()).toBe(0);
      clock.advance(1);
      expect(log.gc()).toBe(1);
    });

    it("does not prune an unsettled turn's chunk events before abandonedTurnChunksMs elapses", () => {
      const { log, clock } = setup({ abandonedTurnChunksMs: 5_000 });
      log.publish(chunkEvent("req_1"));
      clock.advance(4_999);
      expect(log.gc()).toBe(0);
    });

    it("prunes an unsettled (abandoned) turn's chunk events once abandonedTurnChunksMs elapses since the last chunk", () => {
      const { log, clock } = setup({ abandonedTurnChunksMs: 5_000 });
      log.publish(chunkEvent("req_1"));
      clock.advance(5_000);
      expect(log.gc()).toBe(1);
    });

    it("measures abandonment from the most recent chunk of the turn, not the first", () => {
      const { log, clock } = setup({ abandonedTurnChunksMs: 5_000 });
      log.publish(chunkEvent("req_1"));
      clock.advance(4_000);
      log.publish(chunkEvent("req_1")); // resets the abandonment clock for the whole turn
      clock.advance(4_000);
      expect(log.gc()).toBe(0);
      clock.advance(1_000);
      expect(log.gc()).toBe(2); // both chunk events of the turn are pruned together
    });

    it("uses the documented default retention windows when none are configured", () => {
      const { log, clock } = setup();
      log.publish(chunkEvent("req_1"));
      log.publish(settledEvent("req_1"));
      clock.advance(600_000 - 1);
      expect(log.gc()).toBe(0);
      clock.advance(1);
      expect(log.gc()).toBe(1);
    });

    it("does not prune chunk events belonging to a different, still-live turn", () => {
      const { log, clock } = setup({ settledTurnChunksMs: 10_000 });
      log.publish(chunkEvent("req_1"));
      log.publish(settledEvent("req_1"));
      log.publish(chunkEvent("req_2")); // req_2 never settles or ages out (abandoned default is huge)
      clock.advance(10_000);
      expect(log.gc()).toBe(1);
      // offset 0 (req_1's chunk) was pruned; read from the surviving offset.
      const result = log.read(1);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events.some((s) => s.event.type === "chunk" && s.event.requestId === "req_2")).toBe(true);
    });
  });

  describe("gc() retention: light events FIFO cap", () => {
    it("does not prune light events while under the cap", () => {
      const { log } = setup({ maxLightEvents: 3 });
      log.publish(startedEvent("req_1"));
      log.publish(settledEvent("req_1"));
      expect(log.gc()).toBe(0);
    });

    it("prunes the oldest light events once the cap is exceeded, keeping the newest", () => {
      const { log } = setup({ maxLightEvents: 2 });
      log.publish(startedEvent("req_1"));
      log.publish(settledEvent("req_1"));
      log.publish(startedEvent("req_2"));
      expect(log.gc()).toBe(1);

      // offset 0 (the oldest light event) was pruned; read from the survivor.
      const result = log.read(1);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events).toHaveLength(2);
      expect(result.events[0]?.event).toEqual(settledEvent("req_1"));
      expect(result.events[1]?.event).toEqual(startedEvent("req_2"));
    });

    it("does not count chunk events against the light-event cap", () => {
      const { log } = setup({ maxLightEvents: 1 });
      log.publish(chunkEvent("req_1"));
      log.publish(chunkEvent("req_1"));
      log.publish(chunkEvent("req_1"));
      log.publish(startedEvent("req_1"));
      expect(log.gc()).toBe(0);
    });

    it("uses the documented default cap (500) when none is configured", () => {
      const { log } = setup();
      for (let i = 0; i < 500; i++) log.publish(startedEvent(`req_${i}`));
      expect(log.gc()).toBe(0);
      log.publish(startedEvent("req_500"));
      expect(log.gc()).toBe(1);
    });
  });

  describe("gap semantics after gc()", () => {
    it("reading a pruned offset returns a gap with the correct firstAvailable", () => {
      const { log, clock } = setup({ maxLightEvents: 1 });
      log.publish(startedEvent("req_1")); // offset 0, will be pruned
      log.publish(startedEvent("req_2")); // offset 1, survives
      log.gc();

      const result = log.read(0);
      expect(result).toEqual({ kind: "gap", firstAvailable: 1 });
      void clock;
    });

    it("reading from the firstAvailable offset itself (or later) is not a gap", () => {
      const { log } = setup({ maxLightEvents: 1 });
      log.publish(startedEvent("req_1"));
      log.publish(startedEvent("req_2"));
      log.gc();

      const result = log.read(1);
      expect(result.kind).toBe("events");
    });

    it("firstAvailable reflects chunk-retention pruning too", () => {
      const { log, clock } = setup({ settledTurnChunksMs: 10_000 });
      log.publish(chunkEvent("req_1")); // offset 0
      log.publish(settledEvent("req_1")); // offset 1
      log.publish(startedEvent("req_2")); // offset 2, unrelated light event, survives
      clock.advance(10_000);
      log.gc(); // prunes offset 0 only (the chunk event)

      const result = log.read(0);
      expect(result).toEqual({ kind: "gap", firstAvailable: 1 });
    });

    it("a fully-pruned log reading from before head returns a gap with firstAvailable === head", () => {
      const { log } = setup({ maxLightEvents: 0 });
      log.publish(startedEvent("req_1"));
      log.publish(startedEvent("req_2"));
      log.gc();

      expect(log.head()).toBe(2);
      const result = log.read(0);
      expect(result).toEqual({ kind: "gap", firstAvailable: 2 });
    });
  });

  describe("subscriber isolation and multi-turn independence", () => {
    it("chunk events for different requestIds are tracked independently for retention", () => {
      const { log, clock } = setup({ abandonedTurnChunksMs: 5_000 });
      log.publish(chunkEvent("req_1"));
      clock.advance(4_000);
      log.publish(chunkEvent("req_2"));
      clock.advance(1_000);
      // req_1's last chunk is now 5000ms old (abandoned); req_2's is only 1000ms old.
      expect(log.gc()).toBe(1);
      // offset 0 (req_1's chunk) was pruned; read from the surviving offset.
      const result = log.read(1);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.event.type === "chunk" && result.events[0].event.requestId).toBe("req_2");
    });
  });

  describe("persistence across log recreation", () => {
    it("offsets continue (never reused) when a new log is created over the same store", () => {
      const store = createMemoryKeyValueStore();
      const clock = createTestClock(0);
      const log1 = createConversationEventLog({ store, clock });
      log1.publish(startedEvent("req_1"));
      log1.publish(chunkEvent("req_1"));

      const log2 = createConversationEventLog({ store, clock });
      expect(log2.head()).toBe(2);
      const next = log2.publish(settledEvent("req_1"));
      expect(next.offset).toBe(2);
    });

    it("previously published events remain readable from a recreated log", () => {
      const store = createMemoryKeyValueStore();
      const clock = createTestClock(0);
      const log1 = createConversationEventLog({ store, clock });
      log1.publish(startedEvent("req_1"));
      log1.publish(chunkEvent("req_1"));

      const log2 = createConversationEventLog({ store, clock });
      const result = log2.read(0);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") throw new Error("unreachable");
      expect(result.events).toHaveLength(2);
    });

    it("retention bookkeeping (turn settlement) survives recreation", () => {
      const store = createMemoryKeyValueStore();
      const clock = createTestClock(0);
      const log1 = createConversationEventLog({ store, clock, retention: { settledTurnChunksMs: 10_000 } });
      log1.publish(chunkEvent("req_1"));
      log1.publish(settledEvent("req_1"));

      const log2 = createConversationEventLog({ store, clock, retention: { settledTurnChunksMs: 10_000 } });
      clock.advance(10_000);
      expect(log2.gc()).toBe(1);
    });
  });
});
