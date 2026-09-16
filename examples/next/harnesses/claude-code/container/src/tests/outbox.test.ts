/**
 * The outbox is the only durable thing inside the container, so these cover
 * the three properties the wire depends on: seq is assigned gap-free inside
 * the append transaction, a replay window is bounded by both budgets, and
 * pruning raises the floor rather than renumbering anything.
 */
import { describe, expect, it } from "vitest";
import { Outbox } from "../outbox.ts";

function outbox(maxBytes?: number): Outbox {
  return new Outbox({
    session: "main",
    path: ":memory:",
    ...(maxBytes === undefined ? {} : { maxBytes })
  });
}

describe("Outbox", () => {
  it("assigns a gap-free seq per append", () => {
    const box = outbox();
    const first = box.append([
      { operationId: "op-1", body: { type: "message_start" } },
      { operationId: "op-1", body: { type: "message_end" } }
    ]);
    const second = box.append([{ operationId: "op-2", body: { type: "x" } }]);
    expect(first.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(second[0]?.seq).toBe(3);
    expect(box.highWaterSeq).toBe(3);
    expect(box.floorSeq).toBe(1);
  });

  it("replays after a cursor within both budgets", () => {
    const box = outbox();
    box.append(
      Array.from({ length: 10 }, (_, index) => ({
        operationId: "op-1",
        body: { type: "tick", index } as const
      }))
    );
    const window = box.replay(3, 4, 1_000_000);
    expect(window.map((frame) => frame.seq)).toEqual([4, 5, 6, 7]);

    // A byte budget stops the window early, but never returns nothing.
    const tiny = box.replay(0, 10, 1);
    expect(tiny).toHaveLength(1);
    expect(tiny[0]?.seq).toBe(1);
  });

  it("returns plain objects, not null-prototype rows", () => {
    const box = outbox();
    box.append([{ operationId: null, body: { type: "status" } }]);
    const [frame] = box.replay(0, 10, 1_000_000);
    expect(Object.getPrototypeOf(frame)).toBe(Object.prototype);
    expect(frame?.operationId).toBeNull();
    expect(frame?.body).toEqual({ type: "status" });
  });

  it("dedupes applied keys", () => {
    const box = outbox();
    expect(box.markApplied("op-1", 1)).toBe(true);
    expect(box.markApplied("op-1", 1)).toBe(false);
    expect(box.appliedKeys(10)).toEqual(["op-1"]);
    box.unmarkApplied("op-1");
    expect(box.markApplied("op-1", 1)).toBe(true);
  });

  it("prunes below an ack and keeps the floor honest", () => {
    const box = outbox();
    box.append(
      Array.from({ length: 5 }, () => ({
        operationId: "op-1",
        body: { type: "tick" } as const
      }))
    );
    box.prune(3);
    expect(box.floorSeq).toBe(4);
    expect(box.replay(0, 10, 1_000_000).map((frame) => frame.seq)).toEqual([
      4, 5
    ]);
    expect(box.highWaterSeq).toBe(5);
  });

  it("raises the floor when the byte cap is passed", () => {
    const box = outbox(200);
    box.append(
      Array.from({ length: 20 }, () => ({
        operationId: "op-1",
        body: {
          type: "tick",
          padding: "0123456789012345678901234567890123456789"
        }
      }))
    );
    expect(box.bytes).toBeLessThanOrEqual(200);
    expect(box.floorSeq).toBeGreaterThan(1);
    expect(box.highWaterSeq).toBe(20);
  });

  it("keeps requests and meta across reads", () => {
    const box = outbox();
    box.openRequest({
      requestId: "req-1",
      operationId: "op-1",
      payload: { type: "permission" },
      expiresAt: 10
    });
    box.setRequestDeadline("req-1", 99);
    expect(box.openRequests()).toEqual([
      {
        requestId: "req-1",
        operationId: "op-1",
        payload: { type: "permission" },
        expiresAt: 99
      }
    ]);
    box.closeRequest("req-1");
    expect(box.openRequests()).toEqual([]);

    box.setMeta("runtimeId", "gen-1");
    expect(box.getMeta("runtimeId")).toBe("gen-1");
    box.deleteMeta("runtimeId");
    expect(box.getMeta("runtimeId")).toBeUndefined();
  });
});
