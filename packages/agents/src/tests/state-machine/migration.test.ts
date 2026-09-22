import { describe, expect, it } from "vitest";
import { createHarnessStub } from "./test-harness";

describe("StateMachine schema migration", () => {
  it("upgrades a version one run without losing its checkpoint", async () => {
    const stub = createHarnessStub();
    const migrated = await stub.migrateVersionOneRun();

    expect(migrated.columns).toContain("wait_kind");
    expect(migrated.columns).toContain("cancel_requested");
    expect(JSON.parse(migrated.checkpoint ?? "null")).toEqual({
      phase: "first",
      label: "migrated"
    });
  });
});
