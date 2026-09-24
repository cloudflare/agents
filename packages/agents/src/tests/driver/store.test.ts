import { describe, expect, it } from "vitest";
import { HarnessDriverStore } from "../../driver/store";
import { withCapabilityHarness } from "../shared/capability-harness";

describe("HarnessDriverStore", () => {
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
