import { describe, it, expect } from "vitest";
import {
  applyToolUpdate,
  toolResultUpdate,
  toolApprovalUpdate
} from "../tool-state";

function makePart(
  toolCallId: string,
  state: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return { type: "tool-invocation", toolCallId, state, ...extra };
}

describe("toolResultUpdate", () => {
  it("builds an update for output-available", () => {
    const update = toolResultUpdate("tc1", { result: 42 });
    expect(update.toolCallId).toBe("tc1");
    expect(update.matchStates).toEqual([
      "input-available",
      "approval-requested",
      "approval-responded"
    ]);

    const applied = update.apply({
      toolCallId: "tc1",
      state: "input-available"
    });
    expect(applied.state).toBe("output-available");
    expect(applied.output).toEqual({ result: 42 });
    expect(applied.preliminary).toBe(false);
  });

  it("builds an update for output-error", () => {
    const update = toolResultUpdate("tc1", null, "output-error", "denied");
    const applied = update.apply({
      toolCallId: "tc1",
      state: "input-available"
    });
    expect(applied.state).toBe("output-error");
    expect(applied.errorText).toBe("denied");
  });

  it("uses default errorText when not provided", () => {
    const update = toolResultUpdate("tc1", null, "output-error");
    const applied = update.apply({
      toolCallId: "tc1",
      state: "input-available"
    });
    expect(applied.errorText).toBe("Tool execution denied by user");
  });
});

describe("toolApprovalUpdate", () => {
  it("builds an update for approval-responded", () => {
    const update = toolApprovalUpdate("tc1", true);
    expect(update.matchStates).toEqual([
      "input-available",
      "approval-requested"
    ]);

    const applied = update.apply({
      toolCallId: "tc1",
      state: "approval-requested",
      approval: { id: "a1" }
    });
    expect(applied.state).toBe("approval-responded");
    expect(applied.approval).toEqual({ id: "a1", approved: true });
  });

  it("builds an update for output-denied", () => {
    const update = toolApprovalUpdate("tc1", false);
    const applied = update.apply({
      toolCallId: "tc1",
      state: "approval-requested",
      approval: { id: "a1" }
    });
    expect(applied.state).toBe("output-denied");
    expect(applied.approval).toEqual({ id: "a1", approved: false });
  });
});

describe("applyToolUpdate", () => {
  it("applies update to the matching part", () => {
    const parts = [
      makePart("tc1", "input-available"),
      { type: "text", text: "hello" },
      makePart("tc2", "input-available")
    ];

    const result = applyToolUpdate(
      parts,
      toolResultUpdate("tc2", "output-value")
    );

    expect(result).not.toBeNull();
    expect(result!.index).toBe(2);
    expect(result!.parts[2]).toEqual(
      expect.objectContaining({
        state: "output-available",
        output: "output-value"
      })
    );
    expect(result!.parts[0]).toBe(parts[0]);
    expect(result!.parts[1]).toBe(parts[1]);
  });

  it("returns null when no part matches the toolCallId", () => {
    const parts = [makePart("tc1", "input-available")];
    const result = applyToolUpdate(
      parts,
      toolResultUpdate("tc-unknown", "value")
    );
    expect(result).toBeNull();
  });

  it("returns null when part is in wrong state", () => {
    const parts = [makePart("tc1", "output-available")];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "new-value"));
    expect(result).toBeNull();
  });

  it("does not mutate the original parts array", () => {
    const parts = [makePart("tc1", "input-available")];
    const original = [...parts];

    applyToolUpdate(parts, toolResultUpdate("tc1", "value"));

    expect(parts).toEqual(original);
    expect(parts[0]).toBe(original[0]);
  });

  it("matches approval-requested state for tool result", () => {
    const parts = [makePart("tc1", "approval-requested")];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "value"));
    expect(result).not.toBeNull();
    expect(result!.parts[0]).toEqual(
      expect.objectContaining({ state: "output-available" })
    );
  });

  it("applies approval update correctly", () => {
    const parts = [
      makePart("tc1", "approval-requested", { approval: { id: "a1" } })
    ];
    const result = applyToolUpdate(parts, toolApprovalUpdate("tc1", true));
    expect(result).not.toBeNull();
    expect(result!.parts[0]).toEqual(
      expect.objectContaining({
        state: "approval-responded",
        approval: { id: "a1", approved: true }
      })
    );
  });

  it("only updates the first matching part", () => {
    const parts = [
      makePart("tc1", "input-available"),
      makePart("tc1", "input-available")
    ];
    const result = applyToolUpdate(parts, toolResultUpdate("tc1", "value"));
    expect(result!.index).toBe(0);
    expect((result!.parts[1] as Record<string, unknown>).state).toBe(
      "input-available"
    );
  });
});
