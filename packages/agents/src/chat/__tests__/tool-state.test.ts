import { describe, it, expect } from "vitest";
import {
  applyToolUpdate,
  toolResultUpdate,
  crossMessageToolResultUpdate,
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

describe("crossMessageToolResultUpdate", () => {
  it("matches the broad set of pre-terminal and terminal states", () => {
    const update = crossMessageToolResultUpdate("tc1", "output-available", 1);
    expect(update.matchStates).toEqual([
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
      "output-available",
      "output-error",
      "output-denied"
    ]);
  });

  it("resolves an approved tool part to output-available", () => {
    const update = crossMessageToolResultUpdate("tc1", "output-available", {
      enabled: true
    });
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.state).toBe("output-available");
    expect(applied.output).toEqual({ enabled: true });
    // A final result is marked non-preliminary so settled detection works.
    expect(applied.preliminary).toBe(false);
  });

  it("preserves a streamed preliminary flag when present", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-available",
      "partial",
      undefined,
      true
    );
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.state).toBe("output-available");
    expect(applied.output).toBe("partial");
    expect(applied.preliminary).toBe(true);
  });

  it("resolves to output-error with the provided errorText", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-error",
      undefined,
      "Trigger update failed"
    );
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.state).toBe("output-error");
    expect(applied.errorText).toBe("Trigger update failed");
  });

  it("uses a default errorText when none is provided", () => {
    const update = crossMessageToolResultUpdate("tc1", "output-error");
    const applied = update.apply(makePart("tc1", "approval-responded"));
    expect(applied.errorText).toBe("Tool execution failed");
  });

  it("is first-write-wins: returns the same reference for a settled part", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-available",
      "replayed-output"
    );

    for (const state of ["output-available", "output-error", "output-denied"]) {
      const part = makePart("tc1", state, { output: "original" });
      const applied = update.apply(part);
      // Same reference signals an idempotent no-op so callers skip the
      // durable write + broadcast — and the original output is never lost.
      expect(applied).toBe(part);
      expect(applied.output).toBe("original");
    }
  });

  it("does not overwrite an errored tool on replay", () => {
    const update = crossMessageToolResultUpdate(
      "tc1",
      "output-available",
      "late-success"
    );
    const part = makePart("tc1", "output-error", { errorText: "boom" });
    const applied = update.apply(part);
    expect(applied).toBe(part);
    expect(applied.state).toBe("output-error");
    expect(applied.errorText).toBe("boom");
  });

  it("matches a terminal part via applyToolUpdate but yields an unchanged reference", () => {
    // toolResultUpdate would return null here (terminal not in its match
    // states); the cross-message builder matches so a replay still resolves
    // to the part, but apply leaves it untouched.
    const parts = [makePart("tc1", "output-available", { output: "done" })];
    const result = applyToolUpdate(
      parts,
      crossMessageToolResultUpdate("tc1", "output-available", "done-again")
    );
    expect(result).not.toBeNull();
    expect(result!.parts[result!.index]).toBe(parts[result!.index]);
  });

  it("transitions a fresh approval-responded part via applyToolUpdate", () => {
    const parts = [
      makePart("tc1", "approval-responded", { approval: { approved: true } })
    ];
    const result = applyToolUpdate(
      parts,
      crossMessageToolResultUpdate("tc1", "output-available", { ok: 1 })
    );
    expect(result).not.toBeNull();
    expect(result!.parts[0]).not.toBe(parts[0]);
    expect(result!.parts[0]).toEqual(
      expect.objectContaining({ state: "output-available", output: { ok: 1 } })
    );
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
