import { describe, expect, it } from "vitest";
import { DriverStore } from "../../driver/store";
import { withCapabilityHarness } from "../shared/capability-harness";

describe("DriverStore", () => {
  it("rejects invalid identifiers and non-serializable input", async () => {
    await withCapabilityHarness(({ storage }) => {
      expect(() => new DriverStore(storage, " ")).toThrow(
        "runtimeId must not be empty"
      );
      const store = new DriverStore(storage, "test");
      expect(() => store.enqueue(" ", "op-1", null)).toThrow(
        "scope must not be empty"
      );
      expect(() => store.enqueue("main", " ", null)).toThrow(
        "id must not be empty"
      );
      expect(() => store.enqueue("main", "op-1", undefined)).toThrow(
        "input must be JSON-serializable"
      );
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(() => store.enqueue("main", "op-2", cyclic)).toThrow();
      expect(() => store.enqueue("main", "op-3", 1n)).toThrow();
    });
  });

  it("reads a missing id without changing the queue", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new DriverStore(storage, "test");
      store.enqueue("main", "op-1", null);

      expect(store.get("missing")).toBeUndefined();
      store.markRunning("missing");
      store.requestStop("missing");
      expect(store.remove("missing")).toBe(false);
      expect(store.list()).toMatchObject([
        { id: "op-1", status: "queued", stopRequested: false }
      ]);
    });
  });

  it("keeps submissions in FIFO order within each scope", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new DriverStore(storage, "test");

      expect(store.enqueue("lane-a", "op-1", { text: "first" })).toMatchObject({
        accepted: true,
        submission: { id: "op-1" }
      });
      store.enqueue("lane-b", "op-2", { text: "other" });
      store.enqueue("lane-a", "op-3", { text: "second" });

      expect(store.head("lane-a")?.id).toBe("op-1");
      expect(store.list("lane-a").map((row) => row.id)).toEqual([
        "op-1",
        "op-3"
      ]);
      expect(store.head("lane-b")?.id).toBe("op-2");
    });
  });

  it("keeps the first submission of a repeated id", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new DriverStore(storage, "test");
      const first = store.enqueue("lane-a", "op-1", { text: "first" });
      const duplicate = store.enqueue("lane-b", "op-1", { text: "other" });

      expect(first.accepted).toBe(true);
      expect(duplicate).toEqual({
        accepted: false,
        submission: first.submission
      });
      expect(store.get("op-1")).toMatchObject({
        scope: "lane-a",
        input: { text: "first" }
      });
    });
  });

  it("allows one running submission per scope", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new DriverStore(storage, "test");
      store.enqueue("lane-a", "op-1", null);
      store.enqueue("lane-a", "op-2", null);

      store.markRunning("op-1", 100);
      expect(store.get("op-1")).toMatchObject({
        status: "running",
        startedAt: 100
      });
      expect(() => store.markRunning("op-2", 101)).toThrow();

      expect(store.remove("op-1")).toBe(true);
      store.markRunning("op-2", 102);
      expect(store.get("op-2")?.status).toBe("running");
    });
  });

  it("records attempts and a failure owed to onFail", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new DriverStore(storage, "test");
      store.enqueue("main", "op-1", null);

      store.recordAttempt("op-1", 2, null);
      expect(store.get("op-1")).toMatchObject({ attempt: 2, failure: null });

      store.resetAttempts("op-1");
      expect(store.get("op-1")?.attempt).toBe(0);

      const failure = { name: "Error", message: "boom" };
      store.recordAttempt("op-1", 3, failure);
      store.resetAttempts("op-1");
      // A recorded failure pins the count until onFail has run.
      expect(store.get("op-1")).toMatchObject({ attempt: 3, failure });
    });
  });

  it("isolates rows by runtime id", async () => {
    await withCapabilityHarness(({ storage }) => {
      const first = new DriverStore(storage, "first");
      const second = new DriverStore(storage, "second");

      expect(first.enqueue("main", "op-1", 1).accepted).toBe(true);
      expect(second.enqueue("main", "op-1", 2).accepted).toBe(true);
      expect(first.get("op-1")?.input).toBe(1);
      expect(second.get("op-1")?.input).toBe(2);
    });
  });

  it("lists scopes that still have submissions", async () => {
    await withCapabilityHarness(({ storage }) => {
      const store = new DriverStore(storage, "test");
      store.enqueue("lane-b", "op-1", null);
      store.enqueue("lane-a", "op-2", null);
      store.enqueue("lane-b", "op-3", null);

      expect(store.scopes()).toEqual(["lane-b", "lane-a"]);
      store.remove("op-1");
      store.remove("op-3");
      expect(store.scopes()).toEqual(["lane-a"]);
    });
  });
});
