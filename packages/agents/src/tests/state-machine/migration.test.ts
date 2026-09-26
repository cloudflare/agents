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

  it("upgrades version three effects without losing attempts", async () => {
    const migrated = await createHarnessStub().migrateVersionThreeEffects();

    expect(migrated.columns).toContain("retry_at");
    expect(migrated.columns).toContain("options_json");
    expect(migrated.attempt).toBe(3);
    expect(migrated.supportsRetrying).toBe(true);
  });

  it("is idempotent when the schema is already current", async () => {
    const stub = createHarnessStub();
    const result = await stub.remigrateChildren();

    expect(result.rowCount).toBe(1);
    expect(result.version).toBe(4);
  });
});
