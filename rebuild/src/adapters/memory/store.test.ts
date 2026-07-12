import { describe, expect, it } from "vitest";
import { scoped } from "../../ports/storage.js";
import { createMemoryKeyValueStore } from "./store.js";

describe("createMemoryKeyValueStore", () => {
  it("put/get round-trips a value", () => {
    const store = createMemoryKeyValueStore();
    store.put("a", { x: 1 });
    expect(store.get("a")).toEqual({ x: 1 });
  });

  it("get returns undefined for a missing key", () => {
    const store = createMemoryKeyValueStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("delete removes a key and reports whether it existed", () => {
    const store = createMemoryKeyValueStore();
    store.put("a", 1);
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.get("a")).toBeUndefined();
  });

  it("list() returns entries ordered by key", () => {
    const store = createMemoryKeyValueStore();
    store.put("b", 2);
    store.put("a", 1);
    store.put("c", 3);
    expect([...store.list().keys()]).toEqual(["a", "b", "c"]);
  });

  it("list() filters by prefix", () => {
    const store = createMemoryKeyValueStore();
    store.put("fiber:1", 1);
    store.put("fiber:2", 2);
    store.put("schedule:1", 3);
    const listed = store.list({ prefix: "fiber:" });
    expect([...listed.keys()].sort()).toEqual(["fiber:1", "fiber:2"]);
  });

  it("list() caps results with limit", () => {
    const store = createMemoryKeyValueStore();
    store.put("a", 1);
    store.put("b", 2);
    store.put("c", 3);
    expect(store.list({ limit: 2 }).size).toBe(2);
  });

  it("deleteAll() removes all matching keys and returns the count", () => {
    const store = createMemoryKeyValueStore();
    store.put("fiber:1", 1);
    store.put("fiber:2", 2);
    store.put("other:1", 3);
    const count = store.deleteAll({ prefix: "fiber:" });
    expect(count).toBe(2);
    expect(store.list().size).toBe(1);
  });

  it("deleteAll() with no options removes everything", () => {
    const store = createMemoryKeyValueStore();
    store.put("a", 1);
    store.put("b", 2);
    expect(store.deleteAll()).toBe(2);
    expect(store.list().size).toBe(0);
  });

  it("deep-copies on put so later mutation of the source doesn't affect stored state", () => {
    const store = createMemoryKeyValueStore();
    const value = { nested: { count: 1 } };
    store.put("a", value);
    value.nested.count = 999;
    expect(store.get<typeof value>("a")?.nested.count).toBe(1);
  });

  it("deep-copies on get so mutating the returned value doesn't affect stored state", () => {
    const store = createMemoryKeyValueStore();
    store.put("a", { nested: { count: 1 } });
    const got = store.get<{ nested: { count: number } }>("a")!;
    got.nested.count = 999;
    expect(store.get<{ nested: { count: number } }>("a")?.nested.count).toBe(1);
  });

  it("works underneath scoped()", () => {
    const store = createMemoryKeyValueStore();
    const view = scoped(store, "fiber:");
    view.put("run:1", { ok: true });
    expect(store.get("fiber:run:1")).toEqual({ ok: true });
    expect([...view.list().keys()]).toEqual(["run:1"]);
  });
});
