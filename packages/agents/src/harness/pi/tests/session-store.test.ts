import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "../context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import {
  DurableObjectSqliteDatabase,
  openPiSessionStore
} from "../session-store";

// pi's own storage conformance suite, run against the session store on a
// real Durable Object's SQLite database. Each case gets a fresh object.
registerStorageConformance(
  { describe, expect, it },
  "pi session store on Durable Object SQLite",
  async (use) => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      try {
        await use(storage);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    });
  }
);

describe("pi session store", () => {
  it("keeps pi's tables under its prefix", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await openPiSessionStore(state.storage, { prefix: "pi_" });
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
        )
        .toArray()
        .map((row) => row.name);
      expect(tables.length).toBeGreaterThan(10);
      expect(tables.every((name) => name.startsWith("pi_"))).toBe(true);
      expect(tables).toContain("pi_tasks");
      expect(tables).toContain("pi_durable_schema");
    });
  });

  it("reopens an existing store without migrating again", async () => {
    const stub = env.PI_STORE_TEST.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      await openPiSessionStore(state.storage);
      await openPiSessionStore(state.storage);
      const version = state.storage.sql
        .exec<{ version: number }>("SELECT version FROM pi_durable_schema")
        .one().version;
      expect(version).toBe(1);
    });
  });

  it("rejects a prefix Durable Objects reserve", () => {
    expect(
      () =>
        new DurableObjectSqliteDatabase({} as DurableObjectStorage, {
          prefix: "_cf_x"
        })
    ).toThrow();
  });
});
