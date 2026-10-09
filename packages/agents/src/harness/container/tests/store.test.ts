import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { openHarnessStore, type HarnessStore } from "../../store/store";

/** Run `fn` against a fresh store, inside a fresh object. */
function withStore(
  fn: (store: HarnessStore, storage: DurableObjectStorage) => void
) {
  const stub = env.HARNESS_STORE_TEST.getByName(crypto.randomUUID());
  return runInDurableObject(stub, (_instance, state) => {
    fn(openHarnessStore(state.storage, { prefix: "t_" }), state.storage);
  });
}

describe("HarnessStore", () => {
  it("creates sessions idempotently and keeps their state", () =>
    withStore((store, storage) => {
      const first = store.createSession({ id: "a", state: { model: "m" } });
      expect(store.createSession({ id: "a", state: { model: "x" } })).toEqual(
        first
      );
      expect(first).toMatchObject({ id: "a", state: { model: "m" } });
      store.createSession({ id: "b", parent: "a" });
      expect(store.setSessionState("b", { n: 1 })).toBe(true);
      expect(store.setSessionState("missing", 1)).toBe(false);
      // A second store over the same database, as a new isolate would open.
      const reopened = openHarnessStore(storage, { prefix: "t_" });
      expect(reopened.sessions().map((s) => [s.id, s.parent, s.state])).toEqual(
        [
          ["a", undefined, { model: "m" }],
          ["b", "a", { n: 1 }]
        ]
      );
    }));

  it("keeps two prefixes apart and rejects reserved ones", () =>
    withStore((store, storage) => {
      store.createSession({ id: "a" });
      expect(
        openHarnessStore(storage, { prefix: "other_" }).sessions()
      ).toEqual([]);
      expect(() => openHarnessStore(storage, { prefix: "_cf_x" })).toThrow();
      expect(() =>
        openHarnessStore(storage, { prefix: "bad prefix" })
      ).toThrow();
    }));

  it("enqueues operations idempotently and guards every transition", () =>
    withStore((store) => {
      const first = store.enqueue({ session: "s", id: "op", input: "hi" });
      const again = store.enqueue({ session: "s", id: "op", input: "other" });
      expect(first.accepted).toBe(true);
      expect(again).toEqual({ record: first.record, accepted: false });
      expect(first.record).toMatchObject({ status: "queued", input: "hi" });

      expect(store.requeue("s", "op")).toBe(false);
      expect(store.start("s", "op")).toBe(true);
      expect(store.start("s", "op")).toBe(false);
      expect(store.requeue("s", "op")).toBe(true);
      expect(store.start("s", "op")).toBe(true);
      expect(
        store.settle("s", "op", { status: "done", result: { text: "ok" } })
      ).toBe(true);
      expect(
        store.settle("s", "op", { status: "unanswered", reason: "late" })
      ).toBe(false);
      expect(store.operation("s", "op")).toMatchObject({
        status: "done",
        result: { text: "ok" },
        reason: undefined
      });
      expect(store.start("s", "op")).toBe(false);
      expect(store.setOperationMeta("s", "op", { delivered: "r1" })).toBe(true);
      expect(store.operation("s", "op")?.meta).toEqual({ delivered: "r1" });
    }));

  it("lists operations in submission order across sessions, by status", () =>
    withStore((store) => {
      store.enqueue({ session: "a", id: "1", input: null });
      store.enqueue({ session: "b", id: "2", input: null });
      store.enqueue({ session: "a", id: "3", input: null });
      store.start("a", "1");
      expect(store.operations().map((o) => o.id)).toEqual(["1", "2", "3"]);
      expect(store.operations({ session: "a" }).map((o) => o.id)).toEqual([
        "1",
        "3"
      ]);
      expect(store.operations({ status: ["queued"] }).map((o) => o.id)).toEqual(
        ["2", "3"]
      );
      expect(store.operations({ status: [] })).toEqual([]);
    }));

  it("appends to logs and replaces entries by id in place", () =>
    withStore((store) => {
      expect(
        store.append("s", "messages", [
          { id: "m1", data: { text: "one" } },
          { data: "anonymous" },
          { id: "m2", data: { text: "two" } }
        ])
      ).toBe(3);
      store.append("s", "messages", [{ id: "m1", data: { text: "ONE" } }]);
      expect(
        store.read("s", "messages").map((e) => [e.seq, e.id, e.data])
      ).toEqual([
        [1, "m1", { text: "ONE" }],
        [2, undefined, "anonymous"],
        [3, "m2", { text: "two" }]
      ]);
      expect(
        store.read("s", "messages", { after: 1, limit: 1 }).map((e) => e.seq)
      ).toEqual([2]);
      expect(store.entry("s", "messages", "m2")?.data).toEqual({ text: "two" });
      expect(store.end("s", "messages")).toBe(3);
      expect(store.read("s", "other")).toEqual([]);
    }));

  it("splits entries larger than a row and reads them back whole", () =>
    withStore((store) => {
      const big = "x".repeat(1_500_000);
      store.append("s", "engine", [{ data: { big } }, { data: "after" }]);
      const entries = store.read("s", "engine");
      expect(entries).toHaveLength(2);
      expect(entries[0]?.data).toEqual({ big });
      expect(entries[1]?.data).toBe("after");
      // Replacing a split entry with a small one leaves no stale parts.
      store.append("s", "big", [{ id: "e", data: big }]);
      store.append("s", "big", [{ id: "e", data: "small" }]);
      expect(store.read("s", "big").map((e) => e.data)).toEqual(["small"]);
    }));

  it("copies a log onto another session and clears logs", () =>
    withStore((store) => {
      store.append("from", "engine", [{ data: 1 }, { id: "x", data: 2 }]);
      store.append("to", "engine", [{ data: 0 }]);
      store.copy("from", "to", "engine");
      expect(store.read("to", "engine").map((e) => [e.seq, e.data])).toEqual([
        [1, 0],
        [2, 1],
        [3, 2]
      ]);
      store.clear("to", "engine");
      expect(store.read("to", "engine")).toEqual([]);
      expect(store.read("from", "engine")).toHaveLength(2);
    }));

  it("keeps a session's creation time when one is given, for imported records", () =>
    withStore((store) => {
      store.createSession({ id: "new" });
      store.createSession({ id: "imported", createdAt: 1000 });
      expect(store.session("imported")).toMatchObject({
        createdAt: 1000,
        updatedAt: 1000
      });
      expect(store.sessions().map((s) => s.id)).toEqual(["imported", "new"]);
    }));

  it("forgets a session's settled operations and keeps its open ones", () =>
    withStore((store) => {
      for (const id of ["done", "gone", "running", "queued"]) {
        store.enqueue({ session: "s", id, input: null });
      }
      store.enqueue({ session: "other", id: "done", input: null });
      store.settle("s", "done", { status: "done", result: null });
      store.settle("s", "gone", { status: "unanswered", reason: "withdrawn" });
      store.settle("other", "done", { status: "done", result: null });
      store.start("s", "running");
      expect(store.deleteSettled("s")).toBe(2);
      expect(store.operations({ session: "s" }).map((o) => o.id)).toEqual([
        "running",
        "queued"
      ]);
      expect(store.operation("other", "done")?.status).toBe("done");
      // The id is free again.
      expect(
        store.enqueue({ session: "s", id: "done", input: 1 }).accepted
      ).toBe(true);
    }));

  it("deletes one operation, so its id may be enqueued again", () =>
    withStore((store) => {
      store.enqueue({ session: "s", id: "op", input: "old" });
      store.enqueue({ session: "other", id: "op", input: "kept" });
      expect(store.deleteOperation("s", "op")).toBe(true);
      expect(store.deleteOperation("s", "op")).toBe(false);
      expect(store.operation("other", "op")?.input).toBe("kept");
      expect(
        store.enqueue({ session: "s", id: "op", input: "new" })
      ).toMatchObject({
        accepted: true,
        record: { input: "new", status: "queued" }
      });
    }));

  it("deletes a session with its operations and logs", () =>
    withStore((store) => {
      store.createSession({ id: "s" });
      store.enqueue({ session: "s", id: "op", input: null });
      store.append("s", "messages", [{ data: 1 }]);
      expect(store.deleteSession("s")).toBe(true);
      expect(store.sessions()).toEqual([]);
      expect(store.operations({ session: "s" })).toEqual([]);
      expect(store.read("s", "messages")).toEqual([]);
      expect(store.deleteSession("s")).toBe(false);
    }));
});
