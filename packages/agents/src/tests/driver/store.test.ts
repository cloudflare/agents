import { describe, expect, it } from "vitest";
import { HarnessDriverStore } from "../../driver/store";
import { withCapabilityHarness } from "../shared/capability-harness";

describe("HarnessDriverStore", () => {
  it("rejects invalid identifiers and non-serializable input", async () => {
    await withCapabilityHarness(({ storage }) => {
      expect(() => new HarnessDriverStore(storage, " ")).toThrow(
        "driverId must not be empty"
      );
      const store = new HarnessDriverStore(storage, "test");
      expect(() => store.enqueue(" ", "op-1", null, null)).toThrow(
        "scope must not be empty"
      );
      expect(() => store.enqueue("main", " ", null, null)).toThrow(
        "operationId must not be empty"
      );
      expect(() => store.enqueue("main", "op-1", undefined, null)).toThrow(
        "input must be JSON-serializable"
      );
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(() => store.enqueue("main", "op-2", cyclic, null)).toThrow();
      expect(() => store.enqueue("main", "op-3", 1n, null)).toThrow();
    });
  });

  it("returns missing results without mutating the queue", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new HarnessDriverStore(storage, "test");
      store.enqueue("main", "op-1", null, null);

      expect(store.get("missing")).toBeUndefined();
      expect(store.markAdmitted("missing")).toBeUndefined();
      expect(store.requestCancellation("missing")).toBeUndefined();
      expect(store.remove("missing")).toBe(false);
      expect(store.list()).toHaveLength(1);
    });
  });

  it("migrates submissions created by the initial driver schema", async () => {
    await withCapabilityHarness(({ storage }) => {
      storage.sql.exec(`
        CREATE TABLE cf_agents_harness_submissions (
          seq INTEGER PRIMARY KEY,
          driver_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          input_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'admitted')),
          stream_id TEXT,
          submitted_at INTEGER NOT NULL,
          admitted_at INTEGER,
          UNIQUE (driver_id, operation_id)
        )
      `);
      const store = new HarnessDriverStore(storage, "test");

      expect(
        store.enqueue("main", "op-1", null, null).submission
      ).toMatchObject({
        attempts: 0,
        failure: null,
        cancelRequested: false
      });
    });
  });
  it("keeps submissions in FIFO order within each scope", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new HarnessDriverStore(storage, "test");

      expect(
        store.enqueue("lane-a", "op-1", { text: "first" }, "s-1")
      ).toMatchObject({
        accepted: true,
        submission: { operationId: "op-1" }
      });
      store.enqueue("lane-b", "op-2", { text: "other" }, "s-2");
      store.enqueue("lane-a", "op-3", { text: "second" }, "s-3");

      expect(store.head("lane-a")?.operationId).toBe("op-1");
      expect(store.list("lane-a").map((row) => row.operationId)).toEqual([
        "op-1",
        "op-3"
      ]);
      expect(store.head("lane-b")?.operationId).toBe("op-2");
    });
  });

  it("deduplicates operation identifiers without changing the original row", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new HarnessDriverStore(storage, "test");
      const first = store.enqueue("lane-a", "op-1", { text: "first" }, "s-1");
      const duplicate = store.enqueue(
        "lane-b",
        "op-1",
        { text: "replacement" },
        "s-2"
      );

      expect(first.accepted).toBe(true);
      expect(duplicate).toEqual({
        accepted: false,
        submission: first.submission
      });
      expect(store.list()).toHaveLength(1);
      expect(store.get("op-1")).toMatchObject({
        scope: "lane-a",
        input: { text: "first" },
        streamId: "s-1"
      });
    });
  });

  it("allows one admitted submission per scope", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new HarnessDriverStore(storage, "test");
      store.enqueue("lane-a", "op-1", null, "s-1");
      store.enqueue("lane-a", "op-2", null, "s-2");

      expect(store.markAdmitted("op-1", 100)).toMatchObject({
        operationId: "op-1",
        status: "admitted",
        admittedAt: 100
      });
      expect(() => store.markAdmitted("op-2", 101)).toThrow();
      expect(store.admitted("lane-a")?.operationId).toBe("op-1");

      expect(store.remove("op-1")).toBe(true);
      expect(store.markAdmitted("op-2", 102)?.operationId).toBe("op-2");
    });
  });

  it("isolates rows by driver identifier", async () => {
    await withCapabilityHarness(({ storage }) => {
      const first = new HarnessDriverStore(storage, "first");
      const second = new HarnessDriverStore(storage, "second");

      expect(first.enqueue("main", "op-1", 1, "a").accepted).toBe(true);
      expect(second.enqueue("main", "op-1", 2, "b").accepted).toBe(true);
      expect(first.get("op-1")?.input).toBe(1);
      expect(second.get("op-1")?.input).toBe(2);
    });
  });

  it("lists scopes with unsettled submissions", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new HarnessDriverStore(storage, "test");
      store.enqueue("lane-b", "op-1", null, "s-1");
      store.enqueue("lane-a", "op-2", null, "s-2");
      store.enqueue("lane-b", "op-3", null, "s-3");

      expect(store.scopes()).toEqual(["lane-b", "lane-a"]);
      store.remove("op-1");
      store.remove("op-3");
      expect(store.scopes()).toEqual(["lane-a"]);
    });
  });
});
