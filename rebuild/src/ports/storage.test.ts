import { describe, expect, it } from "vitest";
import { scoped, type KeyValueStore } from "./storage.js";

/** Minimal hand-rolled KV store for testing `scoped()` in isolation from any adapter. */
function createTestStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    put<T>(key: string, value: T) {
      data.set(key, value);
    },
    delete(key: string) {
      return data.delete(key);
    },
    list<T>(options?: { prefix?: string; limit?: number }) {
      const result = new Map<string, T>();
      const keys = [...data.keys()].sort();
      for (const key of keys) {
        if (options?.prefix && !key.startsWith(options.prefix)) continue;
        result.set(key, data.get(key) as T);
        if (options?.limit && result.size >= options.limit) break;
      }
      return result;
    },
    deleteAll(options?: { prefix?: string }) {
      let count = 0;
      for (const key of [...data.keys()]) {
        if (options?.prefix && !key.startsWith(options.prefix)) continue;
        data.delete(key);
        count++;
      }
      return count;
    },
  };
}

describe("scoped", () => {
  it("prepends the prefix on put/get", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("run:1", { ok: true });
    expect(store.get("fiber:run:1")).toEqual({ ok: true });
    expect(view.get("run:1")).toEqual({ ok: true });
  });

  it("does not see keys outside its prefix", () => {
    const store = createTestStore();
    store.put("other:x", 1);
    const view = scoped(store, "fiber:");
    expect(view.get("other:x")).toBeUndefined();
  });

  it("strips the prefix on list()", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("a", 1);
    view.put("b", 2);
    store.put("other:c", 3);
    const listed = view.list();
    expect([...listed.keys()].sort()).toEqual(["a", "b"]);
  });

  it("combines the scope prefix with a caller-supplied prefix on list()", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("run:1", 1);
    view.put("run:2", 2);
    view.put("other:3", 3);
    const listed = view.list({ prefix: "run:" });
    expect([...listed.keys()].sort()).toEqual(["run:1", "run:2"]);
  });

  it("respects limit on list()", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("a", 1);
    view.put("b", 2);
    view.put("c", 3);
    expect(view.list({ limit: 2 }).size).toBe(2);
  });

  it("delete() only removes within scope", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("a", 1);
    expect(view.delete("a")).toBe(true);
    expect(view.get("a")).toBeUndefined();
  });

  it("deleteAll() only removes within scope, leaving sibling prefixes intact", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("a", 1);
    view.put("b", 2);
    store.put("other:x", 1);
    const count = view.deleteAll();
    expect(count).toBe(2);
    expect(store.get("other:x")).toBe(1);
    expect(view.list().size).toBe(0);
  });

  it("deleteAll() honors a caller-supplied sub-prefix", () => {
    const store = createTestStore();
    const view = scoped(store, "fiber:");
    view.put("run:1", 1);
    view.put("cfg:1", 2);
    view.deleteAll({ prefix: "run:" });
    expect(view.list().size).toBe(1);
    expect(view.get("cfg:1")).toBe(2);
  });

  it("nesting scoped() twice composes prefixes", () => {
    const store = createTestStore();
    const outer = scoped(store, "fiber:");
    const inner = scoped(outer, "run:");
    inner.put("1", "value");
    expect(store.get("fiber:run:1")).toBe("value");
  });
});
