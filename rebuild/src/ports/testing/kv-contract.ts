import { describe, expect, it } from "vitest";
import { scoped, type KeyValueStore } from "../storage.js";

export type WithStore = (fn: (store: KeyValueStore) => void | Promise<void>) => Promise<void>;

export function describeKeyValueStoreContract(
  name: string,
  withStore: WithStore
): void {
  describe(`${name} KeyValueStore contract`, () => {
    it("put/get round-trips a value", async () => {
      await withStore((store) => {
        store.put("a", { x: 1 });
        expect(store.get("a")).toEqual({ x: 1 });
      });
    });

    it("get returns undefined for a missing key", async () => {
      await withStore((store) => {
        expect(store.get("missing")).toBeUndefined();
      });
    });

    it("delete removes a key and reports whether it existed", async () => {
      await withStore((store) => {
        store.put("a", 1);
        expect(store.delete("a")).toBe(true);
        expect(store.delete("a")).toBe(false);
        expect(store.get("a")).toBeUndefined();
      });
    });

    it("list() returns entries ordered by key", async () => {
      await withStore((store) => {
        store.put("b", 2);
        store.put("a", 1);
        store.put("c", 3);
        expect([...store.list().keys()]).toEqual(["a", "b", "c"]);
      });
    });

    it("list() filters by prefix", async () => {
      await withStore((store) => {
        store.put("fiber:1", 1);
        store.put("fiber:2", 2);
        store.put("schedule:1", 3);
        expect([...store.list({ prefix: "fiber:" }).keys()]).toEqual([
          "fiber:1",
          "fiber:2",
        ]);
      });
    });

    it("list() caps results with limit", async () => {
      await withStore((store) => {
        store.put("a", 1);
        store.put("b", 2);
        store.put("c", 3);
        expect([...store.list({ limit: 2 }).keys()]).toEqual(["a", "b"]);
      });
    });

    it("list() applies prefix before limit", async () => {
      await withStore((store) => {
        store.put("a:1", 1);
        store.put("b:1", 2);
        store.put("b:2", 3);
        store.put("b:3", 4);
        expect([...store.list({ prefix: "b:", limit: 2 }).keys()]).toEqual([
          "b:1",
          "b:2",
        ]);
      });
    });

    it("deleteAll() removes all matching keys and returns the count", async () => {
      await withStore((store) => {
        store.put("fiber:1", 1);
        store.put("fiber:2", 2);
        store.put("other:1", 3);
        expect(store.deleteAll({ prefix: "fiber:" })).toBe(2);
        expect([...store.list().keys()]).toEqual(["other:1"]);
      });
    });

    it("deleteAll() with no options removes everything", async () => {
      await withStore((store) => {
        store.put("a", 1);
        store.put("b", 2);
        expect(store.deleteAll()).toBe(2);
        expect(store.list().size).toBe(0);
      });
    });

    it("isolates stored JSON values from mutations after put", async () => {
      await withStore((store) => {
        const value = { nested: { count: 1 }, items: [{ label: "one" }] };
        store.put("a", value);
        value.nested.count = 999;
        value.items[0]!.label = "changed";
        expect(store.get<typeof value>("a")).toEqual({
          nested: { count: 1 },
          items: [{ label: "one" }],
        });
      });
    });

    it("isolates stored JSON values from mutations after get", async () => {
      await withStore((store) => {
        store.put("a", { nested: { count: 1 }, items: [{ label: "one" }] });
        const got = store.get<{
          nested: { count: number };
          items: Array<{ label: string }>;
        }>("a")!;
        got.nested.count = 999;
        got.items[0]!.label = "changed";
        expect(store.get("a")).toEqual({
          nested: { count: 1 },
          items: [{ label: "one" }],
        });
      });
    });

    it("works underneath scoped()", async () => {
      await withStore((store) => {
        const view = scoped(store, "fiber:");
        view.put("run:2", { ok: true });
        view.put("run:1", { ok: false });
        store.put("other:run:1", { visible: false });

        expect(store.get("fiber:run:2")).toEqual({ ok: true });
        expect(view.get("run:2")).toEqual({ ok: true });
        expect(view.get("other:run:1")).toBeUndefined();
        expect([...view.list().keys()]).toEqual(["run:1", "run:2"]);
        expect([...view.list({ prefix: "run:2" }).keys()]).toEqual(["run:2"]);
      });
    });

    it("deleteAll() is scoped underneath scoped()", async () => {
      await withStore((store) => {
        const view = scoped(store, "fiber:");
        view.put("run:1", 1);
        view.put("task:1", 2);
        store.put("fiber-sibling:run:1", 3);
        store.put("other:1", 4);

        expect(view.deleteAll({ prefix: "run:" })).toBe(1);
        expect([...view.list().keys()]).toEqual(["task:1"]);
        expect([...store.list().keys()]).toEqual([
          "fiber-sibling:run:1",
          "fiber:task:1",
          "other:1",
        ]);
      });
    });
  });
}
