import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { createEventBus, type ObservabilityEvent } from "../../kernel/events.js";
import { createStateContainer, type StateSource } from "./state.js";

interface Counter {
  count: number;
}

function bus() {
  return createEventBus({ agent: "test", name: "agent-1" }, () => 0);
}

describe("createStateContainer", () => {
  it("throws on get() when there is no persisted state and no initialState", () => {
    const container = createStateContainer<Counter>({ store: createMemoryKeyValueStore(), bus: bus() });
    expect(() => container.get()).toThrow();
    expect(container.initialized()).toBe(false);
  });

  it("uses initialState only when storage has none", () => {
    const kv = createMemoryKeyValueStore();
    kv.put("state:value", { count: 42 });

    const container = createStateContainer<Counter>({
      store: kv,
      bus: bus(),
      initialState: { count: 0 },
    });

    // Storage already has a value, so initialState must be ignored.
    expect(container.get()).toEqual({ count: 42 });
  });

  it("falls back to initialState when storage is empty", () => {
    const container = createStateContainer<Counter>({
      store: createMemoryKeyValueStore(),
      bus: bus(),
      initialState: { count: 7 },
    });
    expect(container.get()).toEqual({ count: 7 });
    expect(container.initialized()).toBe(true);
  });

  it("persists state so a second container over the same store sees the update", () => {
    const kv = createMemoryKeyValueStore();
    const container1 = createStateContainer<Counter>({ store: kv, bus: bus(), initialState: { count: 0 } });
    container1.set({ count: 5 });

    const container2 = createStateContainer<Counter>({ store: kv, bus: bus() });
    expect(container2.get()).toEqual({ count: 5 });
  });

  it("rejects an update when validate throws, leaving the old state in place", () => {
    const kv = createMemoryKeyValueStore();
    const container = createStateContainer<Counter>({
      store: kv,
      bus: bus(),
      initialState: { count: 0 },
      validate: (next) => {
        if (next.count < 0) throw new Error("count must be non-negative");
      },
    });

    container.set({ count: 3 });
    expect(() => container.set({ count: -1 })).toThrow("count must be non-negative");
    expect(container.get()).toEqual({ count: 3 });
    expect(kv.get("state:value")).toEqual({ count: 3 });
  });

  it("passes the source into validate and onChanged", () => {
    const seenValidate: StateSource[] = [];
    const seenChanged: StateSource[] = [];
    const container = createStateContainer<Counter>({
      store: createMemoryKeyValueStore(),
      bus: bus(),
      initialState: { count: 0 },
      validate: (_next, source) => {
        seenValidate.push(source);
      },
      onChanged: (_state, source) => {
        seenChanged.push(source);
      },
    });

    container.set({ count: 1 }, { kind: "connection", connectionId: "conn_1" });
    expect(seenValidate).toEqual([{ kind: "connection", connectionId: "conn_1" }]);
    expect(seenChanged).toEqual([{ kind: "connection", connectionId: "conn_1" }]);
  });

  it("defaults the source to server when omitted", () => {
    const seen: StateSource[] = [];
    const container = createStateContainer<Counter>({
      store: createMemoryKeyValueStore(),
      bus: bus(),
      initialState: { count: 0 },
      onChanged: (_state, source) => seen.push(source),
    });
    container.set({ count: 1 });
    expect(seen).toEqual([{ kind: "server" }]);
  });

  it("broadcasts the new state, excluding the originating connection for client-driven updates", () => {
    const broadcasts: Array<{ state: Counter; exclude?: string }> = [];
    const container = createStateContainer<Counter>({
      store: createMemoryKeyValueStore(),
      bus: bus(),
      initialState: { count: 0 },
      broadcast: (state, excludeConnectionId) => broadcasts.push({ state, exclude: excludeConnectionId }),
    });

    container.set({ count: 1 }, { kind: "connection", connectionId: "conn_1" });
    container.set({ count: 2 }, { kind: "server" });

    expect(broadcasts).toEqual([
      { state: { count: 1 }, exclude: "conn_1" },
      { state: { count: 2 }, exclude: undefined },
    ]);
  });

  it("emits a state:update event on the bus when state changes", () => {
    const events: ObservabilityEvent[] = [];
    const b = bus();
    b.subscribe("state", (e) => events.push(e));

    const container = createStateContainer<Counter>({
      store: createMemoryKeyValueStore(),
      bus: b,
      initialState: { count: 0 },
    });
    container.set({ count: 1 }, { kind: "connection", connectionId: "conn_1" });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("state:update");
    expect(events[0]!.payload).toMatchObject({ state: { count: 1 } });
  });

  it("does not emit an event or persist when validate rejects the change", () => {
    const events: ObservabilityEvent[] = [];
    const b = bus();
    b.subscribe("state", (e) => events.push(e));
    const kv = createMemoryKeyValueStore();

    const container = createStateContainer<Counter>({
      store: kv,
      bus: b,
      initialState: { count: 0 },
      validate: () => {
        throw new Error("nope");
      },
    });

    expect(() => container.set({ count: 1 })).toThrow();
    expect(events).toHaveLength(0);
    expect(kv.get("state:value")).toBeUndefined();
  });
});
