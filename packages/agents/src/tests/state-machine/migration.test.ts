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
    expect(result.version).toBe(5);
  });

  it("resolves duplicate external ids before indexing them", async () => {
    const migrated = await createHarnessStub().migrateDuplicateExternalIds();

    expect(migrated.indexed).toBe(true);
    // The newest claimant keeps the id; the older row is cleared rather than
    // deleted, so no effect history is lost.
    expect(migrated.kept).toEqual(["effect_new"]);
    expect(migrated.cleared).toEqual(["effect_old"]);
    // And the index is live afterwards, so a fresh duplicate is refused.
    expect(migrated.rejectsDuplicates).toBe(true);
  });
});
