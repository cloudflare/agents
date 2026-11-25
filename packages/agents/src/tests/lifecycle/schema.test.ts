import { describe, expect, it } from "vitest";
import { LifecycleCapability } from "../../lifecycle";
import {
  hasColumn,
  hasTable,
  SCHEMA_VERSIONS_KEY
} from "../../lifecycle/schema";
import { Queue } from "../../queue";
import { withCapabilityHarness } from "../shared/capability-harness";

/** Migrates through two versions, recording each step it runs. */
class Versioned extends LifecycleCapability {
  readonly ran: number[] = [];
  constructor(
    kind: string,
    readonly legacyKey?: string
  ) {
    super(kind);
  }

  onStart(): void {
    this.lifecycle.schema.migrateSync({
      version: 2,
      legacyKey: this.legacyKey,
      steps: {
        1: () => {
          this.ran.push(1);
          this.lifecycle.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS versioned_rows (id TEXT)"
          );
        },
        2: () => {
          this.ran.push(2);
          this.lifecycle.storage.sql.exec(
            "CREATE INDEX IF NOT EXISTS versioned_rows_id ON versioned_rows (id)"
          );
        }
      }
    });
  }
}

describe("the schema versions record", () => {
  it("runs the missing steps in order and records every capability in one record", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      const first = new Versioned("versioned-a");
      const second = new Versioned("versioned-b");
      const { lifecycle } = install(first);
      lifecycle.use(second);
      await lifecycle.start();

      expect(first.ran).toEqual([1, 2]);
      expect(second.ran).toEqual([1, 2]);
      expect(storage.kv.get(SCHEMA_VERSIONS_KEY)).toEqual({
        "versioned-a": 2,
        "versioned-b": 2
      });
    });
  });

  it("folds a capability's old version key in once, and deletes it", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      storage.kv.put("cf_agents:versioned_schema_version", 1);
      storage.sql.exec("CREATE TABLE versioned_rows (id TEXT)");
      const capability = new Versioned(
        "versioned",
        "cf_agents:versioned_schema_version"
      );
      const { lifecycle } = install(capability);
      await lifecycle.start();

      // Version 1 was already in place: only step 2 runs.
      expect(capability.ran).toEqual([2]);
      expect(storage.kv.get("cf_agents:versioned_schema_version")).toBe(
        undefined
      );
      expect(storage.kv.get(SCHEMA_VERSIONS_KEY)).toEqual({ versioned: 2 });
    });
  });

  it("runs nothing at a start where the record is current", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      storage.kv.put(SCHEMA_VERSIONS_KEY, { versioned: 2 });
      const capability = new Versioned("versioned");
      const { lifecycle } = install(capability);
      await lifecycle.start();
      expect(capability.ran).toEqual([]);
    });
  });

  it("checks a table and a column without reading the schema table", async () => {
    await withCapabilityHarness(async ({ storage }) => {
      storage.sql.exec("CREATE TABLE probe_table (present TEXT)");
      expect(hasTable(storage.sql, "probe_table")).toBe(true);
      expect(hasTable(storage.sql, "missing_table")).toBe(false);
      expect(hasColumn(storage.sql, "probe_table", "present")).toBe(true);
      expect(hasColumn(storage.sql, "probe_table", "absent")).toBe(false);
      expect(hasColumn(storage.sql, "missing_table", "present")).toBe(false);
    });
  });

  it("folds Queue's released version key in, keeping what it had", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      // As the release left it: Queue at version 1 under its own key.
      storage.kv.put("cf_agents:queue_schema_version", 1);
      const { lifecycle } = install(new Queue());
      await lifecycle.start();

      expect(storage.kv.get("cf_agents:queue_schema_version")).toBe(undefined);
      expect(storage.kv.get(SCHEMA_VERSIONS_KEY)).toMatchObject({ queue: 1 });
    });
  });

  it("reads only the one record at a start with nothing to migrate", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      storage.kv.put(SCHEMA_VERSIONS_KEY, { queue: 1, lifecycle: 1 });
      const read: string[] = [];
      const get = storage.kv.get.bind(storage.kv);
      storage.kv.get = ((key: string) => {
        read.push(key);
        return get(key);
      }) as typeof storage.kv.get;
      try {
        const { lifecycle } = install(new Queue());
        await lifecycle.start();
      } finally {
        storage.kv.get = get;
      }
      expect(read.filter((key) => key.includes("schema"))).toEqual([
        SCHEMA_VERSIONS_KEY
      ]);
    });
  });

  it("reads a legacy key for an id that names an Object property", async () => {
    await withCapabilityHarness(async ({ install, storage }) => {
      storage.kv.put("cf_agents:constructor_schema_version", 1);
      storage.sql.exec("CREATE TABLE versioned_rows (id TEXT)");
      const capability = new Versioned(
        "constructor",
        "cf_agents:constructor_schema_version"
      );
      const { lifecycle } = install(capability);
      await lifecycle.start();
      expect(capability.ran).toEqual([2]);
      expect(storage.kv.get(SCHEMA_VERSIONS_KEY)).toEqual({ constructor: 2 });
    });
  });

  it("refuses the Lifecycle's own id as a capability kind", () => {
    expect(() => new Versioned("lifecycle")).toThrow(/reserved/);
  });
});
